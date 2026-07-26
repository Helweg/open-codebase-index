; =============================================================
; Swift call graph extraction with tree-sitter-swift 0.7.3
; =============================================================

; Direct calls, including try/await and trailing closures.
((call_expression
  .
  (simple_identifier) @callee.name
  (call_suffix) @call.suffix) @call
  (#match? @call.suffix "^[({]"))

; Type() is syntactically identical to function().
((call_expression
  .
  (simple_identifier) @callee.name
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#match? @callee.name "^[A-Z]"))

; Instance, static/class, self/super, optional, and chained calls.
((call_expression
  .
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @callee.name))
  (call_suffix) @call.suffix) @method.call
  (#match? @call.suffix "^[({]"))

; Module.Type() is syntactically identical to object.method().
((call_expression
  .
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @callee.name))
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#match? @callee.name "^[A-Z]"))

; Type.init(), Module.Type.init(), self.init(), and super.init().
((call_expression
  .
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @callee.name))
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#eq? @callee.name "init"))

; Implicit members such as .success(value) and .init().
((call_expression
  .
  (prefix_expression
    (simple_identifier) @callee.name)
  (call_suffix) @call.suffix) @method.call
  (#match? @call.suffix "^[({]"))

((call_expression
  .
  (prefix_expression
    (simple_identifier) @callee.name)
  (call_suffix) @call.suffix) @constructor
  (#match? @call.suffix "^[({]")
  (#eq? @callee.name "init"))

; Unqualified generic invocation: generic<T>() or Type<T>().
(constructor_expression
  constructed_type: (user_type
    .
    (type_identifier) @callee.name
    .
    (type_arguments))) @call

; Qualified generic invocation: object.method<T>() or Module.Type<T>().
(constructor_expression
  constructed_type: (user_type
    (type_identifier)
    (type_identifier) @callee.name
    .
    (type_arguments))) @method.call

; Uppercase generic invocations are constructor candidates.
((constructor_expression
  constructed_type: (user_type
    (type_identifier) @callee.name
    .
    (type_arguments))) @constructor
  (#match? @callee.name "^[A-Z]"))

; Explicit generic initializer.
((constructor_expression
  constructed_type: (user_type
    (type_identifier) @callee.name
    .
    (type_arguments))) @constructor
  (#eq? @callee.name "init"))

; Simple and selective imports: retain the terminal name.
(import_declaration
  (identifier
    (simple_identifier) @import.name
    .)) @import

; First inheritance element of a non-generic class.
(class_declaration
  declaration_kind: "class"
  name: (_)
  .
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @inherits.name .)
      (user_type (type_identifier) @inherits.name . (type_arguments))
    ])) @inherits

; First inheritance element of a generic class.
(class_declaration
  declaration_kind: "class"
  name: (_)
  (type_parameters)
  .
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @inherits.name .)
      (user_type (type_identifier) @inherits.name . (type_arguments))
    ])) @inherits

; Any element preceded by an inheritance_specifier is a conformance.
; The intentional lack of an anchor between the two elements is important.
(class_declaration
  declaration_kind: "class"
  (inheritance_specifier)
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @implements.name .)
      (user_type (type_identifier) @implements.name . (type_arguments))
    ])) @implements

; Annotated conformance in first position: @unchecked, @preconcurrency, etc.
(class_declaration
  declaration_kind: "class"
  (attribute)
  .
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @implements.name .)
      (user_type (type_identifier) @implements.name . (type_arguments))
    ])) @implements

; Struct, enum, actor, and extension conformances.
(class_declaration
  declaration_kind: [
    "actor"
    "enum"
    "extension"
    "struct"
  ]
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @implements.name .)
      (user_type (type_identifier) @implements.name . (type_arguments))
    ])) @implements

; Protocol inheritance.
(protocol_declaration
  (inheritance_specifier
    inherits_from: [
      (user_type (type_identifier) @inherits.name .)
      (user_type (type_identifier) @inherits.name . (type_arguments))
    ])) @inherits
