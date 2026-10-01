# Python source projection

Prepare one Python analysis module from a complete `.ipy` document without changing its source.

| Metadata    | Value                   |
| ----------- | ----------------------- |
| Version     | `1.0.0`                 |
| Provided by | `language-ipython`      |
| Consumed by | Python analysis clients |
| Owner       | `language-ipython`      |

## Registration

Consume `ipython.source` and call `project(editor, { signal })`. The method returns a promise for a snapshot, or `null` when the editor does not use the IPython document grammar. A failed grammar or cancelled operation rejects; consumers must not silently send mixed `.ipy` source as Python instead. `isApplicable(editor)` answers the grammar and editor-role question synchronously.

For a file that has no editor, call `projectText(source, { filePath, signal })`. This creates one detached, non-DOM model using the same core grammar path and returns the normal snapshot with `filePath` metadata and `dispose()`. The service performs no filesystem reads or writes and does not register the temporary model as a window editor. Dispose the result in a `finally` block; provider disposal also destroys every owned model. Background callers should process closed files sequentially.

## Contract

The service shares one snapshot per buffer revision. Cell ownership comes from the editor's settled IPython scaffold; it does not inspect injected Python trees or create another parser for open documents. Source without `%`, `!` or `?` is provably unchanged and needs no AST wait. Notebook fragment editors and ordinary Python editors are outside its scope. Consumers send original source to execution kernels.

`source` is the exact original text. `text` is the Python analysis copy: ordinary Python remains unchanged; literal Markdown/raw and foreign or unknown magic bodies are masked; known Python wrappers and Python interpreter bodies remain available. Strings and comments that merely resemble magics are preserved. Actual line magics, shell statements and help requests become a padded `0`, which also keeps Python suites nonempty. Assignment RHS magics and shell escapes become `eval('')`, a synthetic expression with an `Any` return type. A short RHS may expand within its existing physical line; the snapshot maps that expansion explicitly. Neither synthetic expression is intended for execution.

All points use Lumine `Point` or `[row, column]`, with zero-based rows and UTF16 columns. All ranges use Lumine `Range` or a pair of those points. Snapshot methods return `Point`/`Range` objects or `null` when a position cannot be mapped safely.

