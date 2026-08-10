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
    Const { value: f64 },
    Param { id: ParamId },
    Add { lhs: Box<Expr>, rhs: Box<Expr> },
    Sub { lhs: Box<Expr>, rhs: Box<Expr> },
    Mul { lhs: Box<Expr>, rhs: Box<Expr> },
    Div { lhs: Box<Expr>, rhs: Box<Expr> },
    Neg { value: Box<Expr> },
    Min { lhs: Box<Expr>, rhs: Box<Expr> },
    Max { lhs: Box<Expr>, rhs: Box<Expr> },
}

impl Expr {
    pub fn constant(value: f64) -> Self {
        Self::Const { value }
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
            Self::Neg { value } => value.collect_params(out),
            Self::Add { lhs, rhs }
            | Self::Sub { lhs, rhs }
            | Self::Mul { lhs, rhs }
            | Self::Div { lhs, rhs }
            | Self::Min { lhs, rhs }
            | Self::Max { lhs, rhs } => {
                lhs.collect_params(out);
                rhs.collect_params(out);
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
    fn eval_f32_hands_the_kernel_what_it_needs() {
        let e = Expr::param("height");
        let v: f32 = e.eval_f32(&params()).unwrap();
        assert!((v - 3.0).abs() < 1e-6);
    }
}
