describe("Python injection content edit policy", () => {
  const check = (before, oldText, newText, after) =>
    require("../lib/python-content-edit-policy")({ before, oldText, newText, after });

  it("accepts ordinary words in statements and strings after existing content", () => {
    expect(check("    section = r'Concret", "", "ing", " phase',")).toBe(true);
    expect(check("    section = r'phase',", "", "a", "")).toBe(true);
    expect(check("    call(arg", "ument", "s", ")")).toBe(true);
    expect(check("    section = r'Concret", "ing", "", " phase',")).toBe(true);
  });

  it("rejects structural edits, uncertain statement starts and changed string-prefix flags", () => {
    for (const [before, oldText, newText, after] of [
      ["    ", "", "word", ""],
      ["    value = ", "r", "f", "'text'"],
      ["    value = f", "", " ", "'text'"],
      ["    value = ", "", "'", "word"],
      ["    value = ", "", "\n", "word"],
      ["    value = ", "", "a", "%time work()"],
      ["    value = ", "", "a", "name?"],
      ["    value = x; ", "", "a", ""],
      ["    value = '\\", "", "r", "'"],
      ["    value = x #", "", "a", ""],
    ])
      expect(check(before, oldText, newText, after)).toBe(false);
  });
});
