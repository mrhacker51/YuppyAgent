//! Departments: user-configurable organisational units.
//!
//! Departments are *data*, never hardcoded pages: a stable ID, agents,
//! workspace, tools, permissions, concurrency and panel associations,
//! persisted as JSON and validated when loaded.

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

/// Hard ceiling on a department's parallel-task bound. Departments can be
/// tuned with `yuppy dept conc <id> <n>`; this only stops nonsense values.
pub const MAX_DEPT_CONCURRENCY: usize = 8;

/// Which CLI a department member agent runs. Stored as the adapter's id
/// string so new CLIs can appear without a schema change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAssignment {
    /// Adapter id: "claude-code", "codex", …
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl AgentAssignment {
    pub fn new(cli: impl Into<String>) -> Self {
        Self {
            cli: cli.into(),
            model: None,
        }
    }
}

/// One named sub-agent inside a department. Each role references a real
/// CLI adapter; scheduling one task per role runs them in parallel subject
/// to the department's `max_concurrency` and the orchestrator's global limit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepartmentRole {
    /// Stable slug id, unique within the department.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Adapter id: "claude-code" | "codex".
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl DepartmentRole {
    fn new(id: &str, name: &str, description: &str, cli: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            cli: cli.into(),
            model: None,
            enabled: true,
        }
    }
}

/// Permission knobs interpreted by the orchestrator/adapter layers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Permissions {
    /// High-risk tool calls inside this department require the native
    /// CLI's approval flow (never bypassed).
    #[serde(default = "default_true")]
    pub require_approval: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            require_approval: true,
        }
    }
}

/// One department definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Department {
    /// Stable slug id; referenced by layouts and tasks. Never reused.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Single-character display icon (emoji welcome).
    #[serde(default = "default_icon")]
    pub icon: String,
    #[serde(default)]
    pub agents: Vec<AgentAssignment>,
    /// Named sub-agents/roles schedulable in parallel inside this department.
    #[serde(default)]
    pub roles: Vec<DepartmentRole>,
    /// Workspace root for this department's work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// Tool ids/prefixes the department may use (interpretation is the
    /// executor's job; empty = executor default).
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub permissions: Permissions,
    /// Upper bound on simultaneously running tasks in this department.
    #[serde(default = "default_concurrency")]
    pub max_concurrency: usize,
    /// True once the user set `max_concurrency` on purpose (via
    /// `yuppy dept conc` / the store API). Legacy files predate this flag,
    /// so a stored 1 there means "the old default", not a decision.
    #[serde(default)]
    pub concurrency_explicit: bool,
    /// Disabled departments stay visible but accept no new work.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// HUD panel ids associated with this department.
    #[serde(default)]
    pub panels: Vec<String>,
}

fn default_icon() -> String {
    "▣".into()
}

fn default_concurrency() -> usize {
    1
}

impl Department {
    fn new(id: &str, name: &str, icon: &str, description: &str, agents: &[&str]) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            icon: icon.into(),
            agents: agents.iter().map(|a| AgentAssignment::new(*a)).collect(),
            roles: Vec::new(),
            workspace: None,
            allowed_tools: Vec::new(),
            permissions: Permissions::default(),
            max_concurrency: 1,
            concurrency_explicit: false,
            enabled: true,
            panels: Vec::new(),
        }
    }
}

/// Ordered set of departments + persistence root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepartmentRegistry {
    pub schema_version: u32,
    #[serde(default)]
    pub departments: Vec<Department>,
}

#[derive(Debug, thiserror::Error)]
pub enum DeptError {
    #[error("department id `{0}` already exists")]
    DuplicateId(String),
    #[error("department `{0}` not found")]
    NotFound(String),
    #[error("invalid department data: {0}")]
    Invalid(String),
}