| Member                                                                                              | Contract                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isCurrent()`                                                                                       | True only while the source revision, grammar, mode, document context and provider generation remain current.                                                                                                                                                                                   |
| `isIdentity`                                                                                        | Read-only boolean: true exactly when `source` and `text` are equal strings. All permitted UTF16 endpoint mappings then retain original coordinates. Ownership guards still protect headers and non-Python bodies.                                                                              |
| `protectedRanges`                                                                                   | Original-coordinate ranges containing immutable cell headers, non-Python source and synthetic IPython replacements.                                                                                                                                                                            |
| `syntheticRanges`                                                                                   | Original-coordinate statement and assignment-RHS replacement ranges.                                                                                                                                                                                                                           |
| `pythonFormattingRegions`                                                                           | Original-coordinate Python body ranges, excluding cell/magic headers and non-Python bodies.                                                                                                                                                                                                    |
| `isPythonPosition(sourcePoint)`                                                                     | Gates requests and insertions; opaque/synthetic positions and their command end positions are excluded.                                                                                                                                                                                        |
| `isPythonRange(sourceRange)`                                                                        | True only for an ordinary Python range within one body and without protected overlap.                                                                                                                                                                                                          |
| `toServerPosition(sourcePoint)` / `fromServerPosition(serverPoint)`                                 | Read-only endpoint mapping; protected interiors return null, exact boundaries map.                                                                                                                                                                                                             |
| `toServerRange(sourceRange)` / `fromServerRange(serverRange)`                                       | Read-only endpoint geometry; a range may contain protected interior source, as with an assignment symbol spanning a synthetic RHS. Use ownership gates for diagnostics and edits.                                                                                                              |
| `mapEdits([{ oldRange, newText }])`                                                                 | Takes projected/server-coordinate edits and returns original-coordinate edits, or null atomically for stale, protected, overlapping or cross-body edits. A full projected-document replacement intersecting protected source is rejected; consumers must first derive minimal diff hunks.      |
| `toCodePointPosition(serverUTF16Point)` / `fromCodePointPosition(serverCodePointPoint)`             | Converts projected-text columns for codepoint-based tools such as Ruff CLI and Jedi.                                                                                                                                                                                                           |
| `sourceToCodePointPosition(sourceUTF16Point)` / `sourceFromCodePointPosition(sourceCodePointPoint)` | The same conversion for original text. Positions splitting a surrogate pair or exceeding a line are rejected.                                                                                                                                                                                  |
| `getFormattingBlocks()`                                                                             | Asynchronously prepares and caches Python body blocks with `{ range, text, restore(formatted) }`, or an empty list for a stale snapshot. Concurrent calls share preparation.                                                                                                                   |
| `getFormattingBatch(range?)`                                                                        | Asynchronously prepares one formatter input with `{ text, restore(formatted), getEditPlan(formatted) }`. An optional original-coordinate `Range` or list of ranges selects intersecting bodies. Restoration returns `[{ range, text }]` atomically, or null for empty, stale or unsafe output. |

## Minimal example

```js
async function analyze(editor, sourceService, pythonClient) {
  const snapshot = await sourceService.project(editor);
  if (!snapshot) return;
  const result = await pythonClient.analyze(snapshot.text);
  if (!snapshot.isCurrent()) return;
  return result.flatMap((diagnostic) => {
    const range = snapshot.fromServerRange(diagnostic.range);
    return range && snapshot.isPythonRange(range) ? [{ ...diagnostic, range }] : [];
  });
}
```

## Behavior

All Python cells share one analysis module, so imports and names remain visible between cells. The source copy preserves physical lines, including CRLF, and masks non-Python text rather than joining unrelated lines. Native language injections handle syntax highlighting independently of this analysis copy.

Formatting block text uses unique, reversible statement and RHS call sentinels. `restore(formatted)` returns the formatted original-aware body or null for stale, missing, duplicated, quoted, commented or structurally ambiguous sentinels. In particular, a formatter that wraps an IPython RHS into a continued Python expression is rejected. A consumer may replace the block's original range only after successful restoration and a final `isCurrent()` check. Headers and foreign bodies lie outside every block.

Use `await snapshot.getFormattingBatch(range)` for a formatter request. Multiple Python bodies are separated by unique comment delimiters so one backend invocation can format the document. Restoration validates every delimiter and block before returning edits; a single body needs no delimiters. Consumers must still restrict applied diff hunks to their captured selections. Analysis requests do not prepare formatting sentinels or batch text.

`await batch.getEditPlan(formatted)` validates restoration and returns `{ text, edits, fallback }`, or null for stale, unsafe or out-of-selection changes. `text` is the whole target document with the original protected source restored; `edits` are minimal changes in original buffer coordinates. A single reusable scratch buffer computes the native diff and is destroyed after preparation. `fallback` is true when a native hunk crosses a protected boundary and requires separate body diffs in that same scratch buffer. Before applying the plan, consumers check the snapshot and their captured editor, path and selection again.

There is no editor mutation or save operation in this service. Consumers remain responsible for backend versions, requests to other files, diagnostics filtering, atomic edits and stale-result checks. Read-only geometry must never be used as an edit authorization: use `isPythonRange` or `mapEdits`. Snapshot validity belongs to the buffer revision, mode and provider; closing one split does not invalidate another split's cached snapshot. Consumers must separately guard their own editor and request lifecycle. Caches contain strings, scalar spans and sparse Unicode chunk counts, never syntax nodes or an additional parser. Unicode queries retain offsets for at most two chunks per text, including when a row contains millions of characters. AST traversal, masking and Unicode counting use an eight-millisecond cooperative budget and bounded text chunks; identity source avoids constructing replacement text.

## Teardown

A consumed-service callback returns a disposable for that provider edge. Cancel outstanding requests and discard its snapshots when the edge disappears; consume the next provider generation separately. Each `projectText` result owns a temporary editor and must be disposed in a `finally` block. Provider disposal releases its buffer subscriptions, caches and temporary editors.

## Versioning

This contract is updated at `1.0.0` before the first release. Consumers use the shared source API rather than depending on the scaffold's node layout or an injected language's AST.
