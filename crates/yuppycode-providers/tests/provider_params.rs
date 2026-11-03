//! Regression tests for provider-specific request parameters (spec §11).
//!
//! Background: the terminal surfaced
//! `API Error: 400 DeepSeek V4.1 reasoning_effort must be low, high, xhigh, max,
//!  or an integer within [1, 100]`.
//! These tests pin the contract that a value of that shape is what YuppyCode
//! accepts, that nothing outside it is silently substituted, and that the wire
//! body carries no parameter the caller did not ask for.

use serde_json::Value;
use yuppycode_core::cancel::CancelToken;
use yuppycode_core::provider::{ChatMessage, CompletionRequest, ModelProvider, Role};
use yuppycode_providers::openai::{
    OpenAiCompatible, OpenAiCompatibleConfig, build_request_body, validate_reasoning_effort,
};

fn request() -> CompletionRequest {
    CompletionRequest {
        model: "deepseek-v4.1".into(),
        messages: vec![ChatMessage {
            role: Role::User,
            content: "merhaba — görevi tamamla".into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }],
        tools: Vec::new(),
        temperature: None,
        max_output_tokens: None,
        reasoning_effort: None,
    }
}

/// A provider pointed at a port nothing listens on: if the adapter ever opens a
/// connection, the failure is a transport error, which proves it did *not*
/// reject the request locally.
fn unroutable_provider() -> OpenAiCompatible {
    OpenAiCompatible::new(OpenAiCompatibleConfig {
        display_id: "deepseek".into(),
        base_url: "http://127.0.0.1:9".into(),
        api_key_env: "YUPPY_TEST_KEY_MUST_NEVER_APPEAR".into(),
        model: "deepseek-v4.1".into(),
        timeout_ms: 500,
        retry: Default::default(),
    })
}

#[test]
fn the_documented_reasoning_levels_are_accepted() {
    // The exact vocabulary from the provider's own 400 message.
    for v in ["low", "high", "xhigh", "max"] {
        assert!(validate_reasoning_effort(v), "{v} must be accepted");
    }
    // Surrounding blanks come from config files and must not reject a good value.
    assert!(
        validate_reasoning_effort("  low  "),
        "trimmed value rejected"
    );
    // Every integer in the documented inclusive range.
    for n in [1, 2, 50, 99, 100] {
        assert!(
            validate_reasoning_effort(&n.to_string()),
            "{n} must be accepted"
        );
    }
    assert!(validate_reasoning_effort(" 100 "), "padded 100 rejected");
}

#[test]
fn values_outside_the_documented_range_are_rejected() {
    // Wrong words, including ones that look plausible.
    for v in [
        "", " ", "medium", "minimal", "ultra", "none", "highest", "LOW", "High",
    ] {
        assert!(
            !validate_reasoning_effort(v),
            "{v:?} is not a documented level and must be rejected"
        );
    }
    // Integers outside [1, 100], at and beyond both bounds.
    for v in ["0", "-1", "101", "1000", "-100"] {
        assert!(
            !validate_reasoning_effort(v),
            "{v} is outside [1, 100] and must be rejected"
        );
    }
    // Not integers at all: no rounding, no silent coercion.
    for v in ["1.5", "1e2", "0x10", "1_0", "100ms", "abc", "12 34", "１５"] {
        assert!(
            !validate_reasoning_effort(v),
            "{v:?} is not a plain integer and must be rejected"
        );
    }
}

#[test]
fn an_empty_request_body_gains_no_inventable_parameters() {
    // Nothing in CompletionRequest asks for reasoning effort, so the wire body
    // must not grow one on its own: an unsolicited parameter is exactly the
    // class of 400 this spec item is about.
    let body = build_request_body("deepseek-v4.1", &request());
    let obj = body.as_object().expect("request body is an object");
    for key in ["reasoning_effort", "reasoning", "thinking", "verbosity"] {
        assert!(
            !obj.contains_key(key),
            "the adapter injected `{key}` without being asked: {body}"
        );
    }
    // What it must carry.
    assert_eq!(
        obj.get("model").and_then(Value::as_str),
        Some("deepseek-v4.1")
    );
    assert!(obj.contains_key("messages"), "messages missing from {body}");
}

