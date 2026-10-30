//! Universal genus format: one data shape for every element kind.
//!
//! A [`GenusDef`] (on [`crate::ComponentDefinition::genus`]) describes an
//! element as data:
//!
//! * **params** — the definition's [`crate::ParamSpec`]s; every number in
//!   the body is a formula ([`Expr`]) over them;
//! * **refs** — named reference geometry (points, lines, planes) inside the
//!   genus, also formula-driven;
//! * **body** — an ordered list of items: solids, cuts and nested genus
//!   instances (matryoshka). Each cut carries a target set: the host it is
//!   inserted into, intersecting neighbours (filtered by category) and/or
//!   the genus's own geometry;
//! * **extends** — single inheritance: a child genus overrides param
//!   defaults and replaces / adds / removes body items by id;
//! * **placement** — point, line, or host (with a host category filter).
//!
//! Geometry is built in a yaw-only local frame: `x` along the element
//! (the host wall for hosted elements), `y` up, `z` across (wall normal).

use std::collections::BTreeMap;
use std::fmt;

use apex_geometry::{triangulate_shape, BooleanOp, TriangleMesh};
use glam::Vec3;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::expr::Expr;
use crate::genus::GLASS_NORMAL_TAG;
use crate::param::{ParamMap, ParamValue};

/// Max nesting depth of genus instances inside genera.
pub const MAX_NESTING: usize = 16;

/// Param injected while building: host thickness at the insertion point.
pub const HOST_DEPTH_PARAM: &str = "host_depth";
/// Param injected while building a line-placed genus: line length.
pub const LENGTH_PARAM: &str = "length";

// ---- Formulas ---------------------------------------------------------

/// A formula: an [`Expr`] that also reads from JSON as a number or a text
/// formula (`"width / 2 - frame_width"`, `min(a, b)`, `max(a, b)`) and is
/// written back as text.
#[derive(Debug, Clone, PartialEq)]
pub struct F(pub Expr);

impl F {
    pub fn c(v: f64) -> Self {
        F(Expr::constant(v))
    }
    pub fn p(id: &str) -> Self {
        F(Expr::param(id))
    }
    pub fn parse(src: &str) -> Result<Self, String> {
        Parser::new(src).parse_all().map(F)
    }
    pub fn eval(&self, params: &ParamMap) -> Result<f64, GenusError> {
        self.0
            .eval(params)
            .map_err(|e| GenusError::Formula(format!("{}: {e}", self)))
    }
    pub fn params(&self, out: &mut Vec<String>) {
        collect_params(&self.0, out);
    }
}

impl Default for F {
    fn default() -> Self {
        F::c(0.0)
    }
}

impl From<Expr> for F {
    fn from(e: Expr) -> Self {
        F(e)
    }
}

impl From<f64> for F {
    fn from(v: f64) -> Self {
        F::c(v)
    }
}

impl From<&str> for F {
    fn from(s: &str) -> Self {
        F::parse(s).unwrap_or_else(|e| panic!("bad built-in formula '{s}': {e}"))
    }
}

fn collect_params(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Const { .. } => {}
        Expr::Param { id } => {
            if !out.contains(id) {
                out.push(id.clone());
            }
        }
        Expr::Neg { value } => collect_params(value, out),
        Expr::Add { lhs, rhs }
        | Expr::Sub { lhs, rhs }
        | Expr::Mul { lhs, rhs }
        | Expr::Div { lhs, rhs }
        | Expr::Min { lhs, rhs }
        | Expr::Max { lhs, rhs } => {
            collect_params(lhs, out);
            collect_params(rhs, out);
        }
    }
}

fn prec(e: &Expr) -> u8 {
    match e {
        Expr::Add { .. } | Expr::Sub { .. } => 1,
        Expr::Mul { .. } | Expr::Div { .. } => 2,
        Expr::Neg { .. } => 3,
        _ => 4,
    }
}

fn write_expr(e: &Expr, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let sub = |x: &Expr, min: u8, f: &mut fmt::Formatter<'_>| -> fmt::Result {
        if prec(x) < min {
            write!(f, "(")?;
            write_expr(x, f)?;
            write!(f, ")")
        } else {
            write_expr(x, f)
        }
    };
    match e {
        Expr::Const { value } => write!(f, "{value}"),
        Expr::Param { id } => write!(f, "{id}"),
        Expr::Neg { value } => {
            write!(f, "-")?;
            sub(value, 4, f)
        }
        Expr::Add { lhs, rhs } => {
            sub(lhs, 1, f)?;
            write!(f, " + ")?;
            sub(rhs, 2, f)
        }
        Expr::Sub { lhs, rhs } => {
            sub(lhs, 1, f)?;
            write!(f, " - ")?;
            sub(rhs, 2, f)
        }
        Expr::Mul { lhs, rhs } => {
            sub(lhs, 2, f)?;
            write!(f, " * ")?;
            sub(rhs, 3, f)
        }
        Expr::Div { lhs, rhs } => {
            sub(lhs, 2, f)?;
            write!(f, " / ")?;
            sub(rhs, 3, f)
        }
        Expr::Min { lhs, rhs } | Expr::Max { lhs, rhs } => {
            let name = if matches!(e, Expr::Min { .. }) {
                "min"
            } else {
                "max"
            };
            write!(f, "{name}(")?;
            write_expr(lhs, f)?;
            write!(f, ", ")?;
            write_expr(rhs, f)?;
            write!(f, ")")
        }
    }
}

