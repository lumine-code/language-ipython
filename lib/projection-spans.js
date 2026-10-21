const SLICE_MS = 8;
function abortError() {
  const error = new Error("IPython source projection was cancelled.");
  error.name = "AbortError";
  return error;
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
function lineExtent(buffer, row) {
  const start = buffer.characterIndexForPosition([row, 0]);
  const end =
    row + 1 < buffer.getLineCount()
      ? buffer.characterIndexForPosition([row + 1, 0])
      : buffer.getLength();
  return { start, end };
}
function cooperative(current) {
  let started = performance.now();
  return () => {
    if (!current()) throw abortError();
    if (performance.now() - started < SLICE_MS) return null;
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      if (!current()) throw abortError();
      started = performance.now();
    });
  };
}

module.exports = { abortError, lowerBound, merge, lineExtent, cooperative };
