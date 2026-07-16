use crate::types::Language;
use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Parser, Query, QueryCursor};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallType {
    Call,
    MethodCall,
    Constructor,
    Import,
    Inherits,
    Implements,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Confidence {
    Direct,   // Explicit call/import found in AST
    Inferred, // Pattern-based or indirect (dynamic dispatch, string-based require)
}

#[derive(Debug, Clone)]
pub struct CallSite {
    pub callee_name: String,
    pub line: u32,
    pub column: u32,
    pub call_type: CallType,
    pub confidence: Confidence,
}

struct CallExclusion {
    start_byte: usize,
    end_byte: usize,
    include_method_calls: bool,
}

fn exclusion_scope(
    node: tree_sitter::Node<'_>,
    root: tree_sitter::Node<'_>,
) -> (usize, usize, bool) {
    let mut current = Some(node);
    let mut declaration = None;
    let mut block_end = None;
    let mut is_parameter = false;

    while let Some(ancestor) = current {
        match ancestor.kind() {
            "preproc_def" | "preproc_function_def" => {
                return (ancestor.end_byte(), root.end_byte(), true);
            }
            "parameter_declaration" => is_parameter = true,
            "declaration" => declaration = Some((ancestor.start_byte(), ancestor.end_byte())),
            "for_statement" | "for_range_loop" | "if_statement" | "while_statement"
            | "switch_statement"
                if block_end.is_none() =>
            {
                block_end = Some(ancestor.end_byte());
            }
            "compound_statement" if block_end.is_none() => block_end = Some(ancestor.end_byte()),
            "lambda_expression" => {
                let start = declaration
                    .map(|(start, _)| start)
                    .unwrap_or_else(|| ancestor.start_byte());
                let end = block_end.unwrap_or_else(|| ancestor.end_byte());
                return (start, end, node.kind() == "field_identifier");
            }
            "function_definition" => {
                let start = declaration
                    .map(|(start, _)| start)
                    .unwrap_or_else(|| ancestor.start_byte());
                let end = block_end.unwrap_or_else(|| ancestor.end_byte());
                return (start, end, node.kind() == "field_identifier");
            }
            _ => {}
        }
        current = ancestor.parent();
    }

    if is_parameter {
        if let Some((start, end)) = declaration {
            return (start, end, node.kind() == "field_identifier");
        }
    }

    let start = declaration
        .map(|(start, _)| start)
        .unwrap_or(root.start_byte());
    (start, root.end_byte(), node.kind() == "field_identifier")
}

fn is_first_class_callable(node: tree_sitter::Node<'_>) -> bool {
    let Some(arguments) = node.child_by_field_name("arguments") else {
        return false;
    };
    let mut cursor = arguments.walk();
    arguments
        .named_children(&mut cursor)
        .any(|child| child.kind() == "variadic_placeholder")
}

fn is_pipe_callable(mut node: tree_sitter::Node<'_>, source: &[u8]) -> bool {
    while let Some(parent) = node.parent() {
        if parent.kind() == "parenthesized_expression" {
            node = parent;
            continue;
        }
        if parent.kind() != "binary_expression" || parent.child_by_field_name("right") != Some(node)
        {
            return false;
        }
        return parent
            .child_by_field_name("operator")
            .and_then(|operator| operator.utf8_text(source).ok())
            == Some("|>");
    }
    false
}

pub fn extract_calls(content: &str, language_name: &str) -> Result<Vec<CallSite>> {
    let language = Language::from_string(language_name);
    let ts_language = match language {
        Language::TypeScript | Language::TypeScriptTsx => {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        }
        Language::JavaScript | Language::JavaScriptJsx => tree_sitter_javascript::LANGUAGE.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        Language::Php => tree_sitter_php::LANGUAGE_PHP.into(),
        Language::Zig => tree_sitter_zig::LANGUAGE.into(),
        Language::Gdscript => tree_sitter_gdscript::LANGUAGE.into(),
        Language::Matlab => tree_sitter_matlab::LANGUAGE.into(),
        Language::Apex => tree_sitter_sfapex::apex::LANGUAGE.into(),
        Language::Bash => tree_sitter_bash::LANGUAGE.into(),
        Language::C => tree_sitter_c::LANGUAGE.into(),
        Language::Cpp => tree_sitter_cpp::LANGUAGE.into(),
        _ => return Ok(vec![]),
    };

    let mut parser = Parser::new();
    parser
        .set_language(&ts_language)
        .map_err(|e| anyhow!("Failed to set language: {}", e))?;

    let tree = parser
        .parse(content, None)
        .ok_or_else(|| anyhow!("Parse failed"))?;

    let query_source = match language {
        Language::TypeScript | Language::TypeScriptTsx => {
            include_str!("../queries/typescript-calls.scm")
        }
        Language::JavaScript | Language::JavaScriptJsx => {
            include_str!("../queries/javascript-calls.scm")
        }
        Language::Python => include_str!("../queries/python-calls.scm"),
        Language::Rust => include_str!("../queries/rust-calls.scm"),
        Language::Go => include_str!("../queries/go-calls.scm"),
        Language::Php => include_str!("../queries/php-calls.scm"),
        Language::Zig => include_str!("../queries/zig-calls.scm"),
        Language::Gdscript => include_str!("../queries/gdscript-calls.scm"),
        Language::Matlab => include_str!("../queries/matlab-calls.scm"),
        Language::Apex => include_str!("../queries/apex-calls.scm"),
        Language::Bash => include_str!("../queries/bash-calls.scm"),
        Language::C => include_str!("../queries/c-calls.scm"),
        Language::Cpp => include_str!("../queries/cpp-calls.scm"),
        _ => return Ok(vec![]),
    };

    let query = Query::new(&ts_language, query_source)
        .map_err(|e| anyhow!("Failed to compile query: {}", e))?;

    let callee_name_idx = query.capture_index_for_name("callee.name");
    let call_idx = query.capture_index_for_name("call");
    let method_call_idx = query.capture_index_for_name("method.call");
    let static_call_idx = query.capture_index_for_name("static.call");
    let constructor_idx = query.capture_index_for_name("constructor");
    let import_name_idx = query.capture_index_for_name("import.name");
    let import_default_idx = query.capture_index_for_name("import.default");
    let import_namespace_idx = query.capture_index_for_name("import.namespace");
    let inherits_name_idx = query.capture_index_for_name("inherits.name");
    let implements_name_idx = query.capture_index_for_name("implements.name");
    let constructor_type_idx = query.capture_index_for_name("constructor.type");
    let excluded_name_idx = query.capture_index_for_name("excluded.name");
    let indirect_type_idx = query.capture_index_for_name("indirect.type");
    let indirect_variable_type_idx = query.capture_index_for_name("indirect.variable_type");
    let indirect_variable_idx = query.capture_index_for_name("indirect.variable");
    let text_bytes = content.as_bytes();

    let root = tree.root_node();
    let mut exclusions: HashMap<String, Vec<CallExclusion>> = HashMap::new();
    let mut indirect_types = HashSet::new();
    if excluded_name_idx.is_some() || indirect_type_idx.is_some() {
        let mut exclusion_cursor = QueryCursor::new();
        let mut exclusion_matches = exclusion_cursor.captures(&query, tree.root_node(), text_bytes);
        while let Some((match_, _)) = exclusion_matches.next() {
            for capture in match_.captures {
                if excluded_name_idx == Some(capture.index) {
                    let text = capture.node.utf8_text(text_bytes).unwrap_or("");
                    let (start_byte, end_byte, include_method_calls) =
                        exclusion_scope(capture.node, root);
                    exclusions
                        .entry(text.to_string())
                        .or_default()
                        .push(CallExclusion {
                            start_byte,
                            end_byte,
                            include_method_calls,
                        });
                }
                if indirect_type_idx == Some(capture.index) {
                    let text = capture.node.utf8_text(text_bytes).unwrap_or("");
                    indirect_types.insert(text.to_string());
                }
            }
        }
    }

    if !indirect_types.is_empty()
        && indirect_variable_type_idx.is_some()
        && indirect_variable_idx.is_some()
    {
        let mut variable_cursor = QueryCursor::new();
        let mut variables = variable_cursor.captures(&query, tree.root_node(), text_bytes);
        while let Some((match_, _)) = variables.next() {
            let mut variable_type = None;
            let mut variable_name = None;

            for capture in match_.captures {
                let text = capture.node.utf8_text(text_bytes).unwrap_or("");
                if indirect_variable_type_idx == Some(capture.index) {
                    variable_type = Some(text);
                }
                if indirect_variable_idx == Some(capture.index) {
                    variable_name = Some((text, capture.node));
                }
            }

            if let (Some(type_name), Some((name, name_node))) = (variable_type, variable_name) {
                if indirect_types.contains(type_name) {
                    let (start_byte, end_byte, include_method_calls) =
                        exclusion_scope(name_node, root);
                    exclusions
                        .entry(name.to_string())
                        .or_default()
                        .push(CallExclusion {
                            start_byte,
                            end_byte,
                            include_method_calls,
                        });
                }
            }
        }
    }

    let mut cursor = QueryCursor::new();
    let mut calls = Vec::new();

    let mut captures_iter = cursor.captures(&query, tree.root_node(), text_bytes);

    while let Some((match_, _)) = captures_iter.next() {
        let is_callable_reference = language == Language::Php
            && match_.captures.iter().any(|capture| {
                let is_call_capture = call_idx.map(|idx| capture.index == idx).unwrap_or(false)
                    || method_call_idx
                        .map(|idx| capture.index == idx)
                        .unwrap_or(false)
                    || static_call_idx
                        .map(|idx| capture.index == idx)
                        .unwrap_or(false);
                is_call_capture
                    && is_first_class_callable(capture.node)
                    && !is_pipe_callable(capture.node, text_bytes)
            });
        if is_callable_reference {
            continue;
        }
        let mut callee_name: Option<String> = None;
        let mut call_type: Option<CallType> = None;
        let mut position: Option<(u32, u32)> = None;
        let mut callee_byte = None;
        let mut constructor_type = None;

        for capture in match_.captures {
            let node = capture.node;
            let text = node.utf8_text(text_bytes).unwrap_or("");

            if constructor_type_idx == Some(capture.index) {
                constructor_type = Some(text);
            }

            if let Some(idx) = callee_name_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    if position.is_none() {
                        let start = node.start_position();
                        position = Some((start.row as u32 + 1, start.column as u32));
                    }
                    callee_byte = Some(node.start_byte());
                }
            }

            if let Some(idx) = call_idx {
                if capture.index == idx {
                    // Check if this is actually a method call by looking at other captures
                    // If method_call_idx or static_call_idx also matches, it's a method call
                    let is_method_call = match_.captures.iter().any(|c| {
                        method_call_idx.map(|idx| c.index == idx).unwrap_or(false)
                            || static_call_idx.map(|idx| c.index == idx).unwrap_or(false)
                    });

                    if is_method_call {
                        call_type = Some(CallType::MethodCall);
                    } else {
                        call_type = Some(CallType::Call);
                    }
                }
            }

            if let Some(idx) = method_call_idx {
                if capture.index == idx && call_type.is_none() {
                    call_type = Some(CallType::MethodCall);
                }
            }

            if let Some(idx) = static_call_idx {
                if capture.index == idx && call_type.is_none() {
                    call_type = Some(CallType::MethodCall);
                }
            }

            if let Some(idx) = constructor_idx {
                if capture.index == idx {
                    call_type = Some(CallType::Constructor);
                }
            }

            if let Some(idx) = import_name_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Import);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }

            if let Some(idx) = import_default_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Import);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }

            if let Some(idx) = import_namespace_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Import);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }

            if let Some(idx) = inherits_name_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Inherits);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }

            if let Some(idx) = implements_name_idx {
                if capture.index == idx {
                    callee_name = Some(text.to_string());
                    call_type = Some(CallType::Implements);
                    let start = node.start_position();
                    position = Some((start.row as u32 + 1, start.column as u32));
                }
            }
        }

        // PHP method calls are already marked in query (@method.call, @static.call)
        // @call is only for direct function calls
        // So we need to check if the call was already classified as a method call
        if let (Some(name), Some(ct), Some(pos)) = (callee_name, call_type, position) {
            if ct == CallType::Constructor
                && constructor_type.is_some_and(|type_name| type_name != name)
            {
                continue;
            }

            if matches!(language, Language::C | Language::Cpp)
                && matches!(ct, CallType::Call | CallType::MethodCall)
                && callee_byte.is_some_and(|byte| {
                    exclusions.get(&name).is_some_and(|matching_exclusions| {
                        matching_exclusions.iter().any(|exclusion| {
                            byte >= exclusion.start_byte
                                && byte <= exclusion.end_byte
                                && (ct == CallType::Call || exclusion.include_method_calls)
                        })
                    })
                })
            {
                continue;
            }

            // PHP and Apex are case-insensitive, so normalize ordinary calls
            // to lowercase to match their indexed symbols.
            let normalized_name = if (language == Language::Php || language == Language::Apex)
                && ct != CallType::Import
                && ct != CallType::Constructor
                && ct != CallType::Inherits
                && ct != CallType::Implements
            {
                name.to_lowercase()
            } else {
                name.clone()
            };

            calls.push(CallSite {
                callee_name: normalized_name,
                line: pos.0,
                column: pos.1,
                call_type: ct,
                confidence: Confidence::Direct,
            });
        }
    }

    let mut deduped: Vec<CallSite> = Vec::new();
    for call in calls {
        if let Some(existing) = deduped.iter_mut().find(|existing| {
            existing.callee_name == call.callee_name
                && existing.line == call.line
                && existing.column == call.column
        }) {
            if call_type_specificity(call.call_type) > call_type_specificity(existing.call_type) {
                *existing = call;
            }
        } else {
            deduped.push(call);
        }
    }

    Ok(deduped)
}

