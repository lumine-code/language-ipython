const { TextBuffer, Point, Range } = require("lumine");

let generation = 0;
const CHUNK = 4096;

function owns(range, regions) {
  let low = 0,
    high = regions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (regions[middle].range.start.compare(range.start) <= 0) low = middle + 1;
    else high = middle;
  }
  return low > 0 && regions[low - 1].range.containsRange(range);
}

function extent(text) {
  let row = 0,
    columnStart = 0;
  const endings = /\r?\n/g;
  while (endings.exec(text)) {
    row++;
    columnStart = endings.lastIndex;
  }
  return new Point(row, text.length - columnStart);
}

function splitBoundary(text, offset) {
  return (
    offset > 0 &&
    offset < text.length &&
    ((text[offset - 1] === "\r" && text[offset] === "\n") ||
      (text.charCodeAt(offset - 1) >= 0xd800 &&
        text.charCodeAt(offset - 1) <= 0xdbff &&
        text.charCodeAt(offset) >= 0xdc00 &&
        text.charCodeAt(offset) <= 0xdfff))
  );
}

function trimChange(before, after) {
  if (before === after) return null;
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  if (prefix === before.length && prefix === after.length) return null;
  if (splitBoundary(before, prefix) || splitBoundary(after, prefix)) prefix--;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
  )
    suffix++;
  if (splitBoundary(before, before.length - suffix) || splitBoundary(after, after.length - suffix))
    suffix--;
  return { prefix, suffix };
}