impl fmt::Display for F {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_expr(&self.0, f)
    }
}

impl Serialize for F {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match &self.0 {
            Expr::Const { value } => s.serialize_f64(*value),
            _ => s.serialize_str(&self.to_string()),
        }
    }
}

impl<'de> Deserialize<'de> for F {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Num(f64),
            Text(String),
            Expr(Expr),
        }
        match Raw::deserialize(d)? {
            Raw::Num(v) => Ok(F::c(v)),
            Raw::Text(t) => F::parse(&t).map_err(serde::de::Error::custom),
            Raw::Expr(e) => Ok(F(e)),
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            s: src.as_bytes(),
            i: 0,
        }
    }
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) -> bool {
        self.ws();
        if self.s.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn parse_all(&mut self) -> Result<Expr, String> {
        let e = self.sum()?;
        self.ws();
        if self.i != self.s.len() {
            return Err(format!("unexpected input at {}", self.i));
        }
        Ok(e)
    }
    fn sum(&mut self) -> Result<Expr, String> {
        let mut e = self.product()?;
        loop {
            if self.eat(b'+') {
                e = e + self.product()?;
            } else if self.eat(b'-') {
                e = e - self.product()?;
            } else {
                return Ok(e);
            }
        }
    }
    fn product(&mut self) -> Result<Expr, String> {
        let mut e = self.unary()?;
        loop {
            if self.eat(b'*') {
                e = e * self.unary()?;
            } else if self.eat(b'/') {
                e = e / self.unary()?;
            } else {
                return Ok(e);
            }
        }
    }
    fn unary(&mut self) -> Result<Expr, String> {
        if self.eat(b'-') {
            return Ok(-self.unary()?);
        }
        self.atom()
    }
    fn atom(&mut self) -> Result<Expr, String> {
        self.ws();
        if self.eat(b'(') {
            let e = self.sum()?;
            if !self.eat(b')') {
                return Err("missing ')'".into());
            }
            return Ok(e);
        }
        let start = self.i;
        let c = *self.s.get(self.i).ok_or("unexpected end of formula")?;
        if c.is_ascii_digit() || c == b'.' {
            while self.i < self.s.len()
                && (self.s[self.i].is_ascii_digit()
                    || self.s[self.i] == b'.'
                    || self.s[self.i] == b'e')
            {
                self.i += 1;
            }
            let t = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("");
            return t
                .parse::<f64>()
                .map(Expr::constant)
                .map_err(|_| format!("bad number '{t}'"));
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            while self.i < self.s.len()
                && (self.s[self.i].is_ascii_alphanumeric()
                    || self.s[self.i] == b'_'
                    || self.s[self.i] == b'.')
            {
                self.i += 1;
            }
            let name = std::str::from_utf8(&self.s[start..self.i])
                .unwrap_or("")
                .to_string();
            if (name == "min" || name == "max") && self.eat(b'(') {
                let a = self.sum()?;
                if !self.eat(b',') {
                    return Err(format!("{name}() needs two arguments"));
                }
                let b = self.sum()?;
                if !self.eat(b')') {
                    return Err("missing ')'".into());
                }
                return Ok(if name == "min" { a.min(b) } else { a.max(b) });
            }
            return Ok(Expr::param(name));
        }
        Err(format!("unexpected '{}'", c as char))
    }
}

// ---- Data -------------------------------------------------------------

/// How a genus is inserted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GenusPlacement {
    /// One point plus rotation.
    #[default]
    Point,
    /// Along a two-point line (`length` param is injected).
    Line,
    /// Into a host element (like a window into a wall); the host's category
    /// must be in `categories`.
    Host { categories: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    X,
    Y,
    #[default]
    Z,
}

/// Reference geometry inside a genus (local coordinates, formulas).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefGeom {
    pub id: String,
    #[serde(flatten)]
    pub kind: RefKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "ref", rename_all = "snake_case")]
pub enum RefKind {
    Point {
        at: [F; 3],
    },
    Line {
        from: [F; 3],
        to: [F; 3],
    },
    /// A plane through `origin` with normal along a local axis.
    Plane {
        origin: [F; 3],
        #[serde(default)]
        normal: Axis,
    },
}

/// Which elements a cut subtracts from. Any combination may be set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CutTargets {
    /// The element this genus is inserted into.
    #[serde(default)]
    pub host: bool,
    /// Other intersecting elements; `Some([])` = any category.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub neighbours: Option<Vec<String>>,
    /// This genus's own solids.
    #[serde(default, rename = "self")]
    pub own: bool,
}

impl CutTargets {
    pub fn host() -> Self {
        Self {
            host: true,
            ..Self::default()
        }
    }
    pub fn neighbour_matches(&self, category: &str) -> bool {
        self.neighbours
            .as_ref()
            .is_some_and(|c| c.is_empty() || c.iter().any(|x| x == category))
    }
}

/// Which part of an opening recipe an `opening_part` shape emits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OpeningPartKind {
    /// The seamless frame solid.
    Frame,
    /// Sashes, glass, glazing bars, leaves (and the door swing lines).
    Infill,
    #[default]
    All,
}

