const { Point, Range, CompositeDisposable } = require("lumine");

const CHUNK = 4096;
const SLICE_MS = 8;
const CELL_LANGUAGES = require("./cell-languages");
const PYTHON_WRAPPERS = new Set(["time", "timeit", "prun", "debug", "capture", "code_wrap"]);
const STATEMENTS = new Set(["magic_statement", "shell_statement", "help_statement"]);
const EXPRESSIONS = new Set(["magic_expression", "shell_expression"]);
const LEAVES = new Set([
  "string",
  "comment",
  "cell_body",
  "cell_marker_marker",
  "cell_marker_name",
  "cell_marker_metadata",
  "dictionary",
  "list",
  "tuple",
  "set",
]);
let sentinelGeneration = 0;

function abortError() {
  const error = new Error("IPython source projection was cancelled.");
  error.name = "AbortError";
  return error;
}
function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason ?? abortError();
}
function point(value) {
  return Point.fromObject(value);
}
function range(value) {
  return Range.fromObject(value);
}
function frozenRange(start, end) {
  const result = new Range(start, end);
  Object.freeze(result.start);
  Object.freeze(result.end);
  return Object.freeze(result);
}
function lowerBound(items, value, key = (item) => item) {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (key(items[middle]) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
function merge(spans) {
  const output = [];
  for (const span of spans.toSorted((a, b) => a.start - b.start || a.end - b.end)) {
    if (span.end <= span.start) continue;
    const previous = output.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else output.push({ start: span.start, end: span.end });
  }
  return output;
}
function inside(spans, offset, strict = false) {
  const index = lowerBound(spans, offset + 1, (span) => span.start) - 1;
  const span = spans[index];
  return !!span && (strict ? offset > span.start : offset >= span.start) && offset < span.end;
}
function overlaps(spans, start, end) {
  if (start === end) return inside(spans, start);
  const index = lowerBound(spans, start + 1, (span) => span.end);
  return !!spans[index] && spans[index].start < end;
}
function lineExtent(buffer, row) {
  const start = buffer.characterIndexForPosition([row, 0]);
  const end =
    row + 1 < buffer.getLineCount()
      ? buffer.characterIndexForPosition([row + 1, 0])
      : buffer.getLength();
  return { start, end };
}
function isDocument(editor) {
  return (
    editor?.getGrammar?.()?.scopeName === "source.python.ipy" &&
    !editor.isDestroyed?.() &&
    lumine.textEditors.roleFor?.(editor) !== "fragment"
  );
}
async function waitFor(promise, signal) {
  checkSignal(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function cooperative(current) {
  let started = performance.now(),
    count = 0;
  return async (force = false) => {
    if (force || ++count % CHUNK === 0 || performance.now() - started >= SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!current()) throw abortError();
      started = performance.now();
    }
  };
}
// Compact chunked offsets avoid a per-line Unicode object and a large temporary
// array when a body contains millions of astral characters.
class PairOffsets {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  add(value) {
    if (this.length % CHUNK === 0) this.chunks.push(new Uint32Array(CHUNK));
    this.chunks[this.length >>> 12][this.length & (CHUNK - 1)] = value;
    this.length++;
  }
  at(index) {
    return this.chunks[index >>> 12][index & (CHUNK - 1)];
  }
  before(value) {
    let low = 0,
      high = this.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.at(middle) < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
async function collect(editor, source, tree, current) {
  const buffer = editor.getBuffer();
  const headers = [],
    emptyPythonStarts = new Set(),
    cuts = [],
    protectedSpans = [],
    replacements = [],
    sentinels = [];
  const tick = cooperative(current);
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
        const pythonAlias =
          name &&
          name.endIndex - name.startIndex <= 16 &&
          CELL_LANGUAGES.get(name.text) === "python";
        const pythonWrapper =
          body?.type === "python_cell_body" ||
          (name && name.endIndex - name.startIndex <= 16 && PYTHON_WRAPPERS.has(name.text));
        if (
          (pythonAlias || pythonWrapper) &&
          /[\r\n]$/.test(source.slice(headerSpan.start, headerSpan.end))
        )
          emptyPythonStarts.add(headerSpan.end);
        if (body?.type !== "python_cell_body") {
          if (!pythonAlias) opaque(body);
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
      await tick();
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
    cursor.delete();
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
    await tick();
  }
  if (!source.length || emptyPythonStarts.has(source.length))
    regions.push({ start: source.length, end: source.length });
  return {
    protectedSpans: merge(protectedSpans),
    replacements: replacements.toSorted((a, b) => a.start - b.start),
    sentinels: sentinels.toSorted((a, b) => a.start - b.start),
    regions,
  };
}
async function masked(source, start, end, tick) {
  const pieces = [];
  for (let offset = start; offset < end; offset += CHUNK) {
    pieces.push(source.slice(offset, Math.min(offset + CHUNK, end)).replace(/[^\r\n]/g, " "));
    await tick(true);
  }
  return pieces.join("");
}
async function buildText(source, data, current) {
  const pieces = [],
    transforms = [];
  let offset = 0,
    delta = 0;
  const tick = cooperative(current);
  for (const item of data.replacements) {
    if (item.start < offset) continue;
    pieces.push(source.slice(offset, item.start));
    const width = item.end - item.start;
    const replacement =
      item.kind === "opaque"
        ? await masked(source, item.start, item.end, tick)
        : item.kind === "rhs"
          ? "eval('')".padEnd(Math.max(8, width), " ")
          : "0".padEnd(width, " ");
    const transform = {
      ...item,
      serverStart: item.start + delta,
      serverEnd: item.start + delta + replacement.length,
      deltaBefore: delta,
    };
    delta += replacement.length - width;
    transform.deltaAfter = delta;
    transforms.push(transform);
    pieces.push(replacement);
    offset = item.end;
    await tick();
  }
  pieces.push(source.slice(offset));
  const text = pieces.join("");
  const sourcePairs = new PairOffsets(),
    serverPairs = new PairOffsets();
  let transformIndex = 0,
    previousDelta = 0;
  for (let chunkStart = 0; chunkStart < source.length; chunkStart += CHUNK) {
    for (let index = chunkStart; index < Math.min(chunkStart + CHUNK, source.length); index++) {
      while (transformIndex < transforms.length && index >= transforms[transformIndex].end)
        previousDelta = transforms[transformIndex++].deltaAfter;
      const character = source.charCodeAt(index),
        next = source.charCodeAt(index + 1);
      if (character >= 0xd800 && character <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        sourcePairs.add(index);
        const transform = transforms[transformIndex];
        if (!transform || index < transform.start) serverPairs.add(index + previousDelta);
      }
    }
    await tick(true);
  }
  return { text, transforms, sourcePairs, serverPairs };
}
function forwardOffset(transforms, offset) {
  const index = lowerBound(transforms, offset + 1, (item) => item.start) - 1;
  const item = transforms[index];
  if (!item) return offset;
  if (offset === item.start) return item.serverStart;
  if (offset < item.end)
    return item.serverStart + Math.min(offset - item.start, item.serverEnd - item.serverStart);
  return offset + item.deltaAfter;
}
function backwardOffset(transforms, offset) {
  const index = lowerBound(transforms, offset + 1, (item) => item.serverStart) - 1;
  const item = transforms[index];
  if (!item) return offset;
  if (offset === item.serverStart) return item.start;
  if (offset < item.serverEnd)
    return item.start + Math.min(offset - item.serverStart, item.end - item.start);
  return offset - item.deltaAfter;
}
function restoreBlock(formatted, records, prefix) {
  if (typeof formatted !== "string") return null;
  if (!records.length) return formatted;
  const byName = new Map(records.map((item) => [item.name, item]));
  const matches = [],
    found = new Set();
  const pattern = new RegExp(
    `"""|'''|["']|#[^\\r\\n]*|[()[\\]{}]|\\b(${prefix}(?:statement|rhs)_\\d+)\\s*\\(\\s*\\)`,
    "g",
  );
  let match,
    depth = 0;
  while ((match = pattern.exec(formatted))) {
    const token = match[0];
    if (match[1]) {
      const record = byName.get(match[1]);
      if (!record || found.has(record.name)) return null;
      const lineStart =
        Math.max(
          formatted.lastIndexOf("\n", match.index - 1),
          formatted.lastIndexOf("\r", match.index - 1),
        ) + 1;
      let lineEnd = formatted.indexOf("\n", pattern.lastIndex);
      if (lineEnd < 0) lineEnd = formatted.length;
      const before = formatted.slice(lineStart, match.index).trimEnd();
      const after = formatted.slice(pattern.lastIndex, lineEnd).trim();
      if (
        depth !== 0 ||
        after ||
        (record.kind === "rhs" ? !before.endsWith("=") : before.trim() && !/[;:]$/.test(before))
      )
        return null;
      found.add(record.name);
      matches.push({ start: match.index, end: pattern.lastIndex, text: record.original });
    } else if (token[0] === "#") continue;
    else if (token[0] === "'" || token[0] === '"') {
      let end = formatted.indexOf(token, pattern.lastIndex);
      while (end >= 0) {
        let slash = end;
        while (slash > 0 && formatted[slash - 1] === "\\") slash--;
        if ((end - slash) % 2 === 0) break;
        end = formatted.indexOf(token, end + token.length);
      }
      if (end < 0 || (token.length === 1 && /[\r\n]/.test(formatted.slice(pattern.lastIndex, end))))
        return null;
      pattern.lastIndex = end + token.length;
    } else if (/[([{]/.test(token)) depth++;
    else depth--;
  }
  if (found.size !== records.length || depth !== 0) return null;
  const pieces = [];
  let offset = 0;
  for (const item of matches) {
    pieces.push(formatted.slice(offset, item.start), item.text);
    offset = item.end;
  }
  pieces.push(formatted.slice(offset));
  return pieces.join("");
}
async function formattingBlocks(source, data, buffer, current) {
  let prefix;
  const tick = cooperative(current);
  let collision;
  do {
    prefix = `__lumine_ipy_${++sentinelGeneration}_`;
    collision = false;
    for (let offset = 0; offset < source.length; offset += CHUNK) {
      if (source.slice(offset, offset + CHUNK + prefix.length - 1).includes(prefix)) {
        collision = true;
        break;
      }
      await tick(true);
    }
  } while (collision);
  const blocks = [];
  for (const region of data.regions) {
    const records = [];
    for (
      let index = lowerBound(data.sentinels, region.start, (item) => item.start);
      index < data.sentinels.length && data.sentinels[index].start < region.end;
      index++
    ) {
      const item = data.sentinels[index];
      if (item.end <= region.end)
        records.push({
          ...item,
          name: `${prefix}${item.kind}_${index}`,
          original: source.slice(item.start, item.end),
        });
    }
    const pieces = [];
    let offset = region.start;
    for (const item of records) {
      pieces.push(source.slice(offset, item.start), `${item.name}()`);
      offset = item.end;
      await tick();
    }
    pieces.push(source.slice(offset, region.end));
    const text = pieces.join("");
    let hasContent = false;
    for (let index = 0; index < text.length; index += CHUNK) {
      if (/\S/.test(text.slice(index, index + CHUNK))) {
        hasContent = true;
        break;
      }
      await tick(true);
    }
    if (!hasContent) continue;
    const blockRange = frozenRange(
      buffer.positionForCharacterIndex(region.start),
      buffer.positionForCharacterIndex(region.end),
    );
    blocks.push(
      Object.freeze({
        range: blockRange,
        text,
        restore(formatted) {
          if (!current()) return null;
          const restored = restoreBlock(formatted, records, prefix);
          return current() ? restored : null;
        },
      }),
    );
    await tick();
  }
  return Object.freeze(blocks);
}
async function snapshot(editor, source, tree, current) {
  const buffer = editor.getBuffer();
  const data = await collect(editor, source, tree, current);
  const built = await buildText(source, data, current);
  const blocks = await formattingBlocks(source, data, buffer, current);
  const { text, transforms } = built;
  const serverProtected = data.protectedSpans.map((item) => ({
    start: forwardOffset(transforms, item.start),
    end: forwardOffset(transforms, item.end),
  }));
  const originalOffset = (value) => {
    if (!current()) return null;
    const candidate = point(value),
      clipped = buffer.clipPosition(candidate);
    return candidate.isEqual(clipped) ? buffer.characterIndexForPosition(candidate) : null;
  };
  const serverLine = (row) => {
    if (!current() || row < 0 || row >= buffer.getLineCount()) return null;
    const sourceStart = buffer.characterIndexForPosition([row, 0]);
    const sourceEnd = sourceStart + buffer.lineLengthForRow(row);
    return {
      start: forwardOffset(transforms, sourceStart),
      end: forwardOffset(transforms, sourceEnd),
    };
  };
  const serverOffset = (value) => {
    const candidate = point(value),
      line = serverLine(candidate.row);
    return line && candidate.column >= 0 && candidate.column <= line.end - line.start
      ? line.start + candidate.column
      : null;
  };
  const originalPoint = (offset) => buffer.positionForCharacterIndex(offset);
  const projectedPoint = (offset) => {
    const sourcePoint = originalPoint(backwardOffset(transforms, offset));
    const line = serverLine(sourcePoint.row);
    return new Point(sourcePoint.row, offset - line.start);
  };
  const isPythonPosition = (value) => {
    const offset = originalOffset(value);
    if (offset === null || inside(data.protectedSpans, offset)) return false;
    const emptyBody = data.regions.at(-1)?.start === offset && data.regions.at(-1)?.end === offset;
    if (offset === source.length && data.protectedSpans.at(-1)?.end === offset && !emptyBody)
      return false;
    const synthetic = data.sentinels[lowerBound(data.sentinels, offset, (item) => item.end)];
    if (synthetic?.end === offset) return false;
    const region = data.regions[lowerBound(data.regions, offset + 1, (item) => item.start) - 1];
    return !!region && (offset < region.end || (offset === source.length && region.end === offset));
  };
  const isPythonRange = (value) => {
    const candidate = range(value),
      start = originalOffset(candidate.start),
      end = originalOffset(candidate.end);
    if (start === null || end === null || start > end || overlaps(data.protectedSpans, start, end))
      return false;
    const region = data.regions[lowerBound(data.regions, start + 1, (item) => item.start) - 1];
    return start === end ? isPythonPosition(candidate.start) : !!region && end <= region.end;
  };
  const toServerPosition = (value) => {
    const offset = originalOffset(value);
    return offset === null || inside(data.protectedSpans, offset, true)
      ? null
      : projectedPoint(forwardOffset(transforms, offset));
  };
  const fromServerPosition = (value) => {
    const offset = serverOffset(value);
    return offset === null || inside(serverProtected, offset, true)
      ? null
      : originalPoint(backwardOffset(transforms, offset));
  };
  const mapRange = (value, mapper) => {
    const candidate = range(value),
      start = mapper(candidate.start),
      end = mapper(candidate.end);
    return start && end ? new Range(start, end) : null;
  };
  const convertCodePoints = (value, pairs, projected, reverse) => {
    if (!current()) return null;
    const candidate = point(value);
    const line = projected
      ? serverLine(candidate.row)
      : serverLine(candidate.row) && {
          start: buffer.characterIndexForPosition([candidate.row, 0]),
          end:
            buffer.characterIndexForPosition([candidate.row, 0]) +
            buffer.lineLengthForRow(candidate.row),
        };
    if (!line || candidate.column < 0) return null;
    const first = pairs.before(line.start),
      last = pairs.before(line.end);
    if (reverse) {
      if (candidate.column > line.end - line.start - (last - first)) return null;
      let low = first,
        high = last;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (pairs.at(middle) - line.start - (middle - first) < candidate.column) low = middle + 1;
        else high = middle;
      }
      return new Point(candidate.row, candidate.column + low - first);
    }
    if (candidate.column > line.end - line.start) return null;
    const absolute = line.start + candidate.column,
      before = pairs.before(absolute);
    if (before > first && pairs.at(before - 1) + 1 === absolute) return null;
    return new Point(candidate.row, candidate.column - (before - first));
  };
  const protectedRanges = Object.freeze(
    data.protectedSpans.map((item) =>
      frozenRange(originalPoint(item.start), originalPoint(item.end)),
    ),
  );
  const syntheticRanges = Object.freeze(
    data.sentinels.map((item) => frozenRange(originalPoint(item.start), originalPoint(item.end))),
  );
  return Object.freeze({
    source,
    text,
    isCurrent: current,
    protectedRanges,
    syntheticRanges,
    pythonFormattingRegions: Object.freeze(blocks.map((block) => block.range)),
    isPythonPosition,
    isPythonRange,
    toServerPosition,
    fromServerPosition,
    toServerRange: (value) => mapRange(value, toServerPosition),
    fromServerRange: (value) => mapRange(value, fromServerPosition),
    toCodePointPosition: (value) => convertCodePoints(value, built.serverPairs, true, false),
    fromCodePointPosition: (value) => convertCodePoints(value, built.serverPairs, true, true),
    sourceToCodePointPosition: (value) => convertCodePoints(value, built.sourcePairs, false, false),
    sourceFromCodePointPosition: (value) =>
      convertCodePoints(value, built.sourcePairs, false, true),
    getFormattingBlocks: () => (current() ? blocks : []),
    mapEdits(edits) {
      if (!current() || !Array.isArray(edits)) return null;
      const output = [];
      for (const edit of edits) {
        if (typeof edit?.newText !== "string") return null;
        const oldRange = mapRange(edit.oldRange, fromServerPosition);
        if (!oldRange || !isPythonRange(oldRange)) return null;
        output.push({ oldRange, newText: edit.newText });
      }
      const sorted = output.toSorted((a, b) => a.oldRange.start.compare(b.oldRange.start));
      for (let index = 1; index < sorted.length; index++)
        if (sorted[index - 1].oldRange.end.isGreaterThan(sorted[index].oldRange.start)) return null;
      return current() ? output : null;
    },
  });
}

class SourceProjectionService {
  constructor() {
    this.states = new WeakMap();
    this.live = new Set();
    this.owned = new Set();
    this.generation = 0;
    this.disposed = false;
  }
  isApplicable(editor) {
    return isDocument(editor);
  }
  stateFor(buffer) {
    let state = this.states.get(buffer);
    if (!state) {
      state = {
        revision: 0,
        cached: null,
        pending: null,
        subscriptions: new CompositeDisposable(),
      };
      const changed = buffer.onDidChange(() => {
        state.revision++;
        state.cached = null;
      });
      state.subscriptions.add(
        changed,
        buffer.onDidDestroy(() => {
          state.revision++;
          state.cached = null;
          state.subscriptions.dispose();
          this.live.delete(state);
        }),
      );
      this.states.set(buffer, state);
      this.live.add(state);
    }
    return state;
  }
  buildSnapshot(editor, source, tree, current) {
    return snapshot(editor, source, tree, current);
  }
  async project(editor, { signal } = {}) {
    checkSignal(signal);
    if (!this.isApplicable(editor)) return null;
    if (this.disposed) throw abortError();
    const buffer = editor.getBuffer(),
      state = this.stateFor(buffer),
      generation = this.generation;
    while (this.isApplicable(editor) && !this.disposed) {
      checkSignal(signal);
      if (!(await editor.whenGrammarSettled({ signal })))
        throw new Error("The IPython grammar could not settle for source projection.");
      checkSignal(signal);
      const revision = state.revision,
        mode = buffer.getLanguageMode(),
        grammar = editor.getGrammar();
      const editorReference = new WeakRef(editor);
      const current = () =>
        !this.disposed &&
        this.generation === generation &&
        state.revision === revision &&
        !buffer.isDestroyed() &&
        buffer.getLanguageMode() === mode &&
        mode.grammar === grammar &&
        this.isApplicable(editorReference.deref());
      if (state.cached?.isCurrent()) return state.cached;
      if (!state.pending || state.pending.revision !== revision || state.pending.mode !== mode) {
        const tree = mode.rootLanguageLayer?.tree;
        if (!tree) throw new Error("The IPython syntax tree is unavailable for source projection.");
        const pending = { revision, mode };
        pending.promise = this.buildSnapshot(editor, buffer.getText(), tree, current)
          .then((value) => {
            if (current()) state.cached = value;
            return value;
          })
          .finally(() => {
            if (state.pending === pending) state.pending = null;
          });
        state.pending = pending;
      }
      try {
        const result = await waitFor(state.pending.promise, signal);
        if (result.isCurrent()) return result;
      } catch (error) {
        checkSignal(signal);
        if (current() || this.disposed) throw error;
      }
    }
    if (this.disposed) throw abortError();
    return null;
  }
  async projectText(source, { filePath = null, signal } = {}) {
    checkSignal(signal);
    if (this.disposed) throw abortError();
    if (typeof source !== "string") throw new TypeError("IPython source must be a string.");
    const editor = lumine.workspace.buildTextEditor();
    this.owned.add(editor);
    editor.onDidDestroy(() => this.owned.delete(editor));
    const dispose = () => {
      if (!editor.isDestroyed()) editor.destroy();
    };
    try {
      editor.setText(source);
      lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
      const result = await this.project(editor, { signal });
      if (!result) throw abortError();
      return Object.freeze({ ...result, filePath, dispose });
    } catch (error) {
      dispose();
      throw error;
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    for (const editor of this.owned) editor.destroy();
    this.owned.clear();
    for (const state of this.live) {
      state.cached = null;
      state.subscriptions.dispose();
    }
    this.live.clear();
    this.states = new WeakMap();
  }
}
module.exports = { SourceProjectionService };
