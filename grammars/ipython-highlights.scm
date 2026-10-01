; Document structure and IPython syntax; Python bodies use language-python.

(magic_statement) @support.function.magic.ipython
(magic_expression) @support.function.magic.ipython
(shell_statement) @string.unquoted.shell.ipython
(shell_expression) @string.unquoted.shell.ipython
(help_statement) @keyword.operator.help.ipython

(cell_magic "%%" @punctuation.definition.magic.ipython @support.function.magic.ipython
  name: (cell_magic_name) @support.function.magic.ipython)
(cell_magic_arguments) @string.unquoted.arguments.ipython

; Raw and unknown magic bodies need a plain scope, with no extra parser.
; Known language injections replace this scope within their own body range.
(cell_body) @text.plain

; Cell markers remain comments for styling, jupyter-cells, and comment injections.
(cell_marker) @comment.line.number-sign.cell-marker.ipython

((cell_marker) @punctuation.definition.comment.python
  (#set! adjust.endAfterFirstMatchOf "^#"))
