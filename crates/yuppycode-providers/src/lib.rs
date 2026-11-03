//! YuppyCode provider adapters.
//!
//! The traits live in `yuppycode-core::provider`; this crate supplies concrete
//! wire-format adapters. Phase 1 ships:
//!
//! - [`OpenAiCompatible`] — the OpenAI Chat Completions wire format with SSE
//!   streaming and incremental tool calls. Works against any endpoint that
//!   speaks it (OpenAI, OpenRouter, Together, Ollama `/v1`, LM Studio, vLLM…)
//!   by pointing `base_url` at it.
//!
//! API keys are resolved from environment variables at request time and are
//! never written to logs or persisted. There is no demo/fabricated provider:
//! every adapter speaks to a real endpoint (or is explicitly `off`).

pub mod off;
pub mod openai;

pub use off::Off;
pub use openai::{OpenAiCompatible, OpenAiCompatibleConfig, RetryPolicy};

use yuppycode_core::ModelProvider;

/// Build an adapter from a provider id + model, used by config wiring.
pub fn build_provider(
    id: &str,
    model: &str,
    base_url: Option<&str>,
    api_key_env: Option<&str>,
) -> Result<Box<dyn ModelProvider>, yuppycode_core::ProviderError> {
    match id {
        "openai-compatible" | "openai" | "openrouter" | "ollama" | "lmstudio" | "omniroute" => {
            let default_url = match id {
                "ollama" => "http://127.0.0.1:11434/v1",
                "lmstudio" => "http://127.0.0.1:1234/v1",
                "openrouter" => "https://openrouter.ai/api/v1",
                "omniroute" => "http://127.0.0.1:20128/v1",
                _ => "https://api.openai.com/v1",
            };
            let key_env = match id {
                "omniroute" => api_key_env.unwrap_or("OMNIROUTE_API_KEY"),
                _ => api_key_env.unwrap_or("YUPPY_OPENAI_API_KEY"),
            };
            Ok(Box::new(OpenAiCompatible::new(OpenAiCompatibleConfig {
                display_id: id.to_string(),
                base_url: base_url
                    .unwrap_or(default_url)
                    .trim_end_matches('/')
                    .to_string(),
                api_key_env: key_env.to_string(),
                model: model.to_string(),
                timeout_ms: 60_000,
                retry: RetryPolicy::default(),
            })))
        }
        "off" => Ok(Box::new(Off::new())),
        "simulated" | "demo" => Err(yuppycode_core::ProviderError::Config(
            "the demo provider was removed — YuppyCode never runs on fabricated data. \
             Use a real provider (openai-compatible, openai, openrouter, ollama, lmstudio) \
             or 'off' to host CLI agent sessions."
                .into(),
        )),
        other => Err(yuppycode_core::ProviderError::Config(format!(
            "unknown provider id '{other}'"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_known_ids_and_rejects_unknown() {
        assert!(build_provider("openai-compatible", "gpt-4o-mini", None, None).is_ok());
        assert!(build_provider("off", "none", None, None).is_ok());
        assert!(build_provider("nope", "x", None, None).is_err());
    }
    #[test]
    fn omniroute_provider_uses_its_own_open_gateway() {
        // OmniRoute is a local, OpenAI-compatible aggregator with no
        // required key. The id must resolve and pick its own base URL.
        let p = build_provider("omniroute", "auto/best-coding", None, None).unwrap();
        assert_eq!(p.id(), "omniroute");
        // A missing env var must not be fatal: the gateway is open.
        unsafe {
            std::env::remove_var("OMNIROUTE_API_KEY");
        }
        let p2 = build_provider("omniroute", "auto/best-coding", None, None).unwrap();
        assert_eq!(p2.id(), "omniroute");
    }

    #[test]
    fn demo_provider_is_removed() {
        // No fabricated data anywhere: the old simulated provider must fail.
        assert!(build_provider("simulated", "demo", None, None).is_err());
        assert!(build_provider("demo", "demo", None, None).is_err());
    }
}
