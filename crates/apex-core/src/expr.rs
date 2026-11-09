//! Tiny expression language over parameters.
//!
//! This is what makes a component parametric: a recipe stores `thickness / 2`
//! rather than a baked number, so editing a parameter rebuilds the geometry.

use std::ops::{Add, Div, Mul, Neg, Sub};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::param::{ParamId, ParamMap};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExprError {
    #[error("expression refers to unknown parameter '{0}'")]
    UnknownParam(ParamId),
    #[error("parameter '{0}' is not numeric")]
    NotNumeric(ParamId),
    #[error("division by zero")]
    DivisionByZero,
}

/// Struct variants (rather than tuples) keep the JSON self-describing:
/// `{"op":"mul","lhs":{"op":"param","id":"thickness"},"rhs":{"op":"const","value":0.5}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Expr {
    Const {
        value: f64,
    },
    Param {
        id: ParamId,
    },
    Add {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Sub {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Mul {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Div {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Neg {
        value: Box<Expr>,
    },
    Min {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Max {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// Comparison: 1 when it holds, else 0.
    Cmp {
        cmp: CmpOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// Logical and / or / not over truthiness (non-zero = true); 1 or 0.
    And {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Or {
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Not {
        value: Box<Expr>,
    },
    /// `if(cond, then, otherwise)`: only the chosen branch is evaluated.
    If {
        cond: Box<Expr>,
        then: Box<Expr>,
        otherwise: Box<Expr>,
    },
}

/// Comparison operator of [`Expr::Cmp`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CmpOp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

/// Tolerance of `==` / `!=` (formulas run on metres).
pub const EQ_TOLERANCE: f64 = 1e-9;

impl CmpOp {
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Lt => "<",
            Self::Le => "<=",
            Self::Gt => ">",
            Self::Ge => ">=",
            Self::Eq => "==",
            Self::Ne => "!=",
        }
    }

    pub fn holds(self, a: f64, b: f64) -> bool {
        match self {
            Self::Lt => a < b,
            Self::Le => a <= b + EQ_TOLERANCE,
            Self::Gt => a > b,
            Self::Ge => a + EQ_TOLERANCE >= b,
            Self::Eq => (a - b).abs() <= EQ_TOLERANCE,
            Self::Ne => (a - b).abs() > EQ_TOLERANCE,
        }
    }
}

/// Truthiness of a formula value: non-zero (and not NaN) is true.
pub fn truthy(v: f64) -> bool {
    v != 0.0 && !v.is_nan()
}

fn bit(b: bool) -> f64 {
    if b {
        1.0
    } else {
        0.0
    }
}

impl Expr {
    /// Human-readable formula, e.g. `thickness * 0.5` (shown in the UI).
    pub fn to_formula(&self) -> String {
        fn wrap(e: &Expr) -> String {
            match e {
                Expr::Add { .. } | Expr::Sub { .. } => format!("({})", e.to_formula()),
                _ => e.to_formula(),
            }
        }
        match self {
            Self::Const { value } => format!("{value}"),
            Self::Param { id } => id.to_string(),
            Self::Add { lhs, rhs } => format!("{} + {}", lhs.to_formula(), rhs.to_formula()),
            Self::Sub { lhs, rhs } => format!("{} - {}", lhs.to_formula(), wrap(rhs)),
            Self::Mul { lhs, rhs } => format!("{} * {}", wrap(lhs), wrap(rhs)),
            Self::Div { lhs, rhs } => format!("{} / {}", wrap(lhs), wrap(rhs)),
            Self::Neg { value } => format!("-{}", wrap(value)),
            Self::Min { lhs, rhs } => format!("min({}, {})", lhs.to_formula(), rhs.to_formula()),
            Self::Max { lhs, rhs } => format!("max({}, {})", lhs.to_formula(), rhs.to_formula()),
            Self::Cmp { cmp, lhs, rhs } => {
                format!("{} {} {}", wrap(lhs), cmp.symbol(), wrap(rhs))
            }
            Self::And { lhs, rhs } => format!("({}) and ({})", lhs.to_formula(), rhs.to_formula()),
            Self::Or { lhs, rhs } => format!("({}) or ({})", lhs.to_formula(), rhs.to_formula()),
            Self::Not { value } => format!("not ({})", value.to_formula()),
            Self::If {
                cond,
                then,
                otherwise,
            } => format!(
                "if({}, {}, {})",
                cond.to_formula(),
                then.to_formula(),
                otherwise.to_formula()
            ),
        }
    }

    pub fn constant(value: f64) -> Self {
        Self::Const { value }
    }

    pub fn zero() -> Self {
        Self::Const { value: 0.0 }
    }

    pub fn param(id: impl Into<ParamId>) -> Self {
        Self::Param { id: id.into() }
    }

    pub fn min(self, other: Expr) -> Self {
        Self::Min {
            lhs: Box::new(self),
            rhs: Box::new(other),
        }
    }

    pub fn cmp(self, cmp: CmpOp, other: Expr) -> Self {
        Self::Cmp {
            cmp,
            lhs: Box::new(self),
            rhs: Box::new(other),
        }
    }

    pub fn and(self, other: Expr) -> Self {
        Self::And {
            lhs: Box::new(self),
            rhs: Box::new(other),
        }
    }

    pub fn or(self, other: Expr) -> Self {
        Self::Or {
            lhs: Box::new(self),
            rhs: Box::new(other),
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn not(self) -> Self {
        Self::Not {
            value: Box::new(self),
        }
    }

    pub fn if_else(cond: Expr, then: Expr, otherwise: Expr) -> Self {
        Self::If {
            cond: Box::new(cond),
            then: Box::new(then),
            otherwise: Box::new(otherwise),
        }
    }

    pub fn max(self, other: Expr) -> Self {
        Self::Max {
            lhs: Box::new(self),
            rhs: Box::new(other),
        }
    }

    pub fn eval(&self, params: &ParamMap) -> Result<f64, ExprError> {
        Ok(match self {
            Self::Const { value } => *value,
            Self::Param { id } => params
                .get(id)
                .ok_or_else(|| ExprError::UnknownParam(id.clone()))?
                .as_number()
                .ok_or_else(|| ExprError::NotNumeric(id.clone()))?,
            Self::Add { lhs, rhs } => lhs.eval(params)? + rhs.eval(params)?,
            Self::Sub { lhs, rhs } => lhs.eval(params)? - rhs.eval(params)?,
            Self::Mul { lhs, rhs } => lhs.eval(params)? * rhs.eval(params)?,
            Self::Div { lhs, rhs } => {
                let divisor = rhs.eval(params)?;
                if divisor == 0.0 {
                    return Err(ExprError::DivisionByZero);
                }
                lhs.eval(params)? / divisor
            }
            Self::Neg { value } => -value.eval(params)?,
            Self::Min { lhs, rhs } => lhs.eval(params)?.min(rhs.eval(params)?),
            Self::Max { lhs, rhs } => lhs.eval(params)?.max(rhs.eval(params)?),
            Self::Cmp { cmp, lhs, rhs } => bit(cmp.holds(lhs.eval(params)?, rhs.eval(params)?)),
            Self::And { lhs, rhs } => bit(truthy(lhs.eval(params)?) && truthy(rhs.eval(params)?)),
            Self::Or { lhs, rhs } => bit(truthy(lhs.eval(params)?) || truthy(rhs.eval(params)?)),
            Self::Not { value } => bit(!truthy(value.eval(params)?)),
            Self::If {
                cond,
                then,
                otherwise,
            } => {
                if truthy(cond.eval(params)?) {
                    then.eval(params)?
                } else {
                    otherwise.eval(params)?
                }
            }
        })
    }

    /// Evaluate to `f32`, which is what the geometry kernel consumes.
    pub fn eval_f32(&self, params: &ParamMap) -> Result<f32, ExprError> {
        self.eval(params).map(|v| v as f32)
    }

    /// Every parameter this expression reads.
    pub fn referenced_params(&self) -> Vec<ParamId> {
        let mut out = Vec::new();
        self.collect_params(&mut out);
        out.sort();
        out.dedup();
        out
    }

    fn collect_params(&self, out: &mut Vec<ParamId>) {
        match self {
            Self::Const { .. } => {}
            Self::Param { id } => out.push(id.clone()),
            Self::Neg { value } | Self::Not { value } => value.collect_params(out),
            Self::Add { lhs, rhs }
            | Self::Sub { lhs, rhs }
            | Self::Mul { lhs, rhs }
            | Self::Div { lhs, rhs }
            | Self::Min { lhs, rhs }
            | Self::Max { lhs, rhs }
            | Self::Cmp { lhs, rhs, .. }
            | Self::And { lhs, rhs }
            | Self::Or { lhs, rhs } => {
                lhs.collect_params(out);
                rhs.collect_params(out);
            }
            Self::If {
                cond,
                then,
                otherwise,
            } => {
                cond.collect_params(out);
                then.collect_params(out);
                otherwise.collect_params(out);
            }
        }
    }
}

impl From<f64> for Expr {
    fn from(value: f64) -> Self {
        Self::constant(value)
    }
}

impl From<f32> for Expr {
    fn from(value: f32) -> Self {
        Self::constant(value as f64)
    }
}

macro_rules! binary_op {
    ($trait:ident, $method:ident, $variant:ident) => {
        impl $trait for Expr {
            type Output = Expr;
            fn $method(self, rhs: Expr) -> Expr {
                Expr::$variant {
                    lhs: Box::new(self),
                    rhs: Box::new(rhs),
                }
            }
        }
    };
}

binary_op!(Add, add, Add);
binary_op!(Sub, sub, Sub);
binary_op!(Mul, mul, Mul);
binary_op!(Div, div, Div);

impl Neg for Expr {
    type Output = Expr;
    fn neg(self) -> Expr {
        Expr::Neg {
            value: Box::new(self),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;

    fn params() -> ParamMap {
        ParamMap::new()
            .with("height", ParamValue::Length(3.0))
            .with("thickness", ParamValue::Length(0.4))
            .with("visible", ParamValue::Bool(true))
            .with("name", ParamValue::Text("wall".into()))
    }

    #[test]
    fn constants_and_params_evaluate() {
        assert_eq!(Expr::constant(2.5).eval(&params()).unwrap(), 2.5);
        assert_eq!(Expr::param("height").eval(&params()).unwrap(), 3.0);
    }

    #[test]
    fn arithmetic_composes_through_operators() {
        // half the thickness plus a 0.05 cover
        let e = Expr::param("thickness") / Expr::constant(2.0) + Expr::constant(0.05);
        assert!((e.eval(&params()).unwrap() - 0.25).abs() < 1e-9);

        let e = Expr::param("height") * Expr::constant(2.0) - Expr::constant(1.0);
        assert!((e.eval(&params()).unwrap() - 5.0).abs() < 1e-9);

        assert_eq!((-Expr::param("height")).eval(&params()).unwrap(), -3.0);
    }

    #[test]
    fn min_and_max_clamp_a_parameter() {
        let floor = Expr::param("thickness").max(Expr::constant(1.0));
        let ceiling = Expr::param("height").min(Expr::constant(2.0));
        assert_eq!(floor.eval(&params()).unwrap(), 1.0);
        assert_eq!(ceiling.eval(&params()).unwrap(), 2.0);
    }

    #[test]
    fn booleans_read_as_one_and_zero() {
        let e = Expr::param("height") * Expr::param("visible");
        assert_eq!(e.eval(&params()).unwrap(), 3.0);
    }

    #[test]
    fn an_unknown_parameter_is_an_error() {
        assert_eq!(
            Expr::param("depth").eval(&params()).unwrap_err(),
            ExprError::UnknownParam("depth".into())
        );
    }

    #[test]
    fn a_text_parameter_is_not_numeric() {
        assert_eq!(
            Expr::param("name").eval(&params()).unwrap_err(),
            ExprError::NotNumeric("name".into())
        );
    }

    #[test]
    fn dividing_by_zero_fails_instead_of_producing_infinity() {
        let e = Expr::param("height") / Expr::constant(0.0);
        assert_eq!(e.eval(&params()).unwrap_err(), ExprError::DivisionByZero);
    }

    #[test]
    fn referenced_params_are_deduplicated_and_sorted() {
        let e = (Expr::param("thickness") + Expr::param("height")) * Expr::param("thickness");
        assert_eq!(
            e.referenced_params(),
            vec!["height".to_string(), "thickness".to_string()]
        );
        assert!(Expr::constant(1.0).referenced_params().is_empty());
    }

    #[test]
    fn expressions_round_trip_through_json() {
        let e = Expr::param("thickness") * Expr::constant(0.5);
        let json = serde_json::to_string(&e).expect("serialize");
        assert_eq!(
            json,
            r#"{"op":"mul","lhs":{"op":"param","id":"thickness"},"rhs":{"op":"const","value":0.5}}"#
        );
        assert_eq!(serde_json::from_str::<Expr>(&json).unwrap(), e);
    }

    #[test]
    fn comparisons_logic_and_if_evaluate() {
        let p = params();
        let gt = Expr::param("height").cmp(CmpOp::Gt, Expr::constant(2.0));
        assert_eq!(gt.eval(&p).unwrap(), 1.0);
        let eq = Expr::param("thickness").cmp(CmpOp::Eq, Expr::constant(0.4));
        assert_eq!(eq.eval(&p).unwrap(), 1.0);
        let both = gt.clone().and(Expr::param("visible").not());
        assert_eq!(both.eval(&p).unwrap(), 0.0);
        assert_eq!(gt.clone().or(Expr::constant(0.0)).eval(&p).unwrap(), 1.0);
        // Only the chosen branch runs: the other one divides by zero.
        let pick = Expr::if_else(
            gt,
            Expr::constant(5.0),
            Expr::constant(1.0) / Expr::constant(0.0),
        );
        assert_eq!(pick.eval(&p).unwrap(), 5.0);
        assert_eq!(pick.referenced_params(), vec!["height".to_string()]);
    }

    #[test]
    fn eval_f32_hands_the_kernel_what_it_needs() {
        let e = Expr::param("height");
        let v: f32 = e.eval_f32(&params()).unwrap();
        assert!((v - 3.0).abs() < 1e-6);
    }
}
