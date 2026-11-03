//! YuppyCode HUD: departments and panel-layout state, UI-independent.
//!
//! Two orthogonal persisted models (spec §5/§6):
//! - [`department::DepartmentRegistry`] — user-configurable departments;
//! - [`layout::LayoutModel`] — panel docking/visibility/focus state.
//!
//! Neither depends on any frontend; the TUI (and later the web UI)
//! renders them. Layout and department state persist separately from
//! agent/task state via [`store::HudStore`].

pub mod department;
pub mod dto;
pub mod layout;
pub mod store;

pub use department::{
    AgentAssignment, Department, DepartmentRegistry, DepartmentRole, Permissions,
};
pub use layout::{FloatingPanel, LayoutModel, Panel, PanelKind, Zone};
pub use store::HudStore;
