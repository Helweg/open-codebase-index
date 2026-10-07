; Kotlin tree-sitter-kotlin-ng 1.1.0. Expression calls do not establish
; constructor identity or overload/runtime dispatch, regardless of capitalization.

; Bare calls, generic calls, and calls with trailing lambdas.
(call_expression
  .
  (identifier) @callee.name) @call

; Member, safe-navigation, and chained calls. Callable references (::) are
; deliberately excluded; references alone do not execute the named function.
(call_expression
  .
  (navigation_expression
    .
    (_) @callee.object
    ["." "?."]
    (identifier) @callee.name
    .)) @method.call

; The grammar explicitly identifies supertype/annotation constructor invocation.
; Capture the terminal type identifier, not a generic argument or namespace.
(constructor_invocation
  (user_type
    (identifier) @callee.name
    (type_arguments)?
    .)) @constructor

; Declaration captures retain the common caller contract for query consumers.
(function_declaration
  name: (identifier) @caller.name) @caller