function withEditPlan(
  batch,
  source,
  current,
  requested,
  allowWholeDocument,
  bodyRanges,
  sourceGeometry,
) {
  let geometryPromise;
  const bodyOrder = Object.freeze(
    bodyRanges
      .map((range, index) => ({ range, index }))
      .sort((a, b) => a.range.start.compare(b.range.start))
      .map((item) => item.index),
  );
  const prepareGeometry = async () => {
    const ranges = bodyOrder.map((index) => bodyRanges[index]);
    const supplied = new Map((sourceGeometry || []).map((item) => [item.range, item]));
    const endings = /\r?\n/g;
    let next = endings.exec(source),
      row = 0,
      rowStart = 0;
    const indexFor = (point) => {
      if (
        ![point.row, point.column].every((value) => Number.isInteger(value) && value >= 0) ||
        point.row < row
      )
        return null;
      while (row < point.row) {
        if (!next) return null;
        rowStart = next.index + next[0].length;
        row++;
        next = endings.exec(source);
      }
      return point.column <= (next?.index ?? source.length) - rowStart
        ? rowStart + point.column
        : null;
    };
    const output = [];
    let offset = 0,
      position = new Point(0, 0),
      started = performance.now();
    for (const range of ranges) {
      const scalar = supplied.get(range);
      const start = scalar ? scalar.start : indexFor(range.start),
        end = scalar ? scalar.end : indexFor(range.end);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < offset ||
        end < start ||
        end > source.length ||
        splitBoundary(source, start) ||
        splitBoundary(source, end)
      )
        return null;
      const expectedStart = position.traverse(extent(source.slice(offset, start)));
      const expectedEnd = expectedStart.traverse(extent(source.slice(start, end)));
      if (!expectedStart.isEqual(range.start) || !expectedEnd.isEqual(range.end)) return null;
      const cachedRange = new Range(range.start.copy(), range.end.copy());
      Object.freeze(cachedRange.start);
      Object.freeze(cachedRange.end);
      Object.freeze(cachedRange);
      output.push(Object.freeze({ range: cachedRange, start, end }));
      offset = end;
      position = range.end;
      if (performance.now() - started >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!current()) return null;
        started = performance.now();
      }
    }
    return Object.freeze(output);
  };
  const selections = requested
    ?.map((range) => ({ range }))
    .sort((a, b) => a.range.start.compare(b.range.start));
  const merged = [];
  for (const selection of selections || []) {
    const previous = merged.at(-1);
    if (previous && selection.range.start.compare(previous.range.end) <= 0)
      previous.range = previous.range.union(selection.range);
    else merged.push({ range: selection.range });
  }
  return Object.freeze({
    ...batch,
    async getEditPlan(formatted, selectionPoints = []) {
      const restored = batch.restore(formatted);
      if (!restored || !current()) return null;
      if (allowWholeDocument && !requested) {
        geometryPromise ??= prepareGeometry();
        const geometry = await geometryPromise;
        if (!geometry || geometry.length !== restored.length || !current()) return null;
        if (
          formatted === batch.text &&
          bodyOrder.every(
            (item, index) =>
              restored[item].range.isEqual(geometry[index].range) &&
              restored[item].text === source.slice(geometry[index].start, geometry[index].end),
          )
        )
          return current()
            ? { text: source, edits: [], fallback: false, replaceWholeDocument: true }
            : null;
        const pieces = [],
          edits = [],
          refinements = [];
        const points = selectionPoints
          .map((point) => Point.fromObject(point))
          .sort((a, b) => a.compare(b));
        const containsSelection = (range) => {
          let low = 0,
            high = points.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (points[middle].compare(range.start) < 0) low = middle + 1;
            else high = middle;
          }
          return low < points.length && points[low].compare(range.end) <= 0;
        };
        let oldEnd = new Point(0, 0),
          newEnd = new Point(0, 0),
          offset = 0;
        for (let index = 0; index < geometry.length; index++) {
          const scalar = geometry[index],
            region = restored[bodyOrder[index]];
          if (
            !region.range.isEqual(scalar.range) ||
            typeof region.text !== "string" ||
            (scalar.end < source.length &&
              scalar.range.end.column === 0 &&
              !/[\r\n]$/.test(region.text))
          )
            return null;
          pieces.push(source.slice(offset, scalar.start), region.text);
          offset = scalar.end;
          const targetStart = newEnd.traverse(scalar.range.start.traversalFrom(oldEnd)),
            before = source.slice(scalar.start, scalar.end),
            change = trimChange(before, region.text);
          if (change) {
            const { prefix, suffix } = change;
            const prefixExtent = extent(before.slice(0, prefix));
            const oldRange = new Range(
              scalar.range.start.traverse(prefixExtent),
              suffix
                ? scalar.range.start.traverse(extent(before.slice(0, before.length - suffix)))
                : scalar.range.end,
            );
            const newText = region.text.slice(prefix, region.text.length - suffix),
              start = targetStart.traverse(prefixExtent),
              end = start.traverse(extent(newText));
            if (containsSelection(oldRange))
              refinements.push({ region: { ...scalar, text: region.text }, targetStart });
            else {
              edits.push({
                oldRange,
                newRange: new Range(start, end),
                newText,
              });
            }
            newEnd = end.traverse(scalar.range.end.traversalFrom(oldRange.end));
          } else newEnd = targetStart.traverse(scalar.range.end.traversalFrom(scalar.range.start));
          oldEnd = scalar.range.end;
        }
        pieces.push(source.slice(offset));
        const text = pieces.join("");
        let buffer;
        try {
          for (const { region, targetStart } of refinements) {
            const before = source.slice(region.start, region.end);
            if (buffer) buffer.setText(before);
            else buffer = new TextBuffer({ text: before });
            for (const edit of buffer.getChangesToText(region.text))
              edits.push({
                oldRange: new Range(
                  region.range.start.traverse(edit.oldRange.start),
                  region.range.start.traverse(edit.oldRange.end),
                ),
                newRange: new Range(
                  targetStart.traverse(edit.newRange.start),
                  targetStart.traverse(edit.newRange.end),
                ),
                newText: edit.newText,
              });
          }
          if (refinements.length) edits.sort((a, b) => a.oldRange.start.compare(b.oldRange.start));
          return current() ? { text, edits, fallback: false, replaceWholeDocument: true } : null;
        } finally {
          buffer?.destroy();
        }
      }
      const regions = [...restored].sort((a, b) => a.range.start.compare(b.range.start));
      const buffer = new TextBuffer({ text: source });
      let sliceStart = performance.now();
      const cooperate = () => {
        if (performance.now() - sliceStart >= 8) {
          return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
            sliceStart = performance.now();
            return current();
          });
        }
        return null;
      };
      try {
        const pieces = [];
        const records = [];
        let offset = 0;
        for (const region of regions) {
          const range = Range.fromObject(region.range),
            start = buffer.characterIndexForPosition(range.start),
            end = buffer.characterIndexForPosition(range.end);
          if (
            !buffer.clipPosition(range.start).isEqual(range.start) ||
            !buffer.clipPosition(range.end).isEqual(range.end) ||
            start < offset ||
            end < start ||
            typeof region.text !== "string"
          )
            return null;
          if (end < source.length && range.end.column === 0 && !/[\r\n]$/.test(region.text))
            return null;
          pieces.push(source.slice(offset, start), region.text);
          records.push({ ...region, start, end });
          offset = end;
          const pending = cooperate();
          if (pending && !(await pending)) return null;
        }
        pieces.push(source.slice(offset));
        const text = pieces.join("");
        let edits = buffer
          .getChangesToText(text)
          .map(({ oldRange, newRange, newText }) => ({ oldRange, newRange, newText }));
        let fallback = false;
        if (edits.some((edit) => !owns(edit.oldRange, records))) {
          fallback = true;
          edits = [];
          for (const region of records) {
            const original = region.range;
            // Reuse the same scratch model when the native differ groups a
            // hunk across a header or another protected boundary.
            buffer.setText(source.slice(region.start, region.end));
            for (const edit of buffer.getChangesToText(region.text)) {
              const toSource = (point) =>
                new Point(
                  original.start.row + point.row,
                  point.column + (point.row === 0 ? original.start.column : 0),
                );
              edits.push({
                oldRange: new Range(toSource(edit.oldRange.start), toSource(edit.oldRange.end)),
                newText: edit.newText,
              });
            }
            const pending = cooperate();
            if (pending && !(await pending)) return null;
          }
        }
        for (const edit of edits) {
          if (!owns(edit.oldRange, records) || (requested && !owns(edit.oldRange, merged)))
            return null;
          const pending = cooperate();
          if (pending && !(await pending)) return null;
        }
        if (fallback) {
          let oldEnd = new Point(0, 0),
            newEnd = new Point(0, 0);
          for (const edit of edits.sort((a, b) => a.oldRange.start.compare(b.oldRange.start))) {
            const start = newEnd.traverse(edit.oldRange.start.traversalFrom(oldEnd));
            let rows = 0,
              offset = 0;
            const endings = /\r?\n/g;
            while (endings.exec(edit.newText)) {
              rows++;
              offset = endings.lastIndex;
            }
            newEnd = start.traverse(new Point(rows, edit.newText.length - offset));
            edit.newRange = new Range(start, newEnd);
            oldEnd = edit.oldRange.end;
          }
        }
        return current()
          ? {
              text,
              edits,
              fallback,
              replaceWholeDocument: Boolean(allowWholeDocument && !requested),
            }
          : null;
      } finally {
        buffer.destroy();
      }
    },
  });
}

