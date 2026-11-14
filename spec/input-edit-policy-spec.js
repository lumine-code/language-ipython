describe("IPython input edit policy", () => {
  const check = (before, after = "", previousLine = "", newText = "\n") =>
    require("../lib/input-edit-policy")({ before, oldText: "", newText, after, previousLine });

  it("preserves ordinary Python ownership for line splits and Unicode identifiers", () => {
    expect(check("if ready: ", "work()", "padding = 'text'")).toBe(true);
    expect(check("elif s.l<=80e-3: ", "s.Δσ_C = 71e6")).toBe(true);
    expect(check("    value = call(", "argument)", "# A previous comment")).toBe(true);
    expect(check("    value = 1", "", "", "\n    ")).toBe(true);
  });

  it("declines scaffold controls, strings, comments, uncertain starts and continuations", () => {
    for (const [before, after, previousLine] of [
      ["", "if ready:"],
      ["    ", "value = 1"],
      ["# %%", ""],
      ["%time ", "work()"],
      ["!echo ", "value"],
      ["value?", ""],
      ["value = ", "'text'"],
      ['value = "text"', ""],
      ["`value`", ""],
      ["value = 1; ", "work()"],
      ["value = 1 #", "comment"],
      ["value = ", "1", "previous = \\"],
    ])
      expect(check(before, after, previousLine)).toBe(false);
  });

  it("declines nonwhitespace and oversized edits", () => {
    expect(check("value", "", "", "word")).toBe(false);
    expect(check("value", "", "", "")).toBe(false);
    expect(check("value", "", "", " ".repeat(4097))).toBe(false);
    expect(check("value".repeat(1000))).toBe(false);
  });
});
