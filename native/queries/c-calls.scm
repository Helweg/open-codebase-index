; Direct calls: foo(), bar(1, 2)
(call_expression
  function: (identifier) @callee.name) @call

; Local and system includes: #include "header.h", #include <stdio.h>
(preproc_include
  path: [
    (string_literal)
    (system_lib_string)
  ] @import.name) @import

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

; Function-pointer or function-type aliases.
(type_definition
  declarator: (function_declarator
    declarator: (parenthesized_declarator
      (pointer_declarator
        declarator: (type_identifier) @indirect.type))))

(type_definition
  declarator: (function_declarator
    declarator: (type_identifier) @indirect.type))

; Parameters declared with an indirect function alias.
(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (identifier) @indirect.variable)

(parameter_declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (pointer_declarator
    declarator: (identifier) @indirect.variable))

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
  declarator: (init_declarator
    declarator: (identifier) @indirect.variable))

(declaration
  type: (type_identifier) @indirect.variable_type
  declarator: (init_declarator
    declarator: (pointer_declarator
      declarator: (identifier) @indirect.variable)))
