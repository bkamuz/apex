//! DXF R12 ASCII subset parser → plan underlay polylines.
//!
//! Mirrors the entities our [`crate::dxf_export`] writer emits (`LINE`,
//! `TEXT`, …) plus common survey CAD primitives (`LWPOLYLINE`, `POLYLINE`,
//! `CIRCLE`, `ARC`). Blocks, dimensions, and 3D faces are skipped in v1.
//!
//! DXF drawing XY maps to Apex world XZ (Y up). `$INSUNITS` scales to metres.

use thiserror::Error;

/// Soft caps so a huge CAD dump cannot freeze the WASM tab.
pub const MAX_DXF_BYTES: usize = 2_000_000;
pub const MAX_UNDERLAY_SEGMENTS: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum DxfImportError {
    #[error("DXF file is empty")]
    Empty,
    #[error("DXF file is too large ({size} bytes; max {MAX_DXF_BYTES})")]
    TooLarge { size: usize },
    #[error("DXF produced too many segments ({count}; max {MAX_UNDERLAY_SEGMENTS})")]
    TooManySegments { count: usize },
    #[error("DXF has no drawable LINE / POLYLINE / CIRCLE / ARC entities")]
    NoGeometry,
    #[error("invalid DXF number '{0}'")]
    BadNumber(String),
}

/// One open or closed polyline in DXF drawing units (pre-scale).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPolyline {
    pub layer: String,
    pub closed: bool,
    /// DXF XY pairs.
    pub points: Vec<[f64; 2]>,
}

/// Result of parsing a useful DXF subset for underlay display.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDxf {
    /// Scale factor from DXF drawing units → metres (`$INSUNITS`).
    pub to_metres: f64,
    /// Raw `$INSUNITS` code when present (6 = metres, 4 = mm, …).
    pub insunits: Option<i32>,
    pub polylines: Vec<ParsedPolyline>,
}

/// Parse ASCII DXF R12 (and compatible) text into underlay polylines.
pub fn parse_dxf_r12(text: &str) -> Result<ParsedDxf, DxfImportError> {
    let size = text.len();
    if size == 0 {
        return Err(DxfImportError::Empty);
    }
    if size > MAX_DXF_BYTES {
        return Err(DxfImportError::TooLarge { size });
    }

    let pairs = read_pairs(text)?;
    let mut to_metres = 1.0;
    let mut insunits = None;
    let mut polylines = Vec::new();
    let mut segment_budget = 0usize;

    let mut i = 0usize;
    while i < pairs.len() {
        let (code, value) = &pairs[i];
        if *code == 0 {
            match value.as_str() {
                "SECTION" => {
                    // Peek section name (group 2).
                    if let Some((2, name)) = pairs.get(i + 1) {
                        if name == "HEADER" {
                            i += 2;
                            parse_header(&pairs, &mut i, &mut to_metres, &mut insunits)?;
                            continue;
                        }
                    }
                    i += 1;
                }
                "LINE" => {
                    i += 1;
                    if let Some(line) = parse_line(&pairs, &mut i)? {
                        push_polyline(
                            &mut polylines,
                            &mut segment_budget,
                            line.0,
                            false,
                            vec![line.1, line.2],
                        )?;
                    }
                }
                "LWPOLYLINE" => {
                    i += 1;
                    if let Some(pl) = parse_lwpolyline(&pairs, &mut i)? {
                        push_polyline(
                            &mut polylines,
                            &mut segment_budget,
                            pl.layer,
                            pl.closed,
                            pl.points,
                        )?;
                    }
                }
                "POLYLINE" => {
                    i += 1;
                    if let Some(pl) = parse_polyline(&pairs, &mut i)? {
                        push_polyline(
                            &mut polylines,
                            &mut segment_budget,
                            pl.layer,
                            pl.closed,
                            pl.points,
                        )?;
                    }
                }
                "CIRCLE" => {
                    i += 1;
                    if let Some(pl) = parse_circle(&pairs, &mut i)? {
                        push_polyline(
                            &mut polylines,
                            &mut segment_budget,
                            pl.layer,
                            true,
                            pl.points,
                        )?;
                    }
                }
                "ARC" => {
                    i += 1;
                    if let Some(pl) = parse_arc(&pairs, &mut i)? {
                        push_polyline(
                            &mut polylines,
                            &mut segment_budget,
                            pl.layer,
                            false,
                            pl.points,
                        )?;
                    }
                }
                _ => {
                    // Skip unknown entity until next group 0.
                    i += 1;
                    while i < pairs.len() && pairs[i].0 != 0 {
                        i += 1;
                    }
                }
            }
        } else {
            i += 1;
        }
    }

    if polylines.is_empty() {
        return Err(DxfImportError::NoGeometry);
    }

    Ok(ParsedDxf {
        to_metres,
        insunits,
        polylines,
    })
}

