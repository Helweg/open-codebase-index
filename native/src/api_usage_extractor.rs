use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser, Tree};

const HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiRouteUsage {
    pub method: String,
    pub path: String,
    pub handler_name: Option<String>,
    pub handler_start_line: u32,
    pub handler_end_line: u32,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiFetchUsage {
    pub method: String,
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApiUsageExtraction {
    pub routes: Vec<ApiRouteUsage>,
    pub fetches: Vec<ApiFetchUsage>,
}

fn parser_for(language_name: &str) -> Result<Parser> {
    let mut parser = Parser::new();
    let language = match language_name.to_lowercase().as_str() {
        "typescript" | "ts" | "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" | "js" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
        _ => {
            return Err(anyhow!(
                "API usage extraction only supports JavaScript and TypeScript"
            ))
        }
    };
    parser.set_language(&language)?;
    Ok(parser)
}

fn text<'a>(node: Node<'a>, source: &'a str) -> Option<&'a str> {
    node.utf8_text(source.as_bytes()).ok()
}

fn plain_string(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() != "string" {
        return None;
    }
    let raw = text(node, source)?;
    if raw.len() < 2 {
        return None;
    }
    let quote = raw.as_bytes()[0];
    if (quote != b'\'' && quote != b'"') || raw.as_bytes()[raw.len() - 1] != quote {
        return None;
    }
    if raw[1..raw.len() - 1].contains('\\') {
        return None;
    }
    Some(raw[1..raw.len() - 1].to_string())
}

fn named_children<'a>(node: Node<'a>) -> Vec<Node<'a>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn call_function(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("function")
        .or_else(|| named_children(node).into_iter().next())
}

fn call_arguments(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("arguments").or_else(|| {
        named_children(node)
            .into_iter()
            .find(|child| child.kind() == "arguments")
    })
}

fn identifier_text(node: Node<'_>, source: &str) -> Option<String> {
    matches!(node.kind(), "identifier" | "property_identifier")
        .then(|| text(node, source).map(str::to_string))
        .flatten()
}

fn descendant_identifiers(node: Node<'_>, source: &str, names: &mut Vec<String>) {
    if let Some(name) = identifier_text(node, source).or_else(|| {
        node.kind()
            .contains("identifier")
            .then(|| text(node, source).map(str::to_string))
            .flatten()
    }) {
        names.push(name);
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        descendant_identifiers(child, source, names);
    }
}

fn is_literal_call(node: Node<'_>, source: &str, function_name: &str, argument: &str) -> bool {
    if node.kind() != "call_expression" {
        return false;
    }
    let Some(function) = call_function(node) else {
        return false;
    };
    if identifier_text(function, source).as_deref() != Some(function_name) {
        return false;
    }
    let Some(arguments) = call_arguments(node) else {
        return false;
    };
    named_children(arguments)
        .first()
        .and_then(|child| plain_string(*child, source))
        .as_deref()
        == Some(argument)
}

fn import_express_binding(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() != "import_statement" {
        return None;
    }
    let children = named_children(node);
    let source_is_express = children
        .iter()
        .any(|child| plain_string(*child, source).as_deref() == Some("express"));
    if !source_is_express {
        return None;
    }
    // Only accept the default binding. Named/namespace imports are not callable Express factories.
    let clause = children
        .iter()
        .find(|child| child.kind() == "import_clause")?;
    named_children(*clause)
        .into_iter()
        .find(|child| child.kind() == "identifier")
        .and_then(|child| identifier_text(child, source))
}

fn variable_parts<'a>(node: Node<'a>) -> Option<(Node<'a>, Node<'a>)> {
    if node.kind() != "variable_declarator" {
        return None;
    }
    let name = node.child_by_field_name("name")?;
    let value = node.child_by_field_name("value")?;
    Some((name, value))
}

#[derive(Default)]
struct ApiFacts {
    express_bindings: HashSet<String>,
    app_bindings: HashSet<String>,
    local_handlers: HashMap<String, (u32, u32)>,
    handler_declarations: HashSet<String>,
    declared_identifiers: HashSet<String>,
    app_factories: HashMap<String, String>,
    tainted_identifiers: HashSet<String>,
    fetch_shadowed: bool,
    require_shadowed: bool,
    require_express_bindings: HashSet<String>,
}

