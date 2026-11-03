//! OpenAI-compatible Chat Completions adapter with SSE streaming.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use yuppycode_core::provider::{
    ChunkStream, CompletionRequest, FinishReason, ModelProvider, ProviderError, ProviderFuture,
    Role, StreamChunk,
};
use yuppycode_core::{CancelToken, ProviderCapabilities};

/// Exponential backoff policy applied before the first byte of the stream.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            base_delay_ms: 250,
            max_delay_ms: 4_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpenAiCompatibleConfig {
    /// Provider id shown in the UI, e.g. "openai" or "ollama".
    pub display_id: String,
    /// Base URL *without* trailing slash, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    /// Environment variable holding the API key. Resolved per request.
    pub api_key_env: String,
    pub model: String,
    pub timeout_ms: u64,
    pub retry: RetryPolicy,
}

pub struct OpenAiCompatible {
    cfg: OpenAiCompatibleConfig,
    client: OnceLock<reqwest::Client>,
}

impl OpenAiCompatible {
    pub fn new(cfg: OpenAiCompatibleConfig) -> Self {
        Self {
            cfg,
            client: OnceLock::new(),
        }
    }

    /// Lazily built shared client (connection pooling; no startup cost).
    ///
    /// NOTE: deliberately no client-wide `timeout` — reqwest's client timeout
    /// bounds the *entire* call including the response body, which would cut
    /// SSE streams (long DeepSeek/OpenAI completions) at a fixed wall-clock
    /// limit. We bound connect and time-to-response-headers separately instead,
    /// and rely on the pump's per-chunk idle timeout for the stream itself.
    fn client(&self) -> &reqwest::Client {
        self.client.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_millis(self.cfg.timeout_ms.min(15_000)))
                .build()
                .expect("reqwest client with default TLS config cannot fail here")
        })
    }

    fn api_key(&self) -> Option<String> {
        std::env::var(&self.cfg.api_key_env)
            .ok()
            .filter(|k| !k.is_empty())
    }

    async fn post_with_retry(
        &self,
        body: Value,
        cancel: &CancelToken,
    ) -> Result<reqwest::Response, ProviderError> {
        let url = format!("{}/chat/completions", self.cfg.base_url);
        let policy = self.cfg.retry.clone();
        let mut attempt: u32 = 0;
        loop {
            if cancel.is_cancelled() {
                return Err(ProviderError::Cancelled);
            }
            let mut req = self.client().post(&url).json(&body);
            // Key fetched at request time; never stored, never logged.
            if let Some(key) = self.api_key() {
                req = req.bearer_auth(key);
            }
            // Bound only until response headers arrive; the body may stream
            // far longer (SSE). A stalled server therefore fails the same
            // way it used to, but healthy long streams are never cut.
            let send = tokio::time::timeout(Duration::from_millis(self.cfg.timeout_ms), req.send());
            tokio::select! {
                _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
                res = send => match res {
                    Ok(Ok(resp)) if resp.status().is_success() => return Ok(resp),
                    Ok(Ok(resp)) => {
                        let status = resp.status().as_u16();
                        let retryable = status == 429 || status >= 500;
                        let body = resp.text().await.unwrap_or_default();
                        let body: String = body.chars().take(500).collect();
                        if !retryable || attempt >= policy.max_retries {
                            return Err(ProviderError::Http { status, body });
                        }
                    }
                    Ok(Err(e)) => {
                        if (!e.is_connect() && !e.is_timeout()) || attempt >= policy.max_retries {
                            return Err(ProviderError::Transport(redact_key_text(&e.to_string())));
                        }
                    }
                    Err(_elapsed) => {
                        if attempt >= policy.max_retries {
                            return Err(ProviderError::Transport(format!(
                                "request timed out after {} ms waiting for response headers",
                                self.cfg.timeout_ms
                            )));
                        }
                    }
                }
            }
            attempt += 1;
            let delay = (policy.base_delay_ms * 2u64.pow(attempt - 1)).min(policy.max_delay_ms);
            let sleep = tokio::time::sleep(Duration::from_millis(delay));
            tokio::select! {
                _ = sleep => {}
                _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
            }
        }
    }
}

impl ModelProvider for OpenAiCompatible {
    fn id(&self) -> &str {
        &self.cfg.display_id
    }

