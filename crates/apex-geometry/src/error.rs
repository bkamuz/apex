use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum GeometryError {
    #[error("curve is degenerate (length {0})")]
    DegenerateCurve(f32),
    #[error("radius must be positive ({0})")]
    InvalidRadius(f32),
    #[error("height must be positive ({0})")]
    InvalidHeight(f32),
    #[error("width must be positive ({0})")]
    InvalidWidth(f32),
    #[error("thickness must be positive ({0})")]
    InvalidThickness(f32),
    #[error("profile needs at least 3 points, got {0}")]
    ProfileTooSmall(usize),
    #[error("profile encloses no area")]
    ProfileDegenerate,
    #[error("profiles with holes are not supported yet")]
    HolesUnsupported,
    #[error("profile could not be triangulated (self-intersecting?)")]
    Triangulation,
    #[error("a sweep needs at least two stations")]
    NotEnoughStations,
}
