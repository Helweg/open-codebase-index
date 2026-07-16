; Appels directs : helper(), min_value(...)
(call_expression
  function: (identifier) @callee.name) @call

; Appels de fonctions templates : helper<float>(...)
(call_expression
  function: (template_function
    name: (identifier) @callee.name)) @call

; Appels de méthodes : texture.sample(...)
(call_expression
  function: (field_expression
    field: (field_identifier) @callee.name)) @method.call

; Appels de méthodes templates : object.convert<float>(...)
(call_expression
  function: (field_expression
    field: (template_method
      name: (field_identifier) @callee.name))) @method.call

; Appels de méthodes templates dépendantes
(call_expression
  function: (field_expression
    field: (dependent_name
      (template_method
        name: (field_identifier) @callee.name)))) @method.call

; Appels qualifiés : metal::precise::rsqrt(...)
(call_expression
  function: (qualified_identifier
    name: (identifier) @callee.name)) @static.call

; Appels qualifiés de fonctions templates
(call_expression
  function: (qualified_identifier
    name: (template_function
      name: (identifier) @callee.name))) @static.call

; Identifiants qualifiés imbriqués récupérés par tree-sitter-cpp
(call_expression
  function: (qualified_identifier
    name: (qualified_identifier
      name: (identifier) @callee.name))) @static.call