    fn display_name(&self) -> String {
        format!("{}/{}", self.cfg.display_id, self.cfg.model)
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            tool_calls: true,
        }
    }

    fn stream(&self, req: CompletionRequest, cancel: CancelToken) -> ProviderFuture<'_> {
        Box::pin(async move {
            // Fail fast with an actionable message instead of letting the
            // upstream API answer with an opaque 400 (this is exactly the
            // DeepSeek V4.1 reasoning_effort rejection contract).
            if let Some(re) = req.reasoning_effort.as_deref() {
                if !validate_reasoning_effort(re) {
                    return Err(ProviderError::Config(format!(
                        "invalid reasoning_effort '{re}': expected one of \
                         low|high|xhigh|max or an integer 1..=100"
                    )));
                }
            }
            let model = if req.model.is_empty() {
                self.cfg.model.clone()
            } else {
                req.model.clone()
            };
            let body = build_request_body(&model, &req);
            let resp = self.post_with_retry(body, &cancel).await?;
            // Pump task: parses SSE off the UI/engine hot path, applies
            // bounded-queue backpressure, exits when the consumer drops or
            // cancellation fires.
            let (tx, rx) = mpsc::channel::<Result<StreamChunk, ProviderError>>(64);
            let pump_cancel = cancel.clone();
            let idle = Duration::from_millis(self.cfg.timeout_ms);
            tokio::spawn(async move {
                let _ = pump_sse(resp, tx, pump_cancel, idle).await;
            });
            Ok(Box::pin(MpscStream { rx }) as ChunkStream)
        })
    }
}

/// Adapter turning the pump's bounded channel into a futures Stream.
struct MpscStream<T> {
    rx: mpsc::Receiver<T>,
}

impl<T> futures_util::Stream for MpscStream<T> {
    type Item = T;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<T>> {
        self.rx.poll_recv(cx)
    }
}

async fn pump_sse(
    resp: reqwest::Response,
    tx: mpsc::Sender<Result<StreamChunk, ProviderError>>,
    cancel: CancelToken,
    idle_timeout: Duration,
) -> Result<(), ProviderError> {
    use futures_util::TryStreamExt;
    let mut stream = resp.bytes_stream();
    // Byte buffer, not String: providers sending CJK text (DeepSeek et al.)
    // routinely split a multi-byte UTF-8 character across TCP chunks, and
    // lossy-converting partial chunks corrupts the JSON with U+FFFD, which
    // then surfaces as a misleading "bad SSE JSON" error. Newlines never
    // appear inside a multi-byte sequence, so line boundaries are always
    // character boundaries and decoding complete lines is lossless.
    let mut buf: Vec<u8> = Vec::new();

    loop {
        let chunk = match tokio::time::timeout(idle_timeout, stream.try_next()).await {
            Err(_elapsed) => {
                return Err(ProviderError::Transport(format!(
                    "stream stalled: no data received for {} ms",
                    idle_timeout.as_millis()
                )));
            }
            Ok(Err(e)) => {
                return Err(ProviderError::Transport(redact_key_text(&format!(
                    "stream read failed: {e}"
                ))));
            }
            Ok(Ok(None)) => break,
            Ok(Ok(Some(c))) => c,
        };
        if cancel.is_cancelled() {
            let _ = tx
                .send(Ok(StreamChunk::Done {
                    finish: FinishReason::Cancelled,
                }))
                .await;
            return Ok(());
        }
        buf.extend_from_slice(&chunk);
        for payload in sse_take_payloads(&mut buf) {
            if payload == "[DONE]" {
                let _ = tx
                    .send(Ok(StreamChunk::Done {
                        finish: FinishReason::Stop,
                    }))
                    .await;
                return Ok(());
            }
            let value: Value = serde_json::from_str(&payload)
                .map_err(|e| ProviderError::InvalidResponse(format!("bad SSE JSON: {e}")))?;
            for ev in chunk_to_stream_events(&value) {
                if tx.send(Ok(ev)).await.is_err() {
                    return Ok(()); // consumer dropped
                }
            }
        }
        if buf.len() > 4 * 1024 * 1024 {
            return Err(ProviderError::InvalidResponse("SSE buffer overflow".into()));
        }
    }
    let _ = tx
        .send(Ok(StreamChunk::Done {
            finish: FinishReason::Stop,
        }))
        .await;
    Ok(())
}