fn default_roles(department: &str) -> Vec<DepartmentRole> {
    use DepartmentRole as R;
    match department {
        "software-development" => vec![
            R::new(
                "backend",
                "Backend Developer",
                "APIs, services, data and Rust/backend code",
                "claude-code",
            ),
            R::new(
                "frontend",
                "Frontend Developer",
                "React/Next.js UI, 3D scene and interaction code",
                "claude-code",
            ),
            R::new(
                "test",
                "Test Engineer",
                "Test authorship and verification",
                "codex",
            ),
        ],
        "youtube-content" => vec![
            R::new(
                "script",
                "Script Writer",
                "Hooks, scripts, outlines and narration",
                "claude-code",
            ),
            R::new(
                "editor",
                "Video Editor",
                "Shot lists, edit plans and media pipeline code",
                "claude-code",
            ),
            R::new(
                "research",
                "Content Researcher",
                "Topic research with source notes",
                "codex",
            ),
        ],
        "research" => vec![
            R::new(
                "web",
                "Web Researcher",
                "Source gathering and fact checking",
                "codex",
            ),
            R::new(
                "code",
                "Code Archaeologist",
                "Repository and dependency investigation",
                "codex",
            ),
            R::new(
                "writer",
                "Technical Writer",
                "Synthesis, notes and documentation",
                "claude-code",
            ),
        ],
        "code-review-testing" => vec![
            R::new(
                "reviewer",
                "Code Reviewer",
                "Correctness, design and maintainability review",
                "claude-code",
            ),
            R::new(
                "test",
                "Test Engineer",
                "Regression tests and verification",
                "codex",
            ),
            R::new(
                "security",
                "Security Auditor",
                "Threat review and unsafe patterns",
                "codex",
            ),
        ],
        "finance" => vec![
            R::new(
                "analyst",
                "Finance Analyst",
                "Cost analysis, budgets and reconciliation scripts",
                "codex",
            ),
            R::new(
                "reporter",
                "Report Writer",
                "Monthly and ad-hoc finance reports",
                "claude-code",
            ),
        ],
        "custom" => vec![
            R::new(
                "backend",
                "Backend Developer",
                "Backend implementation",
                "claude-code",
            ),
            R::new(
                "frontend",
                "Frontend Developer",
                "Frontend implementation",
                "claude-code",
            ),
        ],
        _ => Vec::new(),
    }
}

impl Default for DepartmentRegistry {
    fn default() -> Self {
        let mut departments = vec![
            Department::new(
                "software-development",
                "Software Development",
                "🛠",
                "Feature work, refactors and bug fixes",
                &["claude-code", "codex"],
            ),
            Department::new(
                "code-review-testing",
                "Code Review & Testing",
                "🔍",
                "Reviews, test authorship and verification",
                &["claude-code"],
            ),
            Department::new(
                "research",
                "Research",
                "🔬",
                "Investigation, documentation reading, spike work",
                &["codex"],
            ),
            Department::new(
                "youtube-content",
                "YouTube & Content",
                "🎬",
                "Scripts, outlines and media pipelines",
                &["claude-code"],
            ),
            Department::new(
                "finance",
                "Finance",
                "📈",
                "Bookkeeping scripts and report generation",
                &["codex"],
            ),
            Department::new(
                "custom",
                "Custom Department",
                "✨",
                "Template for your own departments",
                &[],
            ),
        ];
        for department in &mut departments {
            department.roles = default_roles(&department.id);
            // Every built-in department ships with a role team, so its
            // default bound is the team size (capped). A prompt aimed at a
            // department should fan out, not queue behind max_concurrency=1.
            department.max_concurrency = team_size(&department.roles).clamp(1, 3);
        }
        Self {
            schema_version: SCHEMA_VERSION,
            departments,
        }
    }
}

/// Number of schedulable (enabled) roles in a department.
fn team_size(roles: &[DepartmentRole]) -> usize {
    roles.iter().filter(|r| r.enabled).count()
}

