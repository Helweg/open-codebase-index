; =============================================================
; Tree-sitter query for extracting function calls from PHP
; =============================================================

; Direct function calls: foo(), strlen($s)
; Must be checked first to avoid being captured by method call patterns
(function_call_expression
  function: (name) @callee.name) @call

; Qualified function calls: Namespace\foo()
(function_call_expression
  function: (qualified_name
    (name) @callee.name)) @call

; Relative function calls: namespace\foo()
(function_call_expression
  function: (relative_name
    (name) @callee.name)) @call

; Static method calls: Foo::bar(), self::method()
(scoped_call_expression
  name: (name) @callee.name) @static.call

; Method calls: $obj->method()
(member_call_expression
  name: (name) @callee.name) @method.call

; Nullsafe method calls: $obj?->method()
(nullsafe_member_call_expression
  name: (name) @callee.name) @method.call

; Constructor calls: new Foo()
(object_creation_expression
  (name) @callee.name) @constructor

; Qualified constructor: new Namespace\Foo()
(object_creation_expression
  (qualified_name
    (name) @callee.name)) @constructor

; Relative constructor: new namespace\Foo()
(object_creation_expression
  (relative_name
    (name) @callee.name)) @constructor

; Use imports: use App\Models\User;
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name
      (name) @import.name))) @import

; Grouped use imports: use App\Models\{User, Post};
(namespace_use_declaration
  (namespace_use_group
    (namespace_use_clause
      (name) @import.name))) @import
