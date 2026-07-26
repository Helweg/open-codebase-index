; Direct calls: helper(), min_value(...)
(call_expression
  function: (identifier) @callee.name) @call

; Template function calls: helper<float>(...)
(call_expression
  function: (template_function
    name: (identifier) @callee.name)) @call

; Method calls: texture.sample(...)
(call_expression
  function: (field_expression
    field: (field_identifier) @callee.name)) @method.call

; Template method calls: object.convert<float>(...)
(call_expression
  function: (field_expression
    field: (template_method
      name: (field_identifier) @callee.name))) @method.call

; Dependent template method calls
(call_expression
  function: (field_expression
    field: (dependent_name
      (template_method
        name: (field_identifier) @callee.name)))) @method.call

; Qualified calls: metal::precise::rsqrt(...)
(call_expression
  function: (qualified_identifier
    name: (identifier) @callee.name)) @static.call

; Qualified template function calls
(call_expression
  function: (qualified_identifier
    name: (template_function
      name: (identifier) @callee.name))) @static.call

; Nested qualified identifiers recovered by tree-sitter-cpp
(call_expression
  function: (qualified_identifier
    name: (qualified_identifier
      name: (identifier) @callee.name))) @static.call