/// A solid shape in the genus's local frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "snake_case")]
pub enum Shape {
    /// Axis-aligned box `min..max`.
    Box { min: [F; 3], max: [F; 3] },
    /// Polygon (outer loop, then holes) in a plane, extruded `depth[0]..depth[1]`
    /// along the plane normal. Plane axes: normal z → outline (x, y);
    /// normal x → outline (z, y); normal y → outline (x, z).
    Prism {
        #[serde(default)]
        normal: Axis,
        /// Reference plane/point the outline is relative to.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<String>,
        loops: Vec<Vec<[F; 2]>>,
        depth: [F; 2],
    },
    /// Closed profile `(r, y)` revolved around the local y axis.
    Revolve {
        profile: Vec<[F; 2]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<String>,
        #[serde(default = "default_segments")]
        segments: u32,
    },
    /// Parts of the opening recipe in scope (the nearest genus with an
    /// `opening` recipe), or of its plugin generator.
    OpeningPart {
        #[serde(default)]
        part: OpeningPartKind,
    },
}

fn default_segments() -> u32 {
    24
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BodyItem {
    pub id: String,
    #[serde(flatten)]
    pub kind: BodyKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "item", rename_all = "snake_case")]
pub enum BodyKind {
    Solid {
        #[serde(flatten)]
        shape: Shape,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        glass: bool,
    },
    Cut {
        #[serde(flatten)]
        shape: Shape,
        #[serde(default)]
        targets: CutTargets,
    },
    /// An instance of another genus, placed relative to a ref of this one.
    Nested {
        genus: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        species: Option<String>,
        /// Ref point/plane origin (or line start) this child sits on.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        #[serde(default)]
        offset: [F; 3],
        /// Yaw about local y, degrees.
        #[serde(default)]
        rotation: F,
        /// Child param → formula over this genus's params. Unbound child
        /// params take this genus's same-named value, else their default.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        params: BTreeMap<String, F>,
    },
}

type RefOrigin<'a> = dyn Fn(&Option<String>) -> Result<[f64; 3], GenusError> + 'a;

/// The universal genus body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct GenusDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<GenusPlacement>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<RefGeom>,
    #[serde(default)]
    pub body: Vec<BodyItem>,
    /// Inherited body item / ref ids to drop.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove: Vec<String>,
}

/// Id of the nested frame genus used by built-in windows and doors.
pub const OPENING_FRAME_GENUS: &str = "apex.opening.frame";
/// Id of the nested sash / glass / leaf genus.
pub const OPENING_INFILL_GENUS: &str = "apex.opening.infill";

impl GenusDef {
    /// Body every opening genus (window, door, user openings) shares:
    /// nested frame + infill genera and a host cut through the wall.
    pub fn opening_body(host_categories: Vec<String>) -> Self {
        Self {
            extends: None,
            placement: Some(GenusPlacement::Host {
                categories: host_categories,
            }),
            refs: vec![RefGeom {
                id: "sill".into(),
                kind: RefKind::Plane {
                    origin: [F::c(0.0), F::p("sill"), F::c(0.0)],
                    normal: Axis::Y,
                },
            }],
            body: vec![
                BodyItem {
                    id: "frame".into(),
                    kind: BodyKind::Nested {
                        genus: OPENING_FRAME_GENUS.into(),
                        species: None,
                        at: None,
                        offset: Default::default(),
                        rotation: F::c(0.0),
                        params: BTreeMap::new(),
                    },
                },
                BodyItem {
                    id: "infill".into(),
                    kind: BodyKind::Nested {
                        genus: OPENING_INFILL_GENUS.into(),
                        species: None,
                        at: None,
                        offset: Default::default(),
                        rotation: F::c(0.0),
                        params: BTreeMap::new(),
                    },
                },
                BodyItem {
                    id: "opening".into(),
                    kind: BodyKind::Cut {
                        shape: Shape::Box {
                            min: ["-width / 2".into(), "sill - 0.02".into(), F::c(-0.6)],
                            max: ["width / 2".into(), "sill + height + 0.02".into(), F::c(0.6)],
                        },
                        targets: CutTargets::host(),
                    },
                },
            ],
            remove: Vec::new(),
        }
    }

    /// One-item body emitting the given opening part (frame / infill genera).
    pub fn opening_part(part: OpeningPartKind) -> Self {
        Self {
            body: vec![BodyItem {
                id: "part".into(),
                kind: BodyKind::Solid {
                    shape: Shape::OpeningPart { part },
                    glass: false,
                },
            }],
            ..Self::default()
        }
    }

    pub fn item(&self, id: &str) -> Option<&BodyItem> {
        self.body.iter().find(|b| b.id == id)
    }