fn push_polyline(
    out: &mut Vec<ParsedPolyline>,
    budget: &mut usize,
    layer: String,
    closed: bool,
    points: Vec<[f64; 2]>,
) -> Result<(), DxfImportError> {
    if points.len() < 2 {
        return Ok(());
    }
    let segs = if closed {
        points.len()
    } else {
        points.len().saturating_sub(1)
    };
    *budget = budget.saturating_add(segs);
    if *budget > MAX_UNDERLAY_SEGMENTS {
        return Err(DxfImportError::TooManySegments { count: *budget });
    }
    out.push(ParsedPolyline {
        layer,
        closed,
        points,
    });
    Ok(())
}

fn read_pairs(text: &str) -> Result<Vec<(i32, String)>, DxfImportError> {
    let mut pairs = Vec::new();
    let mut lines = text.lines();
    while let Some(code_line) = lines.next() {
        let code_trim = code_line.trim();
        if code_trim.is_empty() && pairs.is_empty() {
            continue;
        }
        let code: i32 = code_trim
            .parse()
            .map_err(|_| DxfImportError::BadNumber(code_trim.to_string()))?;
        let value = lines.next().unwrap_or("").trim_end().to_string();
        // Keep leading spaces trimmed for codes we care about; DXF values
        // are usually trim-safe for entity names / numbers.
        let value = value.trim().to_string();
        pairs.push((code, value));
    }
    Ok(pairs)
}

fn parse_header(
    pairs: &[(i32, String)],
    i: &mut usize,
    to_metres: &mut f64,
    insunits: &mut Option<i32>,
) -> Result<(), DxfImportError> {
    while *i < pairs.len() {
        let (code, value) = &pairs[*i];
        if *code == 0 && value == "ENDSEC" {
            *i += 1;
            return Ok(());
        }
        if *code == 9 && value == "$INSUNITS" {
            *i += 1;
            if let Some((70, raw)) = pairs.get(*i) {
                let code70: i32 = raw
                    .parse()
                    .map_err(|_| DxfImportError::BadNumber(raw.clone()))?;
                *insunits = Some(code70);
                *to_metres = insunits_to_metres(code70);
                *i += 1;
                continue;
            }
        }
        *i += 1;
    }
    Ok(())
}

/// AutoCAD `$INSUNITS` → metres. Unknown / unitless → 1.0 (treat as metres).
fn insunits_to_metres(code: i32) -> f64 {
    match code {
        1 => 0.0254,        // inches
        2 => 0.3048,        // feet
        3 => 1609.344,      // miles
        4 => 0.001,         // millimetres
        5 => 0.01,          // centimetres
        6 => 1.0,           // metres
        7 => 1000.0,        // kilometres
        8 => 2.54e-7,       // microinches
        9 => 2.54e-5,       // mils
        10 => 0.9144,       // yards
        11 => 1e-10,        // ångströms
        12 => 1e-9,         // nanometres
        13 => 1e-6,         // microns
        14 => 0.1,          // decimetres
        15 => 10.0,         // decametres
        16 => 100.0,        // hectometres
        17 => 1e9,          // gigametres
        18 => 1.4959787e11, // astronomical units
        19 => 9.460730e15,  // light years
        20 => 3.0856776e16, // parsecs
        _ => 1.0,           // 0 = unitless / unknown
    }
}

fn parse_f64(raw: &str) -> Result<f64, DxfImportError> {
    raw.parse()
        .map_err(|_| DxfImportError::BadNumber(raw.to_string()))
}

type LineEnds = (String, [f64; 2], [f64; 2]);

