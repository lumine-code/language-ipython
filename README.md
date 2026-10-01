# language-ipython

IPython language support.

## Features

- **Grammars**: provides Tree-sitter grammars built from [lumine-code/tree-sitter-ipython](https://github.com/lumine-code/tree-sitter-ipython).
- **Syntax highlighting**: uses the original Python grammar for code and highlights magics, shell escapes, help requests, and cell headers through a small document grammar.
- **Cell markers**: parses column-zero `# %% Title` as a named code cell, preserves additional percent signs, and uses `[markdown]`, `[md]`, and `[raw]` for literal bodies; `[code]` explicitly selects code.
- **Embedded languages**: injects the original Python, Markdown, shell, HTML, JavaScript, XML, LaTeX, Perl, and Ruby grammars; raw and unknown bodies stay plain.
- **Python integration**: inherits Python settings and snippets without maintaining copies.
- **Folding and symbols**: uses native Python queries for structural editing and exposes named cells alongside Python definitions.

## Installation

To install `language-ipython` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/language-ipython`.

## Usage

This grammar owns `.ipy` documents. Notebook cells use their original language packages and keep the type declared in the notebook.

```ipy
# %% Setup
directory = %pwd
# %% [markdown] Notes
# Heading
Write **Markdown** literally, without a Python comment prefix.
# %% [raw] Payload
Keep this text exactly as written.
# %% Shell
%%bash
echo hello
```

Metadata is case-sensitive and must immediately follow the marker's percent run as a complete word. `[markdown]` and `[md]` mean Markdown; `[raw]` means raw; `[code]` means code. Bare `markdown`, `md`, and `raw`, and unknown metadata stay code-cell titles. Markers inside Python strings, brackets, continued expressions, or indented blocks do not split cells. A column-zero marker is reserved inside literal bodies too; indent it to include it as text.

Navigation panel keeps its own annotations, including `#%%$#` and `#%%$$#`. These remain compatible with the document grammar; navigation behavior is owned by that package.

Cell magics must occupy the first nonblank line in a code cell. Their entire body belongs to that magic until the next cell marker or EOF. `time`, `timeit`, `prun`, `debug`, `capture`, and `code_wrap` keep Python syntax and symbols. Other known names inject the corresponding installed language grammar; `script`, `writefile`, `file`, `cmd`, and custom magics keep a plain body. Language highlighting never changes which kernel executes a code cell.

The document parser recognizes cells and IPython syntax; it does not fork the Python grammar. All Python bodies share one native Python injection. Entire physical rows containing line magics, shell escapes, help requests or magic assignments are omitted from that syntax tree, so a magic assignment cannot leave a dangling right-hand side. Python may recover from an empty suite after such an omission. The document scaffold remains valid, and Python tooling receives the separate valid one-document projection, which retains assignment names and preserves source coordinates. No second IPython parser or virtual parser input is used.

## Services

- `ipython.source`: provided to share an AST-based Python analysis projection, safe position/edit mapping and lazy reversible Python-body formatting in one backend batch. See the [service contract](docs/ipython.source.md).
- `hyperlink.injection`: consumed to highlight URLs in comments, strings, and cell titles as clickable links.
- `todo.injection`: consumed to highlight `TODO`-style markers in comments and cell titles.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
