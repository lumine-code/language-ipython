((markdown_cell body: (_) @injection.content) @injection.owner
  (#set! injection.language "markdown")
  (#set! injection.include-children)
  (#set! injection.cover-shallower-scopes))

((cell_magic
  name: (_) @_name
  body: (cell_body) @injection.content) @injection.owner
  (#any-of? @_name "python" "python2" "python3" "pypy")
  (#set! injection.language "python")
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
