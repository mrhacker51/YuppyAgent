//! Translations from the persisted HUD models to wire DTOs, so a
//! future transport bridge can emit `ServerPayload`s without knowing
//! anything about the HUD crate internals.

use crate::department::Department;
use crate::layout::{LayoutModel, Zone};
use yuppycode_protocol::{DepartmentDto, DeptAgentDto, FloatingPanelDto, LayoutDto, PanelDto};

pub fn department_dto(d: &Department) -> DepartmentDto {
    DepartmentDto {
        id: d.id.clone(),
        name: d.name.clone(),
        description: d.description.clone(),
        icon: d.icon.clone(),
        agents: d
            .agents
            .iter()
            .map(|a| DeptAgentDto {
                cli: a.cli.clone(),
                model: a.model.clone(),
            })
            .collect(),
        roles: d
            .roles
            .iter()
            .map(|r| yuppycode_protocol::DepartmentRoleDto {
                id: r.id.clone(),
                name: r.name.clone(),
                description: r.description.clone(),
                cli: r.cli.clone(),
                model: r.model.clone(),
                enabled: r.enabled,
            })
            .collect(),
        workspace: d.workspace.clone(),
        allowed_tools: d.allowed_tools.clone(),
        max_concurrency: d.max_concurrency,
        enabled: d.enabled,
        panels: d.panels.clone(),
    }
}

pub fn layout_dto(l: &LayoutModel) -> LayoutDto {
    LayoutDto {
        panels: l
            .panels
            .iter()
            .map(|p| PanelDto {
                id: p.id.clone(),
                kind: kind_str(&p.kind),
                title: p.title.clone(),
                zone: match p.zone {
                    Zone::Left => "left",
                    Zone::Center => "center",
                    Zone::Right => "right",
                }
                .to_string(),
                order: p.order,
                visible: p.visible,
                collapsed: p.collapsed,
                maximized: p.maximized,
                z: p.z,
                department: p.department.clone(),
            })
            .collect(),
        focused: l.focused.clone(),
        active_department: l.active_department.clone(),
        floating: l
            .floating
            .iter()
            .map(|f| FloatingPanelDto {
                id: f.id.clone(),
                x: f.x,
                y: f.y,
                z: f.z,
                scale: f.scale,
                width: f.width,
                height: f.height,
                visible: f.visible,
                pinned: f.pinned,
                minimized: f.minimized,
                z_order: f.z_order,
            })
            .collect(),
    }
}

fn kind_str(k: &crate::layout::PanelKind) -> String {
    use crate::layout::PanelKind as K;
    match k {
        K::DepartmentNavigator => "department_navigator",
        K::ActiveProjects => "active_projects",
        K::AgentRegistry => "agent_registry",
        K::TaskQueue => "task_queue",
        K::GitStatus => "git_status",
        K::AgentNetwork => "agent_network",
        K::TaskExecutionTree => "task_execution_tree",
        K::SystemMonitor => "system_monitor",
        K::LiveLogs => "live_logs",
        K::TokenThroughput => "token_throughput",
        K::ApprovalRequests => "approval_requests",
        K::TerminalWorkspace => "terminal_workspace",
        K::EngineOutput => "engine_output",
        K::Custom(s) => return s.clone(),
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_translate_to_wire_dtos() {
        let d = crate::department::DepartmentRegistry::default();
        let dto = department_dto(&d.departments[0]);
        assert_eq!(dto.id, "software-development");
        assert_eq!(dto.agents[0].cli, "claude-code");

        let l = LayoutModel::default();
        let ldt = layout_dto(&l);
        assert_eq!(ldt.panels.len(), 11);
        assert_eq!(ldt.focused.as_deref(), Some("engine-out"));
        assert!(ldt.floating.is_empty());
        let json = serde_json::to_string(&ldt).unwrap();
        assert!(json.contains("terminal_workspace"));
    }
}
