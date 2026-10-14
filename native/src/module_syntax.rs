use crate::types::Language;
use napi_derive::napi;
use std::collections::HashMap;
use tree_sitter::{Node, Parser, Tree};

#[napi(object)]
#[derive(Default)]
pub struct ModuleSyntaxData {
    pub valid: bool,
    pub bindings: Vec<ModuleBindingData>,
    pub calls: Vec<ModuleCallData>,
    pub exports: Vec<ModuleExportData>,
    pub star_exports: Vec<String>,
}

#[napi(object)]
pub struct ModuleBindingData {
    pub name: String,
    pub kind: String,
    pub declaration_kind: String,
    pub scope_id: u32,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub callable: bool,
    pub constructable: bool,
    pub mutated: bool,
    pub source: Option<String>,
    pub imported_name: Option<String>,
    pub import_line: Option<u32>,
    pub import_col: Option<u32>,
}

#[napi(object)]
pub struct ModuleCallData {
    pub name: String,
    pub line: u32,
    pub column: u32,
    pub call_type: String,
    pub binding_index: Option<u32>,
    pub qualifier: Option<String>,
    pub constructor_owner: Option<ModuleConstructorOwnerData>,
}

#[napi(object)]
pub struct ModuleConstructorOwnerData {
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[napi(object)]
pub struct ModuleExportData {
    pub exported_name: String,
    pub kind: String,
    pub local_name: Option<String>,
    pub source: Option<String>,
    pub imported_name: Option<String>,
}

struct Scope {
    parent: Option<usize>,
    function: bool,
}

struct Binding<'tree, 'source> {
    name: &'source str,
    node: Node<'tree>,
    scope: usize,
    kind: &'static str,
    callable: bool,
    constructable: bool,
    mutated: bool,
    source: Option<&'source str>,
    imported_name: Option<&'source str>,
    require_scope: Option<usize>,
    import_node: Option<Node<'tree>>,
}

fn binding_available(binding: &Binding<'_, '_>, use_node: Node<'_>) -> bool {
    if matches!(binding.kind, "import" | "namespace")
        || matches!(
            binding.node.kind(),
            "function_declaration" | "generator_function_declaration"
        )
    {
        return true;
    }
    binding.node.end_byte() <= use_node.start_byte()
        || binding
            .node
            .child_by_field_name("body")
            .is_some_and(|body| {
                body.start_byte() <= use_node.start_byte() && body.end_byte() >= use_node.end_byte()
            })
}

struct EsmExport<'source> {
    exported_name: &'source str,
    kind: &'static str,
    local_name: Option<&'source str>,
    source: Option<&'source str>,
    imported_name: Option<&'source str>,
}

