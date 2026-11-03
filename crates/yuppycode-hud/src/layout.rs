//! HUD layout model: framework-independent panel state.
//!
//! No widget types, no geometry in pixels — panels live in docking zones
//! with order, visibility, collapse/maximize state, z-order and focus.
//! Renderers decide what that means on screen. Persisted independently
//! from agent/task state (spec §6).

use serde::{Deserialize, Serialize};

pub const LAYOUT_SCHEMA_VERSION: u32 = 1;

/// Suggested default panel kinds (spec §1). Not an exhaustive list —
/// unknown kinds deserialize as `Custom` so future panels do not break
/// old binaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelKind {
    DepartmentNavigator,
    ActiveProjects,
    AgentRegistry,
    TaskQueue,
    GitStatus,
    AgentNetwork,
    TaskExecutionTree,
    SystemMonitor,
    LiveLogs,
    TokenThroughput,
    ApprovalRequests,
    TerminalWorkspace,
    EngineOutput,
    Custom(String),
}

impl PanelKind {
    pub fn default_title(&self) -> &'static str {
        match self {
            PanelKind::DepartmentNavigator => "Departments",
            PanelKind::ActiveProjects => "Projects",
            PanelKind::AgentRegistry => "Agents",
            PanelKind::TaskQueue => "Task Queue",
            PanelKind::GitStatus => "Git Status",
            PanelKind::AgentNetwork => "Agent Network",
            PanelKind::TaskExecutionTree => "Task Tree",
            PanelKind::SystemMonitor => "System Monitor",
            PanelKind::LiveLogs => "Live Logs",
            PanelKind::TokenThroughput => "Tokens",
            PanelKind::ApprovalRequests => "Approvals",
            PanelKind::TerminalWorkspace => "Terminal",
            PanelKind::EngineOutput => "Output",
            PanelKind::Custom(_) => "Panel",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Zone {
    Left,
    Right,
    Center,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Panel {
    /// Stable id, unique within a layout.
    pub id: String,
    pub kind: PanelKind,
    #[serde(default)]
    pub title: String,
    pub zone: Zone,
    /// Order within its zone, ascending.
    #[serde(default)]
    pub order: u32,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub maximized: bool,
    /// Stacking order where the renderer needs one.
    #[serde(default)]
    pub z: i32,
    /// Optional association with a department id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub department: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Panel {
    fn new(id: &str, kind: PanelKind, zone: Zone, order: u32) -> Self {
        Self {
            id: id.into(),
            title: kind.default_title().to_string(),
            kind,
            zone,
            order,
            visible: true,
            collapsed: false,
            maximized: false,
            z: 0,
            department: None,
        }
    }
}

/// Free-floating geometry used by spatial renderers (the 3D web HUD).
///
/// This is intentionally separate from the zone-based [`Panel`] model so the
/// terminal UI keeps its deterministic docking layout while the web renderer
/// can persist world-space positions, sizes and stacking order. Coordinates
/// are renderer-defined (world units for the current Three.js frontend).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FloatingPanel {
    pub id: String,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub z: f32,
    #[serde(default = "default_scale")]
    pub scale: f32,
    #[serde(default = "default_width")]
    pub width: f32,
    #[serde(default = "default_height")]
    pub height: f32,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub minimized: bool,
    #[serde(default)]
    pub z_order: i32,
}

fn default_scale() -> f32 {
    1.0
}
fn default_width() -> f32 {
    320.0
}
fn default_height() -> f32 {
    300.0
}

/// The full HUD state: panels, focus and the active department.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutModel {
    pub schema_version: u32,
    #[serde(default)]
    pub panels: Vec<Panel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_department: Option<String>,
    /// Optional floating geometry for spatial renderers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub floating: Vec<FloatingPanel>,
}

#[derive(Debug, thiserror::Error)]
pub enum LayoutError {
    #[error("invalid layout: {0}")]
    Invalid(String),
    #[error("panel `{0}` not found")]
    NotFound(String),
}

impl Default for LayoutModel {
    /// The suggested default panel arrangement (spec §1), left zone:
    /// departments/projects/agents/tasks/git; right zone: terminal,
    /// task tree, logs, tokens, approvals; center: engine output.
    fn default() -> Self {
        let mut panels = vec![
            Panel::new("dept-nav", PanelKind::DepartmentNavigator, Zone::Left, 0),
            Panel::new("projects", PanelKind::ActiveProjects, Zone::Left, 1),
            Panel::new("agents", PanelKind::AgentRegistry, Zone::Left, 2),
            Panel::new("task-queue", PanelKind::TaskQueue, Zone::Left, 3),
            Panel::new("git-status", PanelKind::GitStatus, Zone::Left, 4),
            Panel::new("terminal", PanelKind::TerminalWorkspace, Zone::Center, 0),
            Panel::new("engine-out", PanelKind::EngineOutput, Zone::Center, 1),
            Panel::new("task-tree", PanelKind::TaskExecutionTree, Zone::Right, 0),
            Panel::new("logs", PanelKind::LiveLogs, Zone::Right, 1),
            Panel::new("tokens", PanelKind::TokenThroughput, Zone::Right, 2),
            Panel::new("approvals", PanelKind::ApprovalRequests, Zone::Right, 3),
        ];
        // The terminal panel starts hidden in the TUI (no sessions exist
        // until opened), but full-width once shown.
        let term = panels.iter_mut().find(|p| p.id == "terminal").unwrap();
        term.visible = false;
        term.maximized = true;
        Self {
            schema_version: LAYOUT_SCHEMA_VERSION,
            panels,
            focused: Some("engine-out".into()),
            active_department: None,
            floating: Vec::new(),
        }
    }
}

impl LayoutModel {
    pub fn get(&self, id: &str) -> Option<&Panel> {
        self.panels.iter().find(|p| p.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Result<&mut Panel, LayoutError> {
        self.panels
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| LayoutError::NotFound(id.into()))
    }

    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if self.schema_version != LAYOUT_SCHEMA_VERSION {
            errors.push(format!(
                "unsupported layout schema_version {} (expected {})",
                self.schema_version, LAYOUT_SCHEMA_VERSION
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for p in &self.panels {
            if p.id.is_empty() {
                errors.push("panel with empty id".into());
            } else if !seen.insert(&p.id) {
                errors.push(format!("duplicate panel id {:?}", p.id));
            }
        }
        if let Some(f) = &self.focused {
            if self.get(f).is_none() {
                errors.push(format!("focused panel {f:?} does not exist"));
            }
        }
        let mut floating_seen = std::collections::HashSet::new();
        for f in &self.floating {
            if f.id.is_empty() {
                errors.push("floating panel with empty id".into());
            } else if !floating_seen.insert(&f.id) {
                errors.push(format!("duplicate floating panel id {:?}", f.id));
            }
            if !f.x.is_finite()
                || !f.y.is_finite()
                || !f.z.is_finite()
                || !f.scale.is_finite()
                || !f.width.is_finite()
                || !f.height.is_finite()
            {
                errors.push(format!(
                    "floating panel {:?} contains non-finite geometry",
                    f.id
                ));
            } else if f.scale <= 0.0 || f.width <= 0.0 || f.height <= 0.0 {
                errors.push(format!(
                    "floating panel {:?} must have positive scale/width/height",
                    f.id
                ));
            }
        }
        errors
    }

    /// Panel ids eligible for keyboard focus, ordered by
    /// zone (Left, Center, Right) then order then z.
    pub fn focus_order(&self) -> Vec<String> {
        let mut vis: Vec<&Panel> = self.panels.iter().filter(|p| p.visible).collect();
        vis.sort_by_key(|p| (zone_rank(p.zone), p.order, p.z));
        vis.into_iter().map(|p| p.id.clone()).collect()
    }

    /// Tab / Shift+Tab: cycle focus among visible panels.
    pub fn cycle_focus(&mut self, backwards: bool) {
        let order = self.focus_order();
        if order.is_empty() {
            self.focused = None;
            return;
        }
        let pos = self
            .focused
            .as_ref()
            .and_then(|f| order.iter().position(|id| id == f))
            .unwrap_or(usize::MAX);
        let next = if backwards {
            match pos {
                usize::MAX => order.len() - 1,
                0 => order.len() - 1,
                i => i - 1,
            }
        } else if pos == usize::MAX {
            0
        } else {
            (pos + 1) % order.len()
        };
        self.focused = Some(order[next].clone());
    }

    /// Alt+Left/Right on the focused panel: dock to a zone (keeps a
    /// stable order at the end of that zone).
    pub fn dock_focused(&mut self, zone: Zone) -> Result<(), LayoutError> {
        let Some(f) = self.focused.clone() else {
            return Err(LayoutError::Invalid("no focused panel".into()));
        };
        let next_order = self
            .panels
            .iter()
            .filter(|p| p.zone == zone)
            .map(|p| p.order + 1)
            .max()
            .unwrap_or(0);
        let p = self.get_mut(&f)?;
        p.zone = zone;
        p.order = next_order;
        Ok(())
    }

    /// Maximize one visible panel (clears others' maximized flags).
    pub fn maximize(&mut self, id: &str) -> Result<(), LayoutError> {
        for p in &mut self.panels {
            p.maximized = false;
        }
        self.get_mut(id)?.maximized = true;
        Ok(())
    }

    pub fn toggle_visible(&mut self, id: &str) -> Result<bool, LayoutError> {
        let visible;
        {
            let p = self.get_mut(id)?;
            p.visible = !p.visible;
            if !p.visible {
                p.maximized = false;
            }
            visible = p.visible;
        }
        if !visible && self.focused.as_deref() == Some(id) {
            self.focused = None;
        }
        Ok(visible)
    }

    pub fn toggle_collapsed(&mut self, id: &str) -> Result<(), LayoutError> {
        let p = self.get_mut(id)?;
        p.collapsed = !p.collapsed;
        Ok(())
    }

    pub fn set_z(&mut self, id: &str, z: i32) -> Result<(), LayoutError> {
        self.get_mut(id)?.z = z;
        Ok(())
    }
}

fn zone_rank(z: Zone) -> u8 {
    match z {
        Zone::Left => 0,
        Zone::Center => 1,
        Zone::Right => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_layout_matches_the_suggested_zones() {
        let l = LayoutModel::default();
        assert!(l.validate().is_empty());
        assert_eq!(l.panels.iter().filter(|p| p.zone == Zone::Left).count(), 5);
        assert_eq!(l.panels.iter().filter(|p| p.zone == Zone::Right).count(), 4);
        let term = l.get("terminal").unwrap();
        assert_eq!(term.kind, PanelKind::TerminalWorkspace);
        assert!(
            !term.visible,
            "terminal starts hidden until a session opens"
        );
    }

    #[test]
    fn focus_cycles_visible_panels_only() {
        let mut l = LayoutModel::default();
        let visible = l.focus_order().len();
        assert_eq!(visible, 10); // 11 panels - hidden terminal
        let start = l.focused.clone(); // engine-out
        l.cycle_focus(false);
        let after_fwd = l.focused.clone();
        assert_ne!(after_fwd, start);
        assert_ne!(after_fwd.as_deref(), Some("terminal"));
        l.cycle_focus(true);
        assert_eq!(l.focused, start);
    }

    #[test]
    fn cycle_visits_every_visible_panel() {
        let mut l = LayoutModel::default();
        let order = l.focus_order();
        l.focused = None;
        let mut visited = vec![];
        for _ in 0..order.len() {
            l.cycle_focus(false);
            visited.push(l.focused.clone().unwrap());
        }
        visited.dedup();
        assert_eq!(visited.len(), order.len());
    }

    #[test]
    fn dock_moves_focused_panel_to_zone_end() {
        let mut l = LayoutModel {
            focused: Some("engine-out".into()),
            ..LayoutModel::default()
        };
        l.dock_focused(Zone::Right).unwrap();
        let p = l.get("engine-out").unwrap();
        assert_eq!(p.zone, Zone::Right);
        assert_eq!(p.order, 4); // after logs/tokens/approvals tree
    }

    #[test]
    fn maximize_is_exclusive() {
        let mut l = LayoutModel::default();
        l.maximize("terminal").unwrap();
        l.maximize("task-tree").unwrap();
        assert!(l.get("task-tree").unwrap().maximized);
        assert!(!l.get("terminal").unwrap().maximized);
    }

    #[test]
    fn hiding_a_focused_panel_clears_focus() {
        let mut l = LayoutModel {
            focused: Some("logs".into()),
            ..LayoutModel::default()
        };
        l.toggle_visible("logs").unwrap();
        assert_eq!(l.focused, None);
    }

    #[test]
    fn validation_flags_duplicate_ids_and_dangling_focus() {
        let mut l = LayoutModel::default();
        l.panels.push(l.panels[0].clone());
        assert!(l.validate().iter().any(|e| e.contains("duplicate")));
        let l2 = LayoutModel {
            focused: Some("ghost".into()),
            ..LayoutModel::default()
        };
        assert!(l2.validate().iter().any(|e| e.contains("ghost")));
    }

    #[test]
    fn custom_kind_round_trips_and_serializes_snake_case() {
        let l = LayoutModel::default();
        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains("\"zone\":\"left\""));
        assert!(json.contains("\"kind\":\"department_navigator\""));
        let back: LayoutModel = serde_json::from_str(&json).unwrap();
        assert_eq!(back, l);
    }
}
