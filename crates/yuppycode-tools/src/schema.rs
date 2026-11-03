//! Tiny JSON Schema subset validator (no `jsonschema` dependency).
//!
//! Supported:
//! - type: object, string, integer, number, boolean, array, null
//! - required, properties, items, enum
//! - additionalProperties: false rejects unknown keys
//!
//! Arrays/objects are validated recursively. Anything more complex falls back
//! to permissive validation so the agent isn't blocked by schema extensions.

use serde_json::Value;

pub fn validate_arguments(schema: &Value, args: &Value) -> Result<(), String> {
    validate_value(schema, args, "")
}

fn validate_value(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    if schema.is_null() || schema.is_object() && schema.as_object().unwrap().is_empty() {
        return Ok(());
    }
    if let Some(enums) = schema.get("enum").and_then(Value::as_array) {
        if !enums.contains(value) {
            return Err(format!(
                "{path}: value {value} not in enum {}",
                serde_json::to_string(enums).unwrap_or_default()
            ));
        }
    }
    let Some(ty) = schema.get("type").and_then(Value::as_str) else {
        return Ok(());
    };
    match ty {
        "object" => validate_object(schema, value, path),
        "array" => validate_array(schema, value, path),
        "string" => {
            if value.is_string() {
                Ok(())
            } else {
                Err(format!("{path}: expected string, got {value}"))
            }
        }
        "integer" => match value {
            Value::Number(n) if n.is_i64() => Ok(()),
            _ => Err(format!("{path}: expected integer, got {value}")),
        },
        "number" => {
            if value.is_number() {
                Ok(())
            } else {
                Err(format!("{path}: expected number, got {value}"))
            }
        }
        "boolean" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(format!("{path}: expected boolean, got {value}"))
            }
        }
        "null" => {
            if value.is_null() {
                Ok(())
            } else {
                Err(format!("{path}: expected null, got {value}"))
            }
        }
        _ => Ok(()),
    }
}

fn validate_object(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| format!("{path}: expected object, got {value}"))?;
    if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
        let known: std::collections::HashSet<&str> = schema
            .get("properties")
            .and_then(Value::as_object)
            .map(|m| m.keys().map(String::as_str).collect())
            .unwrap_or_default();
        for key in obj.keys() {
            if !known.contains(key.as_str()) {
                return Err(format!("{path}: unknown argument '{key}'"));
            }
        }
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for r in required {
            let name = r.as_str().ok_or("required name must be a string")?;
            if !obj.contains_key(name) {
                return Err(format!("{path}: missing required argument '{name}'"));
            }
        }
    }
    if let Some(props) = schema.get("properties").and_then(Value::as_object) {
        for (key, sub) in props {
            if let Some(v) = obj.get(key) {
                let p = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                validate_value(sub, v, &p)?;
            }
        }
    }
    Ok(())
}

fn validate_array(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let arr = value
        .as_array()
        .ok_or_else(|| format!("{path}: expected array, got {value}"))?;
    if let Some(items) = schema.get("items") {
        for (i, item) in arr.iter().enumerate() {
            validate_value(items, item, &format!("{path}[{i}]"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {"type": "string"},
                "count": {"type": "integer"},
                "enabled": {"type": "boolean"},
                "mode": {"enum": ["fast", "slow"]},
                "tags": {"type": "array", "items": {"type": "string"}}
            },
            "additionalProperties": false
        })
    }

    #[test]
    fn accepts_valid_args() {
        let v = serde_json::json!({
            "path": "a/b.txt", "count": 7, "enabled": true, "mode": "fast", "tags": ["x"]
        });
        assert!(validate_arguments(&schema(), &v).is_ok());
    }

    #[test]
    fn rejects_missing_required() {
        let v = serde_json::json!({"count": 7});
        assert!(validate_arguments(&schema(), &v).is_err());
    }

    #[test]
    fn rejects_wrong_type_and_unknown_key() {
        let v = serde_json::json!({"path": "a.txt", "count": "seven", "evil": 1});
        let e = validate_arguments(&schema(), &v).unwrap_err();
        assert!(e.contains("count") || e.contains("evil"), "{e}");
    }

    #[test]
    fn rejects_unknown_enum() {
        let v = serde_json::json!({"path": "a", "mode": "turbo"});
        assert!(validate_arguments(&schema(), &v).is_err());
    }

    #[test]
    fn rejects_path_traversal_string_type_only() {
        // The validator itself only checks types; traversal is caught by the
        // workspace path resolver in `local`. Type checking must still pass.
        let v = serde_json::json!({"path": "../../../etc/passwd"});
        assert!(validate_arguments(&schema(), &v).is_ok());
    }
}
