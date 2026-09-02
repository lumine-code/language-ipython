; IPython-only statements provided by tree-sitter-ipython.
; Appended after the Python-compatible highlights for the .ipy grammar.

(magic_statement) @support.function.magic.ipython
(shell_statement) @string.unquoted.shell.ipython
(help_statement) @keyword.operator.help.ipython

; Cell markers remain comments for styling, jupyter-cells, and comment injections.
(cell_marker) @comment.line.number-sign.cell-marker.ipython

((cell_marker) @punctuation.definition.comment.python
  (#set! adjust.endAfterFirstMatchOf "^#"))