impl DepartmentRegistry {
    /// Give every role-less department its built-in role team.
    ///
    /// Role teams landed after `departments.json` first shipped, so files
    /// written before that carry an empty (or absent) `roles` list — which
    /// silently killed every fan-out path (`/build`, missions: one prompt
    /// would open zero agents). Departments are only touched when they have
    /// no roles at all, and their concurrency floor rises to the team size
    /// so the team can actually run at once. Returns how many departments
    /// were filled.
    pub fn backfill_roles(&mut self) -> usize {
        let mut filled = 0;
        for d in &mut self.departments {
            if !d.roles.is_empty() {
                continue;
            }
            let roles = default_roles(&d.id);
            if roles.is_empty() {
                continue;
            }
            let needed = team_size(&roles).clamp(1, 3);
            d.max_concurrency = d.max_concurrency.max(needed).min(MAX_DEPT_CONCURRENCY);
            d.roles = roles;
            filled += 1;
        }
        filled
    }

    /// Departments saved with the old one-at-a-time default cannot fan a
    /// mission out even though they ship a role team. Raise them to the
    /// enabled team size (capped) so a submitted goal actually runs in
    /// parallel. Returns how many departments were raised.
    pub fn ensure_parallel_teams(&mut self) -> usize {
        let mut raised = 0;
        for d in &mut self.departments {
            if d.concurrency_explicit {
                continue;
            }
            let enabled = d.roles.iter().filter(|r| r.enabled).count();
            if enabled >= 2 && d.max_concurrency <= 1 {
                d.max_concurrency = enabled.clamp(2, MAX_DEPT_CONCURRENCY);
                raised += 1;
            }
        }
        raised
    }

    /// Set how many tasks one department may run at once. Values outside
    /// `1..=MAX_DEPT_CONCURRENCY` are clamped; the applied value is
    /// returned so callers can report what actually stuck.
    pub fn set_max_concurrency(&mut self, id: &str, value: usize) -> Result<usize, DeptError> {
        let d = self
            .get_mut(id)
            .ok_or_else(|| DeptError::NotFound(id.into()))?;
        let applied = value.clamp(1, MAX_DEPT_CONCURRENCY);
        d.max_concurrency = applied;
        d.concurrency_explicit = true;
        Ok(applied)
    }

