//! Minimal STEP Physical File parser for IFC DATA sections.
//!
//! Enough to resolve `#id=TYPE(...);` instances with nested lists, entity
//! references, strings, numbers, enums and `$` / `*` omitted values. Not a
//! full EXPRESS parser.

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Entity {
    pub id: u64,
    pub type_name: String,
    pub args: Vec<Value>,
}

#[derive(Debug, Clone)]
pub enum Value {
    Null,
    Derived,
    Int(i64),
    Float(f64),
    String(String),
    Enum(String),
    Ref(u64),
    List(Vec<Value>),
    Typed {
        #[allow(dead_code)]
        type_name: String,
        inner: Box<Value>,
    },
}

impl Value {
    pub fn as_ref_id(&self) -> Option<u64> {
        match self {
            Self::Ref(id) => Some(*id),
            Self::Typed { inner, .. } => inner.as_ref_id(),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Float(v) => Some(*v),
            Self::Int(v) => Some(*v as f64),
            Self::Typed { inner, .. } => inner.as_f64(),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            Self::Typed { inner, .. } => inner.as_str(),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Value]> {
        match self {
            Self::List(items) => Some(items),
            Self::Typed { inner, .. } => inner.as_list(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct StepFile {
    pub entities: HashMap<u64, Entity>,
}

impl StepFile {
    pub fn get(&self, id: u64) -> Option<&Entity> {
        self.entities.get(&id)
    }

    pub fn of_type<'a>(&'a self, type_name: &'a str) -> impl Iterator<Item = &'a Entity> + 'a {
        let upper = type_name.to_ascii_uppercase();
        self.entities.values().filter(move |e| e.type_name == upper)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ParseError {}

/// Parse an IFC / STEP Physical File into entity instances.
pub fn parse_step(text: &str) -> Result<StepFile, ParseError> {
    let stripped = strip_comments(text);
    let data = data_section(&stripped)?;
    let mut entities = HashMap::new();
    let bytes = data.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] != b'#' {
            // Skip junk until next entity or end.
            i += 1;
            continue;
        }
        let (entity, next) = parse_entity(bytes, i)?;
        entities.insert(entity.id, entity);
        i = next;
    }
    Ok(StepFile { entities })
}

fn strip_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn data_section(text: &str) -> Result<&str, ParseError> {
    let upper = text.to_ascii_uppercase();
    let start = upper
        .find("DATA;")
        .ok_or_else(|| ParseError("missing DATA; section".into()))?
        + 5;
    let rest = &text[start..];
    let end_rel = rest
        .to_ascii_uppercase()
        .find("ENDSEC;")
        .unwrap_or(rest.len());
    Ok(&rest[..end_rel])
}

fn parse_entity(bytes: &[u8], mut i: usize) -> Result<(Entity, usize), ParseError> {
    debug_assert_eq!(bytes[i], b'#');
    i += 1;
    let (id, next) = parse_int(bytes, i)?;
    i = skip_ws(bytes, next);
    if i >= bytes.len() || bytes[i] != b'=' {
        return Err(ParseError(format!("expected '=' after #{id}")));
    }
    i = skip_ws(bytes, i + 1);
    let (type_name, next) = parse_ident(bytes, i)?;
    i = skip_ws(bytes, next);
    if i >= bytes.len() || bytes[i] != b'(' {
        return Err(ParseError(format!("expected '(' after {type_name}")));
    }
    let (args, next) = parse_list_contents(bytes, i + 1)?;
    i = skip_ws(bytes, next);
    if i < bytes.len() && bytes[i] == b';' {
        i += 1;
    }
    Ok((
        Entity {
            id: id as u64,
            type_name: type_name.to_ascii_uppercase(),
            args,
        },
        i,
    ))
}

fn parse_list_contents(bytes: &[u8], mut i: usize) -> Result<(Vec<Value>, usize), ParseError> {
    let mut items = Vec::new();
    loop {
        i = skip_ws(bytes, i);
        if i >= bytes.len() {
            return Err(ParseError("unterminated list".into()));
        }
        if bytes[i] == b')' {
            return Ok((items, i + 1));
        }
        let (value, next) = parse_value(bytes, i)?;
        items.push(value);
        i = skip_ws(bytes, next);
        if i < bytes.len() && bytes[i] == b',' {
            i += 1;
            continue;
        }
        if i < bytes.len() && bytes[i] == b')' {
            return Ok((items, i + 1));
        }
        return Err(ParseError("expected ',' or ')' in list".into()));
    }
}

fn parse_value(bytes: &[u8], mut i: usize) -> Result<(Value, usize), ParseError> {
    i = skip_ws(bytes, i);
    if i >= bytes.len() {
        return Err(ParseError("unexpected end of value".into()));
    }
    match bytes[i] {
        b'$' => Ok((Value::Null, i + 1)),
        b'*' => Ok((Value::Derived, i + 1)),
        b'#' => {
            let (id, next) = parse_int(bytes, i + 1)?;
            Ok((Value::Ref(id as u64), next))
        }
        b'.' => {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j] != b'.' {
                j += 1;
            }
            if j >= bytes.len() {
                return Err(ParseError("unterminated enum".into()));
            }
            let name = std::str::from_utf8(&bytes[start..j])
                .map_err(|_| ParseError("invalid enum utf8".into()))?
                .to_string();
            Ok((Value::Enum(name), j + 1))
        }
        b'\'' => parse_string(bytes, i),
        b'(' => {
            let (items, next) = parse_list_contents(bytes, i + 1)?;
            Ok((Value::List(items), next))
        }
        b'0'..=b'9' | b'+' | b'-' => parse_number(bytes, i),
        b'A'..=b'Z' | b'a'..=b'z' | b'_' => {
            // Typed value: IFCLABEL('x') or similar.
            let (type_name, next) = parse_ident(bytes, i)?;
            let next = skip_ws(bytes, next);
            if next < bytes.len() && bytes[next] == b'(' {
                let (inner_list, after) = parse_list_contents(bytes, next + 1)?;
                let inner = if inner_list.len() == 1 {
                    inner_list.into_iter().next().unwrap()
                } else {
                    Value::List(inner_list)
                };
                Ok((
                    Value::Typed {
                        type_name: type_name.to_ascii_uppercase(),
                        inner: Box::new(inner),
                    },
                    after,
                ))
            } else {
                Err(ParseError(format!(
                    "unexpected identifier '{type_name}' in value position"
                )))
            }
        }
        other => Err(ParseError(format!(
            "unexpected byte {:?} in value",
            other as char
        ))),
    }
}

fn parse_string(bytes: &[u8], mut i: usize) -> Result<(Value, usize), ParseError> {
    debug_assert_eq!(bytes[i], b'\'');
    i += 1;
    let mut out = String::new();
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                out.push('\'');
                i += 2;
                continue;
            }
            return Ok((Value::String(out), i + 1));
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Err(ParseError("unterminated string".into()))
}

fn parse_number(bytes: &[u8], i: usize) -> Result<(Value, usize), ParseError> {
    let start = i;
    let mut j = i;
    if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
        j += 1;
    }
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
    }
    let mut is_float = false;
    if j < bytes.len() && bytes[j] == b'.' {
        is_float = true;
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
    }
    if j < bytes.len() && (bytes[j] == b'E' || bytes[j] == b'e') {
        is_float = true;
        j += 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
    }
    let text = std::str::from_utf8(&bytes[start..j])
        .map_err(|_| ParseError("invalid number utf8".into()))?;
    if is_float {
        let v: f64 = text
            .parse()
            .map_err(|_| ParseError(format!("bad float '{text}'")))?;
        Ok((Value::Float(v), j))
    } else {
        let v: i64 = text
            .parse()
            .map_err(|_| ParseError(format!("bad int '{text}'")))?;
        Ok((Value::Int(v), j))
    }
}