function stringPrefix(text, index) {
  let start = index;
  while (start > 0 && /[a-z]/i.test(text[start - 1])) start--;
  return /^(?:f|fr|rf)$/i.test(text.slice(start, index));
}

// Delimiters must be actual top-level comments, including when strings use
// nested, same-quote expressions allowed by modern Python f-strings.
function delimiters(text, prefix) {
  const found = [],
    stack = [],
    brackets = [];
  let lineStart = 0,
    continued = false;
  const quoted = (index) => {
    const quote = text[index],
      triple = text.slice(index, index + 3) === quote.repeat(3);
    stack.push({ kind: "string", quote, triple, formatted: stringPrefix(text, index) });
    return index + (triple ? 3 : 1);
  };
  for (let index = 0; index < text.length;) {
    const character = text[index],
      frame = stack.at(-1);
    if (character === "\r" || character === "\n") {
      if (frame?.kind === "string" && !frame.triple) return null;
      index += character === "\r" && text[index + 1] === "\n" ? 2 : 1;
      lineStart = index;
      continued = false;
      continue;
    }
    if (frame?.kind === "string") {
      if (character === "\\") {
        const newline = text[index + 1] === "\r" || text[index + 1] === "\n";
        index += text[index + 1] === "\r" && text[index + 2] === "\n" ? 3 : 2;
        if (newline) lineStart = index;
        continue;
      }
      if (
        character === frame.quote &&
        (!frame.triple || text.slice(index, index + 3) === character.repeat(3))
      ) {
        index += frame.triple ? 3 : 1;
        stack.pop();
        continue;
      }
      if (frame.formatted && character === "{") {
        if (text[index + 1] === "{") index += 2;
        else {
          stack.push({ kind: "field", brackets: [], format: false });
          index++;
        }
        continue;
      }
      if (frame.formatted && character === "}" && text[index + 1] === "}") {
        index += 2;
        continue;
      }
      index++;
      continue;
    }
    if (frame?.kind === "field" && frame.format) {
      if (character === "{") {
        stack.push({ kind: "field", brackets: [], format: false });
        index++;
      } else if (character === "}") {
        stack.pop();
        index++;
      } else index++;
      continue;
    }
    if (character === "'" || character === '"') {
      index = quoted(index);
      continue;
    }
    if (character === "\\" && /[\r\n]/.test(text[index + 1] || "")) {
      index += text[index + 1] === "\r" && text[index + 2] === "\n" ? 3 : 2;
      lineStart = index;
      continued = true;
      continue;
    }
    if (character === "#") {
      let end = index;
      while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end++;
      const line = text.slice(index, end);
      if (line.startsWith(`# ${prefix}`)) {
        if (stack.length || brackets.length || continued || index !== lineStart) return null;
        const match = line.slice(prefix.length + 2).match(/^(begin|end)_([0-9]+)$/);
        if (!match) return null;
        const next =
          end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : end < text.length ? 1 : 0);
        found.push({ kind: match[1], index: Number(match[2]), start: index, next });
      }
      index = end;
      continue;
    }
    const active = frame?.kind === "field" ? frame.brackets : brackets;
    if (/[([{]/.test(character)) active.push(character);
    else if (/[)\]}]/.test(character)) {
      if (frame?.kind === "field" && character === "}" && !active.length) stack.pop();
      else if ({ ")": "(", "]": "[", "}": "{" }[character] !== active.pop()) return null;
    } else if (
      frame?.kind === "field" &&
      character === ":" &&
      !active.length &&
      text[index + 1] !== "="
    )
      frame.format = true;
    index++;
  }
  return stack.length || brackets.length ? null : found;
}

