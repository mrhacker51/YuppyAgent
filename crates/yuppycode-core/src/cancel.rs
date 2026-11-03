//! Cooperative cancellation shared by providers, tools and the engine.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

/// Cheap-to-clone cancellation signal.
///
/// Set once, observed many times. Waiters block efficiently on a [`Notify`]
/// instead of polling timers.
#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
    wake: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self.inner.cancelled.swap(true, Ordering::SeqCst) {
            self.inner.wake.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves immediately if already cancelled, otherwise when cancelled.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        // Notified-after-await race is closed by re-checking the flag.
        loop {
            let notified = self.inner.wake.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
        }
    }

    /// `Err(Cancelled)` when the token is set, else `Ok(v)`.
    pub fn guard<T>(&self, v: T) -> Result<T, crate::provider::ProviderError> {
        if self.is_cancelled() {
            Err(crate::provider::ProviderError::Cancelled)
        } else {
            Ok(v)
        }
    }
}

impl std::fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_starts_unset_and_set_is_sticky() {
        let t = CancelToken::new();
        assert!(!t.is_cancelled());
        t.cancel();
        t.cancel(); // idempotent
        assert!(t.is_cancelled());
        assert!(t.guard(1).is_err());
    }

    #[tokio::test]
    async fn waiter_wakes_on_cancel() {
        let t = CancelToken::new();
        let t2 = t.clone();
        tokio::spawn(async move { t2.cancel() });
        tokio::time::timeout(std::time::Duration::from_secs(1), t.cancelled())
            .await
            .expect("should wake");
    }

    #[tokio::test]
    async fn already_cancelled_returns_immediately() {
        let t = CancelToken::new();
        t.cancel();
        tokio::time::timeout(std::time::Duration::from_millis(50), t.cancelled())
            .await
            .expect("no-op cancel");
    }
}
