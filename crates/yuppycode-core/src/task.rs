//! Hierarchical task model: nodes, statuses and a small graph store.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::ids::TaskId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    WaitingApproval,
    Success,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TaskStatus::Success | TaskStatus::Failed | TaskStatus::Cancelled
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskNode {
    pub id: TaskId,
    pub parent_id: Option<TaskId>,
    pub title: String,
    pub status: TaskStatus,
    pub detail: Option<String>,
    /// Department that owns this task, when submitted through one. Drives
    /// the per-department activity shown in the TUI's left rail.
    #[serde(default)]
    pub department: Option<String>,
    /// Children in creation order (drives the TUI tree rendering).
    #[serde(default)]
    pub children: Vec<TaskId>,
}

/// Insertion-ordered task graph. Nodes are addressed by id; iteration order
/// is stable so view models can diff cheaply.
#[derive(Debug, Default, Clone)]
pub struct TaskGraph {
    nodes: HashMap<TaskId, TaskNode>,
    order: Vec<TaskId>,
    roots: Vec<TaskId>,
}

impl TaskGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, title: impl Into<String>, parent_id: Option<TaskId>) -> TaskNode {
        let id = format!("task_{}", self.order.len());
        let node = TaskNode {
            id: id.clone(),
            parent_id: parent_id.clone(),
            title: title.into(),
            status: TaskStatus::Pending,
            detail: None,
            department: None,
            children: Vec::new(),
        };
        self.nodes.insert(id.clone(), node.clone());
        self.order.push(id.clone());
        match parent_id {
            Some(p) => {
                if let Some(parent) = self.nodes.get_mut(&p) {
                    parent.children.push(id.clone());
                }
            }
            None => self.roots.push(id),
        }
        node
    }

    /// Mutate status/detail; returns the updated node (for event emission).
    pub fn update(
        &mut self,
        id: &TaskId,
        status: TaskStatus,
        detail: Option<String>,
    ) -> Option<TaskNode> {
        let node = self.nodes.get_mut(id)?;
        node.status = status;
        if detail.is_some() {
            node.detail = detail;
        }
        Some(node.clone())
    }

    pub fn get(&self, id: &TaskId) -> Option<&TaskNode> {
        self.nodes.get(id)
    }

    pub fn roots(&self) -> impl Iterator<Item = &TaskId> {
        self.roots.iter()
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Clear all nodes (new turn).
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.order.clear();
        self.roots.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_links_children_to_parents() {
        let mut g = TaskGraph::new();
        let root = g.add("turn", None);
        let c1 = g.add("tool a", Some(root.id.clone()));
        let c2 = g.add("tool b", Some(root.id.clone()));
        let r = g.get(&root.id).unwrap();
        assert_eq!(r.children, vec![c1.id.clone(), c2.id.clone()]);
        assert_eq!(
            g.roots().cloned().collect::<Vec<_>>(),
            vec![root.id.clone()]
        );
        assert_eq!(g.len(), 3);
    }

    #[test]
    fn update_sets_status_and_keeps_detail_when_none() {
        let mut g = TaskGraph::new();
        let n = g.add("t", None);
        g.update(&n.id, TaskStatus::Running, Some("working".into()));
        let updated = g.update(&n.id, TaskStatus::Success, None).unwrap();
        assert_eq!(updated.status, TaskStatus::Success);
        assert_eq!(updated.detail.as_deref(), Some("working"));
        assert!(updated.status.is_terminal());
    }

    #[test]
    fn update_missing_node_is_noop() {
        let mut g = TaskGraph::new();
        assert!(
            g.update(&"nope".to_string(), TaskStatus::Failed, None)
                .is_none()
        );
    }
}
