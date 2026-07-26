; Direct calls: foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Member calls: object.method(), pointer->method()
; Pointer-to-member operators are intentionally excluded.
(call_expression
  function: (field_expression
    operator: ["." "->"]
    field: (field_identifier) @callee.name)) @method.call

; Qualified calls: namespace::function(), Type::method()
; Without type analysis, these remain classified as direct calls.
(call_expression
  function: (qualified_identifier) @callee.name
  (#match? @callee.name "(^|::)[A-Za-z_][A-Za-z0-9_]*$")
  (#not-match? @callee.name "[<>]")) @call

; Explicit heap constructors: new Widget(...)
(new_expression
  type: (type_identifier) @callee.name) @constructor

; Qualified heap constructors: new namespace::Widget(...)
(new_expression
  type: (qualified_identifier) @callee.name
  (#match? @callee.name "(^|::)[A-Za-z_][A-Za-z0-9_]*$")
  (#not-match? @callee.name "[<>]")) @constructor

; Braced temporary constructors: Widget{...}
(compound_literal_expression
  type: (type_identifier) @callee.name) @constructor

; Qualified braced temporary constructors: namespace::Widget{...}
(compound_literal_expression
  type: (qualified_identifier) @callee.name
  (#match? @callee.name "(^|::)[A-Za-z_][A-Za-z0-9_]*$")
  (#not-match? @callee.name "[<>]")) @constructor

; Stack constructors: Widget value(...), Widget value{...}
(declaration
  type: [
    (type_identifier)
    (qualified_identifier)
  ] @callee.name
  declarator: (init_declarator
    value: [
      (argument_list)
      (initializer_list)
    ])) @constructor

; Copy-initialized temporary constructors: Widget value = Widget(...)
; The extractor verifies that @constructor.type and @callee.name are equal.
(declaration
  type: [
    (type_identifier)
    (qualified_identifier)
  ] @constructor.type
  declarator: (init_declarator
    value: (call_expression
      function: [
        (identifier)
        (qualified_identifier)
      ] @callee.name))) @constructor

; Local and system includes: #include "header.hpp", #include <memory>
(preproc_include
  path: [
    (string_literal)
    (system_lib_string)
  ] @import.name) @import

; Namespace imports: using namespace std;
(using_declaration
  "namespace"
  (identifier) @import.namespace) @import

; Qualified namespace imports: using namespace project::detail;
(using_declaration
  "namespace"
  (qualified_identifier) @import.namespace
  (#not-match? @import.namespace "[<>]")) @import

; Macros defined in this file are excluded from ordinary calls.
(preproc_function_def
  name: (identifier) @excluded.name)

(preproc_def
  name: (identifier) @excluded.name)

; Function-pointer variables, parameters, and aliases.
(function_declarator
  declarator: (parenthesized_declarator
    (pointer_declarator
      declarator: [
        (identifier)
        (field_identifier)
        (type_identifier)
      ] @excluded.name)))

; Function-pointer or function-type aliases declared with typedef or using.
(type_definition
  declarator: (function_declarator
    declarator: (parenthesized_declarator
      (pointer_declarator
        declarator: (type_identifier) @indirect.type))))

(type_definition
  declarator: (function_declarator
    declarator: (type_identifier) @indirect.type))

(alias_declaration
  name: (type_identifier) @indirect.type
  type: (type_descriptor
    declarator: (abstract_function_declarator)))

; Parameters declared with an indirect function alias.
(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (identifier) @indirect.variable)

(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (identifier) @indirect.variable))

(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (reference_declarator
    (identifier) @indirect.variable))

; Callable fields declared with an indirect function alias.
(field_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (field_identifier) @indirect.variable)

(field_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (field_identifier) @indirect.variable))

; Local or global variables declared with the same alias type.
(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (identifier) @indirect.variable)

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (reference_declarator
    (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (pointer_declarator
      declarator: (identifier) @indirect.variable)))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (reference_declarator
      (identifier) @indirect.variable)))
