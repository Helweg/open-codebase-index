/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  SPREAD: 1,
  LOGICAL_OR: 2,
  LOGICAL_AND: 3,
  EQUAL: 4,
  RELATIONAL: 5,
  IN: 6,
  ELVIS: 7,
  INFIX: 8,
  RANGE: 9,
  ADD: 10,
  MULTIPLY: 11,
  AS: 12,
  CALL: 13,
  UNARY: 14,
};

module.exports = grammar({
  name: 'kotlin',

  conflicts: $ => [
    [$.class_body, $.enum_class_body],

    [$.binary_expression, $.call_expression],
    [$.binary_expression, $.in_expression, $.call_expression],
    [$.binary_expression, $.infix_expression, $.call_expression],
    [$.binary_expression, $.range_expression, $.call_expression],

    [$.user_type],
    [$._simple_user_type, $.primary_expression],
    [$.type, $._receiver_type],

    [$.modifiers, $.annotated_lambda],
    [$.modifiers, $.annotated_expression],

    [$.delegation_specifier, $.type_modifiers],
    [$.annotated_expression, $.type_modifiers],
    [$.annotated_expression, $.type_modifiers, $.when_subject],
    [$.annotated_expression, $.type_modifiers, $.modifiers],
    [$.parameter_modifiers, $.type_modifiers],
    [$.function_modifier, $.type_modifiers],
    [$.function_modifier, $._reserved_identifier],
    [$.variable_declaration, $.type_modifiers],
    [$.variable_declaration, $.type_modifiers, $.modifiers, $.annotated_expression],
    [$.variable_declaration, $.type_modifiers, $.annotated_expression],
    [$.variable_declaration],

    [$.function_value_parameters, $.function_type_parameters],
    [$.parenthesized_type, $.function_type_parameters],
    [$.multi_variable_declaration, $.function_type_parameters],

    [$.class_modifier, $._reserved_identifier],
    [$.platform_modifier, $._reserved_identifier],
    [$.property_modifier, $._reserved_identifier],

    [$.explicit_delegation, $.expression],
    [$.qualified_identifier],
    [$.constructor_invocation, $._unescaped_annotation],
    [$.nullable_type],
    [$.non_nullable_type],
    [$.function_type],
    [$._receiver_type],
  ],

  extras: $ => [
    /\s/,
    $.line_comment,
    $.block_comment,
  ],

  externals: $ => [
    $._semi,
    $._class_member_semi,
    $.block_comment,
    $._not_is,
    $._in,
    $._q_dot,
    $._multiline_string_content,
    // used to check if a preceding annoation should not have an automatic _semi inserted
    'constructor',
    'get',
    'set',
    // used to check if we can parse a comment
    '$',
  ],

  inline: $ => [
    $._statements,
    $._identifier,
  ],

  precedences: $ => [
    [$.block, $.lambda_literal],
    [$.function_type, $.nullable_type],
    [$.function_type, $.non_nullable_type],
  ],

  supertypes: $ => [
    $.class_member_declaration,
    $.declaration,
    $.expression,
    $.primary_expression,
    $.type,
    $.statement,
  ],

  word: $ => $.identifier,

  rules: {
    source_file: $ => seq(
      optional($.shebang),
      repeat($.file_annotation),
      optional($.package_header),
      repeat($.import),
      repeat(seq($.statement, $._semi)),
    ),

    file_annotation: $ => seq(
      '@',
      'file',
      ':',
      choice(
        seq('[', repeat1($._unescaped_annotation), ']'),
        $._unescaped_annotation,
      ),
      $._semi,

    ),

    package_header: $ => seq(
      'package',
      $.qualified_identifier,
      optional(';'),
    ),

    import: $ => seq(
      'import',
      $.qualified_identifier,
      optional(choice(
        seq('.', '*'),
        seq('as', $.identifier),
      )),
      optional(';'),
    ),

    declaration: $ => choice(
      $.class_declaration,
      $.object_declaration,
      $.function_declaration,
      $.property_declaration,
      $.type_alias,
    ),

    class_declaration: $ => prec.right(seq(
      optional($.modifiers),
      choice('class', seq(optional('fun'), 'interface')),
      field('name', $.identifier),
      optional($.type_parameters),
      optional($.primary_constructor),
      optional(seq(':', $.delegation_specifiers)),
      optional($.type_constraints),
      optional(choice($.class_body, $.enum_class_body)),
    )),

    object_declaration: $ => prec.right(seq(
      optional($.modifiers),
      'object',
      field('name', $.identifier),
      optional(seq(':', $.delegation_specifiers)),
      optional($.class_body),
    )),

    property_declaration: $ => prec.right(seq(
      optional($.modifiers),
      choice('val', 'var'),
      optional($.type_parameters),
      optional(seq($._receiver_type, optional('.'))),
      choice($.variable_declaration, $.multi_variable_declaration),
      optional($.type_constraints),
      optional(choice(
        seq('=', $.expression),
        $.property_delegate,
      )),
      optional(';'),
      optional(choice(
        seq($.getter, optional($.setter)),
        seq($.setter, optional($.getter)),
      )),
    )),

    type_alias: $ => prec.right(seq(
      optional($.modifiers),
      'typealias',
      field('type', $.identifier),
      optional($.type_parameters),
      '=',
      $.type,
    )),

    companion_object: $ => seq(
      optional($.modifiers),
      'companion',
      'object',
      optional(field('name', $.identifier)),
      optional(seq(':', $.delegation_specifiers)),
      optional($.class_body),
    ),

    anonymous_initializer: $ => seq('init', $.block),

    secondary_constructor: $ => seq(
      optional($.modifiers),
      'constructor',
      $.function_value_parameters,
      optional(seq(':', $.constructor_delegation_call)),
      optional($.block),
    ),

    constructor_delegation_call: $ => seq(choice('this', 'super'), $.value_arguments),

    type_parameters: $ => seq('<', commaSep1($.type_parameter), '>'),

    type_parameter: $ => seq(
      optional($.type_parameter_modifiers),
      $.identifier,
      optional(seq(':', $.type)),
    ),

    primary_constructor: $ => seq(
      optional(seq(
        optional($.modifiers),
        'constructor',
      )),
      $.class_parameters,
    ),

    class_parameters: $ => seq(
      '(',
      optionalCommaSep1($.class_parameter),
      ')',
    ),

    class_parameter: $ => seq(
      optional($.modifiers),
      optional(choice('val', 'var')),
      $._identifier,
      ':', $.type,
      optional(seq('=', $.expression)),
    ),

    type_constraints: $ => prec.right(seq(
      'where',
      commaSep1($.type_constraint),
    )),

    type_constraint: $ => prec.right(seq(
      $.identifier,
      ':',
      $.type,
    )),

    constructor_invocation: $ => seq($.type, $.value_arguments),

    function_declaration: $ => prec.right(1, seq(
      optional($.modifiers),
      'fun',
      optional($.type_parameters),
      optional(seq($._receiver_type, optional('.'))),
      field('name', $._identifier),
      $.function_value_parameters,
      optional(seq(':', $.type)),
      optional($.type_constraints),
      optional($.function_body),
    )),

    function_value_parameters: $ => seq(
      '(',
      optionalCommaSep1(seq(
        optional($.parameter_modifiers),
        $.parameter,
        optional(seq('=', $.expression)),
      )),
      ')',
    ),

    parameter: $ => seq($._identifier, ':', $.type),

    delegation_specifiers: $ => commaSep1($.delegation_specifier),

    delegation_specifier: $ => prec.right(seq(
      repeat($.annotation),
      choice(
        $.constructor_invocation,
        $.explicit_delegation,
        $.type,
      ),
    )),

    variable_declaration: $ => prec(1, seq(
      repeat($.annotation),
      $._identifier,
      optional(seq(':', $.type)),
    )),

    multi_variable_declaration: $ => seq(
      '(',
      optionalCommaSep1($.variable_declaration),
      ')',
    ),

    property_delegate: $ => seq(
      'by',
      $.expression,
    ),

    explicit_delegation: $ => seq(
      $.type,
      'by',
      $.primary_expression,
    ),

    getter: $ => prec.right(seq(
      optional($.modifiers),
      'get',
      optional(seq(
        '(',
        ')',
        optional(seq(':', $.type)),
        $.function_body,
      )),
    )),

    setter: $ => prec.right(seq(
      optional($.modifiers),
      'set',
      optional(seq(
        '(',
        optional($.parameter_modifiers),
        $.identifier,
        optional(seq(':', $.type)),
        optional(seq('=', $.expression)),
        ')',
        optional(seq(':', $.type)),
        $.function_body,
      )),
    )),

    function_body: $ => choice(
      $.block,
      seq('=', $.expression),
    ),

    block: $ => seq(
      '{',
      optional($._statements),
      '}',
    ),

    for_statement: $ => prec.right(seq(
      optional($.label),
      'for',
      '(',
      repeat($.annotation),
      choice($.variable_declaration, $.multi_variable_declaration),
      'in',
      $.expression,
      ')',
      optional(choice($.block, $.statement)),
    )),

    while_statement: $ => prec.right(seq(
      optional($.label),
      'while',
      '(',
      field('condition', $.expression),
      ')',
      optional(choice($.block, $.statement, ';')),
    )),

    do_while_statement: $ => prec.right(seq(
      optional($.label),
      'do',
      optional(choice($.block, $.statement, ';')),
      'while',
      '(',
      field('condition', $.expression),
      ')',
    )),

    class_body: $ => seq(
      '{',
      repeat(seq($.class_member_declaration, $._class_member_semi)),
      '}',
    ),

    class_member_declaration: $ => choice(
      $.declaration,
      $.companion_object,
      $.anonymous_initializer,
      $.secondary_constructor,
    ),

    enum_class_body: $ => seq(
      '{',
      optionalCommaSep1($.enum_entry),
      optional(seq(
        ';',
        repeat(seq($.class_member_declaration, $._class_member_semi)),
      )),
      '}',
    ),

    enum_entry: $ => seq(
      optional($.modifiers),
      $.identifier,
      optional($.value_arguments),
      optional($.class_body),
    ),

    value_arguments: $ => seq(
      '(',
      optionalCommaSep1($.value_argument),
      ')',
    ),

    value_argument: $ => seq(
      optional(seq($._identifier, '=')),
      optional('*'),
      $.expression,
    ),

    _statements: $ => seq(
      $.statement,
      repeat(seq($._semi, $.statement)),
      optional($._semi),
    ),

    statement: $ => choice(
      $.declaration,
      $.assignment,
      $.for_statement,
      $.while_statement,
      $.do_while_statement,
      $.expression,
    ),

    modifiers: $ => prec.right(repeat1(choice(
      $.annotation,
      $.class_modifier,
      $.member_modifier,
      $.function_modifier,
      $.property_modifier,
      $.visibility_modifier,
      $.inheritance_modifier,
      $.parameter_modifier,
      $.platform_modifier,
    ))),

    class_modifier: _ => choice(
      'enum',
      'sealed',
      'annotation',
      'data',
      'inner',
      'value',
    ),

    function_modifier: _ => prec.right(choice(
      'tailrec',
      'operator',
      'infix',
      'inline',
      'external',
      'suspend',
    )),

    property_modifier: _ => 'const',

    visibility_modifier: _ => choice(
      'public',
      'private',
      'protected',
      'internal',
    ),

    inheritance_modifier: _ => choice(
      'abstract',
      'final',
      'open',
    ),

    member_modifier: _ => choice(
      'override',
      'lateinit',
    ),

    parameter_modifiers: $ => repeat1(choice($.annotation, $.parameter_modifier)),

    parameter_modifier: _ => choice(
      'vararg',
      'noinline',
      'crossinline',
    ),

    reification_modifier: _ => 'reified',

    platform_modifier: _ => choice(
      'expect',
      'actual',
    ),

    type_modifiers: $ => prec.right(
      repeat1(choice($.annotation, 'suspend')),
    ),

    annotation: $ => choice(
      seq(
        '@',
        optional($.use_site_target),
        $._unescaped_annotation,
      ),
      seq(
        '@',
        optional($.use_site_target),
        '[',
        repeat1($._unescaped_annotation),
        ']',
      ),
    ),

    use_site_target: _ => seq(
      choice('field', 'property', 'get', 'set', 'receiver', 'param', 'setparam', 'delegate'),
      ':',
    ),

    _unescaped_annotation: $ => choice(
      $.constructor_invocation,
      $.type,
    ),

    type: $ => choice(
      $.user_type,
      $.nullable_type,
      $.function_type,
      $.non_nullable_type,
      $.parenthesized_type,
      'dynamic',
    ),

    user_type: $ => seq(
      optional($.type_modifiers),
      sep1(
        $._simple_user_type,
        '.',
      ),
    ),

    _simple_user_type: $ => prec.right(seq($._identifier, optional($.type_arguments))),

    nullable_type: $ => seq(
      optional($.type_modifiers),
      $.type,
      '?',
    ),

    non_nullable_type: $ => prec.right(seq(
      optional($.type_modifiers),
      $.type,
      '&',
      optional($.type_modifiers),
      $.type,
    )),

    _receiver_type: $ => seq(
      optional($.type_modifiers),
      choice(
        $.user_type,
        'dynamic',
        $.parenthesized_type,
        $.nullable_type,
      ),
    ),

    type_arguments: $ => seq('<', commaSep1($.type_projection), '>'),

    type_projection: $ => choice(
      seq(repeat($.variance_modifier), $.type),
      '*',
    ),

    function_type: $ => seq(
      optional($.type_modifiers),
      optional(seq($._receiver_type, '.')),
      $.function_type_parameters,
      '->',
      $.type,
    ),

    function_type_parameters: $ => seq(
      '(',
      optionalCommaSep1(choice($.parameter, $.type)),
      ')',
    ),

    parenthesized_type: $ => seq('(', $.type, ')'),

    assignment: $ => seq(
      field('left', $.expression),
      field('operator', choice(
        '=',
        '+=',
        '-=',
        '*=',
        '/=',
        '%=',
      )),
      field('right', $.expression),
    ),

    expression: $ => choice(
      $.primary_expression,
      $.index_expression,
      $.return_expression,
      $.throw_expression,
    ),

    primary_expression: $ => choice(
      $._identifier,
      $.string_literal,
      $.multiline_string_literal,
      $.character_literal,
      $.number_literal,
      $.float_literal,
      $.object_literal,
      $.collection_literal,
      $.navigation_expression,
      $.binary_expression,
      $.unary_expression,
      $.annotated_expression,
      $.labeled_expression,
      $.call_expression,
      $.in_expression,
      $.is_expression,
      $.as_expression,
      $.spread_expression,
      $.infix_expression,
      $.range_expression,
      $.if_expression,
      $.parenthesized_expression,
      $.this_expression,
      $.super_expression,
      $.when_expression,
      $.try_expression,
      $.callable_reference,
      $.lambda_literal,
      $.anonymous_function,
    ),

    unary_expression: $ => prec.left(PREC.UNARY, choice(
      seq(
        field('operator', choice('++', '--', '+', '-', '!')),
        field('argument', $.expression),
      ),
      seq(
        field('argument', $.expression),
        field('operator', choice('++', '--', '!!')),
      ),
    )),

    annotated_expression: $ => seq($.annotation, $.expression),

    labeled_expression: $ => seq($.label, $.expression),

    binary_expression: $ => {
      const table = [
        ['+', PREC.ADD],
        ['-', PREC.ADD],
        ['*', PREC.MULTIPLY],
        ['/', PREC.MULTIPLY],
        ['%', PREC.MULTIPLY],
        ['||', PREC.LOGICAL_OR],
        ['&&', PREC.LOGICAL_AND],
        ['!=', PREC.EQUAL],
        ['!==', PREC.EQUAL],
        ['==', PREC.EQUAL],
        ['===', PREC.EQUAL],
        ['>', PREC.RELATIONAL],
        ['>=', PREC.RELATIONAL],
        ['<=', PREC.RELATIONAL],
        ['<', PREC.RELATIONAL],
        ['?:', PREC.ELVIS],
      ];

      return choice(...table.map(([operator, precedence]) => {
        return prec.left(precedence, seq(
          field('left', $.expression),
          // @ts-ignore
          field('operator', operator),
          field('right', $.expression),
        ));
      }));
    },

    in_expression: $ => prec.left(PREC.IN, seq(
      field('left', $.expression),
      choice('in', '!in'),
      field('right', $.expression),
    )),

    is_expression: $ => prec.left(PREC.IN, seq(
      field('left', $.expression),
      choice('is', alias($._not_is, '!is')),
      field('right', $.type),
    )),

    as_expression: $ => prec.left(PREC.AS, seq(
      field('left', $.expression),
      choice('as', 'as?'),
      field('right', $.type),
    )),

    spread_expression: $ => prec(PREC.SPREAD, seq('*', $.expression)),

    range_expression: $ => prec.left(PREC.RANGE, seq(
      $.expression,
      choice('..', '..<'),
      $.expression,
    )),

    infix_expression: $ => prec.left(PREC.INFIX, seq(
      $.expression,
      $.identifier,
      $.expression,
    )),

    call_expression: $ => prec.left(PREC.CALL, seq(
      $.expression,
      optional($.type_arguments),
      choice(
        $.value_arguments,
        seq(optional($.value_arguments), $.annotated_lambda),
      ),
    )),

    annotated_lambda: $ => seq(
      repeat($.annotation),
      optional($.label),
      $.lambda_literal,
    ),

    lambda_literal: $ => seq(
      '{',
      optional(seq(optional($.lambda_parameters), '->')),
      optionalSep1($.statement, $._semi),
      '}',
    ),

    lambda_parameters: $ => seq(commaSep1($._lambda_parameter), optional(',')),

    _lambda_parameter: $ => choice(
      $.variable_declaration,
      $.multi_variable_declaration,
    ),

    anonymous_function: $ => prec.right(seq(
      'fun',
      optional(seq($.type, '.')),
      $.function_value_parameters,
      optional(seq(':', $.type)),
      optional($.type_constraints),
      optional($.function_body),
    )),

    index_expression: $ => prec(PREC.CALL, seq(
      $.expression,
      '[',
      commaSep($.expression),
      ']',
    )),

    this_expression: $ => seq(
      choice(
        'this',
        seq('this@', $.identifier),
      ),
    ),

    super_expression: $ => prec.right(choice(
      'super',
      seq('super', '<', $.type, '>'),
      seq('super@', $.identifier),
      seq('super', '<', $.type, '>', token.immediate('@'), $.identifier),
    )),

    if_expression: $ => prec.right(seq(
      'if',
      '(',
      field('condition', $.expression),
      ')',
      choice(
        $.block,
        $.expression,
        $.assignment,
        ';',
        seq(
          optional(choice(
            $.block,
            $.expression,
            $.assignment,
          )),
          optional(';'),
          'else',
          choice(
            $.block,
            $.expression,
            $.assignment,
            ';',
          ),
        ),
      ),
    )),

    parenthesized_expression: $ => seq('(', $.expression, ')'),

    collection_literal: $ => seq('[', commaSep1($.expression), optional(','), ']'),

    when_expression: $ => seq(
      'when',
      optional($.when_subject),
      '{',
      repeat($.when_entry),
      '}',
    ),

    when_subject: $ => seq(
      '(',
      optional(seq(
        repeat($.annotation),
        'val',
        $.variable_declaration,
        '=',
      )),
      $.expression,
      ')',
    ),

    when_entry: $ => seq(
      choice(
        seq(
          commaSep1(field('condition', $._when_condition)),
          optional(','),
        ),
        'else',
      ),
      '->',
      choice($.block, $.statement),
      optional($._semi),
    ),

    _when_condition: $ => choice(
      $.expression,
      $.range_test,
      $.type_test,
    ),

    range_test: $ => seq(
      choice(alias($._in, 'in'), '!in'),
      $.expression,
    ),

    type_test: $ => seq(
      choice('is', alias($._not_is, '!is')),
      $.type,
    ),

    try_expression: $ => seq(
      'try',
      $.block,
      choice(
        seq(repeat1($.catch_block), optional($.finally_block)),
        $.finally_block,
      ),
    ),

    catch_block: $ => seq(
      'catch',
      '(',
      repeat($.annotation),
      $.identifier,
      ':',
      $.type,
      ')',
      $.block,
    ),

    finally_block: $ => seq('finally', $.block),

    return_expression: $ => prec.right(seq(
      choice(
        'return',
        seq('return@', field('label', $.identifier)),
      ),
      optional($.expression),
    )),

    throw_expression: $ => seq(
      'throw',
      $.expression,
    ),

    continue_expression: $ => choice(
      'continue',
      seq('continue@', field('label', $.identifier)),
    ),

    break_expression: $ => choice(
      'break',
      seq('break@', field('label', $.identifier)),
    ),

    callable_reference: $ => seq(
      optional($._receiver_type),
      '::',
      choice($.identifier, 'class'),
    ),

    navigation_expression: $ => prec(PREC.CALL, seq(
      $.expression,
      choice('.', alias($._q_dot, '?.'), '::'),
      $.identifier,
    )),

    object_literal: $ => seq(
      'object',
      optional(seq(':', $.delegation_specifiers)),
      $.class_body,
    ),

    string_literal: $ => seq(
      '"',
      repeat(choice(
        alias(choice(
          token.immediate(prec(2, seq('\\', /[^bnrt'\"\\\$]/))),
          token.immediate(prec(1, /[^"\\\$]+/)),
          '$',
        ),
        $.string_content,
        ),
        $.escape_sequence,
        $.interpolation,
      )),
      '"',
    ),

    multiline_string_literal: $ => seq(
      '"""',
      repeat(choice(
        alias($._multiline_string_content, $.string_content),
        $.interpolation,
      )),
      choice('"""', '""""'),
    ),

    interpolation: $ => choice(
      seq('$', $._identifier),
      seq('${', $.expression, '}'),
    ),

    character_literal: $ => seq(
      '\'',
      choice(
        token.immediate(prec(1, /[^'\\\r\n]/)),
        $.escape_sequence,
      ),
      '\'',
    ),

    escape_sequence: _ => token.immediate(prec(1, seq(
      '\\',
      choice(
        /[^xu0-7]/,
        /u[0-9a-fA-F]{4}/,
      ),
    ))),

    number_literal: _ => {
      const separator = '_';
      const decimal = /[0-9]+/;
      const hex = /[0-9a-fA-F]/;
      const bin = /[01]/;
      const decimalDigits = seq(repeat1(decimal), repeat(seq(separator, repeat1(decimal))));
      const hexDigits = seq(repeat1(hex), repeat(seq(separator, repeat1(hex))));
      const binDigits = seq(repeat1(bin), repeat(seq(separator, repeat1(bin))));

      return token(seq(
        choice(
          decimalDigits,
          seq(/0[xX]/, hexDigits),
          seq(/0[bB]/, binDigits),
        ),
        optional(/([lL]|[uU][lL]?)/),
      ));
    },

    float_literal: _ => {
      const separator = '_';
      const decimal = /[0-9]+/;
      const exponent = /[eE][+-]?[0-9]+/;
      const decimalDigits = seq(repeat1(decimal), repeat(seq(separator, repeat1(decimal))));

      return token(seq(
        choice(
          seq(decimalDigits, exponent, optional(/[fF]/)),
          seq(optional(decimalDigits), '.', repeat1(decimalDigits), optional(exponent), optional(/[fF]/)),
          seq(decimalDigits, /[fF]/),
        ),
      ));
    },

    variance_modifier: _ => choice(
      'in',
      'out',
    ),

    type_parameter_modifiers: $ => repeat1(choice(
      $.reification_modifier,
      $.variance_modifier,
      $.annotation,
    )),

    qualified_identifier: $ => seq(
      $.identifier,
      repeat(seq('.', $.identifier)),
    ),

    label: _ => token(/[a-zA-Z_][a-zA-Z_0-9]*@/),

    _identifier: $ => choice($.identifier, $._reserved_identifier),

    identifier: _ => token(choice(
      /[\p{L}_][\p{L}_\p{Nd}]*/u,
      /`[^\r\n`]+`/,
    )),

    _reserved_identifier: $ => prec.dynamic(1, alias(
      choice(
        'actual',
        'annotation',
        'constructor',
        'const',
        'data',
        'enum',
        'expect',
        'inner',
        'get',
        'set',
        'operator',
        'value',
      ),
      $.identifier,
    )),

    shebang: _ => /#!.*/,

    line_comment: _ => token(seq('//', /.*/)),
  },
});

/**
 * Creates a rule to match one or more of the rules separated by `separator`
 *
 * @param {RuleOrLiteral} rule
 *
 * @param {RuleOrLiteral} separator
 *
 * @returns {SeqRule}
 */
function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}

/**
 * Creates a rule to optionally match one or more of the rules separated by `separator`
 * and optionally ending with `separator`
 *
 * @param {RuleOrLiteral} rule
 *
 * @param {RuleOrLiteral} separator
 *
 * @returns {ChoiceRule}
 */
function optionalSep1(rule, separator) {
  return optional(seq(rule, repeat(seq(separator, rule)), optional(separator)));
}

/**
 * Creates a rule to optionally match one or more of the rules separated by a comma
 *
 * @param {Rule} rule
 *
 * @returns {ChoiceRule}
 */
function commaSep(rule) {
  return optional(commaSep1(rule));
}

/**
 * Creates a rule to match one or more of the rules separated by a comma
 *
 * @param {Rule} rule
 *
 * @returns {SeqRule}
 */
function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}

/**
 * Creates a rule to optionally match one or more of the rules separated by a comma
 * and optionally ending with a comma
 *
 * @param {Rule} rule
 *
 * @returns {ChoiceRule}
 */
function optionalCommaSep1(rule) {
  return optional(seq(rule, repeat(seq(',', rule)), optional(',')));
}