    /// Structural validation. Errors make the file unusable (fall back to
    /// defaults); warnings are reported but tolerated.
    pub fn validate(&self) -> (Vec<String>, Vec<String>) {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        if self.schema_version != SCHEMA_VERSION {
            errors.push(format!(
                "unsupported schema_version {} (expected {})",
                self.schema_version, SCHEMA_VERSION
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for d in &self.departments {
            if d.id.is_empty()
                || !d
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
            {
                errors.push(format!("department id {:?} is not a safe slug", d.id));
            }
            if !seen.insert(&d.id) {
                errors.push(format!("duplicate department id {:?}", d.id));
            }
            if d.name.trim().is_empty() {
                errors.push(format!("department {:?} has no name", d.id));
            }
            if d.max_concurrency == 0 {
                warnings.push(format!(
                    "department {:?} max_concurrency=0 → clamped to 1",
                    d.id
                ));
            }
            for a in &d.agents {
                if a.cli.trim().is_empty() {
                    errors.push(format!(
                        "department {:?} has an agent with empty cli id",
                        d.id
                    ));
                }
                if a.cli != "claude-code" && a.cli != "codex" {
                    warnings.push(format!(
                        "department {:?} references unknown cli {:?}",
                        d.id, a.cli
                    ));
                }
            }
            let mut role_ids = std::collections::HashSet::new();
            for role in &d.roles {
                if role.id.is_empty()
                    || !role.id.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'
                    })
                {
                    errors.push(format!(
                        "department {:?} role {:?} is not a safe slug",
                        d.id, role.id
                    ));
                }
                if !role_ids.insert(&role.id) {
                    errors.push(format!(
                        "department {:?} has duplicate role id {:?}",
                        d.id, role.id
                    ));
                }
                if role.name.trim().is_empty() {
                    errors.push(format!(
                        "department {:?} role {:?} has no name",
                        d.id, role.id
                    ));
                }
                if role.cli != "claude-code" && role.cli != "codex" {
                    warnings.push(format!(
                        "department {:?} role {:?} references unknown cli {:?}",
                        d.id, role.id, role.cli
                    ));
                }
            }
        }
        (errors, warnings)
    }

    pub fn get(&self, id: &str) -> Option<&Department> {
        self.departments.iter().find(|d| d.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Department> {
        self.departments.iter_mut().find(|d| d.id == id)
    }

    pub fn add(&mut self, dept: Department) -> Result<(), DeptError> {
        if self.get(&dept.id).is_some() {
            return Err(DeptError::DuplicateId(dept.id));
        }
        let (errors, _) = {
            let mut probe = self.clone();
            probe.departments.push(dept.clone());
            probe.validate()
        };
        if let Some(e) = errors.first() {
            return Err(DeptError::Invalid(e.clone()));
        }
        self.departments.push(dept);
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Result<Department, DeptError> {
        let i = self
            .departments
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| DeptError::NotFound(id.into()))?;
        Ok(self.departments.remove(i))
    }

    /// Clone a department under a fresh id with a new display name.
    pub fn clone_as(&mut self, id: &str, new_id: &str, new_name: &str) -> Result<(), DeptError> {
        let mut d = self
            .get(id)
            .ok_or_else(|| DeptError::NotFound(id.into()))?
            .clone();
        d.id = new_id.into();
        d.name = new_name.into();
        self.add(d)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), DeptError> {
        let d = self
            .get_mut(id)
            .ok_or_else(|| DeptError::NotFound(id.into()))?;
        d.enabled = enabled;
        Ok(())
    }

    /// Reorder: move department `id` to index `to` (clamped).
    pub fn reorder(&mut self, id: &str, to: usize) -> Result<(), DeptError> {
        let from = self
            .departments
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| DeptError::NotFound(id.into()))?;
        let to = to.min(self.departments.len() - 1);
        let d = self.departments.remove(from);
        self.departments.insert(to, d);
        Ok(())
    }

    pub fn enabled(&self) -> impl Iterator<Item = &Department> {
        self.departments.iter().filter(|d| d.enabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_cover_the_six_spec_departments() {
        let r = DepartmentRegistry::default();
        let ids: Vec<&str> = r.departments.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "software-development",
                "code-review-testing",
                "research",
                "youtube-content",
                "finance",
                "custom"
            ]
        );
        let (errors, _) = r.validate();
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn built_in_departments_default_to_their_team_size() {
        let r = DepartmentRegistry::default();
        // A department with a three-role team must be able to run it at once.
        for id in ["software-development", "code-review-testing", "research"] {
            let d = r.get(id).unwrap();
            assert_eq!(team_size(&d.roles), 3, "{id} team");
            assert_eq!(d.max_concurrency, 3, "{id} concurrency");
        }
        let d = r.get("finance").unwrap();
        assert_eq!((team_size(&d.roles), d.max_concurrency), (2, 2));
    }

    #[test]
    fn ensure_parallel_teams_raises_stale_one_at_a_time_defaults() {
        let mut r = DepartmentRegistry::default();
        // The file an early build wrote: role teams present, but the old
        // one-at-a-time bound and no explicit-choice flag.
        for d in &mut r.departments {
            d.max_concurrency = 1;
            d.concurrency_explicit = false;
        }
        assert_eq!(r.ensure_parallel_teams(), 6);
        assert_eq!(
            r.get("software-development").unwrap().max_concurrency,
            3,
            "a three-role team must run at once"
        );
        assert_eq!(r.get("finance").unwrap().max_concurrency, 2);
        // Idempotent once raised.
        assert_eq!(r.ensure_parallel_teams(), 0);
    }

    #[test]
    fn ensure_parallel_teams_respects_an_explicit_bound() {
        let mut r = DepartmentRegistry::default();
        r.set_max_concurrency("research", 1).unwrap();
        assert!(r.get("research").unwrap().concurrency_explicit);
        assert_eq!(r.ensure_parallel_teams(), 0);
        assert_eq!(r.get("research").unwrap().max_concurrency, 1);
    }

    #[test]
    fn backfill_roles_fills_only_role_less_departments() {
        let mut r = DepartmentRegistry::default();
        // Simulate a pre-roles file: no roles anywhere, concurrency 1.
        for d in &mut r.departments {
            d.roles.clear();
            d.max_concurrency = 1;
        }
        assert_eq!(r.backfill_roles(), 6, "every built-in has a team");
        assert_eq!(r.get("research").unwrap().roles.len(), 3);
        // Concurrency rose to the team size so the fan-out is really parallel.
        assert_eq!(r.get("research").unwrap().max_concurrency, 3);
        assert_eq!(r.get("custom").unwrap().max_concurrency, 2);
        // A department the user created keeps its empty team and its bound.
        r.add(Department::new(
            "ops",
            "Ops",
            "\u{2699}",
            "infra",
            &["codex"],
        ))
        .unwrap();
        assert_eq!(r.backfill_roles(), 0);
        assert_eq!(r.get("ops").unwrap().max_concurrency, 1);
        assert!(r.get("ops").unwrap().roles.is_empty());

        // Explicit choices are respected: a department with roles and a
        // deliberate bound of 1 is left exactly as it was.
        let mut r2 = DepartmentRegistry::default();
        r2.get_mut("research").unwrap().max_concurrency = 1;
        assert_eq!(r2.backfill_roles(), 0);
        assert_eq!(r2.get("research").unwrap().max_concurrency, 1);
    }

    #[test]
    fn set_max_concurrency_clamps_and_validates() {
        let mut r = DepartmentRegistry::default();
        assert_eq!(r.set_max_concurrency("research", 4).unwrap(), 4);
        assert_eq!(r.get("research").unwrap().max_concurrency, 4);
        assert_eq!(r.set_max_concurrency("research", 0).unwrap(), 1);
        assert_eq!(
            r.set_max_concurrency("research", 99).unwrap(),
            MAX_DEPT_CONCURRENCY
        );
        assert!(matches!(
            r.set_max_concurrency("nope", 2),
            Err(DeptError::NotFound(_))
        ));
    }

    #[test]
    fn crud_and_clone_and_reorder() {
        let mut r = DepartmentRegistry::default();
        let mut d = Department::new("ops", "Ops", "⚙", "infra", &["codex"]);
        d.max_concurrency = 3;
        r.add(d).unwrap();
        assert_eq!(r.get("ops").unwrap().max_concurrency, 3);
        assert!(matches!(
            r.add(Department::new("ops", "dup", "", "", &[])),
            Err(DeptError::DuplicateId(_))
        ));
        r.clone_as("research", "research2", "Research II").unwrap();
        assert!(r.get("research2").is_some());
        r.set_enabled("research2", false).unwrap();
        assert!(!r.get("research2").unwrap().enabled);
        assert!(!r.enabled().any(|d| d.id == "research2"));
        r.reorder("ops", 0).unwrap();
        assert_eq!(r.departments[0].id, "ops");
        r.remove("ops").unwrap();
        assert!(matches!(r.remove("ops"), Err(DeptError::NotFound(_))));
    }

    #[test]
    fn validation_rejects_duplicate_ids_and_bad_schema() {
        let mut r = DepartmentRegistry::default();
        let mut dup = r.departments[0].clone();
        dup.name = "dup".into();
        r.departments.push(dup);
        let (errors, _) = r.validate();
        assert!(errors.iter().any(|e| e.contains("duplicate")));

        let bad = DepartmentRegistry {
            schema_version: 99,
            ..DepartmentRegistry::default()
        };
        let (errors, _) = bad.validate();
        assert!(errors.iter().any(|e| e.contains("schema_version")));
    }

    #[test]
    fn unknown_cli_is_a_warning_not_an_error() {
        let mut r = DepartmentRegistry::default();
        r.add(Department::new("future", "Future", "🚀", "", &["aider"]))
            .unwrap();
        let (errors, warnings) = r.validate();
        assert!(errors.is_empty());
        assert!(warnings.iter().any(|w| w.contains("aider")));
    }
}