struct Proof<'tree, 'source> {
    source: &'source str,
    language: Language,
    scopes: Vec<Scope>,
    bindings: Vec<Binding<'tree, 'source>>,
    names: HashMap<(usize, &'source str), Option<usize>>,
    calls: Vec<(Node<'tree>, usize, &'static str, Option<Node<'tree>>)>,
    constructor_owners: Option<Vec<(usize, ModuleConstructorOwnerData)>>,
    writes: Vec<(Node<'tree>, usize)>,
    root_exports: Vec<(Node<'tree>, usize)>,
    esm_exports: Vec<EsmExport<'source>>,
    star_exports: Vec<&'source str>,
    unknown_exports: bool,
    esm_syntax: bool,
    require_written: bool,
    module_written: bool,
    exports_written: bool,
    builtin_uses: Vec<(Node<'tree>, usize)>,
    valid: bool,
}

fn is_cjs_wrapper_name(name: &str) -> bool {
    matches!(
        name,
        "require" | "module" | "exports" | "__dirname" | "__filename"
    )
}

fn text<'source>(node: Node<'_>, source: &'source str) -> &'source str {
    node.utf8_text(source.as_bytes()).unwrap_or("")
}

fn unparen(mut node: Node<'_>) -> Node<'_> {
    while node.kind() == "parenthesized_expression" {
        let Some(child) = node.named_child(0) else {
            break;
        };
        node = child;
    }
    node
}

fn literal<'source>(node: Node<'_>, source: &'source str) -> Option<&'source str> {
    if node.kind() != "string" {
        return None;
    }
    let value = text(node, source);
    if value.len() < 2 || value.contains('\\') {
        return None;
    }
    Some(&value[1..value.len() - 1])
}

fn is_function(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "function_declaration"
            | "function_expression"
            | "function"
            | "generator_function_declaration"
            | "generator_function"
            | "arrow_function"
            | "method_definition"
    )
}

fn is_instance_constructor(node: Node<'_>, source: &str) -> bool {
    if node.kind() != "method_definition"
        || !node
            .parent()
            .is_some_and(|parent| parent.kind() == "class_body")
        || !node.child_by_field_name("name").is_some_and(|name| {
            name.kind() == "property_identifier" && text(name, source) == "constructor"
        })
    {
        return false;
    }
    let mut cursor = node.walk();
    let is_static = node
        .children(&mut cursor)
        .any(|child| child.kind() == "static");
    !is_static
}

fn constructable(node: Node<'_>) -> bool {
    if matches!(
        node.kind(),
        "class_declaration" | "abstract_class_declaration" | "class"
    ) {
        return true;
    }
    if !matches!(
        node.kind(),
        "function_declaration" | "function_expression" | "function"
    ) {
        return false;
    }
    let mut cursor = node.walk();
    let forbidden = node
        .children(&mut cursor)
        .any(|child| matches!(child.kind(), "async" | "*"));
    !forbidden
}

fn module_exports(node: Node<'_>, source: &str) -> bool {
    node.kind() == "member_expression"
        && node
            .child_by_field_name("object")
            .is_some_and(|object| object.kind() == "identifier" && text(object, source) == "module")
        && node
            .child_by_field_name("property")
            .is_some_and(|property| text(property, source) == "exports")
}

fn touches_exports(mut node: Node<'_>, source: &str) -> bool {
    loop {
        if module_exports(node, source)
            || (node.kind() == "identifier" && text(node, source) == "exports")
        {
            return true;
        }
        if !matches!(node.kind(), "member_expression" | "subscript_expression") {
            return false;
        }
        let Some(object) = node.child_by_field_name("object") else {
            return false;
        };
        node = object;
    }
}

fn availability_guard(node: Node<'_>, source: &str) -> bool {
    if node.kind() != "if_statement" || node.child_by_field_name("alternative").is_some() {
        return false;
    }
    let Some(condition) = node.child_by_field_name("condition").map(unparen) else {
        return false;
    };
    if condition.kind() != "binary_expression" {
        return false;
    }
    let (Some(left), Some(right), Some(operator)) = (
        condition.child_by_field_name("left"),
        condition.child_by_field_name("right"),
        condition.child_by_field_name("operator"),
    ) else {
        return false;
    };
    let left = unparen(left);
    text(operator, source) == "!=="
        && literal(right, source) == Some("undefined")
        && left.kind() == "unary_expression"
        && left
            .child_by_field_name("operator")
            .is_some_and(|operator| text(operator, source) == "typeof")
        && left
            .child_by_field_name("argument")
            .is_some_and(|argument| {
                argument.kind() == "identifier" && text(argument, source) == "module"
            })
}

fn static_export_position(node: Node<'_>, source: &str) -> bool {
    let mut child = node;
    let mut guard_seen = false;
    while let Some(parent) = child.parent() {
        match parent.kind() {
            "program" => return true,
            "expression_statement" | "statement_block" => {}
            "if_statement"
                if !guard_seen
                    && availability_guard(parent, source)
                    && parent.child_by_field_name("consequence") == Some(child) =>
            {
                guard_seen = true;
            }
            _ => return false,
        }
        child = parent;
    }
    false
}

impl<'tree, 'source> Proof<'tree, 'source> {
    fn add(
        &mut self,
        name: &'source str,
        node: Node<'tree>,
        scope: usize,
        kind: &'static str,
    ) -> usize {
        if name.contains('\\') {
            self.valid = false;
        }
        let index = self.bindings.len();
        if kind != "ambient" {
            self.names
                .entry((scope, name))
                .and_modify(|binding| *binding = None)
                .or_insert(Some(index));
        }
        self.bindings.push(Binding {
            name,
            node,
            scope,
            kind,
            callable: kind != "ambient"
                && node.child_by_field_name("body").is_some()
                && is_function(node)
                && node.kind() != "method_definition",
            constructable: kind != "ambient"
                && node.child_by_field_name("body").is_some()
                && constructable(node),
            mutated: false,
            source: None,
            imported_name: None,
            require_scope: None,
            import_node: None,
        });
        index
    }

    fn pattern(
        &mut self,
        node: Node<'tree>,
        declaration: Node<'tree>,
        scope: usize,
        kind: &'static str,
    ) {
        match node.kind() {
            "identifier" | "shorthand_property_identifier_pattern" => {
                let name = text(node, self.source);
                if name.contains('\\') {
                    self.valid = false;
                    return;
                }
                self.add(name, declaration, scope, kind);
            }
            "pair_pattern"
            | "assignment_pattern"
            | "object_assignment_pattern"
            | "required_parameter"
            | "optional_parameter" => {
                let field = match node.kind() {
                    "pair_pattern" => "value",
                    "required_parameter" | "optional_parameter" => "pattern",
                    _ => "left",
                };
                if let Some(pattern) = node.child_by_field_name(field) {
                    self.pattern(pattern, declaration, scope, kind);
                } else {
                    self.valid = false;
                }
            }
            "formal_parameters" | "object_pattern" | "array_pattern" | "rest_pattern" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if child.kind() != "comment" {
                        self.pattern(child, declaration, scope, kind);
                    }
                }
            }
            _ => self.valid = false,
        }
    }

    fn lookup(&self, mut scope: usize, name: &'source str) -> Option<usize> {
        loop {
            if let Some(binding) = self.names.get(&(scope, name)) {
                return *binding;
            }
            scope = self.scopes[scope].parent?;
        }
    }

    fn bound(&self, mut scope: usize, name: &'source str) -> bool {
        loop {
            if self.names.contains_key(&(scope, name)) {
                return true;
            }
            let Some(parent) = self.scopes[scope].parent else {
                return false;
            };
            scope = parent;
        }
    }

    fn function_scope(&self, mut scope: usize) -> usize {
        while !self.scopes[scope].function {
            scope = self.scopes[scope].parent.unwrap_or(0);
        }
        scope
    }

    fn imports(&mut self, node: Node<'tree>, scope: usize, ambient: bool) {
        let Some(source) = node
            .child_by_field_name("source")
            .and_then(|source| literal(source, self.source))
        else {
            self.valid = false;
            return;
        };
        // A type-only import introduces no runtime binding and is not runtime module syntax.
        let mut modifier_cursor = node.walk();
        if node
            .children(&mut modifier_cursor)
            .any(|child| child.kind() == "type")
        {
            return;
        }
        if !ambient {
            self.esm_syntax = true;
        }
        let mut cursor = node.walk();
        let Some(clause) = node
            .named_children(&mut cursor)
            .find(|child| child.kind() == "import_clause")
        else {
            return;
        };
        let mut cursor = clause.walk();
        for child in clause.named_children(&mut cursor) {
            match child.kind() {
                "identifier" => {
                    let index = self.add(
                        text(child, self.source),
                        child,
                        scope,
                        if ambient { "ambient" } else { "import" },
                    );
                    self.bindings[index].source = Some(source);
                    self.bindings[index].imported_name = Some("default");
                    self.bindings[index].import_node = Some(child);
                }
                "namespace_import" => {
                    if let Some(name) = child.named_child(0) {
                        let index = self.add(
                            text(name, self.source),
                            name,
                            scope,
                            if ambient { "ambient" } else { "namespace" },
                        );
                        self.bindings[index].source = Some(source);
                        self.bindings[index].import_node = Some(name);
                    }
                }
                "named_imports" => {
                    let mut cursor = child.walk();
                    for specifier in child.named_children(&mut cursor) {
                        if specifier.kind() == "comment" {
                            continue;
                        }
                        let mut modifier_cursor = specifier.walk();
                        if specifier
                            .children(&mut modifier_cursor)
                            .any(|child| child.kind() == "type")
                        {
                            continue;
                        }
                        let Some(name) = specifier.child_by_field_name("name") else {
                            self.valid = false;
                            continue;
                        };
                        let local = specifier.child_by_field_name("alias").unwrap_or(name);
                        let index = self.add(
                            text(local, self.source),
                            local,
                            scope,
                            if ambient { "ambient" } else { "import" },
                        );
                        self.bindings[index].source = Some(source);
                        self.bindings[index].imported_name = Some(text(name, self.source));
                        self.bindings[index].import_node = Some(name);
                    }
                }
                _ => self.valid = false,
            }
        }
    }

    fn visit(
        &mut self,
        node: Node<'tree>,
        parent_scope: usize,
        depth: usize,
        ambient: bool,
        constructor_owner: Option<Node<'tree>>,
    ) {
        if depth > 1024 {
            self.valid = false;
            return;
        }
        let ambient = ambient || node.kind() == "ambient_declaration";
        if node.kind() == "identifier" && text(node, self.source).contains('\\') {
            self.valid = false;
        }
        if !ambient
            && matches!(node.kind(), "identifier" | "shorthand_property_identifier")
            && matches!(text(node, self.source), "module" | "exports")
        {
            self.builtin_uses.push((node, parent_scope));
        }
        let mut scope = parent_scope;
        let function = is_function(node);
        let constructor_owner = if self.constructor_owners.is_none() {
            None
        } else if function {
            is_instance_constructor(node, self.source).then_some(node)
        } else if matches!(
            node.kind(),
            "class" | "class_declaration" | "abstract_class_declaration" | "class_body"
        ) {
            None
        } else {
            constructor_owner
        };
        let creates_scope = function
            || matches!(
                node.kind(),
                "class"
                    | "class_declaration"
                    | "abstract_class_declaration"
                    | "statement_block"
                    | "catch_clause"
                    | "for_statement"
                    | "for_in_statement"
                    | "switch_body"
                    | "class_body"
            );
        if creates_scope {
            scope = self.scopes.len();
            self.scopes.push(Scope {
                parent: Some(parent_scope),
                function,
            });
        }
        match node.kind() {
            "function_declaration"
            | "generator_function_declaration"
            | "class_declaration"
            | "abstract_class_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    // A program-scope lexical class declaration of a wrapper name is ESM-exclusive.
                    if matches!(
                        node.kind(),
                        "class_declaration" | "abstract_class_declaration"
                    ) && !ambient
                        && parent_scope == 0
                        && is_cjs_wrapper_name(text(name, self.source))
                    {
                        self.esm_syntax = true;
                    }
                    self.add(
                        text(name, self.source),
                        node,
                        parent_scope,
                        if ambient { "ambient" } else { "local" },
                    );
                }
            }
            "function_expression" | "function" | "generator_function" | "class" => {
                if let Some(name) = node.child_by_field_name("name") {
                    self.add(
                        text(name, self.source),
                        node,
                        scope,
                        if ambient { "ambient" } else { "local" },
                    );
                }
            }
            "variable_declarator" => {
                let Some(name) = node.child_by_field_name("name") else {
                    self.valid = false;
                    return;
                };
                let declaration = node.parent().unwrap_or(node);
                let is_var = declaration.kind() == "variable_declaration";
                let binding_scope = if is_var {
                    self.function_scope(scope)
                } else {
                    scope
                };
                let value = node.child_by_field_name("value").map(unparen);
                let callable =
                    value.filter(|value| is_function(*value) || matches!(value.kind(), "class"));
                if name.kind() == "identifier" {
                    // Program-scope lexical redeclaration of a wrapper name is ESM-exclusive.
                    if !ambient
                        && !is_var
                        && binding_scope == 0
                        && is_cjs_wrapper_name(text(name, self.source))
                    {
                        self.esm_syntax = true;
                    }
                    let index = self.add(
                        text(name, self.source),
                        callable.unwrap_or(node),
                        binding_scope,
                        if ambient { "ambient" } else { "local" },
                    );
                    if let Some(value) = value.filter(|value| value.kind() == "call_expression") {
                        if let (Some(callee), Some(arguments)) = (
                            value.child_by_field_name("function"),
                            value.child_by_field_name("arguments"),
                        ) {
                            if callee.kind() == "identifier"
                                && text(callee, self.source) == "require"
                            {
                                let mut cursor = arguments.walk();
                                let mut arguments = arguments
                                    .named_children(&mut cursor)
                                    .filter(|argument| argument.kind() != "comment");
                                let source = arguments
                                    .next()
                                    .and_then(|argument| literal(argument, self.source));
                                if !ambient
                                    && scope == 0
                                    && declaration
                                        .child(0)
                                        .is_some_and(|kind| kind.kind() == "const")
                                    && arguments.next().is_none()
                                    && source.is_some()
                                {
                                    self.bindings[index].kind = "require";
                                    self.bindings[index].source = source;
                                    self.bindings[index].imported_name = Some("default");
                                    self.bindings[index].require_scope = Some(scope);
                                }
                            }
                        }
                    }
                } else {
                    let first_binding = self.bindings.len();
                    self.pattern(
                        name,
                        node,
                        binding_scope,
                        if ambient { "ambient" } else { "unsupported" },
                    );
                    if !ambient
                        && !is_var
                        && binding_scope == 0
                        && self.bindings[first_binding..]
                            .iter()
                            .any(|binding| is_cjs_wrapper_name(binding.name))
                    {
                        self.esm_syntax = true;
                    }
                }
            }
            "import_statement" => self.imports(node, scope, ambient),
            "catch_clause" => {
                if let Some(parameter) = node.child_by_field_name("parameter") {
                    self.pattern(
                        parameter,
                        parameter,
                        scope,
                        if ambient { "ambient" } else { "unsupported" },
                    );
                }
            }
            "for_in_statement" if node.child_by_field_name("kind").is_some() => {
                if let Some(pattern) = node.child_by_field_name("left") {
                    let binding_scope = if node
                        .child_by_field_name("kind")
                        .is_some_and(|kind| text(kind, self.source) == "var")
                    {
                        self.function_scope(scope)
                    } else {
                        scope
                    };
                    self.pattern(
                        pattern,
                        pattern,
                        binding_scope,
                        if ambient { "ambient" } else { "unsupported" },
                    );
                }
            }
            "enum_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    self.add(
                        text(name, self.source),
                        node,
                        scope,
                        if ambient { "ambient" } else { "unsupported" },
                    );
                }
            }
            "assignment_expression" | "augmented_assignment_expression" | "update_expression"
                if !ambient =>
            {
                if let Some(left) = node
                    .child_by_field_name("left")
                    .or_else(|| node.child_by_field_name("argument"))
                {
                    self.writes.push((left, scope));
                    if touches_exports(left, self.source) {
                        if module_exports(left, self.source)
                            && node.kind() == "assignment_expression"
                            && static_export_position(node, self.source)
                        {
                            if let Some(right) = node
                                .child_by_field_name("right")
                                .filter(|right| right.kind() == "identifier")
                            {
                                self.root_exports.push((right, scope));
                            } else {
                                self.unknown_exports = true;
                            }
                        } else {
                            self.unknown_exports = true;
                        }
                    }
                }
            }
            "export_statement" if !ambient => self.export_statement(node),
            "with_statement" if !ambient => self.valid = false,
            _ => {}
        }
        if function {
            if let Some(parameters) = node
                .child_by_field_name("parameters")
                .or_else(|| node.child_by_field_name("parameter"))
            {
                self.pattern(
                    parameters,
                    parameters,
                    scope,
                    if ambient { "ambient" } else { "unsupported" },
                );
            }
        }
        // import.meta and top-level await are ESM-only, so they invalidate a script CommonJS root.
        if !ambient
            && node.kind() == "meta_property"
            && text(node, self.source).starts_with("import")
        {
            self.esm_syntax = true;
        }
        if !ambient && node.kind() == "await_expression" && !self.inside_function(scope) {
            self.esm_syntax = true;
        }
        if !ambient && node.kind() == "for_in_statement" && !self.inside_function(scope) {
            let mut await_cursor = node.walk();
            if node
                .children(&mut await_cursor)
                .any(|child| child.kind() == "await")
            {
                self.esm_syntax = true;
            }
        }
        let call_type = match node.kind() {
            "call_expression" => Some("Call"),
            "new_expression" => Some("Constructor"),
            "extends_clause" => Some("Inherits"),
            _ => None,
        };
        if let Some(call_type) = call_type.filter(|_| !ambient) {
            let field = match call_type {
                "Constructor" => "constructor",
                "Inherits" => "value",
                _ => "function",
            };
            if let Some(callee) = node.child_by_field_name(field).map(unparen) {
                if callee.kind() == "identifier" {
                    self.push_call(callee, scope, call_type, None, constructor_owner);
                } else if callee.kind() == "member_expression" {
                    if let (Some(object), Some(property)) = (
                        callee.child_by_field_name("object"),
                        callee.child_by_field_name("property"),
                    ) {
                        if object.kind() == "identifier" && property.kind() == "property_identifier"
                        {
                            self.push_call(
                                property,
                                scope,
                                if call_type == "Call" {
                                    "MethodCall"
                                } else {
                                    call_type
                                },
                                Some(object),
                                constructor_owner,
                            );
                        }
                    }
                }
            }
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.visit(child, scope, depth + 1, ambient, constructor_owner);
        }
    }

    fn push_call(
        &mut self,
        node: Node<'tree>,
        scope: usize,
        call_type: &'static str,
        qualifier: Option<Node<'tree>>,
        constructor_owner: Option<Node<'tree>>,
    ) {
        self.calls.push((node, scope, call_type, qualifier));
        if let (Some(owners), Some(owner)) = (&mut self.constructor_owners, constructor_owner) {
            let start = owner.start_position();
            let end = owner.end_position();
            owners.push((
                self.calls.len() - 1,
                ModuleConstructorOwnerData {
                    start_line: start.row as u32 + 1,
                    start_col: start.column as u32,
                    end_line: end.row as u32 + 1,
                    end_col: end.column as u32,
                },
            ));
        }
    }

    fn export_statement(&mut self, node: Node<'tree>) {
        let mut is_default = false;
        let mut type_only_statement = false;
        let mut export_assignment = false;
        let mut children = node.walk();
        for child in node.children(&mut children) {
            match child.kind() {
                "default" => is_default = true,
                "type" => type_only_statement = true,
                "=" => export_assignment = true,
                _ => {}
            }
        }
        // Type-only exports carry no expressible runtime ancestry.
        if type_only_statement {
            return;
        }
        if export_assignment {
            self.esm_syntax = true;
            self.esm_exports.push(EsmExport {
                exported_name: "",
                kind: "opaque",
                local_name: None,
                source: None,
                imported_name: None,
            });
            return;
        }
        let declaration = node.child_by_field_name("declaration");
        let erased_declaration = declaration.is_some_and(|declaration| {
            matches!(
                declaration.kind(),
                "interface_declaration" | "type_alias_declaration" | "ambient_declaration",
            )
        });
        if erased_declaration {
            return;
        }
        self.esm_syntax = true;
        let mut clause_cursor = node.walk();
        let clause = node
            .named_children(&mut clause_cursor)
            .find(|child| child.kind() == "export_clause");
        if let Some(clause) = clause {
            let source = node
                .child_by_field_name("source")
                .and_then(|source| literal(source, self.source));
            let mut specifier_cursor = clause.walk();
            for specifier in clause.named_children(&mut specifier_cursor) {
                if specifier.kind() != "export_specifier" {
                    continue;
                }
                let mut marker_cursor = specifier.walk();
                if specifier
                    .children(&mut marker_cursor)
                    .any(|child| child.kind() == "type")
                {
                    continue;
                }
                let Some(name) = specifier.child_by_field_name("name") else {
                    self.valid = false;
                    continue;
                };
                let alias = specifier.child_by_field_name("alias").unwrap_or(name);
                self.esm_exports.push(EsmExport {
                    exported_name: text(alias, self.source),
                    kind: if source.is_some() {
                        "reexport"
                    } else {
                        "local"
                    },
                    local_name: source.is_none().then(|| text(name, self.source)),
                    source,
                    imported_name: source.map(|_| text(name, self.source)),
                });
            }
            return;
        }
        if let Some(source) = node
            .child_by_field_name("source")
            .and_then(|source| literal(source, self.source))
        {
            let mut child_cursor = node.walk();
            if node
                .named_children(&mut child_cursor)
                .any(|child| child.kind() == "namespace_export")
            {
                self.esm_exports.push(EsmExport {
                    exported_name: "",
                    kind: "opaque",
                    local_name: None,
                    source: None,
                    imported_name: None,
                });
            } else {
                self.star_exports.push(source);
            }
            return;
        }
        if let Some(declaration) = node.child_by_field_name("declaration") {
            if matches!(
                declaration.kind(),
                "lexical_declaration" | "variable_declaration"
            ) {
                let mut declarator_cursor = declaration.walk();
                for declarator in declaration
                    .named_children(&mut declarator_cursor)
                    .filter(|child| child.kind() == "variable_declarator")
                {
                    match declarator.child_by_field_name("name") {
                        Some(name) if name.kind() == "identifier" => {
                            self.esm_exports.push(EsmExport {
                                exported_name: if is_default {
                                    "default"
                                } else {
                                    text(name, self.source)
                                },
                                kind: "local",
                                local_name: Some(text(name, self.source)),
                                source: None,
                                imported_name: None,
                            })
                        }
                        _ => self.esm_exports.push(EsmExport {
                            exported_name: "",
                            kind: "opaque",
                            local_name: None,
                            source: None,
                            imported_name: None,
                        }),
                    }
                }
                return;
            }
            if matches!(
                declaration.kind(),
                "function_declaration"
                    | "generator_function_declaration"
                    | "class_declaration"
                    | "abstract_class_declaration"
            ) {
                match declaration.child_by_field_name("name") {
                    Some(name) => self.esm_exports.push(EsmExport {
                        exported_name: if is_default {
                            "default"
                        } else {
                            text(name, self.source)
                        },
                        kind: "local",
                        local_name: Some(text(name, self.source)),
                        source: None,
                        imported_name: None,
                    }),
                    None => self.esm_exports.push(EsmExport {
                        exported_name: "",
                        kind: "opaque",
                        local_name: None,
                        source: None,
                        imported_name: None,
                    }),
                }
                return;
            }
            // A runtime declaration form this proof cannot express keeps resolution fail-closed.
            self.esm_exports.push(EsmExport {
                exported_name: "",
                kind: "opaque",
                local_name: None,
                source: None,
                imported_name: None,
            });
            return;
        }
        if let Some(value) = node.child_by_field_name("value") {
            if value.kind() == "identifier" {
                self.esm_exports.push(EsmExport {
                    exported_name: "default",
                    kind: "local",
                    local_name: Some(text(value, self.source)),
                    source: None,
                    imported_name: None,
                });
                return;
            }
        }
        self.esm_exports.push(EsmExport {
            exported_name: "",
            kind: "opaque",
            local_name: None,
            source: None,
            imported_name: None,
        });
    }

    /** True only for scopes created by a function, excluding the program scope. */
    fn inside_function(&self, mut scope: usize) -> bool {
        while scope != 0 {
            if self.scopes[scope].function {
                return true;
            }
            let Some(parent) = self.scopes[scope].parent else {
                return false;
            };
            scope = parent;
        }
        false
    }

    fn mark_write(&mut self, node: Node<'tree>, scope: usize) {
        match node.kind() {
            "identifier" | "shorthand_property_identifier_pattern" => {
                let name = text(node, self.source);
                if let Some(index) = self.lookup(scope, name) {
                    self.bindings[index].mutated = true;
                } else if !self.bound(scope, name) {
                    match name {
                        "require" => self.require_written = true,
                        "module" => self.module_written = true,
                        "exports" => self.exports_written = true,
                        _ => {}
                    }
                }
            }
            "array_pattern"
            | "object_pattern"
            | "rest_pattern"
            | "assignment_pattern"
            | "object_assignment_pattern"
            | "pair_pattern" => {
                let field = match node.kind() {
                    "pair_pattern" => Some("value"),
                    "assignment_pattern" | "object_assignment_pattern" => Some("left"),
                    _ => None,
                };
                if let Some(field) = field {
                    if let Some(child) = node.child_by_field_name(field) {
                        self.mark_write(child, scope);
                    }
                } else {
                    let mut cursor = node.walk();
                    for child in node.named_children(&mut cursor) {
                        self.mark_write(child, scope);
                    }
                }
            }
            _ => {}
        }
    }

    fn finish(mut self) -> ModuleSyntaxData {
        for index in 0..self.writes.len() {
            let (node, scope) = self.writes[index];
            self.mark_write(node, scope);
        }
        for &(node, scope) in &self.builtin_uses {
            if self.bound(scope, text(node, self.source)) {
                continue;
            }
            let allowed = node.parent().is_some_and(|parent| {
                (parent.kind() == "member_expression"
                    && parent.child_by_field_name("object") == Some(node)
                    && module_exports(parent, self.source)
                    && parent.parent().is_some_and(|assignment| {
                        assignment.kind() == "assignment_expression"
                            && assignment.child_by_field_name("left") == Some(parent)
                    }))
                    || (parent.kind() == "unary_expression"
                        && parent
                            .child_by_field_name("operator")
                            .is_some_and(|operator| operator.kind() == "typeof"))
            });
            if !allowed {
                self.unknown_exports = true;
            }
        }
        for &(node, scope, call_type, qualifier) in &self.calls {
            if call_type != "Call" || qualifier.is_some() || text(node, self.source) != "eval" {
                continue;
            }
            let own = self.lookup(scope, "eval").is_some_and(|index| {
                let binding = &self.bindings[index];
                binding.kind == "local"
                    && !binding.mutated
                    && (binding.callable || binding.constructable)
            });
            if !own {
                self.valid = false;
            }
        }
        for index in 0..self.bindings.len() {
            if let Some(scope) = self.bindings[index].require_scope {
                if self.esm_syntax || self.require_written || self.bound(scope, "require") {
                    self.bindings[index].kind = "unsupported";
                    self.bindings[index].source = None;
                }
            }
        }
        let mut constructor_owners = self
            .constructor_owners
            .take()
            .into_iter()
            .flatten()
            .peekable();
        let calls = self
            .calls
            .iter()
            .enumerate()
            .map(|(call_index, &(node, scope, call_type, qualifier))| {
                let position = node.start_position();
                let binding_index = self
                    .lookup(scope, text(qualifier.unwrap_or(node), self.source))
                    .filter(|&index| {
                        let binding = &self.bindings[index];
                        !binding.mutated && binding_available(binding, node)
                    })
                    .map(|index| index as u32);
                ModuleCallData {
                    name: text(node, self.source).to_owned(),
                    line: position.row as u32 + 1,
                    column: position.column as u32,
                    call_type: call_type.to_owned(),
                    binding_index,
                    qualifier: qualifier.map(|qualifier| text(qualifier, self.source).to_owned()),
                    constructor_owner: if constructor_owners
                        .peek()
                        .is_some_and(|(owner_index, _)| *owner_index == call_index)
                    {
                        constructor_owners.next().map(|(_, owner)| owner)
                    } else {
                        None
                    },
                }
            })
            .collect();
        let mut exports: Vec<ModuleExportData> = self
            .esm_exports
            .iter()
            .filter(|export| export.kind != "opaque")
            .map(|export| ModuleExportData {
                exported_name: export.exported_name.to_owned(),
                kind: export.kind.to_owned(),
                local_name: export.local_name.map(str::to_owned),
                source: export.source.map(str::to_owned),
                imported_name: export.imported_name.map(str::to_owned),
            })
            .collect();
        // Any export form the AST proof cannot express keeps generic resolution fail-closed.
        let opaque = self
            .esm_exports
            .iter()
            .any(|export| export.kind == "opaque");
        let uncertain = opaque || self.unknown_exports;
        if uncertain {
            exports.clear();
        }
        if !uncertain
            && !self.esm_syntax
            && !self.module_written
            && !self.exports_written
            && self.root_exports.len() == 1
        {
            let (node, scope) = self.root_exports[0];
            if !self.bound(scope, "module") && !self.bound(scope, "exports") {
                if let Some(index) = self.lookup(scope, text(node, self.source)) {
                    if !self.bindings[index].mutated
                        && self.bindings[index].scope == 0
                        && binding_available(&self.bindings[index], node)
                    {
                        exports.push(ModuleExportData {
                            exported_name: "default".to_owned(),
                            kind: "root".to_owned(),
                            local_name: Some(self.bindings[index].name.to_owned()),
                            source: None,
                            imported_name: None,
                        });
                    }
                }
            }
        }
        let bindings = self
            .bindings
            .into_iter()
            .map(|binding| {
                let start = binding.node.start_position();
                let end = binding.node.end_position();
                ModuleBindingData {
                    name: binding.name.to_owned(),
                    kind: binding.kind.to_owned(),
                    scope_id: binding.scope as u32,
                    declaration_kind: crate::parser::semantic_chunk_type(
                        &binding.node,
                        self.source,
                        &self.language,
                    ),
                    start_line: start.row as u32 + 1,
                    start_col: start.column as u32,
                    end_line: end.row as u32 + 1,
                    end_col: end.column as u32,
                    callable: binding.callable,
                    constructable: binding.constructable,
                    mutated: binding.mutated,
                    import_line: binding
                        .import_node
                        .map(|node| node.start_position().row as u32 + 1),
                    import_col: binding
                        .import_node
                        .map(|node| node.start_position().column as u32),
                    source: binding.source.map(str::to_owned),
                    imported_name: binding.imported_name.map(str::to_owned),
                }
            })
            .collect();
        ModuleSyntaxData {
            valid: self.valid,
            bindings,
            calls,
            exports,
            // An inexpressible or competing export surface must not fall back to star evidence.
            star_exports: if uncertain {
                Vec::new()
            } else {
                self.star_exports
                    .iter()
                    .map(|source| (*source).to_owned())
                    .collect()
            },
        }
    }
}

