# language-ipython

IPython language support.

## Features

- **Grammars**: provides Tree-sitter grammars built from [lumine-code/tree-sitter-ipython](https://github.com/lumine-code/tree-sitter-ipython).
- **Syntax highlighting**: highlights Python plus IPython magics, shell escapes, help requests, and cell markers.
- **Cell markers**: parses `# %% Title` as a named code cell; each additional `%` increases its navigation level, while `[markdown]`, `markdown`, and `md` select a Markdown cell.
- **Python integration**: inherits Python settings and snippets without maintaining copies.
- **Folding and symbols**: reuses the Python tree shape for structural editing and exposes named cells alongside Python definitions.

## Installation

To install `language-ipython` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/language-ipython`.

## Services

- `hyperlink.injection`: consumed to highlight URLs in comments, strings, and cell titles as clickable links.
- `todo.injection`: consumed to highlight `TODO`-style markers in comments and cell titles.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
