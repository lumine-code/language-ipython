// Whitespace on an ordinary Python statement cannot create an IPython cell,
// magic, escape, help expression or string boundary. Uncertain lines retain
// the normal parsed input path; Python indentation is still query-driven.
module.exports = ({ before, oldText, newText, after, previousLine }) =>
  typeof before === "string" &&
  typeof after === "string" &&
  typeof previousLine === "string" &&
  oldText === "" &&
  typeof newText === "string" &&
  newText.length > 0 &&
  newText.length <= 4096 &&
  before.length + after.length <= 4096 &&
  /\S/.test(before) &&
  /^[ \t\r\n]+$/.test(newText) &&
  !/[#%!?;\\'"`]/.test(before + after) &&
  !/\\\s*$/.test(previousLine);