fn parse_line(pairs: &[(i32, String)], i: &mut usize) -> Result<Option<LineEnds>, DxfImportError> {
    let mut layer = "0".to_string();
    let mut x1 = None;
    let mut y1 = None;
    let mut x2 = None;
    let mut y2 = None;
    while *i < pairs.len() && pairs[*i].0 != 0 {
        let (code, value) = &pairs[*i];
        match *code {
            8 => layer = value.clone(),
            10 => x1 = Some(parse_f64(value)?),
            20 => y1 = Some(parse_f64(value)?),
            11 => x2 = Some(parse_f64(value)?),
            21 => y2 = Some(parse_f64(value)?),
            _ => {}
        }
        *i += 1;
    }
    match (x1, y1, x2, y2) {
        (Some(ax), Some(ay), Some(bx), Some(by)) => Ok(Some((layer, [ax, ay], [bx, by]))),
        _ => Ok(None),
    }
}

struct LwPoly {
    layer: String,
    closed: bool,
    points: Vec<[f64; 2]>,
}

fn parse_lwpolyline(
    pairs: &[(i32, String)],
    i: &mut usize,
) -> Result<Option<LwPoly>, DxfImportError> {
    let mut layer = "0".to_string();
    let mut closed = false;
    let mut points = Vec::new();
    let mut pending_x: Option<f64> = None;
    while *i < pairs.len() && pairs[*i].0 != 0 {
        let (code, value) = &pairs[*i];
        match *code {
            8 => layer = value.clone(),
            70 => {
                let flags: i32 = value
                    .parse()
                    .map_err(|_| DxfImportError::BadNumber(value.clone()))?;
                closed = flags & 1 != 0;
            }
            10 => pending_x = Some(parse_f64(value)?),
            20 => {
                if let Some(x) = pending_x.take() {
                    points.push([x, parse_f64(value)?]);
                }
            }
            _ => {}
        }
        *i += 1;
    }
    if points.len() < 2 {
        return Ok(None);
    }
    Ok(Some(LwPoly {
        layer,
        closed,
        points,
    }))
}

fn parse_polyline(
    pairs: &[(i32, String)],
    i: &mut usize,
) -> Result<Option<LwPoly>, DxfImportError> {
    let mut layer = "0".to_string();
    let mut closed = false;
    // Consume POLYLINE header groups.
    while *i < pairs.len() && pairs[*i].0 != 0 {
        let (code, value) = &pairs[*i];
        match *code {
            8 => layer = value.clone(),
            70 => {
                let flags: i32 = value
                    .parse()
                    .map_err(|_| DxfImportError::BadNumber(value.clone()))?;
                closed = flags & 1 != 0;
            }
            _ => {}
        }
        *i += 1;
    }
    let mut points = Vec::new();
    while *i < pairs.len() {
        let (code, value) = &pairs[*i];
        if *code != 0 {
            *i += 1;
            continue;
        }
        match value.as_str() {
            "VERTEX" => {
                *i += 1;
                let mut x = None;
                let mut y = None;
                while *i < pairs.len() && pairs[*i].0 != 0 {
                    let (c, v) = &pairs[*i];
                    match *c {
                        10 => x = Some(parse_f64(v)?),
                        20 => y = Some(parse_f64(v)?),
                        _ => {}
                    }
                    *i += 1;
                }
                if let (Some(px), Some(py)) = (x, y) {
                    points.push([px, py]);
                }
            }
            "SEQEND" => {
                *i += 1;
                while *i < pairs.len() && pairs[*i].0 != 0 {
                    *i += 1;
                }
                break;
            }
            _ => break,
        }
    }
    if points.len() < 2 {
        return Ok(None);
    }
    Ok(Some(LwPoly {
        layer,
        closed,
        points,
    }))
}

const CIRCLE_SEGMENTS: usize = 48;

fn parse_circle(pairs: &[(i32, String)], i: &mut usize) -> Result<Option<LwPoly>, DxfImportError> {
    let mut layer = "0".to_string();
    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut r = None;
    while *i < pairs.len() && pairs[*i].0 != 0 {
        let (code, value) = &pairs[*i];
        match *code {
            8 => layer = value.clone(),
            10 => cx = parse_f64(value)?,
            20 => cy = parse_f64(value)?,
            40 => r = Some(parse_f64(value)?),
            _ => {}
        }
        *i += 1;
    }
    let Some(radius) = r.filter(|v| *v > 1e-12) else {
        return Ok(None);
    };
    let mut points = Vec::with_capacity(CIRCLE_SEGMENTS);
    for k in 0..CIRCLE_SEGMENTS {
        let a = std::f64::consts::TAU * (k as f64) / (CIRCLE_SEGMENTS as f64);
        points.push([cx + radius * a.cos(), cy + radius * a.sin()]);
    }
    Ok(Some(LwPoly {
        layer,
        closed: true,
        points,
    }))
}

