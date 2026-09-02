; IPython-only statements provided by tree-sitter-ipython.
; Appended after the Python-compatible highlights for the .ipy grammar.

(magic_statement) @support.function.magic.ipython
(shell_statement) @string.unquoted.shell.ipython
(help_statement) @keyword.operator.help.ipython

; Cell markers remain comments for jupyter-cells and comment injections, while
; their delimiter, metadata, and optional title retain semantic scopes.
(cell_marker) @comment.line.number-sign.cell-marker.ipython

((cell_marker) @punctuation.definition.comment.python
  (#set! adjust.endAfterFirstMatchOf "^#"))

(cell_marker
  marker: (cell_marker_marker) @punctuation.section.cell-marker.ipython)

(cell_marker
  metadata: (cell_marker_metadata) @storage.modifier.cell-marker.ipython)

(cell_marker
  name: (cell_marker_name) @entity.name.section.cell-marker.ipython)
