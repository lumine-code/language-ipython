(module
  (assignment
    left: (identifier) @name) @definition.constant)

(module
  (expression_statement
    (assignment
      left: (identifier) @name) @definition.constant))

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
  (#not-match? @name "^(?:md|markdown)\\s*$")
  (#set! symbol.strip "^(?:md|markdown)\\s+")
  (#set! symbol.icon "bookmark"))