fn parse_arc(pairs: &[(i32, String)], i: &mut usize) -> Result<Option<LwPoly>, DxfImportError> {
    let mut layer = "0".to_string();
    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut r = None;
    let mut start_deg = 0.0;
    let mut end_deg = 360.0;
    while *i < pairs.len() && pairs[*i].0 != 0 {
        let (code, value) = &pairs[*i];
        match *code {
            8 => layer = value.clone(),
            10 => cx = parse_f64(value)?,
            20 => cy = parse_f64(value)?,
            40 => r = Some(parse_f64(value)?),
            50 => start_deg = parse_f64(value)?,
            51 => end_deg = parse_f64(value)?,
            _ => {}
        }
        *i += 1;
    }
    let Some(radius) = r.filter(|v| *v > 1e-12) else {
        return Ok(None);
    };
    let mut sweep = end_deg - start_deg;
    if sweep <= 0.0 {
        sweep += 360.0;
    }
    let steps = ((sweep / 360.0) * CIRCLE_SEGMENTS as f64).ceil().max(2.0) as usize;
    let mut points = Vec::with_capacity(steps + 1);
    for k in 0..=steps {
        let t = start_deg + sweep * (k as f64) / (steps as f64);
        let a = t.to_radians();
        points.push([cx + radius * a.cos(), cy + radius * a.sin()]);
    }
    Ok(Some(LwPoly {
        layer,
        closed: false,
        points,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_metres_dxf() -> String {
        // Matches the shape of our exporter output.
        r#"  0
SECTION
  2
HEADER
  9
$INSUNITS
 70
6
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
WALL
 10
0.0
 20
0.0
 30
0.0
 11
10.0
 21
0.0
 31
0.0
  0
LWPOLYLINE
  8
SITE
 70
1
 90
4
 10
0.0
 20
0.0
 10
4.0
 20
0.0
 10
4.0
 20
3.0
 10
0.0
 20
3.0
  0
CIRCLE
  8
0
 10
1.0
 20
1.0
 30
0.0
 40
0.5
  0
ENDSEC
  0
EOF
"#
        .to_string()
    }

    #[test]
    fn parses_lines_lwpolyline_circle_metres() {
        let parsed = parse_dxf_r12(&sample_metres_dxf()).expect("parse");
        assert_eq!(parsed.insunits, Some(6));
        assert!((parsed.to_metres - 1.0).abs() < 1e-12);
        assert_eq!(parsed.polylines.len(), 3);
        assert_eq!(parsed.polylines[0].points.len(), 2);
        assert_eq!(parsed.polylines[0].layer, "WALL");
        assert!(parsed.polylines[1].closed);
        assert_eq!(parsed.polylines[1].points.len(), 4);
        assert!(parsed.polylines[2].closed);
        assert_eq!(parsed.polylines[2].points.len(), CIRCLE_SEGMENTS);
    }

    #[test]
    fn millimetres_scale_to_metres() {
        let dxf = sample_metres_dxf().replace(" 70\n6\n", " 70\n4\n");
        let parsed = parse_dxf_r12(&dxf).expect("parse");
        assert_eq!(parsed.insunits, Some(4));
        assert!((parsed.to_metres - 0.001).abs() < 1e-12);
    }

    #[test]
    fn rejects_empty_and_no_geometry() {
        assert!(matches!(parse_dxf_r12(""), Err(DxfImportError::Empty)));
        let bare = "  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n";
        assert!(matches!(
            parse_dxf_r12(bare),
            Err(DxfImportError::NoGeometry)
        ));
    }

    #[test]
    fn round_trip_with_exporter_line() {
        use crate::vector_export::{ExportUnits, VectorDrawing2d, VectorLine2d};
        let drawing = VectorDrawing2d {
            units: ExportUnits::Metres,
            scale_denominator: 100.0,
            lines: vec![VectorLine2d {
                layer: "A".into(),
                a: [1.0, 2.0],
                b: [3.0, 4.0],
            }],
            texts: vec![],
            dimensions: vec![],
            fills: vec![],
        };
        let dxf = crate::dxf_export::drawing_to_dxf(&drawing);
        let parsed = parse_dxf_r12(&dxf).expect("parse exported");
        assert_eq!(parsed.polylines.len(), 1);
        assert_eq!(parsed.polylines[0].points[0], [1.0, 2.0]);
        assert_eq!(parsed.polylines[0].points[1], [3.0, 4.0]);
    }
}