    /// Genus ids nested directly in the body.
    pub fn nested_ids(&self) -> Vec<&str> {
        self.body
            .iter()
            .filter_map(|b| match &b.kind {
                BodyKind::Nested { genus, .. } => Some(genus.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Merge this (child) over an already-resolved `parent`: refs and body
    /// items replace by id or append, `remove` drops ids.
    pub fn merged_over(&self, parent: &GenusDef) -> GenusDef {
        let mut refs = parent.refs.clone();
        for r in &self.refs {
            match refs.iter_mut().find(|x| x.id == r.id) {
                Some(slot) => *slot = r.clone(),
                None => refs.push(r.clone()),
            }
        }
        let mut body = parent.body.clone();
        for b in &self.body {
            match body.iter_mut().find(|x| x.id == b.id) {
                Some(slot) => *slot = b.clone(),
                None => body.push(b.clone()),
            }
        }
        refs.retain(|r| !self.remove.contains(&r.id));
        body.retain(|b| !self.remove.contains(&b.id));
        GenusDef {
            extends: self.extends.clone(),
            placement: self.placement.clone().or_else(|| parent.placement.clone()),
            refs,
            body,
            remove: Vec::new(),
        }
    }

    /// Every param id a formula in this body / its refs reads.
    pub fn referenced_params(&self) -> Vec<String> {
        let mut out = Vec::new();
        let p3 = |a: &[F; 3], out: &mut Vec<String>| a.iter().for_each(|f| f.params(out));
        for r in &self.refs {
            match &r.kind {
                RefKind::Point { at } => p3(at, &mut out),
                RefKind::Line { from, to } => {
                    p3(from, &mut out);
                    p3(to, &mut out);
                }
                RefKind::Plane { origin, .. } => p3(origin, &mut out),
            }
        }
        let shape = |s: &Shape, out: &mut Vec<String>| match s {
            Shape::Box { min, max } => {
                p3(min, out);
                p3(max, out);
            }
            Shape::Prism { loops, depth, .. } => {
                loops.iter().flatten().flatten().for_each(|f| f.params(out));
                depth.iter().for_each(|f| f.params(out));
            }
            Shape::Revolve { profile, .. } => {
                profile.iter().flatten().for_each(|f| f.params(out));
            }
            Shape::OpeningPart { .. } => {}
        };
        for b in &self.body {
            match &b.kind {
                BodyKind::Solid { shape: s, .. } | BodyKind::Cut { shape: s, .. } => {
                    shape(s, &mut out)
                }
                BodyKind::Nested {
                    offset,
                    rotation,
                    params,
                    ..
                } => {
                    p3(offset, &mut out);
                    rotation.params(&mut out);
                    params.values().for_each(|f| f.params(&mut out));
                }
            }
        }
        out.retain(|p| p != HOST_DEPTH_PARAM && p != LENGTH_PARAM);
        out
    }

    pub fn has_cuts(&self, pred: impl Fn(&CutTargets) -> bool) -> bool {
        self.body
            .iter()
            .any(|b| matches!(&b.kind, BodyKind::Cut { targets, .. } if pred(targets)))
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum GenusError {
    #[error("genus cycle: {0}")]
    Cycle(String),
    #[error("genus nesting deeper than {MAX_NESTING}: {0}")]
    TooDeep(String),
    #[error("unknown genus '{0}'")]
    Unknown(String),
    #[error("unknown genus ref '{0}'")]
    UnknownRef(String),
    #[error("formula {0}")]
    Formula(String),
    #[error("{0}")]
    Other(String),
}

// ---- Building ---------------------------------------------------------

/// Yaw-only frame: `u` local x, +Y local y, `n` local z.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GenusFrame {
    pub origin: Vec3,
    pub u: Vec3,
    pub n: Vec3,
}

impl GenusFrame {
    pub fn from_yaw(origin: Vec3, yaw: f32) -> Self {
        let u = Vec3::new(yaw.cos(), 0.0, -yaw.sin());
        Self {
            origin,
            u,
            n: Vec3::new(-u.z, 0.0, u.x),
        }
    }
    pub fn along(origin: Vec3, u: Vec3) -> Self {
        Self {
            origin,
            u,
            n: Vec3::new(-u.z, 0.0, u.x),
        }
    }
    pub fn point(&self, p: [f64; 3]) -> Vec3 {
        self.origin + self.u * p[0] as f32 + Vec3::Y * p[1] as f32 + self.n * p[2] as f32
    }
    fn dir(&self, axis: Axis) -> Vec3 {
        match axis {
            Axis::X => self.u,
            Axis::Y => Vec3::Y,
            Axis::Z => self.n,
        }
    }
    /// Child frame at local point `p`, rotated `yaw` (radians) about y.
    pub fn child(&self, p: [f64; 3], yaw: f32) -> Self {
        let (s, c) = yaw.sin_cos();
        let u = self.u * c - self.n * s;
        Self::along(self.point(p), u)
    }
}

/// A cut leaving the genus (host / neighbour targets), in world space.
#[derive(Debug, Clone)]
pub struct GenusCut {
    /// Item path, e.g. `opening` or `frame/notch`.
    pub path: String,
    pub targets: CutTargets,
    pub mesh: TriangleMesh,
    /// Plan footprint (xz) and world y range when the cut is a vertical prism.
    pub prism: Option<(Vec<[f64; 2]>, f64, f64)>,
}

/// One built solid (kept separate so self cuts stay robust booleans).
#[derive(Debug, Clone)]
pub struct GenusSolid {
    pub path: String,
    pub mesh: TriangleMesh,
    pub glass: bool,
}

#[derive(Debug, Clone, Default)]
pub struct GenusBuild {
    pub solids: Vec<GenusSolid>,
    /// Loose lines (door swing).
    pub lines: TriangleMesh,
    pub cuts: Vec<GenusCut>,
    /// Self cuts that failed as booleans (reported, not fatal).
    pub warnings: Vec<String>,
}

impl GenusBuild {
    pub fn mesh(&self) -> TriangleMesh {
        let mut out = TriangleMesh::empty();
        // With an exact kernel active, the opaque solids (frame, sashes,
        // leaves) become one seamless union; glass stays separate (tagged).
        let opaque: Vec<&TriangleMesh> = self
            .solids
            .iter()
            .filter(|s| !s.glass && !s.mesh.is_empty())
            .map(|s| &s.mesh)
            .collect();
        let united = if crate::kroute::active() && !opaque.is_empty() {
            crate::kroute::union_parts(&opaque)
        } else {
            None
        };
        for s in &self.solids {
            if united.is_some() && !s.glass {
                continue;
            }
            out.append(&s.mesh);
        }
        if let Some(u) = &united {
            out.append(u);
        }
        out.append(&self.lines);
        out
    }
}

/// What the builder needs from the registry.
pub trait GenusSource {
    /// Flattened (inheritance-resolved) genus, its param specs' resolver and
    /// the opening recipe it carries.
    fn genus_entry(&self, id: &str) -> Option<GenusEntry<'_>>;
    /// Opening geometry for a recipe (plugin generator or built-in).
    fn opening_parts(
        &self,
        recipe: &crate::genus::OpeningRecipe,
        params: &ParamMap,
        host_depth: f64,
    ) -> Result<crate::genus::OpeningGeometry, String>;
    /// Species values of `species` if it belongs to `genus`.
    fn species_values(&self, genus: &str, species: &str) -> Option<ParamMap>;
}

pub struct GenusEntry<'a> {
    pub def: &'a crate::ComponentDefinition,
    pub genus: &'a GenusDef,
}

/// Inputs to one build.
pub struct BuildInput<'a> {
    pub genus_id: &'a str,
    pub params: &'a ParamMap,
    pub frame: GenusFrame,
    pub host_depth: f64,
    pub length: f64,
}

pub fn build_genus(src: &dyn GenusSource, input: &BuildInput) -> Result<GenusBuild, GenusError> {
    let mut stack = Vec::new();
    build_level(
        src,
        input.genus_id,
        input.params,
        input.frame,
        input.host_depth,
        input.length,
        None,
        "",
        &mut stack,
    )
}

/// Check that nesting from `id` is acyclic and within depth.
pub fn check_nesting(src: &dyn GenusSource, id: &str) -> Result<(), GenusError> {
    fn walk(src: &dyn GenusSource, id: &str, stack: &mut Vec<String>) -> Result<(), GenusError> {
        if stack.iter().any(|s| s == id) {
            stack.push(id.into());
            return Err(GenusError::Cycle(stack.join(" → ")));
        }
        if stack.len() >= MAX_NESTING {
            return Err(GenusError::TooDeep(stack.join(" → ")));
        }
        let entry = src
            .genus_entry(id)
            .ok_or_else(|| GenusError::Unknown(id.into()))?;
        stack.push(id.into());
        for child in entry.genus.nested_ids() {
            walk(src, child, stack)?;
        }
        stack.pop();
        Ok(())
    }
    walk(src, id, &mut Vec::new())
}

fn eval3(a: &[F; 3], p: &ParamMap) -> Result<[f64; 3], GenusError> {
    Ok([a[0].eval(p)?, a[1].eval(p)?, a[2].eval(p)?])
}

fn with_injected(params: &ParamMap, host_depth: f64, length: f64) -> ParamMap {
    let mut p = params.clone();
    if p.get(HOST_DEPTH_PARAM).is_none() {
        p.set(HOST_DEPTH_PARAM, ParamValue::Length(host_depth));
    }
    if p.get(LENGTH_PARAM).is_none() {
        p.set(LENGTH_PARAM, ParamValue::Length(length));
    }
    p
}

#[allow(clippy::too_many_arguments)]
fn build_level(
    src: &dyn GenusSource,
    id: &str,
    params: &ParamMap,
    frame: GenusFrame,
    host_depth: f64,
    length: f64,
    inherited_opening: Option<(&crate::genus::OpeningRecipe, &ParamMap)>,
    prefix: &str,
    stack: &mut Vec<String>,
) -> Result<GenusBuild, GenusError> {
    if stack.iter().any(|s| s == id) {
        stack.push(id.into());
        return Err(GenusError::Cycle(stack.join(" → ")));
    }
    if stack.len() >= MAX_NESTING {
        return Err(GenusError::TooDeep(stack.join(" → ")));
    }
    let entry = src
        .genus_entry(id)
        .ok_or_else(|| GenusError::Unknown(id.into()))?;
    let p = with_injected(params, host_depth, length);
    // Opening recipe in scope and the params it evaluates with: the owner's
    // params overlaid by this level's (so bound child values win).
    let (opening, opening_params) = match (&entry.def.opening, inherited_opening) {
        (Some(r), _) => (Some(r), p.clone()),
        (None, Some((r, owner))) => (Some(r), owner.merged(&p)),
        (None, None) => (None, p.clone()),
    };
    stack.push(id.into());

    // Reference geometry: origin point (+ normal) per ref id.
    let mut refs: BTreeMap<&str, ([f64; 3], Axis)> = BTreeMap::new();
    for r in &entry.genus.refs {
        let v = match &r.kind {
            RefKind::Point { at } => (eval3(at, &p)?, Axis::Y),
            RefKind::Line { from, .. } => (eval3(from, &p)?, Axis::Y),
            RefKind::Plane { origin, normal } => (eval3(origin, &p)?, *normal),
        };
        refs.insert(r.id.as_str(), v);
    }
    let ref_origin = |r: &Option<String>| -> Result<[f64; 3], GenusError> {
        match r {
            None => Ok([0.0; 3]),
            Some(id) => refs
                .get(id.as_str())
                .map(|v| v.0)
                .ok_or_else(|| GenusError::UnknownRef(id.clone())),
        }
    };

    let mut out = GenusBuild::default();
    let mut self_cuts: Vec<(String, TriangleMesh)> = Vec::new();
    for item in &entry.genus.body {
        let path = format!("{prefix}{}", item.id);
        match &item.kind {
            BodyKind::Solid { shape, glass } => {
                if let Shape::OpeningPart { part } = shape {
                    let Some(recipe) = opening else {
                        continue;
                    };
                    let geo = src
                        .opening_parts(recipe, &opening_params, host_depth)
                        .map_err(GenusError::Other)?;
                    for (k, op) in geo.parts.iter().enumerate() {
                        let keep = match part {
                            OpeningPartKind::All => true,
                            OpeningPartKind::Frame => op.frame,
                            OpeningPartKind::Infill => !op.frame,
                        };
                        if !keep {
                            continue;
                        }
                        let mut mesh = TriangleMesh::empty();
                        let one = crate::genus::OpeningGeometry {
                            parts: vec![op.clone()],
                            lines: vec![],
                        };
                        crate::genus::emit_opening(&mut mesh, &one, frame.origin, frame.u, frame.n);
                        out.solids.push(GenusSolid {
                            path: format!("{path}#{k}"),
                            mesh,
                            glass: op.glass,
                        });
                    }
                    if *part != OpeningPartKind::Frame {
                        let lines = crate::genus::OpeningGeometry {
                            parts: vec![],
                            lines: geo.lines.clone(),
                        };
                        crate::genus::emit_opening(
                            &mut out.lines,
                            &lines,
                            frame.origin,
                            frame.u,
                            frame.n,
                        );
                    }
                    continue;
                }
                let (mut mesh, _) = shape_mesh(shape, &p, &frame, &ref_origin)?;
                if *glass {
                    tag(&mut mesh, GLASS_NORMAL_TAG);
                }
                out.solids.push(GenusSolid {
                    path,
                    mesh,
                    glass: *glass,
                });
            }
            BodyKind::Cut { shape, targets } => {
                let (mesh, prism) = shape_mesh(shape, &p, &frame, &ref_origin)?;
                if targets.own {
                    self_cuts.push((path.clone(), mesh.clone()));
                }
                if targets.host || targets.neighbours.is_some() {
                    out.cuts.push(GenusCut {
                        path,
                        targets: targets.clone(),
                        mesh,
                        prism,
                    });
                }
            }
            BodyKind::Nested {
                genus,
                species,
                at,
                offset,
                rotation,
                params: bindings,
            } => {
                let child = src
                    .genus_entry(genus)
                    .ok_or_else(|| GenusError::Unknown(genus.clone()))?;
                let mut raw = ParamMap::new();
                if let Some(v) = species
                    .as_deref()
                    .and_then(|s| src.species_values(genus, s))
                {
                    raw = v;
                }
                for spec in &child.def.params {
                    if bindings.contains_key(&spec.id) {
                        continue;
                    }
                    if let Some(v) = params.get(&spec.id) {
                        if species.is_none() || raw.get(&spec.id).is_none() {
                            raw.set(spec.id.clone(), v.clone());
                        }
                    }
                }
                for (k, f) in bindings {
                    raw.set(k.clone(), ParamValue::Number(f.eval(&p)?));
                }
                let child_params = child
                    .def
                    .resolve_params(&raw)
                    .map_err(|e| GenusError::Other(format!("{path}: {e}")))?;
                let base = ref_origin(at)?;
                let off = eval3(offset, &p)?;
                let at_p = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
                let yaw = (rotation.eval(&p)? as f32).to_radians();
                let sub = build_level(
                    src,
                    genus,
                    &child_params,
                    frame.child(at_p, yaw),
                    host_depth,
                    length,
                    opening.map(|r| (r, &opening_params)),
                    &format!("{path}/"),
                    stack,
                )?;
                out.solids.extend(sub.solids);
                out.lines.append(&sub.lines);
                out.cuts.extend(sub.cuts);
                out.warnings.extend(sub.warnings);
            }
        }
    }
    stack.pop();

    // Self cuts: real booleans against each own solid, in body order.
    for (cut_path, cut) in &self_cuts {
        for solid in &mut out.solids {
            match crate::kroute::kbool(&solid.mesh, cut, BooleanOp::Subtract) {
                Ok(mut m) => {
                    if solid.glass {
                        tag(&mut m, GLASS_NORMAL_TAG);
                    }
                    solid.mesh = m;
                }
                Err(e) => out
                    .warnings
                    .push(format!("self cut {cut_path} on {}: {e}", solid.path)),
            }
        }
    }
    Ok(out)
}

fn tag(mesh: &mut TriangleMesh, t: f32) {
    for n in mesh.normals.chunks_mut(3) {
        let v = Vec3::new(n[0], n[1], n[2]).normalize_or_zero() * t;
        n.copy_from_slice(&v.to_array());
    }
}

type Prism = Option<(Vec<[f64; 2]>, f64, f64)>;

fn shape_mesh(
    shape: &Shape,
    p: &ParamMap,
    frame: &GenusFrame,
    ref_origin: &RefOrigin,
) -> Result<(TriangleMesh, Prism), GenusError> {
    let mut mesh = TriangleMesh::empty();
    match shape {
        Shape::Box { min, max } => {
            let (a, b) = (eval3(min, p)?, eval3(max, p)?);
            let lo = [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])];
            let hi = [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])];
            let outline = vec![
                [lo[0], lo[2]],
                [hi[0], lo[2]],
                [hi[0], hi[2]],
                [lo[0], hi[2]],
            ];
            let local = GenusFrame {
                origin: frame.origin,
                u: frame.u,
                n: frame.n,
            };
            emit_prism(
                &mut mesh,
                std::slice::from_ref(&outline),
                local.origin,
                local.u,
                local.n,
                Vec3::Y,
                lo[1],
                hi[1],
            );
            let foot = outline
                .iter()
                .map(|q| {
                    let w = frame.point([q[0], 0.0, q[1]]);
                    [w.x as f64, w.z as f64]
                })
                .collect();
            let y = frame.origin.y as f64;
            Ok((mesh, Some((foot, y + lo[1], y + hi[1]))))
        }
        Shape::Prism {
            normal,
            on,
            loops,
            depth,
        } => {
            let o = ref_origin(on)?;
            let origin = frame.point(o);
            let loops: Vec<Vec<[f64; 2]>> = loops
                .iter()
                .map(|l| {
                    l.iter()
                        .map(|q| Ok([q[0].eval(p)?, q[1].eval(p)?]))
                        .collect::<Result<Vec<_>, GenusError>>()
                })
                .collect::<Result<_, _>>()?;
            let (d0, d1) = (depth[0].eval(p)?, depth[1].eval(p)?);
            let (a, b, c) = match normal {
                Axis::Z => (frame.u, Vec3::Y, frame.n),
                Axis::X => (frame.n, Vec3::Y, -frame.u),
                Axis::Y => (frame.u, frame.n, Vec3::Y),
            };
            let _ = frame.dir(*normal);
            emit_prism(&mut mesh, &loops, origin, a, b, c, d0, d1);
            let prism = (*normal == Axis::Y && !loops.is_empty()).then(|| {
                let foot = loops[0]
                    .iter()
                    .map(|q| {
                        let w = origin + a * q[0] as f32 + b * q[1] as f32;
                        [w.x as f64, w.z as f64]
                    })
                    .collect();
                let y = origin.y as f64;
                (foot, y + d0.min(d1), y + d0.max(d1))
            });
            Ok((mesh, prism))
        }
        Shape::Revolve {
            profile,
            on,
            segments,
        } => {
            let o = frame.point(ref_origin(on)?);
            let prof: Vec<[f64; 2]> = profile
                .iter()
                .map(|q| Ok([q[0].eval(p)?.max(0.0), q[1].eval(p)?]))
                .collect::<Result<_, GenusError>>()?;
            emit_revolve(
                &mut mesh,
                &prof,
                o,
                frame.u,
                frame.n,
                (*segments).clamp(3, 256),
            );
            Ok((mesh, None))
        }
        Shape::OpeningPart { .. } => Ok((mesh, None)),
    }
}

