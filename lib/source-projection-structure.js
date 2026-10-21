const CELL_LANGUAGES = require("./cell-languages");
const PYTHON_WRAPPERS = new Set(["time", "timeit", "prun", "debug", "capture", "code_wrap"]);
const STATEMENTS = new Set(["magic_statement", "shell_statement", "help_statement"]);
const EXPRESSIONS = new Set(["magic_expression", "shell_expression"]);
const LEAVES = new Set([
  "cell_body",
  "cell_marker_marker",
  "cell_marker_name",
  "cell_marker_metadata",
  "cell_magic_name",
  "cell_magic_arguments",
]);
const { lowerBound, merge, lineExtent, cooperative } = require("./projection-spans");
exports.collect = async function (context, _params, { signal, emit }) {
  const root = context.getRootSyntaxNode();
  if (!root) throw new Error("The IPython syntax tree is unavailable for source projection.");
  const source = context.buffer.getTextSnapshot().toString();
  const data = await collect(context, source, root.tree, () => !signal.aborted);
  const counts = { sentinels: data.sentinels.length };
  for (const field of ["protectedSpans", "replacements", "regions"]) {
    counts[field] = data[field].length;
    for (let start = 0; start < data[field].length; start += 256) {
      signal.throwIfAborted();
      await emit({ field, records: data[field].slice(start, start + 256) });
    }
  }
  return { counts, hasOpaqueBody: data.hasOpaqueBody };
};
async function collect(editor, source, tree, current) {
  const buffer = editor.getBuffer();
  let hasOpaqueBody = false;
  const headers = [],
    emptyPythonStarts = new Set(),
    cuts = [],
    protectedSpans = [],
    replacements = [],
    sentinels = [];
  const tick = cooperative(current);
  // The root tree owns cells and IPython commands. Python syntax belongs to
  // child injections and is never traversed to prepare this shared document.
  const header = (node, mask = false) => {
    const span = lineExtent(buffer, node.startPosition.row);
    protectedSpans.push(span);
    cuts.push(span);
    if (mask) replacements.push({ ...span, kind: "opaque" });
    return span;
  };
  const opaque = (node) => {
    if (!node) return;
    const span = { start: node.startIndex, end: node.endIndex };
    protectedSpans.push(span);
    cuts.push(span);
    replacements.push({ ...span, kind: "opaque" });
  };
  const cursor = tree.walk();
  let visiting = true,
    depth = 0;
  try {
    while (visiting) {
      const type = cursor.nodeType;
      let descend = !LEAVES.has(type);
      if (type === "cell_marker") {
        const span = header(cursor.currentNode);
        headers.push(span);
        if (/[\r\n]$/.test(source.slice(span.start, span.end))) emptyPythonStarts.add(span.end);
        descend = false;
      } else if (type === "markdown_cell" || type === "raw_cell") {
        hasOpaqueBody = true;
        const node = cursor.currentNode;
        const marker = node.childForFieldName("marker");
        if (marker) headers.push(header(marker));
        opaque(node.childForFieldName("body"));
        descend = false;
      } else if (type === "cell_magic") {
        const node = cursor.currentNode;
        const headerSpan = header(node, true);
        const body = node.childForFieldName("body");
        const name = node.childForFieldName("name");
        // Node.text invokes Tree-sitter's buffer-backed callback. Reuse the
        // immutable captured source rather than copy the document per header.
        const magicName =
          name && name.endIndex - name.startIndex <= 16
            ? source.slice(name.startIndex, name.endIndex)
            : null;
        const pythonAlias = magicName && CELL_LANGUAGES.get(magicName) === "python";
        const pythonWrapper =
          body?.type === "python_cell_body" || (magicName && PYTHON_WRAPPERS.has(magicName));
        if (
          (pythonAlias || pythonWrapper) &&
          /[\r\n]$/.test(source.slice(headerSpan.start, headerSpan.end))
        )
          emptyPythonStarts.add(headerSpan.end);
        if (body?.type !== "python_cell_body") {
          if (!pythonAlias) {
            hasOpaqueBody = true;
            opaque(body);
          }
          descend = false;
        }
      } else if (STATEMENTS.has(type) || EXPRESSIONS.has(type)) {
        const node = cursor.currentNode;
        const item = {
          start: node.startIndex,
          end: node.endIndex,
          kind: EXPRESSIONS.has(type) ? "rhs" : "statement",
        };
        protectedSpans.push(item);
        replacements.push(item);
        sentinels.push(item);
        descend = false;
      }
      const pending = tick();
      if (pending) await pending;
      if (descend && cursor.gotoFirstChild()) depth++;
      else {
        while (depth > 0 && !cursor.gotoNextSibling()) {
          cursor.gotoParent();
          depth--;
        }
        visiting = depth > 0;
      }
    }
  } finally {
    // Native cursors are GC-owned; the web backend requires explicit release.
    cursor.delete?.();
  }
  headers.sort((a, b) => a.start - b.start);
  const uniqueHeaders = headers.filter(
    (item, index) => index === 0 || item.start !== headers[index - 1].start,
  );
  const frames = [];
  let start = 0;
  for (const item of uniqueHeaders) {
    if (start < item.start) frames.push({ start, end: item.start });
    start = item.end;
  }
  if (start < source.length) frames.push({ start, end: source.length });
  const exclusions = merge(cuts),
    regions = [];
  for (const frame of frames) {
    let offset = frame.start;
    for (
      let index = lowerBound(exclusions, offset + 1, (item) => item.end);
      index < exclusions.length;
      index++
    ) {
      const cut = exclusions[index];
      if (cut.end <= offset) continue;
      if (cut.start >= frame.end) break;
      if (offset < cut.start) regions.push({ start: offset, end: Math.min(cut.start, frame.end) });
      offset = Math.max(offset, cut.end);
    }
    if (offset < frame.end) regions.push({ start: offset, end: frame.end });
    const pending = tick();
    if (pending) await pending;
  }
  if (!source.length || emptyPythonStarts.has(source.length))
    regions.push({ start: source.length, end: source.length });
  return {
    protectedSpans: merge(protectedSpans),
    replacements: replacements.toSorted((a, b) => a.start - b.start),
    sentinels: sentinels.toSorted((a, b) => a.start - b.start),
    regions,
    hasOpaqueBody,
  };
}
