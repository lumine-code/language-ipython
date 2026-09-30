(module
  (assignment
    left: (identifier) @name) @definition.constant)

(module
  (expression_statement
    (assignment
      left: (identifier) @name) @definition.constant))

(python_cell_body
  (assignment left: (identifier) @name) @definition.constant)

(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(call
  function: [
      (identifier) @name
      (attribute
        attribute: (identifier) @name)
  ]) @reference.call

((cell_marker
  name: (cell_marker_name) @name) @definition.cell
  (#set! symbol.icon "bookmark"))
