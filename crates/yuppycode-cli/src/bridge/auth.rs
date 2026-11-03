//! Local connection authorization for the WebSocket bridge.
//!
//! Security model:
//! - The bridge binds to a loopback address by default.
//! - On startup it generates a single-use random token and prints it to
//!   stderr exactly once. The frontend must present this token in the
//!   handshake.
//! - The token is never logged again, never placed in a URL, and never
//!   sent back to the client by the server.
//! - Origin header checking is used only as defense-in-depth; it is not
//!   authentication.

#![allow(dead_code)] // verify_token / origin_allowed used in Task 3.

use rand::RngCore;

/// Number of random bytes in a token. Encoded as hex, this yields
/// `TOKEN_BYTES * 2` characters.
const TOKEN_BYTES: usize = 32;

/// Opaque connection token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionToken(pub(crate) String);

impl ConnectionToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Generate a fresh random connection token.
pub fn generate_token() -> ConnectionToken {
    let mut bytes = vec![0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    ConnectionToken(hex_encode(&bytes))
}

/// Return the token from `YUPPY_BRIDGE_TOKEN` if set (useful for
/// development and for pairing with the frontend's env var), otherwise
/// generate a random one.
pub fn token_from_env_or_generate() -> ConnectionToken {
    std::env::var("YUPPY_BRIDGE_TOKEN")
        .map(ConnectionToken)
        .unwrap_or_else(|_| generate_token())
}

/// Verify that `provided` matches `expected` in constant time.
pub fn verify_token(expected: &ConnectionToken, provided: &str) -> bool {
    // Constant-time comparison is overkill for a local token, but it costs
    // nothing and prevents accidental timing side-channels.
    let expected = expected.as_str().as_bytes();
    let provided = provided.as_bytes();
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .iter()
        .zip(provided.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Origin allow-list used as defense-in-depth. The primary authorization
/// is the connection token; this list only rejects obviously wrong origins.
pub fn allowed_origins() -> &'static [&'static str] {
    &[
        "http://localhost",
        "http://localhost:*",
        "http://127.0.0.1",
        "http://127.0.0.1:*",
        // Tauri's own webview origin on Linux (`tauri://localhost`), plus the
        // wry workaround URL used on Windows (`https://tauri.localhost`).
        // Token auth remains the primary authorization; this is depth only.
        "tauri://localhost",
        "https://tauri.localhost",
    ]
}

/// Check whether an Origin header value is in the allow-list.
pub fn origin_allowed(origin: &str) -> bool {
    allowed_origins().iter().any(|allowed| {
        if let Some(prefix) = allowed.strip_suffix(":*") {
            origin == prefix || origin.starts_with(&format!("{}:", prefix))
        } else {
            origin == *allowed
        }
    })
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_is_64_hex_chars() {
        let token = generate_token();
        assert_eq!(token.as_str().len(), 64);
        assert!(token.as_str().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn verify_token_accepts_correct_value() {
        let token = generate_token();
        assert!(verify_token(&token, token.as_str()));
    }

    #[test]
    fn verify_token_rejects_wrong_value() {
        let token = generate_token();
        let wrong = "0".repeat(64);
        assert!(!verify_token(&token, &wrong));
    }

    #[test]
    fn verify_token_rejects_different_length() {
        let token = generate_token();
        assert!(!verify_token(&token, "short"));
    }

    #[test]
    fn allowed_origins_accepts_localhost_ports() {
        assert!(origin_allowed("http://localhost:3000"));
        assert!(origin_allowed("http://127.0.0.1:3000"));
        assert!(origin_allowed("http://localhost"));
    }

    #[test]
    fn allowed_origins_accepts_the_tauri_webview() {
        assert!(origin_allowed("tauri://localhost"));
        assert!(origin_allowed("https://tauri.localhost"));
    }

    #[test]
    fn allowed_origins_rejects_unknown() {
        assert!(!origin_allowed("http://evil.com"));
        assert!(!origin_allowed("https://google.com"));
        assert!(!origin_allowed("tauri://evil.localhost"));
    }
}
