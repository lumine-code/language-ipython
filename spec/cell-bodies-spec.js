const path = require("path");

describe("IPython cell bodies", () => {
  let editor;
  let mode;
  const packagePath = (name) => path.resolve(__dirname, "..", "..", name);
  const scopesAt = (row, column = 0) =>
    editor.scopeDescriptorForBufferPosition([row, column]).getScopesArray();
  const root = () => mode.rootLanguageLayer.tree.rootNode;
  const bodyLayers = () =>
    mode
      .getAllInjectionLayers()
      .filter((layer) => ["markdown_cell", "cell_magic"].includes(layer.injectionPoint?.type));

  async function setUp(source) {
    editor = await lumine.workspace.open();
    editor.setText(source);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    mode = editor.getBuffer().getLanguageMode();
    await mode.ready;
    await mode.atGrammarSettlement();
  }

  beforeEach(async () => {
    for (const name of [
      "language-ipython",
      "language-python",
      "language-gfm",
      "language-html",
      "language-shellscript",
      "language-javascript",
    ]) {
      await lumine.packages.activatePackage(packagePath(name));
    }
  });

  afterEach(() => editor?.destroy());

  it("injects each literal Markdown body once and isolates an unfinished fence", async () => {
    await setUp(
      "# %% [markdown] First\n# Heading\n```python\nvalue = 1\n# %% [markdown] Second\n# Next\n**bold**\n# %%\nafter = 2\n",
    );
    expect(root().hasError).toBe(false);
    expect(root().namedChildren.map((node) => node.type)).toEqual([
      "markdown_cell",
      "markdown_cell",
      "cell_marker",
      "assignment",
    ]);
    expect(bodyLayers().length).toBe(2);
    expect(scopesAt(1, 2)).toContain("source.gfm");
    expect(scopesAt(5, 2)).toContain("source.gfm");
    expect(scopesAt(6, 3).some((scope) => scope.includes("bold"))).toBe(true);
    expect(scopesAt(8, 1)).not.toContain("source.gfm");
  });

  it("keeps raw and unknown magic bodies plain without another parser", async () => {
    await setUp(
      "# %% [raw]\n# payload { <broken>\n# %%\n%%custom\nnot Python }\n# %%\nafter = 1\n",
    );
    expect(root().hasError).toBe(false);
    expect(scopesAt(1, 3)).toContain("text.plain");
    expect(scopesAt(4, 3)).toContain("text.plain");
    expect(bodyLayers().length).toBe(0);
    expect(root().namedChildren.at(-1).type).toBe("assignment");
  });

  it("injects original language packages into foreign magic bodies", async () => {
    await setUp(
      "%%bash -x\necho hello\n# %%\n%%html\n<h1>Hi</h1>\n# %%\n%%javascript\nconst value = 1;\n# %%\n%%python3\nanswer = 42\n",
    );
    expect(root().hasError).toBe(false);
    expect(bodyLayers().map((layer) => layer.grammar.scopeName)).toEqual([
      "source.shell",
      "text.html.basic",
      "source.js",
      "source.python",
    ]);
    expect(scopesAt(0, 3)).toContain("support.function.magic.ipython");
    expect(scopesAt(1, 2)).toContain("source.shell");
    expect(scopesAt(4, 2)).toContain("text.html.basic");
    expect(scopesAt(7, 2)).toContain("source.js");
    expect(scopesAt(10, 2)).toContain("source.python");
  });

  it("preserves symbols and Python parsing under Python cell magics", async () => {
    await setUp(
      "%%capture output\nvalue = 1\ndef work():\n    return value\n# %% Next\nafter = 2\n",
    );
    expect(root().hasError).toBe(false);
    expect(root().namedChild(0).childForFieldName("body").type).toBe("python_cell_body");
    const groups = await editor.getGrammarQueryCaptureGroups("tagsQuery");
    const definitions = groups
      .flatMap((group) => group.captures)
      .filter((capture) => capture.name === "definition.constant");
    expect(definitions.map((capture) => capture.node.text)).toEqual(["value = 1", "after = 2"]);
    expect(bodyLayers().length).toBe(0);
  });

  it("rebuilds injections after changing a raw marker to Markdown", async () => {
    await setUp("# %% [raw]\n# Heading\n# %%\nafter = 1\n");
    expect(bodyLayers().length).toBe(0);
    editor.setTextInBufferRange(
      [
        [0, 6],
        [0, 9],
      ],
      "markdown",
    );
    await mode.atGrammarSettlement();
    expect(root().hasError).toBe(false);
    expect(root().namedChild(0).type).toBe("markdown_cell");
    expect(bodyLayers().length).toBe(1);
    expect(scopesAt(1, 3)).toContain("source.gfm");
  });

  it("owns and disposes only its registered cell injections", async () => {
    const grammar = lumine.grammars.grammarForScopeName("source.python.ipy");
    expect(grammar.injectionPointsByType.markdown_cell.length).toBe(1);
    expect(grammar.injectionPointsByType.cell_magic.length).toBe(1);
    await lumine.packages.deactivatePackage("language-ipython");
    expect(grammar.injectionPointsByType.markdown_cell).toBeUndefined();
    expect(grammar.injectionPointsByType.cell_magic).toBeUndefined();
    const pack = await lumine.packages.activatePackage(packagePath("language-ipython"));
    expect(pack.mainModule).toBeDefined();
    expect(grammar.injectionPointsByType.markdown_cell.length).toBe(1);
    expect(grammar.injectionPointsByType.cell_magic.length).toBe(1);
  });
});