fn signed_area(ring: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len() {
        let (p, q) = (ring[i], ring[(i + 1) % ring.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    a * 0.5
}

fn tri(mesh: &mut TriangleMesh, a: Vec3, b: Vec3, d: Vec3, nn: Vec3) {
    if (b - a).cross(d - a).dot(nn) >= 0.0 {
        mesh.push_triangle(a.to_array(), b.to_array(), d.to_array(), nn.to_array());
    } else {
        mesh.push_triangle(a.to_array(), d.to_array(), b.to_array(), nn.to_array());
    }
}

/// Closed prism: `loops` in the `(a, b)` plane at `origin`, extruded
/// `d0..d1` along `c`. Edges on cap outlines and real corners only.
#[allow(clippy::too_many_arguments)]
pub fn emit_prism(
    mesh: &mut TriangleMesh,
    loops: &[Vec<[f64; 2]>],
    origin: Vec3,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d0: f64,
    d1: f64,
) {
    let (d0, d1) = (d0.min(d1) as f32, d0.max(d1) as f32);
    if d1 - d0 < 1e-6 {
        return;
    }
    // Right-handed (a, b, c)? Otherwise mirror b so outward normals hold.
    let flip = a.cross(b).dot(c) < 0.0;
    let b = if flip { -b } else { b };
    let loops: Vec<Vec<[f64; 2]>> = loops
        .iter()
        .enumerate()
        .filter(|(_, l)| l.len() >= 3)
        .map(|(i, l)| {
            let mut l: Vec<[f64; 2]> = l.clone();
            if flip {
                l.iter_mut().for_each(|q| q[1] = -q[1]);
            }
            if (i == 0) != (signed_area(&l) > 0.0) {
                l.reverse();
            }
            l
        })
        .collect();
    if loops.is_empty() {
        return;
    }
    let pt = |q: [f64; 2], d: f32| origin + a * q[0] as f32 + b * q[1] as f32 + c * d;
    for t in triangulate_shape(&loops) {
        for (d, nn) in [(d0, -c), (d1, c)] {
            tri(mesh, pt(t[0], d), pt(t[1], d), pt(t[2], d), nn);
        }
    }
    for lp in &loops {
        let m = lp.len();
        for k in 0..m {
            let (q0, q1) = (lp[k], lp[(k + 1) % m]);
            let (dx, dy) = ((q1[0] - q0[0]) as f32, (q1[1] - q0[1]) as f32);
            if dx.abs() + dy.abs() < 1e-9 {
                continue;
            }
            let nn = (a * dy - b * dx).normalize_or_zero();
            let (pa, pb, qa, qb) = (pt(q0, d0), pt(q0, d1), pt(q1, d0), pt(q1, d1));
            tri(mesh, pa, qa, qb, nn);
            tri(mesh, pa, qb, pb, nn);
            mesh.push_edge(pa.to_array(), qa.to_array());
            mesh.push_edge(pb.to_array(), qb.to_array());
            let o = lp[(k + m - 1) % m];
            let (v0, v1) = ([q0[0] - o[0], q0[1] - o[1]], [q1[0] - q0[0], q1[1] - q0[1]]);
            let l0 = (v0[0] * v0[0] + v0[1] * v0[1]).sqrt();
            let l1 = (v1[0] * v1[0] + v1[1] * v1[1]).sqrt();
            if l0 > 1e-9 && l1 > 1e-9 {
                let cos = (v0[0] * v1[0] + v0[1] * v1[1]) / (l0 * l1);
                if cos < 20f64.to_radians().cos() {
                    mesh.push_edge(pa.to_array(), pb.to_array());
                }
            }
        }
    }
}

/// Closed solid of revolution of a closed `(r, y)` profile about the y axis
/// through `origin`.
fn emit_revolve(
    mesh: &mut TriangleMesh,
    profile: &[[f64; 2]],
    origin: Vec3,
    u: Vec3,
    n: Vec3,
    seg: u32,
) {
    if profile.len() < 3 {
        return;
    }
    let mut prof = profile.to_vec();
    if signed_area(&prof) < 0.0 {
        prof.reverse();
    }
    let radial = |j: u32| {
        let t = j as f32 / seg as f32 * std::f32::consts::TAU;
        u * t.cos() + n * t.sin()
    };
    let at = |q: [f64; 2], j: u32| origin + radial(j) * q[0] as f32 + Vec3::Y * q[1] as f32;
    let m = prof.len();
    for j in 0..seg {
        let mid = {
            let t = (j as f32 + 0.5) / seg as f32 * std::f32::consts::TAU;
            u * t.cos() + n * t.sin()
        };
        for k in 0..m {
            let (q0, q1) = (prof[k], prof[(k + 1) % m]);
            let (dr, dy) = ((q1[0] - q0[0]) as f32, (q1[1] - q0[1]) as f32);
            let nn = (mid * dy - Vec3::Y * dr).normalize_or_zero();
            let (a, b, c, d) = (at(q0, j), at(q1, j), at(q1, j + 1), at(q0, j + 1));
            if (a - d).length() > 1e-7 {
                tri(mesh, a, b, d, nn);
            }
            if (b - c).length() > 1e-7 {
                tri(mesh, b, c, d, nn);
            }
            if j == 0 {
                mesh.push_edge(a.to_array(), b.to_array());
            }
        }
    }
    for q in &prof {
        for j in 0..seg {
            if q[0] > 1e-6 {
                mesh.push_edge(at(*q, j).to_array(), at(*q, j + 1).to_array());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formulas_parse_print_and_round_trip() {
        let f = F::parse("width / 2 - (frame_width + 0.01) * 2").unwrap();
        let p = ParamMap::new()
            .with("width", ParamValue::Length(1.2))
            .with("frame_width", ParamValue::Length(0.04));
        assert!((f.eval(&p).unwrap() - (0.6 - 0.1)).abs() < 1e-9);
        let back = F::parse(&f.to_string()).unwrap();
        assert_eq!(back, f);
        let m = F::parse("max(-a, min(b, 3))").unwrap();
        assert_eq!(F::parse(&m.to_string()).unwrap(), m);
        let json: F = serde_json::from_str("1.5").unwrap();
        assert_eq!(json, F::c(1.5));
        let json: F = serde_json::from_str("{\"op\":\"param\",\"id\":\"w\"}").unwrap();
        assert_eq!(json, F::p("w"));
        assert!(F::parse("1 +").is_err());
    }

    #[test]
    fn prism_and_box_are_closed() {
        let mut m = TriangleMesh::empty();
        emit_prism(
            &mut m,
            &[vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]],
            Vec3::ZERO,
            Vec3::X,
            Vec3::Z,
            Vec3::Y,
            0.0,
            1.0,
        );
        let cut = apex_geometry::box_mesh([0.5, -1.0, 0.5], [2.0, 2.0, 2.0]);
        let r0 = crate::kroute::kbool(&m, &cut, BooleanOp::Subtract).expect("closed");
        assert!((apex_geometry::mesh_volume(&r0) - 0.75).abs() < 1e-4);
        assert!((apex_geometry::mesh_volume(&m) - 1.0).abs() < 1e-5);
        let mut r = TriangleMesh::empty();
        emit_revolve(
            &mut r,
            &[[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0]],
            Vec3::ZERO,
            Vec3::X,
            Vec3::Z,
            32,
        );
        assert!(apex_geometry::mesh_volume(&r) > 2.0);
    }
}
