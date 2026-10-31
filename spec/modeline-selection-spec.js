describe("ipython modeline selection", () => {
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-ipython");
  });
  it("selects exact Vim aliases", () => {
    for (const field of ["ft", "filetype", "syntax"]) {
      const source = "# vim: set " + field + "=" + "ipython" + ":";
      expect(lumine.grammars.selectGrammar("extensionless", source).scopeName)
        .withContext(source)
        .toBe("source.python.ipy");
    }
  });
  it("rejects aliases that only start with the language name", () => {
    for (const field of ["ft", "filetype", "syntax"])
      for (const suffix of ["ish", "_extra", "-extra", ".extra"]) {
        const source = "# vim: set " + field + "=" + "ipython" + suffix + ":";
        expect(lumine.grammars.selectGrammar("extensionless", source).scopeName)
          .withContext(source)
          .not.toBe("source.python.ipy");
      }
  });
});
