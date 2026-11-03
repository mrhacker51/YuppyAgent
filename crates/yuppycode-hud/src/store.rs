//! JSON persistence with validation-on-load and safe fallbacks.
//!
//! Files (under `$YUPPY_CONFIG_DIR` or the OS config dir):
//! - `yuppycode/departments.json` — department registry
//! - `yuppycode/layout.json`      — current HUD layout
//! - `yuppycode/layouts/<name>.json` — named saved layouts
//!
//! Layout state is persisted separately from any agent/task state
//! (spec §6). Corrupt or invalid files never crash: callers get the
//! default plus a warning string.

use std::path::{Path, PathBuf};

use crate::department::DepartmentRegistry;
#[cfg(test)]
use crate::department::SCHEMA_VERSION;
use crate::layout::LayoutModel;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid data: {0}")]
    Invalid(String),
}

/// Root config directory honoring `YUPPY_CONFIG_DIR` (tests, portable
/// installs) and the OS default otherwise.
pub fn config_root() -> PathBuf {
    if let Ok(dir) = std::env::var("YUPPY_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("yuppycode")
}

pub struct HudStore {
    root: PathBuf,
}

/// Outcome of a load that had to recover: default plus reason.
pub struct Loaded<T> {
    pub value: T,
    /// `Some` when the persisted file was missing-but-created, or was
    /// invalid and the default was used instead.
    pub warning: Option<String>,
}

impl HudStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn from_env() -> Self {
        Self::new(config_root())
    }

    fn departments_path(&self) -> PathBuf {
        self.root.join("departments.json")
    }
    fn layout_path(&self) -> PathBuf {
        self.root.join("layout.json")
    }
    fn named_dir(&self) -> PathBuf {
        self.root.join("layouts")
    }

    // ---- departments -------------------------------------------------

    /// Load departments; missing file seeds and persists the defaults.
    /// Invalid files (schema/duplicate ids) fall back to defaults with a
    /// warning and are left on disk untouched for the user to inspect.
    pub fn load_departments(&self) -> Result<Loaded<DepartmentRegistry>, StoreError> {
        match std::fs::read(self.departments_path()) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let reg = DepartmentRegistry::default();
                self.save_departments(&reg)?;
                Ok(Loaded {
                    value: reg,
                    warning: Some("no departments file; created defaults".into()),
                })
            }
            Err(e) => Err(StoreError::Io(e)),
            Ok(bytes) => {
                match serde_json::from_str::<DepartmentRegistry>(&String::from_utf8_lossy(&bytes)) {
                    Ok(reg) => {
                        let (errors, warnings) = reg.validate();
                        if !errors.is_empty() {
                            Ok(Loaded {
                                value: DepartmentRegistry::default(),
                                warning: Some(format!(
                                    "departments file invalid ({}); using defaults",
                                    errors.join("; ")
                                )),
                            })
                        } else {
                            // Role teams post-date the first departments
                            // file; refill them so fan-out works, and say
                            // so out loud instead of failing silently.
                            let mut reg = reg;
                            let filled = reg.backfill_roles();
                            let raised = reg.ensure_parallel_teams();
                            let warning = match (warnings.first(), filled, raised) {
                                (None, 0, 0) => None,
                                (w, n, r) => {
                                    let mut parts = Vec::new();
                                    if n > 0 {
                                        parts.push(format!(
                                            "added the built-in role team to {n} department(s) and raised their max_concurrency to the team size"
                                        ));
                                    }
                                    if r > 0 {
                                        parts.push(format!(
                                            "raised max_concurrency to the team size on {r} department(s)"
                                        ));
                                    }
                                    parts.push(
                                        "override with: yuppy dept conc <id> <n>".to_string(),
                                    );
                                    let note = parts.join(", ");
                                    Some(match w {
                                        Some(w) => format!("departments: {w}; {note}"),
                                        None => format!("departments: {note}"),
                                    })
                                }
                            };
                            if filled > 0 || raised > 0 {
                                // Persist the one-time migration so the
                                // next start does not repeat the notice.
                                // The role teams matter: without them a
                                // department has no CLI to launch a box
                                // with.
                                let _ = self.save_departments(&reg);
                            }
                            Ok(Loaded {
                                value: reg,
                                warning,
                            })
                        }
                    }
                    Err(e) => Ok(Loaded {
                        value: DepartmentRegistry::default(),
                        warning: Some(format!("departments file unreadable ({e}); using defaults")),
                    }),
                }
            }
        }
    }

    pub fn save_departments(&self, reg: &DepartmentRegistry) -> Result<(), StoreError> {
        let (errors, _) = reg.validate();
        if let Some(e) = errors.first() {
            return Err(StoreError::Invalid(e.clone()));
        }
        write_json(&self.departments_path(), reg)
    }

    // ---- layout -------------------------------------------------------

    /// Load the current layout; invalid/absent → default.
    pub fn load_layout(&self) -> Result<Loaded<LayoutModel>, StoreError> {
        match std::fs::read(self.layout_path()) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Loaded {
                value: LayoutModel::default(),
                warning: None,
            }),
            Err(e) => Err(StoreError::Io(e)),
            Ok(bytes) => {
                match serde_json::from_str::<LayoutModel>(&String::from_utf8_lossy(&bytes)) {
                    Ok(l) if l.validate().is_empty() => Ok(Loaded {
                        value: l,
                        warning: None,
                    }),
                    Ok(l) => Ok(Loaded {
                        value: LayoutModel::default(),
                        warning: Some(format!(
                            "layout invalid ({}); using default",
                            l.validate().join("; ")
                        )),
                    }),
                    Err(e) => Ok(Loaded {
                        value: LayoutModel::default(),
                        warning: Some(format!("layout unreadable ({e}); using default")),
                    }),
                }
            }
        }
    }

    pub fn save_layout(&self, layout: &LayoutModel) -> Result<(), StoreError> {
        let errors = layout.validate();
        if let Some(e) = errors.first() {
            return Err(StoreError::Invalid(e.clone()));
        }
        write_json(&self.layout_path(), layout)
    }

    // ---- named layouts -------------------------------------------------

    pub fn save_named_layout(&self, name: &str, layout: &LayoutModel) -> Result<(), StoreError> {
        validate_name(name)?;
        let errors = layout.validate();
        if let Some(e) = errors.first() {
            return Err(StoreError::Invalid(e.clone()));
        }
        write_json(&self.named_dir().join(format!("{name}.json")), layout)
    }

    pub fn load_named_layout(&self, name: &str) -> Result<LayoutModel, StoreError> {
        validate_name(name)?;
        let bytes = std::fs::read(self.named_dir().join(format!("{name}.json")))?;
        let l: LayoutModel = serde_json::from_str(&String::from_utf8_lossy(&bytes))?;
        if let Some(e) = l.validate().first() {
            return Err(StoreError::Invalid(e.clone()));
        }
        Ok(l)
    }

    pub fn list_named_layouts(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.named_dir()) {
            for entry in rd.flatten() {
                if entry.path().extension().is_some_and(|e| e == "json") {
                    if let Some(stem) = entry.path().file_stem() {
                        out.push(stem.to_string_lossy().to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }
}

/// Named layouts are file names: keep them boring.
fn validate_name(name: &str) -> Result<(), StoreError> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "layout name {name:?} must be [A-Za-z0-9_-]{{1,64}}"
        )))
    }
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Write-then-rename so a crash cannot leave a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(tag: &str) -> HudStore {
        let dir = std::env::temp_dir().join(format!("yuppy-hud-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        HudStore::new(dir)
    }

    #[test]
    fn departments_seed_on_first_load_and_round_trip() {
        let s = tmp_store("seed");
        let loaded = s.load_departments().unwrap();
        assert!(loaded.warning.is_some());
        assert_eq!(loaded.value.departments.len(), 6);
        // Second load reads what was written.
        let mut reg = loaded.value.clone();
        reg.set_enabled("finance", false).unwrap();
        s.save_departments(&reg).unwrap();
        let again = s.load_departments().unwrap();
        assert!(again.warning.is_none());
        assert!(!again.value.get("finance").unwrap().enabled);
        let _ = std::fs::remove_dir_all(s.root);
    }

    #[test]
    fn stored_role_teams_with_the_old_bound_are_raised_and_persisted() {
        let s = tmp_store("stale-conc");
        std::fs::create_dir_all(&s.root).unwrap();
        let mut reg = DepartmentRegistry::default();
        // A file written by an early build: roles exist, but every
        // department is stuck at the old one-at-a-time default.
        for d in &mut reg.departments {
            d.max_concurrency = 1;
            d.concurrency_explicit = false;
        }
        std::fs::write(s.departments_path(), serde_json::to_string(&reg).unwrap()).unwrap();
        let loaded = s.load_departments().unwrap();
        assert_eq!(
            loaded
                .value
                .get("software-development")
                .unwrap()
                .max_concurrency,
            3
        );
        assert!(
            loaded
                .warning
                .as_deref()
                .unwrap()
                .contains("raised max_concurrency"),
            "{:?}",
            loaded.warning
        );
        // The migration is persisted: the next start has nothing to do.
        let again = s.load_departments().unwrap();
        assert!(again.warning.is_none(), "{:?}", again.warning);
        assert_eq!(
            again
                .value
                .get("software-development")
                .unwrap()
                .max_concurrency,
            3
        );
        let _ = std::fs::remove_dir_all(s.root);
    }

    #[test]
    fn legacy_files_get_their_role_teams_backfilled() {
        // A departments.json written before role teams existed: no `roles`
        // key, max_concurrency 1. Loading it must restore the teams and
        // announce it, otherwise every fan-out path fails with "no roles".
        let s = tmp_store("legacy");
        std::fs::create_dir_all(&s.root).unwrap();
        std::fs::write(
            s.departments_path(),
            r#"{"schema_version":1,"departments":[{"id":"research","name":"Research","max_concurrency":1,"enabled":true}]}"#,
        )
        .unwrap();
        let loaded = s.load_departments().unwrap();
        let research = loaded.value.get("research").unwrap();
        assert_eq!(research.roles.len(), 3);
        assert_eq!(research.max_concurrency, 3);
        assert!(
            loaded
                .warning
                .as_deref()
                .unwrap()
                .contains("max_concurrency to the team size"),
            "{:?}",
            loaded.warning
        );
        // The fill is written back: a department with no roles has no CLI
        // to open a box with, so leaving the file role-less would make the
        // deck empty on every start. The migration is one-shot.
        assert!(
            std::fs::read_to_string(s.departments_path())
                .unwrap()
                .contains("roles")
        );
        let again = s.load_departments().unwrap();
        assert!(again.warning.is_none(), "{:?}", again.warning);
        assert_eq!(again.value.get("research").unwrap().roles.len(), 3);
        let _ = std::fs::remove_dir_all(s.root);
    }

    #[test]
    fn corrupt_departments_fall_back_to_defaults() {
        let s = tmp_store("corrupt");
        std::fs::create_dir_all(&s.root).unwrap();
        std::fs::write(s.departments_path(), "{ not json").unwrap();
        let loaded = s.load_departments().unwrap();
        assert_eq!(loaded.value.departments.len(), 6);
        assert!(loaded.warning.unwrap().contains("unreadable"));
        let _ = std::fs::remove_dir_all(s.root);
    }

    #[test]
    fn invalid_departments_schema_fall_back() {
        let s = tmp_store("schema");
        std::fs::create_dir_all(&s.root).unwrap();
        let bad = DepartmentRegistry {
            schema_version: SCHEMA_VERSION + 7,
            ..DepartmentRegistry::default()
        };
        s.save_departments(&bad).unwrap_err(); // refuses to save invalid
        std::fs::write(s.departments_path(), serde_json::to_string(&bad).unwrap()).unwrap();
        let loaded = s.load_departments().unwrap();
        assert_eq!(loaded.value, DepartmentRegistry::default());
        assert!(loaded.warning.unwrap().contains("schema_version"));
        let _ = std::fs::remove_dir_all(s.root);
    }

    #[test]
    fn layout_round_trips_and_falls_back_on_garbage() {
        let s = tmp_store("layout");
        let mut l = LayoutModel {
            active_department: Some("research".into()),
            ..LayoutModel::default()
        };
        l.maximize("terminal").unwrap();
        s.save_layout(&l).unwrap();
        let back = s.load_layout().unwrap();
        assert_eq!(back.value, l);
        std::fs::write(s.layout_path(), "[]").unwrap();
        let back = s.load_layout().unwrap();
        assert_eq!(back.value, LayoutModel::default());
        assert!(back.warning.is_some());
        let _ = std::fs::remove_dir_all(s.root);
    }

    #[test]
    fn named_layouts_save_load_list_and_reject_evil_names() {
        let s = tmp_store("named");
        let l = LayoutModel::default();
        s.save_named_layout("work-day", &l).unwrap();
        assert_eq!(s.list_named_layouts(), vec!["work-day".to_string()]);
        let back = s.load_named_layout("work-day").unwrap();
        assert_eq!(back, l);
        assert!(s.save_named_layout("../escape", &l).is_err());
        assert!(s.load_named_layout("").is_err());
        let _ = std::fs::remove_dir_all(s.root);
    }
}
