//! Per-edit memo of derived solids.
//!
//! An edit asks for the same join pieces and cluster unions many times over
//! (dependents before and after, every cluster member, every hosted opening).
//! Inside a memo scope (see [`SolidMemo::enter`]) those results are kept,
//! stamped with [`crate::Document::shape_version`] so a change to any
//! element's data drops them. The memo is cleared when the outermost scope
//! ends, so registry edits and kernel swaps between edits never see stale
//! entries.
//!
//! Entries are split by build context (`ctx`: whether an exact kernel was
//! routing booleans, whether voids were skipped), and a value built while a
//! kernel result was still pending is never kept: the element has to be
//! rebuilt (and registered as waiting) when it lands.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;

use apex_geometry::{LayeredSolid, TriangleMesh};

use crate::kroute;
use crate::{Element, ElementId};

pub(crate) type Piece = (LayeredSolid, Option<LayeredSolid>, Vec<ElementId>);
pub(crate) type ClusterUnion = (TriangleMesh, Vec<(ElementId, LayeredSolid)>);

#[derive(Default)]
struct State {
    depth: u32,
    stamp: u64,
    /// Keyed by id, holding the element it was built from: an edit builds
    /// the new element before writing it back, so the id alone is not enough.
    pieces: HashMap<(ElementId, u8), (Element, Option<Piece>)>,
    clusters: HashMap<(Vec<ElementId>, u8), Option<ClusterUnion>>,
}

impl State {
    /// Whether memoizing is on, after dropping entries from an older stamp.
    fn live(&mut self, stamp: u64) -> bool {
        if self.depth == 0 {
            return false;
        }
        if self.stamp != stamp {
            self.stamp = stamp;
            self.pieces.clear();
            self.clusters.clear();
        }
        true
    }
}

/// Last [`crate::Project::hide_buried_edges`] answer: (stamp, ctx, hash of
/// the input edges, output). Kept across edits; any change to the document,
/// the build context or the edges themselves misses.
type BuriedEdges = (u64, u8, u64, Vec<f32>);

#[derive(Default)]
pub(crate) struct SolidMemo(Mutex<State>, Mutex<Option<BuriedEdges>>);

impl SolidMemo {
    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    /// Cached buried-edge filter for these inputs, or `make`'s answer (kept
    /// unless it met a pending kernel result).
    pub(crate) fn buried_edges(
        &self,
        stamp: u64,
        ctx: u8,
        edges: &[f32],
        make: impl FnOnce() -> Vec<f32>,
    ) -> Vec<f32> {
        use std::hash::Hasher;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for v in edges {
            h.write_u32(v.to_bits());
        }
        let hash = h.finish();
        let lock = || self.1.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((s, c, hh, out)) = lock().as_ref() {
            if (*s, *c, *hh) == (stamp, ctx, hash) {
                return out.clone();
            }
        }
        let misses = kroute::pending_misses();
        let out = make();
        if kroute::pending_misses() == misses {
            *lock() = Some((stamp, ctx, hash, out.clone()));
        }
        out
    }

    pub(crate) fn enter(&self) {
        self.with(|s| s.depth += 1);
    }

    pub(crate) fn leave(&self) {
        self.with(|s| {
            s.depth = s.depth.saturating_sub(1);
            if s.depth == 0 {
                s.pieces.clear();
                s.clusters.clear();
            }
        });
    }

    /// Memoized value of `make`, unless memoizing is off or it met a
    /// pending kernel result.
    fn cached<K: Eq + Hash, V: Clone>(
        &self,
        stamp: u64,
        map: impl Fn(&mut State) -> &mut HashMap<K, V>,
        key: K,
        valid: impl Fn(&V) -> bool,
        make: impl FnOnce() -> V,
    ) -> V {
        let hit = self.with(|s| {
            s.live(stamp)
                .then(|| map(s).get(&key).filter(|v| valid(v)).cloned())
        });
        match hit {
            None => make(),
            Some(Some(v)) => v,
            Some(None) => {
                let misses = kroute::pending_misses();
                let v = make();
                if kroute::pending_misses() == misses {
                    self.with(|s| {
                        if s.live(stamp) {
                            map(s).insert(key, v.clone());
                        }
                    });
                }
                v
            }
        }
    }

    pub(crate) fn piece(
        &self,
        stamp: u64,
        ctx: u8,
        element: &Element,
        make: impl FnOnce() -> Option<Piece>,
    ) -> Option<Piece> {
        self.cached(
            stamp,
            |s| &mut s.pieces,
            (element.id, ctx),
            |(e, _)| e == element,
            || (element.clone(), make()),
        )
        .1
    }

    pub(crate) fn cluster(
        &self,
        stamp: u64,
        ctx: u8,
        members: &[ElementId],
        make: impl FnOnce() -> Option<ClusterUnion>,
    ) -> Option<ClusterUnion> {
        self.cached(
            stamp,
            |s| &mut s.clusters,
            (members.to_vec(), ctx),
            |_| true,
            make,
        )
    }
}
