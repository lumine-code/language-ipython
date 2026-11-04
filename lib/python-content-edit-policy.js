// An explicit proof about the IPython scaffold, not a Python indentation
// engine. Only nonstructural edits after an unchanged nonblank prefix are
// admitted. The child Python grammar still decides whether the row dedents.
module.exports = function pythonContentEdit({ before, oldText, newText, after }) {
  if (!/^[A-Za-z0-9_ ]*$/.test(oldText) || !/^[A-Za-z0-9_ ]*$/.test(newText)) return false;
  if (!/\S/.test(before)) return false;
  const previous = before + oldText + after;
  const next = before + newText + after;
  // These characters can introduce IPython statements, continuations or
  // another statement. Refuse them even inside strings to keep this proof small.
  if (/[#%!?;\\]/.test(previous)) return false;
  // The scaffold recognizes f/t/r prefixes at quote openers. Compare their
  // flags at every quote (including closers, conservatively), so ordinary word
  // edits cannot change interpolation or raw-string boundary handling.
  const flags = (line) =>
    [...line.matchAll(/([A-Za-z_]*)['"]/g)].map((match) => {
      const word = match[1].toLowerCase();
      return word.length > 2 ? 0 : Number(/[ft]/.test(word)) + 2 * Number(word.includes("r"));
    });
  const oldFlags = flags(previous),
    newFlags = flags(next);
  return oldFlags.length === newFlags.length && oldFlags.every((flag, i) => flag === newFlags[i]);
};
