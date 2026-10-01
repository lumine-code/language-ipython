const fs = require("fs");
const path = require("path");

const packageRoot = path.resolve(__dirname, "..");
const packagePath = (name) => {
  const sibling = path.resolve(__dirname, "..", "..", name);
  return fs.existsSync(sibling) ? sibling : name;
};

describe("language-ipython package", () => {
  beforeEach(async () => {
    await lumine.packages.activatePackage(packagePath("language-python"));
    await lumine.packages.activatePackage("language-ipython");
  });

  it("owns .ipy files with a Tree-sitter grammar", () => {
    const grammar = lumine.grammars.selectGrammar("analysis.ipy", "");
    expect(grammar.name).toBe("IPython");
    expect(grammar.scopeName).toBe("source.python.ipy");
    expect(grammar.constructor.name).toBe("TreeSitterGrammar");
  });

  it("does not duplicate Python settings or snippets", () => {
    expect(fs.existsSync(path.join(packageRoot, "settings"))).toBe(false);
    expect(fs.existsSync(path.join(packageRoot, "snippets"))).toBe(false);
  });

  it("inherits scoped Python settings", async () => {
    const editor = await lumine.workspace.open("analysis.ipy");
    await editor.getBuffer().getLanguageMode().ready;

    expect(editor.getGrammar().scopeName).toBe("source.python.ipy");
    expect(lumine.config.get("editor.tabLength", { scope: editor.getRootScopeDescriptor() })).toBe(
      4,
    );
    editor.destroy();
  });

  it("inherits scoped Python snippets", async () => {
    const { mainModule } = await lumine.packages.activatePackage(packagePath("snippets"));
    await mainModule.waitForSnippetsLoaded();
    const snippets = mainModule.provideSnippets().snippetsForScopes([".source.python.ipy"]);

    expect(snippets.im.prefix).toBe("im");
    expect(snippets.im.body).toContain("import");
  });

  it("updates static title annotations when target grammars deactivate and reactivate", async () => {
    await lumine.packages.activatePackage(packagePath("language-hyperlink"));
    await lumine.packages.activatePackage(packagePath("language-todo"));
    const editor = await lumine.workspace.open("annotations.ipy");
    try {
      editor.setText(
        "# %% TODO https://example.com/title\nvalue = 1\n# %% ordinary title\nother = 2\n",
      );
      const mode = editor.getBuffer().getLanguageMode();
      await mode.ready;
      await mode.atGrammarSettlement();
      const annotations = () =>
        mode
          .getAllInjectionLayers()
          .filter((layer) => ["text.hyperlink", "text.todo"].includes(layer.grammar.scopeName));
      expect(annotations().length).toBe(2);
      for (const name of ["language-hyperlink", "language-todo"]) {
        await lumine.packages.deactivatePackage(name);
      }
      await mode.atGrammarSettlement();
      expect(annotations().length).toBe(0);
      for (const name of ["language-hyperlink", "language-todo"]) {
        await lumine.packages.activatePackage(packagePath(name));
      }
      await mode.atGrammarSettlement();
      expect(annotations().length).toBe(2);
    } finally {
      editor.destroy();
    }
  });
});