pub fn extract_from_tree(
    tree: &Tree,
    source: &str,
    language: Language,
    include_constructor_owners: bool,
) -> ModuleSyntaxData {
    if tree.root_node().has_error() {
        return ModuleSyntaxData::default();
    }
    let mut proof = Proof {
        source,
        language,
        scopes: vec![Scope {
            parent: None,
            function: true,
        }],
        bindings: Vec::new(),
        names: HashMap::new(),
        calls: Vec::new(),
        constructor_owners: include_constructor_owners.then(Vec::new),
        writes: Vec::new(),
        root_exports: Vec::new(),
        esm_exports: Vec::new(),
        star_exports: Vec::new(),
        unknown_exports: false,
        esm_syntax: false,
        valid: true,
        require_written: false,
        module_written: false,
        exports_written: false,
        builtin_uses: Vec::new(),
    };
    proof.visit(tree.root_node(), 0, 0, false, None);
    proof.finish()
}

#[napi]
pub fn extract_module_syntax(content: String, language: String) -> napi::Result<ModuleSyntaxData> {
    let (grammar, language) = match language.as_str() {
        "javascript" | "jsx" => (
            tree_sitter_javascript::LANGUAGE.into(),
            Language::JavaScript,
        ),
        "typescript" => (
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Language::TypeScript,
        ),
        "tsx" => (
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            Language::TypeScriptTsx,
        ),
        _ => return Ok(ModuleSyntaxData::default()),
    };
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let tree = parser
        .parse(&content, None)
        .ok_or_else(|| napi::Error::from_reason("Failed to parse module"))?;
    Ok(extract_from_tree(&tree, &content, language, false))
}