module.exports = async function createFormattingBatch(
  blocks,
  { source, isCurrent, range, allowWholeDocument = false, sourceGeometry },
) {
  if (!isCurrent()) return null;
  const requested = !range ? null : Array.isArray(range) ? range : [range];
  const selected = blocks.filter(
    (block) => !requested || requested.some((item) => item.intersectsWith(block.range)),
  );
  if (!selected.length) return null;
  if (selected.length === 1) {
    const block = selected[0];
    return withEditPlan(
      {
        text: block.text,
        restore(formatted) {
          if (!isCurrent() || typeof formatted !== "string") return null;
          const text = block.restore(formatted);
          return text === null || !isCurrent() ? null : [{ range: block.range, text }];
        },
      },
      source,
      isCurrent,
      requested,
      allowWholeDocument,
      selected.map((item) => item.range),
      sourceGeometry,
    );
  }
  let prefix, collision;
  let sliceStart = performance.now();
  do {
    prefix = `__lumine_ipy_batch_${++generation}_`;
    collision = false;
    for (let offset = 0; offset < source.length; offset += CHUNK) {
      if (source.slice(offset, offset + CHUNK + prefix.length - 1).includes(prefix)) {
        collision = true;
        break;
      }
      if (performance.now() - sliceStart >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!isCurrent()) return null;
        sliceStart = performance.now();
      }
    }
  } while (collision);
  const pieces = [];
  for (let index = 0; index < selected.length; index++) {
    const text = selected[index].text;
    pieces.push(
      `# ${prefix}begin_${index}\n`,
      text,
      /[\r\n]$/.test(text) ? "" : "\n",
      `# ${prefix}end_${index}\n`,
    );
  }
  return withEditPlan(
    {
      text: pieces.join(""),
      restore(formatted) {
        if (!isCurrent() || typeof formatted !== "string") return null;
        const markers = delimiters(formatted, prefix);
        if (!markers || markers.length !== selected.length * 2) return null;
        let occurrences = 0;
        for (
          let offset = formatted.indexOf(prefix);
          offset >= 0;
          offset = formatted.indexOf(prefix, offset + prefix.length)
        )
          occurrences++;
        if (occurrences !== markers.length) return null;
        if (
          formatted.slice(0, markers[0].start).trim() ||
          formatted.slice(markers.at(-1).next).trim()
        )
          return null;
        const output = [];
        for (let index = 0; index < selected.length; index++) {
          const begin = markers[index * 2],
            end = markers[index * 2 + 1];
          if (
            begin.kind !== "begin" ||
            end.kind !== "end" ||
            begin.index !== index ||
            end.index !== index
          )
            return null;
          if (index && formatted.slice(markers[index * 2 - 1].next, begin.start).trim())
            return null;
          const text = selected[index].restore(formatted.slice(begin.next, end.start));
          if (text === null) return null;
          output.push({ range: selected[index].range, text });
        }
        return isCurrent() ? output : null;
      },
    },
    source,
    isCurrent,
    requested,
    allowWholeDocument,
    selected.map((item) => item.range),
    sourceGeometry,
  );
};