fn collect_facts(node: Node<'_>, source: &str, facts: &mut ApiFacts) {
    if let Some(binding) = import_express_binding(node, source) {
        if !facts.declared_identifiers.insert(binding.clone()) {
            facts.tainted_identifiers.insert(binding.clone());
        }
        facts.express_bindings.insert(binding);
    }

    if node.kind() == "variable_declarator" {
        if let Some((name_node, value)) = variable_parts(node) {
            let mut declared_names = Vec::new();
            descendant_identifiers(name_node, source, &mut declared_names);
            for declared_name in declared_names {
                if !facts.declared_identifiers.insert(declared_name.clone()) {
                    facts.tainted_identifiers.insert(declared_name.clone());
                }
                if declared_name == "fetch" {
                    facts.fetch_shadowed = true;
                }
                if declared_name == "require" {
                    facts.require_shadowed = true;
                }
            }
            if let Some(name) = identifier_text(name_node, source) {
                if is_literal_call(value, source, "require", "express") {
                    facts.express_bindings.insert(name.clone());
                    facts.require_express_bindings.insert(name.clone());
                }
                if value.kind() == "call_expression" {
                    if let Some(function) =
                        call_function(value).and_then(|n| identifier_text(n, source))
                    {
                        if facts.express_bindings.contains(&function) {
                            facts.app_bindings.insert(name.clone());
                            facts.app_factories.insert(name.clone(), function);
                        }
                    }
                }
                if matches!(value.kind(), "arrow_function" | "function_expression") {
                    if !facts.handler_declarations.insert(name.clone()) {
                        facts.tainted_identifiers.insert(name.clone());
                    }
                    facts.local_handlers.insert(
                        name,
                        (
                            value.start_position().row as u32 + 1,
                            value.end_position().row as u32 + 1,
                        ),
                    );
                }
            }
        }
    } else if node.kind() == "function_declaration" {
        if let Some(name) = node
            .child_by_field_name("name")
            .and_then(|child| identifier_text(child, source))
        {
            if !facts.declared_identifiers.insert(name.clone()) {
                facts.tainted_identifiers.insert(name.clone());
            }
            if name == "fetch" {
                facts.fetch_shadowed = true;
            }
            if name == "require" {
                facts.require_shadowed = true;
            }
            if !facts.handler_declarations.insert(name.clone()) {
                facts.tainted_identifiers.insert(name.clone());
            }
            facts.local_handlers.insert(
                name,
                (
                    node.start_position().row as u32 + 1,
                    node.end_position().row as u32 + 1,
                ),
            );
        }
    } else if node.kind() == "assignment_expression" {
        if let Some(left) = node.child_by_field_name("left") {
            let mut assigned_names = Vec::new();
            if left.kind() == "member_expression" {
                if let Some(object) = left.child_by_field_name("object") {
                    descendant_identifiers(object, source, &mut assigned_names);
                }
            } else {
                descendant_identifiers(left, source, &mut assigned_names);
            }
            for assigned_name in assigned_names {
                if assigned_name == "fetch" {
                    facts.fetch_shadowed = true;
                }
                if assigned_name == "require" {
                    facts.require_shadowed = true;
                }
                facts.tainted_identifiers.insert(assigned_name);
            }
        }
    } else if matches!(
        node.kind(),
        "required_parameter" | "optional_parameter" | "formal_parameters"
    ) {
        let mut parameter_names = Vec::new();
        descendant_identifiers(node, source, &mut parameter_names);
        for name in parameter_names {
            if !facts.declared_identifiers.insert(name.clone()) {
                facts.tainted_identifiers.insert(name.clone());
            }
            if name == "fetch" {
                facts.fetch_shadowed = true;
            }
            if name == "require" {
                facts.require_shadowed = true;
            }
        }
    } else if node.kind() == "import_statement" {
        let imports_fetch = named_children(node).into_iter().any(|child| {
            child.kind() != "string"
                && text(child, source).is_some_and(|value| {
                    value
                        .split(|c: char| !c.is_alphanumeric() && c != '_')
                        .any(|part| part == "fetch")
                })
        });
        if imports_fetch {
            facts.fetch_shadowed = true;
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_facts(child, source, facts);
    }
}

fn member_parts(node: Node<'_>, source: &str) -> Option<(String, String)> {
    if node.kind() != "member_expression" {
        return None;
    }
    let object = node.child_by_field_name("object")?;
    let property = node.child_by_field_name("property")?;
    Some((
        identifier_text(object, source)?,
        identifier_text(property, source)?,
    ))
}

enum ObjectMethod {
    Absent,
    Literal(String),
    Uncertain,
}

fn object_method(node: Node<'_>, source: &str) -> Option<ObjectMethod> {
    if node.kind() != "object" {
        return None;
    }
    let mut literal_method: Option<String> = None;
    for child in named_children(node) {
        if matches!(child.kind(), "spread_element" | "method_definition") {
            return Some(ObjectMethod::Uncertain);
        }
        if child.kind() == "shorthand_property_identifier" && text(child, source) == Some("method")
        {
            return Some(ObjectMethod::Uncertain);
        }
        if child.kind() != "pair" {
            continue;
        }
        let key = child.child_by_field_name("key")?;
        if key.kind() == "computed_property_name" {
            return Some(ObjectMethod::Uncertain);
        }
        let key_text = identifier_text(key, source).or_else(|| plain_string(key, source));
        if key_text.as_deref() != Some("method") {
            continue;
        }
        let value = child.child_by_field_name("value")?;
        let Some(method) = plain_string(value, source) else {
            return Some(ObjectMethod::Uncertain);
        };
        if literal_method.is_some() {
            return Some(ObjectMethod::Uncertain);
        }
        literal_method = Some(method.to_uppercase());
    }
    Some(match literal_method {
        Some(method) => ObjectMethod::Literal(method),
        None => ObjectMethod::Absent,
    })
}

fn collect_usages(
    node: Node<'_>,
    source: &str,
    app_bindings: &HashSet<String>,
    local_handlers: &HashMap<String, (u32, u32)>,
    fetch_shadowed: bool,
    output: &mut ApiUsageExtraction,
) {
    if node.kind() == "call_expression" {
        if let Some(function) = call_function(node) {
            if let Some((object, property)) = member_parts(function, source) {
                let method = property.to_uppercase();
                if property == property.to_lowercase()
                    && app_bindings.contains(&object)
                    && HTTP_METHODS.contains(&method.as_str())
                {
                    if let Some(arguments) = call_arguments(node) {
                        let args = named_children(arguments);
                        if args.len() >= 2 {
                            if let Some(path) = plain_string(args[0], source) {
                                let handler = args[1];
                                let association = if matches!(
                                    handler.kind(),
                                    "arrow_function" | "function_expression"
                                ) {
                                    Some((
                                        None,
                                        handler.start_position().row as u32 + 1,
                                        handler.end_position().row as u32 + 1,
                                    ))
                                } else {
                                    identifier_text(handler, source).and_then(|name| {
                                        local_handlers
                                            .get(&name)
                                            .map(|(start, end)| (Some(name), *start, *end))
                                    })
                                };
                                if let Some((handler_name, handler_start_line, handler_end_line)) =
                                    association
                                {
                                    output.routes.push(ApiRouteUsage {
                                        method,
                                        path,
                                        handler_name,
                                        handler_start_line,
                                        handler_end_line,
                                        line: node.start_position().row as u32 + 1,
                                        column: node.start_position().column as u32,
                                    });
                                }
                            }
                        }
                    }
                }
            } else if !fetch_shadowed
                && identifier_text(function, source).as_deref() == Some("fetch")
            {
                if let Some(arguments) = call_arguments(node) {
                    let args = named_children(arguments);
                    if let Some(path) = args.first().and_then(|arg| plain_string(*arg, source)) {
                        if path.starts_with('/') && !path.starts_with("//") {
                            let method = match args.get(1) {
                                None => Some("GET".to_string()),
                                Some(options) => match object_method(*options, source) {
                                    Some(ObjectMethod::Literal(method)) => Some(method),
                                    Some(ObjectMethod::Absent) => Some("GET".to_string()),
                                    Some(ObjectMethod::Uncertain) => None,
                                    None => None,
                                },
                            };
                            if let Some(method) = method {
                                if HTTP_METHODS.contains(&method.as_str()) {
                                    output.fetches.push(ApiFetchUsage {
                                        method,
                                        path,
                                        line: node.start_position().row as u32 + 1,
                                        column: node.start_position().column as u32,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_usages(
            child,
            source,
            app_bindings,
            local_handlers,
            fetch_shadowed,
            output,
        );
    }
}

pub fn extract_api_usages(content: &str, language_name: &str) -> Result<ApiUsageExtraction> {
    let mut parser = parser_for(language_name)?;
    let tree: Tree = parser
        .parse(content, None)
        .ok_or_else(|| anyhow!("Failed to parse source"))?;
    let mut facts = ApiFacts::default();
    collect_facts(tree.root_node(), content, &mut facts);
    if facts.require_shadowed {
        facts
            .express_bindings
            .retain(|name| !facts.require_express_bindings.contains(name));
    }
    facts
        .express_bindings
        .retain(|name| !facts.tainted_identifiers.contains(name));
    facts.app_bindings.retain(|name| {
        !facts.tainted_identifiers.contains(name)
            && facts
                .app_factories
                .get(name)
                .is_some_and(|factory| facts.express_bindings.contains(factory))
    });
    facts
        .local_handlers
        .retain(|name, _| !facts.tainted_identifiers.contains(name));
    let mut output = ApiUsageExtraction::default();
    collect_usages(
        tree.root_node(),
        content,
        &facts.app_bindings,
        &facts.local_handlers,
        facts.fetch_shadowed,
        &mut output,
    );
    output
        .routes
        .sort_by_key(|route| (route.line, route.column));
    output
        .fetches
        .sort_by_key(|fetch| (fetch.line, fetch.column));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_proven_named_and_inline_express_routes() {
        let source = r#"
import express from "express";
const app = express();
function createUser(req, res) { res.sendStatus(201); }
app.post('/users', createUser);
app.get('/health', (_req, res) => res.send('ok'));
"#;
        let result = extract_api_usages(source, "typescript").unwrap();
        assert_eq!(result.routes.len(), 2);
        assert_eq!(result.routes[0].method, "POST");
        assert_eq!(result.routes[0].path, "/users");
        assert_eq!(result.routes[0].handler_name.as_deref(), Some("createUser"));
        assert_eq!(result.routes[1].handler_name, None);
    }

    #[test]
    fn accepts_commonjs_factory_and_local_arrow_handler() {
        let source = r#"
const express = require('express');
const app = express();
const updateUser = async (req, res) => res.json({ ok: true });
app.patch('/users/one', updateUser);
"#;
        let result = extract_api_usages(source, "javascript").unwrap();
        assert_eq!(result.routes.len(), 1);
        assert_eq!(result.routes[0].handler_name.as_deref(), Some("updateUser"));
    }

    #[test]
    fn rejects_dynamic_paths_imported_handlers_and_express_lookalikes() {
        let source = r#"
import express from 'express';
import { importedHandler } from './handler';
const app = express();
const path = '/users';
app.get(path, (_req, res) => res.send('no'));
app.get('/imported', importedHandler);
other.get('/fake', (_req, res) => res.send('no'));
"#;
        let result = extract_api_usages(source, "typescript").unwrap();
        assert!(result.routes.is_empty());
    }

    #[test]
    fn extracts_only_exact_relative_literal_fetches() {
        let source = r#"
fetch('/users');
fetch('/users', { method: 'POST' });
fetch(`/users/${id}`, { method: 'DELETE' });
fetch('https://example.com/users');
fetch(path, { method: 'PATCH' });
fetch('/dynamic-method', { method });
"#;
        let result = extract_api_usages(source, "typescript").unwrap();
        assert_eq!(result.fetches.len(), 2);
        assert_eq!(result.fetches[0].method, "GET");
        assert_eq!(result.fetches[1].method, "POST");
    }

    #[test]
    fn ignores_comments_strings_and_preserves_duplicate_literal_routes() {
        let source = r#"
import express from 'express';
const app = express();
const handler = (_req, res) => res.send('ok');
// app.get('/comment', handler)
const example = "app.get('/string', handler)";
app.get('/duplicate', handler);
app.get('/duplicate', handler);
"#;
        let result = extract_api_usages(source, "javascript").unwrap();
        assert_eq!(result.routes.len(), 2);
        assert!(result.routes.iter().all(|route| route.path == "/duplicate"));
    }

    #[test]
    fn suppresses_shadowed_fetch_and_reassigned_route_bindings() {
        let source = r#"
import express from 'express';
const app = express();
let handler = (_req, res) => res.send('ok');
handler = replacement;
app.get('/unsafe-handler', handler);
app = otherApp;
app.get('/unsafe-app', (_req, res) => res.send('no'));
function consumer(fetch) { fetch('/users'); }
fetch('/also-suppressed');
"#;
        let result = extract_api_usages(source, "typescript").unwrap();
        assert!(result.routes.is_empty());
        assert!(result.fetches.is_empty());
    }

    #[test]
    fn suppresses_typed_app_shadowing_and_shadowed_require() {
        let typed_shadow = r#"
import express from 'express';
const app = express();
const handler = (_req, res) => res.send('ok');
function nested(app: unknown) { return app; }
app.get('/unsafe', handler);
"#;
        assert!(extract_api_usages(typed_shadow, "typescript")
            .unwrap()
            .routes
            .is_empty());

        let require_shadow = r#"
function factory(require: Function) {
  const express = require('express');
  const app = express();
  app.get('/unsafe', (_req, res) => res.send('no'));
}
"#;
        assert!(extract_api_usages(require_shadow, "typescript")
            .unwrap()
            .routes
            .is_empty());
    }

    #[test]
    fn rejects_escaped_route_and_fetch_literals_without_runtime_decoding() {
        let source = r#"
import express from 'express';
const app = express();
const handler = (_req, res) => res.send('ok');
app.get('/user\x73', handler);
fetch('/user\x73');
"#;
        let result = extract_api_usages(source, "javascript").unwrap();
        assert!(result.routes.is_empty());
        assert!(result.fetches.is_empty());
    }

    #[test]
    fn suppresses_duplicate_named_handler_declarations() {
        let source = r#"
import express from 'express';
const app = express();
function handler(_req, res) { res.send('one'); }
function handler(_req, res) { res.send('two'); }
app.get('/ambiguous-handler', handler);
"#;
        assert!(extract_api_usages(source, "javascript")
            .unwrap()
            .routes
            .is_empty());
    }

    #[test]
    fn rejects_uncertain_fetch_options_object_semantics() {
        let source = r#"
fetch('/spread-after', { method: 'POST', ...options });
fetch('/spread-only', { ...options });
fetch('/duplicate', { method: 'POST', method: 'DELETE' });
fetch('/computed', { [key]: 'POST' });
fetch('/getter', { get method() { return 'POST'; } });
"#;
        assert!(extract_api_usages(source, "typescript")
            .unwrap()
            .fetches
            .is_empty());
    }

    #[test]
    fn rejects_reassigned_fetch_uppercase_routes_and_mutated_app_methods() {
        let fetch_source = "fetch = fake; fetch('/users');";
        assert!(extract_api_usages(fetch_source, "javascript")
            .unwrap()
            .fetches
            .is_empty());

        let route_source = r#"
import express from 'express';
const app = express();
const handler = (_req, res) => res.send('ok');
app.POST('/uppercase', handler);
app.post = fake;
app.post('/mutated', handler);
"#;
        assert!(extract_api_usages(route_source, "javascript")
            .unwrap()
            .routes
            .is_empty());

        let require_source = r#"
const express = require('express');
require = fake;
const app = express();
app.get('/unsafe-require', (_req, res) => res.send('no'));
"#;
        assert!(extract_api_usages(require_source, "javascript")
            .unwrap()
            .routes
            .is_empty());
    }

    #[test]
    fn rejects_destructured_fetch_and_nested_duplicate_app_bindings() {
        let destructured_fetch = r#"
const { fetch } = client;
fetch('/users');
"#;
        assert!(extract_api_usages(destructured_fetch, "typescript")
            .unwrap()
            .fetches
            .is_empty());

        let nested_app = r#"
import express from 'express';
const app = express();
const handler = (_req, res) => res.send('ok');
function nested() { const app = fake; return app; }
app.get('/ambiguous-app', handler);
"#;
        assert!(extract_api_usages(nested_app, "typescript")
            .unwrap()
            .routes
            .is_empty());
    }
}
