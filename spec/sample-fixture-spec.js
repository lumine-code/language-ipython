const fs = require("fs");
const path = require("path");
const packagePath = (name) => {
  const sibling = path.resolve(__dirname, "..", "..", name);
  return fs.existsSync(sibling) ? sibling : name;
};

// The fixture beside this file is a plain sample of the language — the file to
// open when you want to look at the highlighting rather than assert on it. This
// spec is only what stops the sample quietly rotting: the grammar still claims
// it, and it still parses.

describe("IPython sample fixture", () => {
  beforeEach(async () => {
    await lumine.packages.activatePackage(packagePath("language-python"));
    await lumine.packages.activatePackage("language-ipython");
  });

  it("parses sample.ipy without error", async () => {
    const editor = await lumine.workspace.open(path.join(__dirname, "fixtures", "sample.ipy"));
    const languageMode = editor.getBuffer().getLanguageMode();
    try {
      await editor.whenGrammarSettled();
      expect(editor.getGrammar().scopeName).toBe("source.python.ipy");
      expect(languageMode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it("renders the sample while its covering Python injection is still loading", async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    for (const name of ["language-gfm", "language-shellscript"]) {
      await lumine.packages.activatePackage(packagePath(name));
    }
    const python = lumine.grammars.grammarForScopeName("source.python");
    const loadPython = python.getLanguage.bind(python);
    await loadPython();
    for (const scope of ["source.gfm", "source.gfm.inline", "source.shell"]) {
      const grammar = lumine.grammars.grammarForScopeName(scope);
      await grammar.getLanguage();
      await grammar.getQuery("highlightsQuery");
    }
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    spyOn(python, "getLanguage").and.callFake(() => pending.then(loadPython));
    let editor;
    try {
      editor = await lumine.workspace.open(path.join(__dirname, "fixtures", "sample.ipy"));
      const element = lumine.views.getView(editor);
      element.setUpdatedSynchronously(false);
      element.style.width = "1000px";
      element.style.height = "600px";
      const buffer = editor.getBuffer();
      const mode = buffer.getLanguageMode();
      let injected;
      for (let attempt = 0; attempt < 100; attempt++) {
        const layers = mode.getAllInjectionLayers();
        injected = layers.find((layer) => layer.grammar.scopeName === "source.python");
        if (
          mode.tree &&
          injected &&
          !injected.tree &&
          layers.some((layer) => layer.grammar.scopeName === "source.gfm" && layer.tree)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(mode.tree).toBeTruthy();
      expect(injected).toBeTruthy();
      expect(injected.tree).toBeFalsy();
      expect(
        mode
          .getAllInjectionLayers()
          .some((layer) => layer.grammar.scopeName === "source.gfm" && layer.tree),
      ).toBe(true);
      expect(() => editor.displayLayer.getScreenLines(0, buffer.getLineCount())).not.toThrow();
      expect(() => element.getComponent().updateSync()).not.toThrow();
      release();
      await editor.whenGrammarSettled();
      const scopesAt = (text) =>
        editor
          .scopeDescriptorForBufferPosition(
            buffer.positionForCharacterIndex(editor.getText().indexOf(text)),
          )
          .getScopesArray();
      expect(scopesAt("from pathlib")).toContain("source.python");
      expect(scopesAt("Explore")).toContain("source.gfm");
      expect(scopesAt("echo hello")).toContain("source.shell");
      expect(scopesAt("This text remains literal")).not.toContain("source.python");
      expect(mode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);
      buffer.insert([2, 0], "# redraw after edit\n");
      expect(() => editor.displayLayer.getScreenLines(0, buffer.getLineCount())).not.toThrow();
      await editor.whenGrammarSettled();
      await lumine.packages.deactivatePackage("language-ipython");
      await lumine.packages.unloadPackage("language-ipython");
      await lumine.packages.activatePackage(packagePath("language-ipython"));
      lumine.grammars.assignLanguageMode(buffer, "source.python.ipy");
      expect(() => editor.displayLayer.getScreenLines(0, buffer.getLineCount())).not.toThrow();
      await editor.whenGrammarSettled();
      expect(scopesAt("from pathlib")).toContain("source.python");
      expect(scopesAt("Explore")).toContain("source.gfm");
      expect(() => element.getComponent().updateSync()).not.toThrow();
      const currentMode = buffer.getLanguageMode();
      const layers = currentMode.getAllLanguageLayers();
      editor.destroy();
      expect(buffer.isDestroyed()).toBe(true);
      expect(currentMode.destroyed).toBe(true);
      expect(currentMode.parsersByLanguage.size).toBe(0);
      expect(layers.every((layer) => layer.destroyed)).toBe(true);
    } finally {
      release();
      editor?.destroy();
    }
  });

  it("gives both cell-magic introducer glyphs the same function scope as line magics", async () => {
    const editor = await lumine.workspace.open(path.join(__dirname, "fixtures", "sample.ipy"));
    try {
      await editor.whenGrammarSettled();
      const scopes = (row, column) =>
        editor.scopeDescriptorForBufferPosition([row, column]).getScopesArray();
      const support = "support.function.magic.ipython";
      for (const row of [10, 11, 12]) expect(scopes(row, 0)).toContain(support);
      for (const row of [30, 34]) {
        expect(editor.lineTextForBufferRow(row).startsWith("%%")).toBe(true);
        for (const column of [0, 1]) {
          expect(scopes(row, column)).toContain(support);
          expect(scopes(row, column)).toContain("punctuation.definition.magic.ipython");
        }
        expect(scopes(row, 2)).toContain(support);
      }
      expect(scopes(30, 10)).toContain("string.unquoted.arguments.ipython");
      expect(scopes(30, 10)).not.toContain(support);
      expect(scopes(1, 2)).toContain("comment.line.number-sign.cell-marker.ipython");
      const magics = editor
        .getBuffer()
        .getLanguageMode()
        .rootLanguageLayer.tree.rootNode.descendantsOfType("cell_magic");
      expect(magics.map((node) => node.child(0).type)).toEqual(["%%", "%%"]);
      expect(magics.map((node) => node.child(0).isNamed)).toEqual([false, false]);
    } finally {
      editor.destroy();
    }
  });
});