/// Split complete `data:` payloads out of an SSE buffer, keeping the remainder.
/// Operates on raw bytes so a payload split mid-UTF-8-character across network
/// chunks stays intact until its newline arrives.
fn sse_take_payloads(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
        let line = String::from_utf8_lossy(&buf[..nl])
            .trim_end_matches('\r')
            .to_string();
        buf.drain(..=nl);
        let line = line.trim_start();
        if line.is_empty() || line.starts_with(':') {
            continue; // keep-alives / comments
        }
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if !data.is_empty() {
                out.push(data.to_string());
            }
        }
        // non-data SSE fields (event:, id:) are ignored by this protocol
    }
    out
}

/// Map one parsed chat-completion chunk into core stream events.
fn chunk_to_stream_events(value: &Value) -> Vec<StreamChunk> {
    let mut out = Vec::new();
    let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
        return out;
    };
    let delta = choice.get("delta");
    if let Some(text) = delta.and_then(|d| d.get("content")).and_then(Value::as_str) {
        if !text.is_empty() {
            out.push(StreamChunk::Text(text.to_string()));
        }
    }
    if let Some(calls) = delta
        .and_then(|d| d.get("tool_calls"))
        .and_then(Value::as_array)
    {
        for call in calls {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let id = call.get("id").and_then(Value::as_str).map(str::to_string);
            let func = call.get("function");
            let name = func
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let args = func
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if name.is_some() || !args.is_empty() || id.is_some() {
                out.push(StreamChunk::ToolCallDelta {
                    index,
                    id,
                    name,
                    arguments_delta: args,
                });
            }
        }
    }
    if let Some(finish) = choice.get("finish_reason").and_then(Value::as_str) {
        let f = match finish {
            "tool_calls" => FinishReason::ToolCalls,
            "length" => FinishReason::Length,
            _ => FinishReason::Stop,
        };
        out.push(StreamChunk::Done { finish: f });
    }
    out
}

/// Validate a `reasoning_effort` value for providers/models that accept one.
///
/// Accepted values (per the DeepSeek V4.1 error contract and the OpenAI
/// o-series family): the named levels `low`, `high`, `xhigh`, `max`, or an
/// integer in the inclusive range `[1, 100]`.  Returns `false` for anything
/// else so callers can surface a clear, actionable error instead of
/// silently substituting a default.
pub fn validate_reasoning_effort(value: &str) -> bool {
    let v = value.trim();
    if matches!(v, "low" | "high" | "xhigh" | "max") {
        return true;
    }
    match v.parse::<i64>() {
        Ok(n) => (1..=100).contains(&n),
        Err(_) => false,
    }
}

/// Serialise the neutral request into the OpenAI wire format.
pub fn build_request_body(model: &str, req: &CompletionRequest) -> Value {
    let mut messages = Vec::new();
    for m in &req.messages {
        let mut msg = json!({ "role": role_str(m.role), "content": m.content });
        if !m.tool_calls.is_empty() {
            let calls: Vec<Value> = m
                .tool_calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id.to_string(),
                        "type": "function",
                        "function": {
                            "name": c.name,
                            "arguments": c.arguments.to_string(),
                        }
                    })
                })
                .collect();
            msg = json!({ "role": "assistant", "tool_calls": calls });
            if !m.content.is_empty() {
                msg["content"] = json!(m.content);
            } else {
                msg["content"] = Value::Null;
            }
        }
        if let Some(id) = &m.tool_call_id {
            msg["tool_call_id"] = json!(id);
        }
        messages.push(msg);
    }
    let mut body = json!({ "model": model, "messages": messages, "stream": true });
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect();
        body["tools"] = json!(tools);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = req.max_output_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(re) = &req.reasoning_effort {
        body["reasoning_effort"] = json!(re);
    }
    body
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

