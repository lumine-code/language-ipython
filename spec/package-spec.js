const fs = require("fs");
const path = require("path");
const mainModule = require("../lib/main");

const packageRoot = path.resolve(__dirname, "..");

describe("language-ipython package", () => {
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-python");
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
    const { mainModule } = await lumine.packages.activatePackage("snippets");
    await mainModule.waitForSnippetsLoaded();
    const snippets = mainModule.provideSnippets().snippetsForScopes([".source.python.ipy"]);

    expect(snippets.im.prefix).toBe("im");
    expect(snippets.im.body).toContain("import");
  });

  it("keeps comment services active inside cell marker titles", () => {
    const hyperlink = { addInjectionPoint: jasmine.createSpy("add hyperlink injection") };
    const todo = { addInjectionPoint: jasmine.createSpy("add TODO injection") };

    mainModule.consumeHyperlinkInjection(hyperlink);
    mainModule.consumeTodoInjection(todo);

    expect(hyperlink.addInjectionPoint).toHaveBeenCalledWith("source.python.ipy", {
      types: ["comment", "cell_marker_name", "string_content"],
    });
    expect(todo.addInjectionPoint).toHaveBeenCalledWith("source.python.ipy", {
      types: ["comment", "cell_marker_name"],
    });
  });
});