fn call_type_specificity(call_type: CallType) -> u8 {
    match call_type {
        CallType::Call => 0,
        CallType::MethodCall => 1,
        CallType::Constructor => 2,
        CallType::Import => 2,
        CallType::Inherits => 3,
        CallType::Implements => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_direct_calls() {
        let code = "function test() { foo(); bar(1, 2); }";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call));
        assert!(calls
            .iter()
            .any(|c| c.callee_name == "bar" && c.call_type == CallType::Call));
    }

    #[test]
    fn test_extract_method_calls() {
        let code = "obj.method(); this.foo();";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::MethodCall),
            "Expected method call (self.foo()), got: {:?}",
            calls
        );
    }

    #[test]
    fn test_rust_direct_calls() {
        let code = "fn main() { foo(); bar(1, 2); }";
        let calls = extract_calls(code, "rust").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call),
            "Expected foo call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call),
            "Expected foo call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_rust_method_calls() {
        let code = "fn main() { self.foo(); obj.method(); }";
        let calls = extract_calls(code, "rust").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::MethodCall),
            "Expected method call (self.foo()), got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_unsupported_language() {
        let code = "<html><body>hello</body></html>";
        let calls = extract_calls(code, "html").unwrap();
        assert_eq!(calls.len(), 0);
    }

    #[test]
    fn test_php_direct_calls() {
        let code = "<?php\nfunction caller() { directCall(); helper(1, 2); }";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "directcall" && c.call_type == CallType::Call),
            "Expected directcall (lowercased), got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "helper" && c.call_type == CallType::Call),
            "Expected helper call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_case_insensitive_calls() {
        let code = "<?php\nfunction caller() { HELPER(); MyFunc(); }";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "helper" && c.call_type == CallType::Call),
            "Expected HELPER() normalized to helper, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "myfunc" && c.call_type == CallType::Call),
            "Expected MyFunc() normalized to myfunc, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_method_calls() {
        let code = "<?php\n$obj->method();\n$obj?->safe();";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected method call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "safe" && c.call_type == CallType::MethodCall),
            "Expected nullsafe method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_case_insensitive_method_calls() {
        let code = "<?php\n$obj->Method();\nFoo::Bar();";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "method" && c.call_type == CallType::MethodCall),
            "Expected Method() normalized to method, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "bar" && c.call_type == CallType::MethodCall),
            "Expected Bar() normalized to bar, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_static_calls() {
        let code = "<?php\nFoo::bar();\nself::create();";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "bar" && c.call_type == CallType::MethodCall),
            "Expected static method call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "create" && c.call_type == CallType::MethodCall),
            "Expected static method call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_grouped_imports() {
        let code = "<?php\nuse App\\Helpers\\{StringHelper, ArrayHelper};";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "StringHelper" && c.call_type == CallType::Import),
            "Expected StringHelper import, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "ArrayHelper" && c.call_type == CallType::Import),
            "Expected ArrayHelper import, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_constructors() {
        let code = "<?php\n$obj = new SimpleClass();\n$obj2 = new ClassWithArgs(1, 2);";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "SimpleClass" && c.call_type == CallType::Constructor),
            "Expected SimpleClass constructor, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "ClassWithArgs" && c.call_type == CallType::Constructor),
            "Expected ClassWithArgs constructor, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_gdscript_direct_calls() {
        let code = "func main() -> void:\n    foo()\n    bar(1, 2)\n";
        let calls = extract_calls(code, "gdscript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "foo" && c.call_type == CallType::Call),
            "Expected foo() direct call, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "bar" && c.call_type == CallType::Call),
            "Expected bar() direct call, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_gdscript_method_calls() {
        let code =
            "func _ready() -> void:\n    self.take_damage(5)\n    health_changed.emit(health)\n";
        let calls = extract_calls(code, "gdscript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "take_damage" && c.call_type == CallType::MethodCall),
            "Expected self.take_damage() as MethodCall, got: {:?}",
            calls
        );
        // `signal.emit()` must resolve to the signal name, not the `emit`
        // method, so it can match the indexed `signal_statement` symbol.
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "health_changed" && c.call_type == CallType::MethodCall),
            "Expected health_changed.emit() to target the signal, got: {:?}",
            calls
        );
        assert!(
            !calls.iter().any(|c| c.callee_name == "emit"),
            "`emit` must not leak as a callee, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_gdscript_signal_emit_chained() {
        // `self.<signal>.emit()` must still target the signal name.
        let code = "func _ready() -> void:\n    self.health_changed.emit(health)\n";
        let calls = extract_calls(code, "gdscript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "health_changed" && c.call_type == CallType::MethodCall),
            "Expected chained self.health_changed.emit() to target the signal, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_gdscript_instantiation() {
        // `Class.new()` must resolve to the class name (a constructor call),
        // not the `new` method which is never indexed as a symbol.
        let code = "func spawn() -> void:\n    var e = Enemy.new()\n";
        let calls = extract_calls(code, "gdscript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "Enemy" && c.call_type == CallType::Constructor),
            "Expected Enemy.new() as Constructor targeting the class, got: {:?}",
            calls
        );
        assert!(
            !calls.iter().any(|c| c.callee_name == "new"),
            "`new` must not leak as a callee, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_gdscript_base_call() {
        // GDScript super-call syntax: `.method()` calls the parent's method.
        let code = "func _ready() -> void:\n    .ready()\n";
        let calls = extract_calls(code, "gdscript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "ready" && c.call_type == CallType::MethodCall),
            "Expected .ready() base_call as MethodCall, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_gdscript_case_sensitive() {
        // GDScript identifiers are case-sensitive (unlike PHP/Apex). Verify
        // we do NOT lowercase callee names.
        let code = "func main() -> void:\n    DoThing()\n";
        let calls = extract_calls(code, "gdscript").unwrap();
        assert!(
            calls.iter().any(|c| c.callee_name == "DoThing"),
            "GDScript names must preserve case, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_php_imports() {
        let code = "<?php\nuse App\\Models\\User;\nuse App\\Services\\AuthService;";
        let calls = extract_calls(code, "php").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "User" && c.call_type == CallType::Import),
            "Expected User import, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "AuthService" && c.call_type == CallType::Import),
            "Expected AuthService import, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_typescript_class_extends() {
        let code = "class AdminController extends BaseController { handle() {} }";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "BaseController" && c.call_type == CallType::Inherits),
            "Expected Inherits for BaseController, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_typescript_class_implements() {
        let code = "class UserService implements IUserService { getUser() {} }";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "IUserService" && c.call_type == CallType::Implements),
            "Expected Implements for IUserService, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_typescript_extends_and_implements() {
        let code = "class Admin extends BaseUser implements IAdmin, ISerializable { }";
        let calls = extract_calls(code, "typescript").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "BaseUser" && c.call_type == CallType::Inherits),
            "Expected Inherits for BaseUser, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "IAdmin" && c.call_type == CallType::Implements),
            "Expected Implements for IAdmin, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "ISerializable" && c.call_type == CallType::Implements),
            "Expected Implements for ISerializable, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_typescript_class_expression_extends() {
        let code = "const Foo = class extends Bar { };\nexport default class extends Base { }";
        let calls = extract_calls(code, "typescript").unwrap();
        let inherits: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Inherits)
            .collect();
        assert_eq!(
            inherits.len(),
            2,
            "Expected 2 Inherits from class expressions, got: {:?}",
            inherits
        );
        let names: Vec<&str> = inherits.iter().map(|c| c.callee_name.as_str()).collect();
        assert!(names.contains(&"Bar"));
        assert!(names.contains(&"Base"));
    }

    #[test]
    fn test_typescript_qualified_extends_and_implements() {
        let code = "class Foo extends Ns.Base implements Ns.IBar, pkg.IBaz {}";
        let calls = extract_calls(code, "typescript").unwrap();
        let inherits: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Inherits)
            .collect();
        let impls: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Implements)
            .collect();
        assert_eq!(
            inherits.len(),
            1,
            "Expected 1 Inherits from qualified extends, got: {:?}",
            inherits
        );
        assert_eq!(inherits[0].callee_name, "Base");
        assert_eq!(
            impls.len(),
            2,
            "Expected 2 Implements from qualified interfaces, got: {:?}",
            impls
        );
        let impl_names: Vec<&str> = impls.iter().map(|c| c.callee_name.as_str()).collect();
        assert!(impl_names.contains(&"IBar"));
        assert!(impl_names.contains(&"IBaz"));
    }

    #[test]
    fn test_python_class_inheritance() {
        let code = "class Admin(BaseUser):\n    pass\n";
        let calls = extract_calls(code, "python").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "BaseUser" && c.call_type == CallType::Inherits),
            "Expected Inherits for BaseUser, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_python_multiple_inheritance() {
        let code = "class Admin(BaseUser, Serializable):\n    pass\n";
        let calls = extract_calls(code, "python").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "BaseUser" && c.call_type == CallType::Inherits),
            "Expected Inherits for BaseUser, got: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "Serializable" && c.call_type == CallType::Inherits),
            "Expected Inherits for Serializable, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_rust_impl_trait() {
        let code =
            "impl Display for MyStruct { fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) } }";
        let calls = extract_calls(code, "rust").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "Display" && c.call_type == CallType::Implements),
            "Expected Implements for Display, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_go_struct_embedding() {
        let code = "package main\n\ntype Admin struct {\n\tBaseUser\n}";
        let calls = extract_calls(code, "go").unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.callee_name == "BaseUser" && c.call_type == CallType::Inherits),
            "Expected Inherits for embedded BaseUser, got: {:?}",
            calls
        );
    }

    #[test]
    fn test_go_struct_named_fields_not_inherits() {
        // Regular named fields should NOT produce Inherits edges
        let code = "package main\n\ntype Server struct {\n\tBaseHandler\n\tLogger MyLogger\n\tConfig AppConfig\n}";
        let calls = extract_calls(code, "go").unwrap();
        let inherits: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Inherits)
            .collect();
        // Only BaseHandler is embedded (no field name), Logger and Config have names
        assert_eq!(
            inherits.len(),
            1,
            "Expected only 1 Inherits (BaseHandler), got: {:?}",
            inherits
        );
        assert_eq!(inherits[0].callee_name, "BaseHandler");
    }

    #[test]
    fn test_python_dotted_inheritance() {
        let code = "class MyView(views.APIView, models.Model):\n    pass\n";
        let calls = extract_calls(code, "python").unwrap();
        let inherits: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Inherits)
            .collect();
        assert_eq!(
            inherits.len(),
            2,
            "Expected 2 Inherits from dotted superclasses, got: {:?}",
            inherits
        );
        let names: Vec<&str> = inherits.iter().map(|c| c.callee_name.as_str()).collect();
        assert!(names.contains(&"APIView"));
        assert!(names.contains(&"Model"));
    }

    #[test]
    fn test_go_qualified_embedding() {
        let code = "package main\n\ntype Server struct {\n\tpkg.Base\n}";
        let calls = extract_calls(code, "go").unwrap();
        let inherits: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Inherits)
            .collect();
        assert_eq!(
            inherits.len(),
            1,
            "Expected 1 Inherits from qualified embed, got: {:?}",
            inherits
        );
        assert_eq!(inherits[0].callee_name, "Base");
    }

    #[test]
    fn test_rust_scoped_impl_trait() {
        let code = "impl std::fmt::Display for MyStruct { fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { Ok(()) } }";
        let calls = extract_calls(code, "rust").unwrap();
        let impls: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Implements)
            .collect();
        assert_eq!(
            impls.len(),
            1,
            "Expected 1 Implements from scoped trait, got: {:?}",
            impls
        );
        assert_eq!(impls[0].callee_name, "Display");
    }

    #[test]
    fn test_go_pointer_embedding() {
        // Pointer anonymous embeds: *Base and *http.Client
        // tree-sitter-go parses these the same as non-pointer embeds
        let code = "package main\n\ntype Server struct {\n\t*Base\n\t*http.Client\n}";
        let calls = extract_calls(code, "go").unwrap();
        let inherits: Vec<&CallSite> = calls
            .iter()
            .filter(|c| c.call_type == CallType::Inherits)
            .collect();
        assert_eq!(
            inherits.len(),
            2,
            "Expected 2 Inherits from pointer embeds, got: {:?}",
            inherits
        );
        let names: Vec<&str> = inherits.iter().map(|c| c.callee_name.as_str()).collect();
        assert!(names.contains(&"Base"));
        assert!(names.contains(&"Client"));
    }

    #[test]
    fn test_c_calls_and_conservative_exclusions() {
        let code = r#"
#include <stdio.h>
#define call_helper(value) helper(value)
#define helper_alias helper
typedef int (*callback_fn)(int);
typedef int callback_signature(int);
int declared_only(int value);
int helper(int value) { return value + 1; }
int API_CALL(int value) { return value; }
int direct_target(void) { return 1; }
int call_direct(void) { return direct_target(); }
int use_pointer(int (*direct_target)(void)) { return direct_target(); }
int run(callback_fn callback, callback_signature *signature) {
    callback_fn local_callback = callback;
    int direct = helper(1);
    int macro_value = call_helper(2);
    int indirect = callback(3);
    int local_indirect = local_callback(4);
    int signature_indirect = signature(5);
    int alias_value = helper_alias(6);
    return API_CALL(printf("%d", direct + macro_value + indirect + local_indirect + signature_indirect + alias_value));
}
"#;
        let calls = extract_calls(code, "c").unwrap();

        assert!(calls
            .iter()
            .any(|call| call.callee_name == "helper" && call.call_type == CallType::Call));
        assert!(calls
            .iter()
            .any(|call| call.callee_name == "printf" && call.call_type == CallType::Call));
        assert!(calls
            .iter()
            .any(|call| call.callee_name == "API_CALL" && call.call_type == CallType::Call));
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.callee_name == "direct_target")
                .count(),
            1,
            "Expected the call outside the pointer parameter's scope only: {:?}",
            calls
        );
        assert!(
            calls
                .iter()
                .any(|call| call.callee_name.contains("stdio.h")
                    && call.call_type == CallType::Import)
        );
        assert!(!calls.iter().any(|call| matches!(
            call.callee_name.as_str(),
            "call_helper"
                | "helper_alias"
                | "callback"
                | "local_callback"
                | "signature"
                | "declared_only"
        )));
    }

    #[test]
    fn test_cpp_calls_constructors_namespaces_and_exclusions() {
        let code = r#"
#include "widget.hpp"
#define run_widget(value) helper(value)
#define helper_alias helper
using Callback = int (*)(int);
using CallbackSignature = int(int);
using LoopCallback = int (*)();
using namespace project::detail;
int helper(int value) { return value + 1; }
template <typename T> T identity(T value) { return value; }
struct Table { Callback dispatch; };
int callback(void) { return 1; }
int loop_scope(LoopCallback initial) {
    for (LoopCallback callback = initial; false;) { callback(); }
    return callback();
}
int field_call(Table* table) { return table->dispatch(); }
int lambda_target(void) { return 1; }
int lambda_scope(void) {
    auto indirect = [](int (*lambda_target)(void)) { return lambda_target(); };
    return lambda_target();
}
int indirect_run(int (*run)(int)) { return run(1); }
int method_run(Widget* widget) { return widget->run(); }
Widget make_widget();
int run(Widget* widget, Callback callback, CallbackSignature* signature) {
    Callback local_callback = callback;
    Widget stack(0);
    Widget braced{0};
    Widget copied = Widget(0);
    Widget from_factory = make_widget();
    Widget vexing();
    project::detail::RemoteWidget remote_stack(1);
    auto* heap = new Widget(1);
    auto* remote = new project::detail::RemoteWidget(2);
    int direct = project::detail::normalize(helper(3));
    int member = widget->run() + Widget{4}.run();
    int macro_value = run_widget(5);
    int indirect = callback(6);
    int local_indirect = local_callback(7);
    int signature_indirect = signature(8);
    int alias_value = helper_alias(9);
    return direct + member + macro_value + indirect + local_indirect + signature_indirect + alias_value + identity<int>(10);
}
"#;
        let calls = extract_calls(code, "cpp").unwrap();

        assert!(calls
            .iter()
            .any(|call| call.callee_name == "helper" && call.call_type == CallType::Call));
        assert!(calls
            .iter()
            .any(|call| call.callee_name == "project::detail::normalize"
                && call.call_type == CallType::Call));
        assert!(calls
            .iter()
            .any(|call| call.callee_name == "run" && call.call_type == CallType::MethodCall));
        assert_eq!(
            calls
                .iter()
                .filter(|call| {
                    call.callee_name == "run" && call.call_type == CallType::MethodCall
                })
                .count(),
            3,
            "Expected member calls to survive an unrelated pointer named run: {:?}",
            calls
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.callee_name == "callback")
                .count(),
            1,
            "Expected the direct call after the for-loop scope only: {:?}",
            calls
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.callee_name == "lambda_target")
                .count(),
            1,
            "Expected the direct call outside the lambda parameter's scope only: {:?}",
            calls
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| {
                    call.callee_name == "Widget" && call.call_type == CallType::Constructor
                })
                .count(),
            5,
            "Expected stack, braced, copy-initialized, heap, and temporary constructors: {:?}",
            calls
        );
        assert!(calls
            .iter()
            .any(|call| { call.callee_name == "make_widget" && call.call_type == CallType::Call }));
        assert!(!calls.iter().any(|call| call.callee_name == "vexing"));
        assert_eq!(
            calls
                .iter()
                .filter(|call| {
                    call.callee_name == "project::detail::RemoteWidget"
                        && call.call_type == CallType::Constructor
                })
                .count(),
            2
        );
        assert!(calls.iter().any(|call| {
            call.callee_name == "project::detail" && call.call_type == CallType::Import
        }));
        assert!(!calls.iter().any(|call| matches!(
            call.callee_name.as_str(),
            "run_widget"
                | "helper_alias"
                | "local_callback"
                | "signature"
                | "dispatch"
                | "identity"
        )));
    }
}