/// Best-effort scrub of key material in transport error text.
pub(crate) fn redact_key_text(s: &str) -> String {
    let mut out = s.to_string();
    if let Some(pos) = out.find("sk-") {
        out.replace_range(pos.., "sk-[REDACTED]");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use yuppycode_core::{CallId, ChatMessage, ToolCall};

    #[test]
    fn sse_splits_complete_payloads_only() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: {\"a\":1}\n");
        buf.extend_from_slice(b": keepalive\n\n");
        let got = sse_take_payloads(&mut buf);
        assert_eq!(got, vec!["{\"a\":1}"]);
        buf.extend_from_slice(b"data: {\"b\":2"); // partial stays
        assert!(sse_take_payloads(&mut buf).is_empty());
        buf.extend_from_slice(b"}\n");
        assert_eq!(sse_take_payloads(&mut buf), vec!["{\"b\":2}"]);
    }

    #[test]
    fn sse_payload_survives_multibyte_split_across_chunks() {
        // "深" is E6 B1 B1; split a multi-byte char across two network
        // chunks exactly like a TCP boundary would. The payload must decode
        // intact — lossy-converting the split would inject U+FFFD and make
        // the JSON unparseable (the "DeepSeek bad SSE JSON" failure mode).
        let line = "data: {\"c\":\"深圳\"}\n".as_bytes();
        let split = line.len() - 2; // cut inside the last multi-byte char
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&line[..split]);
        assert!(
            sse_take_payloads(&mut buf).is_empty(),
            "partial line must wait"
        );
        buf.extend_from_slice(&line[split..]);
        let got = sse_take_payloads(&mut buf);
        assert_eq!(got, vec!["{\"c\":\"深圳\"}"]);
        let v: Value = serde_json::from_str(&got[0]).expect("payload must be valid JSON");
        assert_eq!(v["c"], "深圳");
    }

    #[test]
    fn chunk_text_and_finish() {
        let v = json!({"choices":[{"delta":{"content":"hi"},"finish_reason":null}]});
        assert_eq!(
            chunk_to_stream_events(&v),
            vec![StreamChunk::Text("hi".into())]
        );
        let v = json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]});
        assert_eq!(
            chunk_to_stream_events(&v),
            vec![StreamChunk::Done {
                finish: FinishReason::ToolCalls
            }]
        );
    }

    #[test]
    fn chunk_tool_call_delta() {
        let v = json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"c1","function":{"name":"read_file","arguments":""}},
            {"index":0,"function":{"arguments":"{\"path\""}}
        ]}}]});
        let evs = chunk_to_stream_events(&v);
        assert_eq!(evs.len(), 2);
        match &evs[0] {
            StreamChunk::ToolCallDelta {
                index,
                id: Some(id),
                name: Some(n),
                ..
            } => {
                assert_eq!((*index, id.as_str(), n.as_str()), (0, "c1", "read_file"));
            }
            other => panic!("{other:?}"),
        }
        match &evs[1] {
            StreamChunk::ToolCallDelta {
                arguments_delta,
                id: None,
                name: None,
                ..
            } => {
                assert_eq!(arguments_delta, "{\"path\"");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn request_body_wire_shape() {
        let req = CompletionRequest {
            model: String::new(),
            messages: vec![
                ChatMessage::system("sys"),
                ChatMessage::user("hi"),
                ChatMessage::assistant(
                    "",
                    vec![ToolCall {
                        id: CallId::from_string("call_1"),
                        name: "read_file".into(),
                        arguments: json!({"path": "a.txt"}),
                    }],
                ),
                ChatMessage::tool(&CallId::from_string("call_1"), "contents"),
            ],
            tools: vec![yuppycode_core::ToolSpec {
                name: "read_file".into(),
                description: "read".into(),
                input_schema: json!({"type":"object"}),
                risk: yuppycode_core::Risk::Safe,
            }],
            temperature: Some(0.2),
            max_output_tokens: None,
            reasoning_effort: Some("high".into()),
        };
        let body = build_request_body("m1", &req);
        assert_eq!(body["model"], "m1");
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(
            body["messages"][2]["tool_calls"][0]["function"]["name"],
            "read_file"
        );
        assert_eq!(body["messages"][3]["role"], "tool");
        assert_eq!(body["messages"][3]["tool_call_id"], "call_1");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
        // assistant text content may be null when only tool calls stream
        assert!(body["messages"][2]["content"].is_null());
    }

    #[test]
    fn redacts_key_material() {
        let s = redact_key_text("header: Bearer sk-abc123secret");
        assert!(!s.contains("abc123secret"));
    }

    #[test]
    fn reasoning_effort_validation_accepts_supported_values() {
        for v in ["low", "high", "xhigh", "max", "1", "50", "100"] {
            assert!(validate_reasoning_effort(v), "should accept {v}");
        }
    }

    #[test]
    fn reasoning_effort_validation_rejects_invalid_values() {
        for v in ["", "medium", "ultra", "0", "-1", "101", "1.5", "abc"] {
            assert!(!validate_reasoning_effort(v), "should reject {v:?}");
        }
    }
}
