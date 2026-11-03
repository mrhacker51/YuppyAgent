//! Authorization policy for local tools.

/// What local tool side-effects are permitted this session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalToolPolicy {
    /// Read-only inside workspace. write_file and shell are denied outright.
    ReadOnly,
    /// File writes in the workspace are allowed; shell/external still require
    /// explicit human approval via the engine approval gate.
    WorkspaceWrite,
    /// Everything permitted (only for explicitly trusted sandboxes/tests).
    Full,
}

impl LocalToolPolicy {
    pub fn allow_write(self) -> bool {
        matches!(self, Self::WorkspaceWrite | Self::Full)
    }
    pub fn allow_shell(self) -> bool {
        matches!(self, Self::Full)
    }
}