fn parse_int(bytes: &[u8], i: usize) -> Result<(i64, usize), ParseError> {
    let (value, next) = parse_number(bytes, i)?;
    match value {
        Value::Int(v) => Ok((v, next)),
        Value::Float(v) if v.fract() == 0.0 => Ok((v as i64, next)),
        _ => Err(ParseError("expected integer".into())),
    }
}

fn parse_ident(bytes: &[u8], i: usize) -> Result<(&str, usize), ParseError> {
    let mut j = i;
    if j >= bytes.len() || !(bytes[j].is_ascii_alphabetic() || bytes[j] == b'_') {
        return Err(ParseError("expected identifier".into()));
    }
    j += 1;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
        j += 1;
    }
    let name = std::str::from_utf8(&bytes[i..j]).map_err(|_| ParseError("bad ident".into()))?;
    Ok((name, j))
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_entities() {
        let text = r#"
ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((1.,2.,3.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCAXIS2PLACEMENT3D(#1,#2,$);
ENDSEC;
END-ISO-10303-21;
"#;
        let file = parse_step(text).expect("parse");
        assert_eq!(file.entities.len(), 3);
        let pt = file.get(1).unwrap();
        assert_eq!(pt.type_name, "IFCCARTESIANPOINT");
        let coords = pt.args[0].as_list().unwrap();
        assert_eq!(coords[0].as_f64(), Some(1.0));
        assert_eq!(coords[2].as_f64(), Some(3.0));
    }

    #[test]
    fn parses_escaped_strings() {
        let text = r#"
DATA;
#1=IFCWALL('GUID',$,'O''Brien',$,$,$,$,$);
ENDSEC;
"#;
        let file = parse_step(text).expect("parse");
        assert_eq!(file.get(1).unwrap().args[2].as_str(), Some("O'Brien"));
    }
}
