const { Point, Range, CompositeDisposable } = require("lumine");

const CHUNK = 4096;
const createFormattingBatch = require("./formatting-batch");
const { abortError, lowerBound, cooperative } = require("./projection-spans");
let sentinelGeneration = 0;

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
// Sparse counts bound the first lookup in a multi-megabyte Unicode row.
// Two queried chunks retain individual offsets; no whole-row list is stored.
class PairIndex {
  constructor(source) {
    this.source = source;
    this.blocks = [];
    this.queries = new Map();
  }
  before(value) {
    const block = this.blocks[lowerBound(this.blocks, value + 1, (item) => item.start) - 1];
    if (!block) return 0;
    if (value >= block.end) return block.before + block.count;
    let offsets = this.queries.get(block.start);
    if (!offsets) {
      offsets = new PairOffsets();
      const text = this.source.slice(block.start, block.end),
        pattern = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
      for (let match; (match = pattern.exec(text));) offsets.add(match.index);
      if (this.queries.size === 2) this.queries.delete(this.queries.keys().next().value);
      this.queries.set(block.start, offsets);
    }
    return block.before + offsets.before(value - block.start);
  }
}
async function buildPairIndex(source, current) {
  const output = new PairIndex(source),
    tick = cooperative(current);
  let total = 0;
  for (let start = 0; start < source.length;) {
    let end = Math.min(start + CHUNK, source.length);
    // Never bisect a pair: 4097 UTF16 units still contain <=4096 codepoints.
    if (
      source.charCodeAt(end - 1) >= 0xd800 &&
      source.charCodeAt(end - 1) <= 0xdbff &&
      source.charCodeAt(end) >= 0xdc00 &&
      source.charCodeAt(end) <= 0xdfff
    )
      end++;
    const chunk = source.slice(start, end);
    if (/[\uD800-\uDBFF]/.test(chunk)) {
      const pattern = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
      let count = 0;
      while (pattern.exec(chunk)) count++;
      if (count) {
        output.blocks.push({ start, end, before: total, count });
        total += count;
      }
    }
    start = end;
    const pending = tick();
    if (pending) await pending;
  }
  return output;
}
async function hasExtensionSigil(source, current) {
  const tick = cooperative(current);
  for (let offset = 0; offset < source.length; offset += CHUNK) {
    if (/[%!?]/.test(source.slice(offset, offset + CHUNK))) return true;
    const pending = tick();
    if (pending) await pending;
  }
  return false;
}
function identityData(source) {
  return {
    protectedSpans: [],
    replacements: [],
    sentinels: [],
    hasOpaqueBody: false,
    regions: [{ start: 0, end: source.length }],
  };
}
async function masked(source, start, end, tick) {
  const pieces = [];
  for (let offset = start; offset < end; offset += CHUNK) {
    pieces.push(source.slice(offset, Math.min(offset + CHUNK, end)).replace(/[^\r\n]/g, " "));
    const pending = tick();
    if (pending) await pending;
  }
  return pieces.join("");
}
async function buildText(source, data, current) {
  if (!data.replacements.length) return { text: source, transforms: [] };
  const pieces = [],
    transforms = [];
  let offset = 0,
    delta = 0;
  const tick = cooperative(current);
  for (const item of data.replacements) {
    if (item.start < offset) continue;
    pieces.push(source.slice(offset, item.start));
    const width = item.end - item.start;
    let replacement = await masked(source, item.start, item.end, tick);
    if (item.kind !== "opaque") {
      // A logical command may span physical rows. Preserve every newline so
      // all later source/server row mappings still describe the same lines.
      const firstBreak = replacement.search(/[\r\n]/);
      const firstWidth = firstBreak < 0 ? replacement.length : firstBreak;
      const sentinel = item.kind === "rhs" ? "eval('')" : "0";
      replacement =
        sentinel.padEnd(Math.max(sentinel.length, firstWidth), " ") + replacement.slice(firstWidth);
    }
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
    const pending = tick();
    if (pending) await pending;
  }
  pieces.push(source.slice(offset));
  const text = pieces.join("");
  return { text, transforms };
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
async function formattingBlocks(source, data, ranges, current) {
  let prefix;
  const tick = cooperative(current);
  let collision;
  do {
    prefix = `__lumine_ipy_${++sentinelGeneration}_`;
    collision = false;
    for (let offset = 0; data.sentinels.length && offset < source.length; offset += CHUNK) {
      if (source.slice(offset, offset + CHUNK + prefix.length - 1).includes(prefix)) {
        collision = true;
        break;
      }
      const pending = tick();
      if (pending) await pending;
    }
  } while (collision);
  const blocks = [];
  for (const [regionIndex, region] of data.regions.entries()) {
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
      const pending = tick();
      if (pending) await pending;
    }
    pieces.push(source.slice(offset, region.end));
    const text = pieces.join("");
    let hasContent = false;
    for (let index = 0; index < text.length; index += CHUNK) {
      if (/\S/.test(text.slice(index, index + CHUNK))) {
        hasContent = true;
        break;
      }
      const pending = tick();
      if (pending) await pending;
    }
    if (!hasContent) continue;
    const blockRange = ranges[regionIndex];
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
    const pending = tick();
    if (pending) await pending;
  }
  return Object.freeze(blocks);
}
async function snapshot(editor, source, data, current, identity = false) {
  const buffer = editor.getBuffer();
  if (identity) data = identityData(source);
  const built = await buildText(source, data, current);
  const isIdentity = built.text === source;
  const sourcePairs = await buildPairIndex(source, current);
  const serverPairs = isIdentity ? sourcePairs : await buildPairIndex(built.text, current);
  let blocksPromise = null,
    batchPromise = null;
  const getFormattingBlocks = async () => {
    if (!current()) return [];
    blocksPromise ??= formattingBlocks(source, data, pythonFormattingRegions, current);
    try {
      const blocks = await blocksPromise;
      return current() ? blocks : [];
    } catch (error) {
      if (current()) throw error;
      return [];
    }
  };
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
  const convertCodePoints = (value, projected, reverse) => {
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
    const pairs = projected ? serverPairs : sourcePairs,
      first = pairs.before(line.start),
      last = pairs.before(line.end);
    if (reverse) {
      if (candidate.column > line.end - line.start - (last - first)) return null;
      let low = 0,
        high = line.end - line.start;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (middle - (pairs.before(line.start + middle) - first) < candidate.column)
          low = middle + 1;
        else high = middle;
      }
      return new Point(candidate.row, low);
    }
    if (candidate.column > line.end - line.start) return null;
    const offset = line.start + candidate.column,
      content = projected ? text : source;
    if (
      candidate.column > 0 &&
      content.charCodeAt(offset - 1) >= 0xd800 &&
      content.charCodeAt(offset - 1) <= 0xdbff &&
      content.charCodeAt(offset) >= 0xdc00 &&
      content.charCodeAt(offset) <= 0xdfff
    )
      return null;
    const before = pairs.before(offset);
    return new Point(candidate.row, candidate.column - (before - first));
  };
  const geometryTick = cooperative(current);
  const rangesFor = async (spans) => {
    const ranges = [];
    for (const item of spans) {
      ranges.push(frozenRange(originalPoint(item.start), originalPoint(item.end)));
      const pending = geometryTick();
      if (pending) await pending;
    }
    return Object.freeze(ranges);
  };
  const protectedRanges = await rangesFor(data.protectedSpans);
  const syntheticRanges = await rangesFor(data.sentinels);
  const pythonFormattingRegions = await rangesFor(data.regions);
  return Object.freeze({
    source,
    text,
    isIdentity,
    isCurrent: current,
    protectedRanges,
    syntheticRanges,
    pythonFormattingRegions,
    isPythonPosition,
    isPythonRange,
    ownsPosition: isPythonPosition,
    ownsRange: isPythonRange,
    toServerPosition,
    fromServerPosition,
    toServerRange: (value) => mapRange(value, toServerPosition),
    fromServerRange: (value) => mapRange(value, fromServerPosition),
    toCodePointPosition: (value) => convertCodePoints(value, true, false),
    fromCodePointPosition: (value) => convertCodePoints(value, true, true),
    sourceToCodePointPosition: (value) => convertCodePoints(value, false, false),
    sourceFromCodePointPosition: (value) => convertCodePoints(value, false, true),
    getFormattingBlocks,
    async getFormattingBatch(requested) {
      const multiple =
        Array.isArray(requested) &&
        (!requested.length ||
          requested[0] instanceof Range ||
          requested[0]?.start ||
          (Array.isArray(requested[0]) && typeof requested[0][0] !== "number"));
      const ranges = !requested ? null : multiple ? requested.map(range) : range(requested);
      const buildBatch = async () =>
        createFormattingBatch(await getFormattingBlocks(), {
          source,
          isCurrent: current,
          range: ranges,
          allowWholeDocument: !data.hasOpaqueBody,
          sourceGeometry: ranges
            ? undefined
            : data.regions.map((item, index) => ({
                range: pythonFormattingRegions[index],
                start: item.start,
                end: item.end,
              })),
        });
      if (!current()) return null;
      const batch = await (ranges ? buildBatch() : (batchPromise ??= buildBatch()));
      return current() ? batch : null;
    },
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
        source: null,
        pending: null,
        subscriptions: new CompositeDisposable(),
      };
      const invalidate = () => {
        state.revision++;
        state.cached = null;
        state.source = null;
        const pending = state.pending;
        state.pending = null;
        pending?.controller.abort(abortError());
      };
      state.subscriptions.add(
        buffer.onDidChange(invalidate),
        buffer.onDidChangeLanguageMode(invalidate),
        buffer.onDidChangePath(invalidate),
        buffer.onDidDestroy(() => {
          invalidate();
          state.subscriptions.dispose();
          this.live.delete(state);
        }),
      );
      this.states.set(buffer, state);
      this.live.add(state);
    }
    return state;
  }
  buildSnapshot(editor, source, data, current, identity = false) {
    return snapshot(editor, source, data, current, identity);
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
      const revision = state.revision,
        mode = buffer.getLanguageMode(),
        grammar = editor.getGrammar(),
        filePath = buffer.getPath();
      let syntaxToken = null;
      const current = () =>
        !this.disposed &&
        this.generation === generation &&
        state.revision === revision &&
        !buffer.isDestroyed() &&
        buffer.getLanguageMode() === mode &&
        buffer.getPath() === filePath &&
        (!syntaxToken || buffer.getSyntaxSnapshotToken() === syntaxToken) &&
        mode.grammar === grammar &&
        grammar.scopeName === "source.python.ipy";
      if (state.cached?.isCurrent()) return state.cached;
      let pending = state.pending;
      if (
        !pending ||
        pending.revision !== revision ||
        pending.mode !== mode ||
        !pending.isCurrent()
      ) {
        // Validity belongs to the shared producer, independently of a caller's
        // signal. Every waiter must use the token that producer actually read.
        pending = { revision, mode, isCurrent: current, controller: new AbortController() };
        state.pending = pending;
        pending.promise = (async () => {
          // Syntax may settle again without a text edit. Retain this read for
          // the whole shared retry chain, then release it with the task.
          const source = (state.source ??= buffer.getText());
          if (!(await hasExtensionSigil(source, current)))
            return this.buildSnapshot(editor, source, null, current, true);
          // The shared wait belongs to the buffer's mode, so closing one split
          // neither cancels another caller nor lets a stale tree classify text.
          const transaction = await waitFor(mode.atGrammarSettlement(), pending.controller.signal);
          if (!current()) throw abortError();
          if (transaction?.parseError)
            throw new Error("The IPython grammar could not settle for source projection.");
          syntaxToken = buffer.getSyntaxSnapshotToken();
          const data = { protectedSpans: [], replacements: [], sentinels: [], regions: [] };
          const result = await buffer.analyzeSyntax(
            require.resolve("./source-projection-structure"),
            "collect",
            null,
            {
              signal: pending.controller.signal,
              onChunk: ({ field, records }) => {
                for (const record of records) {
                  data[field].push(record);
                  // Statement and RHS replacements are also formatting sentinels;
                  // derive that subset instead of transferring the records twice.
                  if (field === "replacements" && record.kind !== "opaque")
                    data.sentinels.push(record);
                }
              },
            },
          );
          if (!result || !current()) throw abortError();
          for (const [field, count] of Object.entries(result.counts))
            if (data[field].length !== count)
              throw new Error("Incomplete IPython structure stream");
          data.hasOpaqueBody = result.hasOpaqueBody;
          return this.buildSnapshot(editor, source, data, current);
        })()
          .then((value) => {
            if (current()) state.cached = value;
            return value;
          })
          .finally(() => {
            if (state.pending === pending) {
              state.pending = null;
              if (current()) state.source = null;
            }
          });
        // Invalidation may release every waiter before the shared task settles.
        void pending.promise.catch(() => {});
      }
      try {
        const combined = signal
          ? AbortSignal.any([signal, pending.controller.signal])
          : pending.controller.signal;
        const result = await waitFor(pending.promise, combined);
        if (result.isCurrent()) return result;
      } catch (error) {
        checkSignal(signal);
        if (pending.isCurrent() || this.disposed) throw error;
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
      state.source = null;
      state.pending?.controller.abort(abortError());
      state.pending = null;
      state.subscriptions.dispose();
    }
    this.live.clear();
    this.states = new WeakMap();
  }
}
module.exports = { SourceProjectionService };