#[test]
fn a_turkish_prompt_survives_serialisation_unchanged() {
    let body = build_request_body("deepseek-v4.1", &request());
    let sent = body["messages"][0]["content"]
        .as_str()
        .expect("content is a string");
    assert_eq!(sent, "merhaba — görevi tamamla", "Turkish text was mangled");
    assert_eq!(body["messages"][0]["role"].as_str(), Some("user"));
}

#[test]
fn a_valid_effort_is_forwarded_verbatim() {
    let mut req = request();
    req.reasoning_effort = Some("xhigh".into());
    let body = build_request_body("deepseek-v4.1", &req);
    assert_eq!(
        body["reasoning_effort"].as_str(),
        Some("xhigh"),
        "an accepted value must reach the provider unchanged"
    );
}

#[tokio::test]
async fn an_invalid_effort_is_rejected_before_any_request_is_sent() {
    // This is the DeepSeek 400 turned into a local, actionable error: the
    // adapter must refuse the value itself, not forward it and hope.
    let provider = unroutable_provider();
    let mut req = request();
    req.reasoning_effort = Some("medium".into());

    let err = match provider.stream(req, CancelToken::new()).await {
        Ok(_) => panic!("`medium` is not a documented effort level and must be refused"),
        Err(e) => e,
    };
    match &err {
        yuppycode_core::ProviderError::Config(msg) => {
            assert!(
                msg.contains("medium") && msg.contains("low|high|xhigh|max"),
                "the error must name the bad value and the accepted set: {msg}"
            );
            // Config errors are shown in the TUI: no key material, no header dump.
            for leak in ["sk-", "Bearer", "Authorization", "api_key"] {
                assert!(
                    !msg.contains(leak),
                    "an error message shown to the user leaked `{leak}`: {msg}"
                );
            }
        }
        other => panic!(
            "expected a local Config rejection, got {other:?} — that means the \
             request was sent and answered by the network"
        ),
    }
}

#[tokio::test]
async fn a_valid_effort_is_not_blocked_by_the_local_check() {
    // Same path with an accepted value must get past validation and reach the
    // transport layer (proving the guard is not rejecting everything).
    let provider = unroutable_provider();
    let mut req = request();
    req.reasoning_effort = Some("high".into());
    let err = match provider.stream(req, CancelToken::new()).await {
        Ok(_) => panic!("the unroutable endpoint unexpectedly accepted the request"),
        Err(e) => e,
    };
    assert!(
        !matches!(err, yuppycode_core::ProviderError::Config(_)),
        "a valid effort was rejected locally: {err:?}"
    );
}

#[test]
fn every_documented_level_round_trips_through_the_wire_format() {
    for level in ["low", "high", "xhigh", "max", "1", "100"] {
        let mut req = request();
        req.reasoning_effort = Some(level.into());
        let body = build_request_body("m", &req);
        assert_eq!(body["reasoning_effort"].as_str(), Some(level));
    }
}

#[test]
fn characterization_a_signed_integer_currently_passes_the_guard() {
    // KNOWN GAP, recorded deliberately so it is not lost.
    //
    // `"+5".parse::<i64>()` succeeds in Rust, so a signed integer inside the
    // range passes validation and is then copied to the wire *verbatim* by
    // `build_request_body`. The provider documents "an integer within [1, 100]",
    // which does not promise to accept a leading `+`.
    //
    // Today's behaviour (asserted here so a change is a deliberate decision):
    assert!(
        validate_reasoning_effort("+5"),
        "behaviour changed: the guard now rejects signed integers"
    );
    let mut req = request();
    req.reasoning_effort = Some("+5".into());
    assert_eq!(
        build_request_body("m", &req)["reasoning_effort"].as_str(),
        Some("+5"),
        "the unnormalised string is what reaches the provider"
    );
    // If this test starts failing, either the guard rejects signed values or the
    // value is normalised before sending — both are improvements; update it then.
}
