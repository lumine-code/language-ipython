describe("IPython comments with generic source defaults", () => {
  let editor;
  beforeEach(async () => {
    jasmine.useRealClock();
    if (lumine.packages.getLoadedPackage("language-python")) {
      await lumine.packages.deactivatePackage("language-python");
      await lumine.packages.unloadPackage("language-python");
    }
    await lumine.packages.activatePackage("language-source");
    await lumine.packages.activatePackage("language-ipython");
    editor = await lumine.workspace.open();
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.python.ipy"));
  });
  afterEach(() => editor?.destroy());

  it("uses hash comments without requiring native Python settings", async () => {
    editor.setText("value");
    await editor.whenGrammarSettled();
    const delimiters = await editor.getCommentDelimitersForBufferPosition([0, 0]);
    expect(delimiters.line).toBe("#");
    expect(delimiters.block).toBeUndefined();
    await editor.toggleLineCommentsForBufferRows(0, 0);
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe("# value");
    await editor.toggleLineCommentsForBufferRows(0, 0);
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe("value");
  });

  it("retains Markdown comments inside a native Markdown cell", async () => {
    await lumine.packages.activatePackage("language-gfm");
    editor.setText("%%markdown\nA paragraph.\n");
    await editor.whenGrammarSettled();
    const delimiters = await editor.getCommentDelimitersForBufferPosition([1, 2]);
    expect(delimiters.block).toEqual(["<!--", "-->"]);
    expect(delimiters.line).toBeUndefined();
  });
});
