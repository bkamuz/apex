//! Document-level undo/redo via project snapshots.
//!
//! Each undo step stores a full [`ProjectSnapshot`] taken immediately before a
//! user-visible mutation. Meshes are rebuilt on restore, same as save/load.
//!
//! [`History::begin_transaction`] / [`History::commit_transaction`] coalesce
//! intermediate edits (e.g. anchor drags) into one undo step.

use std::collections::VecDeque;

use crate::project::ProjectSnapshot;

const DEFAULT_LIMIT: usize = 100;

pub struct History {
    undo: VecDeque<ProjectSnapshot>,
    redo: VecDeque<ProjectSnapshot>,
    /// Snapshot captured at the start of an open transaction.
    pending: Option<ProjectSnapshot>,
    limit: usize,
}

impl Default for History {
    fn default() -> Self {
        Self::new(DEFAULT_LIMIT)
    }
}

impl History {
    pub fn new(limit: usize) -> Self {
        Self {
            undo: VecDeque::new(),
            redo: VecDeque::new(),
            pending: None,
            limit: limit.max(1),
        }
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.pending = None;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Open a coalesced edit. The next [`Self::commit_transaction`] pushes one
    /// undo entry for the state captured here.
    pub fn begin_transaction(&mut self, before: ProjectSnapshot) {
        if self.pending.is_none() {
            self.pending = Some(before);
        }
    }

    /// Finalize a coalesced edit started with [`Self::begin_transaction`].
    pub fn commit_transaction(&mut self) {
        if let Some(snap) = self.pending.take() {
            self.push_undo(snap);
            self.redo.clear();
        }
    }

    /// Record a checkpoint before a standalone mutation.
    pub fn record_before(&mut self, before: ProjectSnapshot) {
        if self.pending.is_some() {
            return;
        }
        self.push_undo(before);
        self.redo.clear();
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn pop_undo(&mut self) -> Option<ProjectSnapshot> {
        self.undo.pop_back()
    }

    pub fn push_redo(&mut self, snap: ProjectSnapshot) {
        self.redo.push_back(snap);
        while self.redo.len() > self.limit {
            self.redo.pop_front();
        }
    }

    pub fn pop_redo(&mut self) -> Option<ProjectSnapshot> {
        self.redo.pop_back()
    }

    pub fn push_undo(&mut self, snap: ProjectSnapshot) {
        self.undo.push_back(snap);
        while self.undo.len() > self.limit {
            self.undo.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(n: u32) -> ProjectSnapshot {
        ProjectSnapshot {
            format: crate::project::PROJECT_FORMAT,
            levels: Vec::new(),
            active_level: None,
            elements: Vec::new(),
            references: Vec::new(),
            grid_axes: Vec::new(),
            profiles: Vec::new(),
            components: Vec::new(),
            counters: Default::default(),
            ref_counters: Default::default(),
            grid_axis_counter: 0,
            level_counter: n,
        }
    }

    #[test]
    fn undo_stack_respects_limit() {
        let mut history = History::new(3);
        for n in 1..=5 {
            history.record_before(snap(n));
        }
        assert_eq!(history.undo.len(), 3);
        assert_eq!(history.pop_undo().unwrap().level_counter, 5);
        assert_eq!(history.pop_undo().unwrap().level_counter, 4);
        assert_eq!(history.pop_undo().unwrap().level_counter, 3);
    }

    #[test]
    fn transaction_coalesces_to_one_entry() {
        let mut history = History::new(10);
        history.begin_transaction(snap(1));
        history.record_before(snap(99));
        history.commit_transaction();
        assert_eq!(history.undo.len(), 1);
        assert_eq!(history.pop_undo().unwrap().level_counter, 1);
    }
}
