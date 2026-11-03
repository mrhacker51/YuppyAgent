//! Tiny unique ids without a uuid dependency.
//!
//! Format: `<prefix>_<base36 micros since epoch>_<base36 counter>`.
//! Monotonic per process and unique across processes with counter + time.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn next() -> String {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{micros:x}_{n:x}")
}

macro_rules! id_newtype {
    ($name:ident, $prefix:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name {
            pub fn next() -> Self {
                Self(format!("{}_{}", $prefix, crate::ids::next()))
            }
            pub fn from_string(s: impl Into<String>) -> Self {
                Self(s.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_newtype!(RunId, "run");
id_newtype!(CallId, "call");
id_newtype!(ConversationId, "conv");
id_newtype!(WorkspaceId, "ws");

/// Task ids are plain strings for cheap serialisation in the graph.
pub type TaskId = String;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_prefixed() {
        let a = RunId::next();
        let b = RunId::next();
        assert_ne!(a, b);
        assert!(a.as_str().starts_with("run_"));
        assert!(CallId::next().as_str().starts_with("call_"));
    }
}
