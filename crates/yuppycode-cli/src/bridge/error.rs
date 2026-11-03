//! Bridge error types and their mapping to protocol payloads.

use yuppycode_protocol::ServerPayload;

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("protocol version mismatch: expected {expected}, got {got}")]
    ProtocolVersionMismatch { expected: u32, got: u32 },
    #[error("unauthorized: invalid or missing connection token")]
    Unauthorized,
    #[error("invalid message: {0}")]
    InvalidMessage(String),
    #[error("payload too large: {0} bytes")]
    PayloadTooLarge(usize),
    #[error("handshake timeout")]
    HandshakeTimeout,
    #[error("service error: {0}")]
    Service(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl BridgeError {
    /// Stable machine-readable code for the frontend. Never include the
    /// token or any other secret here.
    pub fn code(&self) -> &'static str {
        match self {
            BridgeError::ProtocolVersionMismatch { .. } => "protocol_mismatch",
            BridgeError::Unauthorized => "unauthorized",
            BridgeError::InvalidMessage(_) => "invalid_message",
            BridgeError::PayloadTooLarge(_) => "payload_too_large",
            BridgeError::HandshakeTimeout => "handshake_timeout",
            BridgeError::Service(_) => "service_error",
            BridgeError::Io(_) => "io_error",
        }
    }
}

impl From<BridgeError> for ServerPayload {
    fn from(e: BridgeError) -> Self {
        ServerPayload::Error {
            code: e.code().to_string(),
            message: e.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Vec<(BridgeError, &'static str)> {
        vec![
            (
                BridgeError::ProtocolVersionMismatch {
                    expected: 2,
                    got: 1,
                },
                "protocol_mismatch",
            ),
            (BridgeError::Unauthorized, "unauthorized"),
            (
                BridgeError::InvalidMessage("missing field `run_id`".into()),
                "invalid_message",
            ),
            (BridgeError::PayloadTooLarge(1_048_576), "payload_too_large"),
            (BridgeError::HandshakeTimeout, "handshake_timeout"),
            (
                BridgeError::Service("engine exited".into()),
                "service_error",
            ),
            (
                BridgeError::Io(std::io::Error::other("socket closed")),
                "io_error",
            ),
        ]
    }

    /// A run of 32+ hex characters is what a connection token looks like
    /// (`TOKEN_BYTES * 2` = 64 hex chars). Nothing a client may legitimately be
    /// told should ever match this shape.
    fn looks_like_a_secret(s: &str) -> bool {
        let bytes = s.as_bytes();
        let mut run = 0usize;
        for &b in bytes {
            run = if b.is_ascii_hexdigit() { run + 1 } else { 0 };
            if run >= 32 {
                return true;
            }
        }
        false
    }

    #[test]
    fn every_variant_reports_its_own_stable_code() {
        for (e, expected) in cases() {
            assert_eq!(e.code(), expected, "{e:?} must keep its wire code");
        }
    }

    #[test]
    fn codes_are_unique_and_machine_readable() {
        // The frontend switches on these strings, so two variants sharing one
        // code silently collapses two different failures into one branch.
        let mut seen: Vec<&'static str> = Vec::new();
        for (e, _) in cases() {
            let code = e.code();
            assert!(
                code.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "`{code}` is not a snake_case identifier"
            );
            assert!(
                !seen.contains(&code),
                "`{code}` is reported by two variants"
            );
            seen.push(code);
        }
        assert_eq!(seen.len(), 7, "every variant must be covered here");
    }

    #[test]
    fn the_wire_payload_carries_code_and_message_together() {
        let payload = ServerPayload::from(BridgeError::ProtocolVersionMismatch {
            expected: 2,
            got: 1,
        });
        match payload {
            ServerPayload::Error { code, message } => {
                assert_eq!(code, "protocol_mismatch");
                assert!(
                    message.contains("expected 2") && message.contains("got 1"),
                    "{message} should say what the client got wrong"
                );
            }
            other => panic!("a rejection must serialize as Error, got {other:?}"),
        }
    }

    #[test]
    fn the_detector_of_leaked_secrets_actually_detects_one() {
        // Positive control: without this, the non-leak test below could pass
        // simply because the detector never matches anything.
        let token = "a".repeat(64);
        assert!(looks_like_a_secret(&format!("presented token {token}")));
        assert!(!looks_like_a_secret(
            "unauthorized: invalid or missing connection token"
        ));
    }

    #[test]
    fn no_rejection_echoes_a_credential_to_the_client() {
        // `auth.rs` promises the connection token is "never sent back to the
        // client by the server". Rejections are the one place a token could
        // leak, because they are built at the moment a token is in hand.
        for (e, code) in cases() {
            let message = e.to_string();
            assert!(
                !looks_like_a_secret(&message),
                "rejection `{code}` puts a token-shaped value in its message: {message}"
            );
            let payload = ServerPayload::from(e);
            let json = serde_json::to_string(&payload).expect("payload serializes");
            assert!(
                !looks_like_a_secret(&json),
                "rejection `{code}` leaks a token-shaped value on the wire: {json}"
            );
        }
    }
}
