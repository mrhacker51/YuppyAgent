use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("engine is busy with run {0}; cancel it first")]
    Busy(String),
    #[error("provider error: {0}")]
    Provider(#[from] crate::provider::ProviderError),
    #[error("tool error: {0}")]
    Tool(#[from] crate::tools::ToolError),
    #[error("memory error: {0}")]
    Memory(String),
    #[error("run cancelled")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}
