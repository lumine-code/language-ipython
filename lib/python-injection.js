const MAGIC_NODES = new Set([
  "magic_statement",
  "shell_statement",
  "help_statement",
  "magic_expression",
  "shell_expression",
]);

// Tree-sitter included ranges retain the buffer's original coordinates. Drop
// whole magic rows so an assignment RHS cannot leave a dangling `name =`.
module.exports = function pythonContent(node, buffer) {
  const cuts = [];
  for (const child of node.children) {
    if (!MAGIC_NODES.has(child.type)) continue;
    const start = Math.max(
      node.startIndex,
      buffer.characterIndexForPosition([child.startPosition.row, 0]),
    );
    const end = Math.min(
      node.endIndex,
      buffer.characterIndexForPosition(buffer.clipPosition([child.endPosition.row + 1, 0])),
    );
    const previous = cuts.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else cuts.push({ start, end });
  }
  if (!cuts.length) return node;
  const ranges = [];
  const add = (startIndex, endIndex) => {
    if (startIndex >= endIndex) return;
    ranges.push({
      startIndex,
      endIndex,
      startPosition: buffer.positionForCharacterIndex(startIndex),
      endPosition: buffer.positionForCharacterIndex(endIndex),
    });
  };
  let offset = node.startIndex;
  for (const cut of cuts) {
    add(offset, cut.start);
    offset = cut.end;
  }
  add(offset, node.endIndex);
  return ranges;
};
