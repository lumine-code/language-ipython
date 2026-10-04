((python_cell_body) @injection.owner @injection.content
  (#set! injection.language "python")
  (#set! injection.combined)
  (#set! injection.newlines-between)
  (#set! injection.exclude-children-lines)
  (#set! injection.cover-shallower-scopes))

; Config accepts Python assignments, without the IPython input transformer.
([(magic_statement name: (line_magic_name) @_name body: (python_magic_body) @injection.content)
  (magic_expression name: (line_magic_name) @_name body: (python_magic_body) @injection.content)] @injection.owner
  (#eq? @_name "config")
  (#set! injection.language "python")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

; Executable wrappers transform complete payloads, including assignments to
; nested magics, shell escapes and postfix help. Each is a separate document.
([(magic_statement name: (line_magic_name) @_name body: (python_magic_body) @injection.content)
  (magic_expression name: (line_magic_name) @_name body: (python_magic_body) @injection.content)] @injection.owner
  (#any-of? @_name "time" "timeit" "prun" "debug")
  (#set! injection.language "ipython")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic setup: (python_magic_body) @injection.content) @injection.owner
  (#set! injection.language "ipython")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((markdown_cell body: (_) @injection.content) @injection.owner
  (#set! injection.language "markdown")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "bash")
  (#set! injection.language "bash")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "sh" "sx" "system" "!")
  (#set! injection.language "shell")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "html" "HTML")
  (#set! injection.language "html")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "markdown")
  (#set! injection.language "markdown")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "latex")
  (#set! injection.language "latex")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "javascript" "js")
  (#set! injection.language "javascript")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "svg" "SVG")
  (#set! injection.language "xml")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "perl")
  (#set! injection.language "perl")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "ruby")
  (#set! injection.language "ruby")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_marker_name) @injection.owner @injection.content
  (#set! injection.language "hyperlink")
  (#set! injection.language-scope "none"))

((cell_marker_name) @injection.owner @injection.content
  (#set! injection.language "todo")
  (#set! injection.language-scope "none"))
