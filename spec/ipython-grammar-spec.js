const { Point } = require("lumine");
const path = require("path");

describe("IPython Tree-sitter grammar", () => {
  let editor;
  let languageMode;

  const setUp = async (text) => {
    editor = await lumine.workspace.open();
    editor.setText(text);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    languageMode = editor.getBuffer().getLanguageMode();
    await languageMode.ready;
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };

  const packagePathFor = (name) =>
    lumine.packages.resolvePackagePath(name) ?? path.resolve(__dirname, "..", "..", name);

  beforeEach(async () => {
    await lumine.packages.activatePackage("language-ipython");
  });

  afterEach(() => editor?.destroy());

  it("parses magics, shell escapes, and help requests without errors", async () => {
    await setUp("%matplotlib inline\n!pip install numpy\nnp.mean??\n?np.mean\n%%timeit\nf(x)\n");
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    expect(languageMode.getSyntaxNodeAtPosition(new Point(0, 2)).type).toBe("magic_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(1, 2)).type).toBe("shell_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(2, 2)).type).toBe("help_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(3, 2)).type).toBe("help_statement");
    expect(languageMode.getSyntaxNodeAtPosition(new Point(4, 2)).type).toBe("magic_statement");
  });

  it("keeps statements after a magic line intact", async () => {
    await setUp("a = 1\n%cd ..\nb = 2\n");
    expect(languageMode.tree.rootNode.hasError).toBe(false);

    let node = languageMode.getSyntaxNodeAtPosition(new Point(2, 0));
    while (node && node.type !== "assignment") node = node.parent;
    expect(node.type).toBe("assignment");
    expect(node.startPosition.row).toBe(2);
  });

  it("parses cell marker structure without stealing ordinary comments", async () => {
    await setUp(
      [
        "# %% Setup",
        "# %%% [markdown] Details",
        "# %% markdown Legacy",
        "# %% markdown",
        "# %%",
        "# %% mda title",
        "# %% [section] title",
        "# ordinary comment",
        "value = 1 # %% inline comment",
      ].join("\n"),
    );
    expect(languageMode.tree.rootNode.hasError).toBe(false);

    const markers = languageMode.tree.rootNode.descendantsOfType("cell_marker");
    expect(markers.map((node) => node.childForFieldName("marker").text)).toEqual([
      "# %%",
      "# %%%",
      "# %%",
      "# %%",
      "# %%",
      "# %%",
      "# %%",
    ]);
    expect(markers.map((node) => node.childForFieldName("metadata")?.text ?? null)).toEqual([
      null,
      "[markdown]",
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(markers.map((node) => node.childForFieldName("name")?.text ?? null)).toEqual([
      "Setup",
      "Details",
      "markdown Legacy",
      "markdown",
      null,
      "mda title",
      "[section] title",
    ]);

    expect(
      languageMode.tree.rootNode.descendantsOfType("comment").map((node) => node.text),
    ).toEqual(["# ordinary comment", "# %% inline comment"]);
  });

  it("exposes module assignments to symbol consumers", async () => {
    await setUp("doc = factory()\n%pwd\nlater = 2\n");
    const layer = languageMode.rootLanguageLayer;
    const captures = layer.queries.tagsQuery.captures(layer.tree.rootNode);
    const definitions = captures.filter((capture) => capture.name === "definition.constant");
    expect(definitions.map((capture) => capture.node.text)).toEqual([
      "doc = factory()",
      "later = 2",
    ]);
  });

  it("exposes only named cell markers to symbol consumers", async () => {
    await setUp(
      "# %% Setup\n# %%% [markdown] Details\n# %% markdown Legacy\n# %% markdown\n# %%\n# %% mda title\nvalue = 1\n",
    );
    const layer = languageMode.rootLanguageLayer;
    const captures = layer.queries.tagsQuery.captures(layer.tree.rootNode);

    expect(
      captures
        .filter((capture) => capture.name === "definition.cell")
        .map((capture) => capture.node.text),
    ).toEqual(["# %% Setup", "# %%% [markdown] Details", "# %% markdown Legacy", "# %% mda title"]);
    expect(
      captures
        .filter((capture) => capture.name === "name" && capture.node.type === "cell_marker_name")
        .map((capture) => capture.node.text),
    ).toEqual(["Setup", "Details", "markdown Legacy", "mda title"]);

    const symbolPackage = await lumine.packages.activatePackage(
      packagePathFor("symbol-tree-sitter"),
    );
    const symbols = await symbolPackage.mainModule.provideSymbol().getSymbols({
      editor,
      type: "file",
      signal: new AbortController().signal,
    });
    expect(symbols.filter((symbol) => symbol.tag === "cell").map((symbol) => symbol.name)).toEqual([
      "Setup",
      "Details",
      "Legacy",
      "mda title",
    ]);
  });

  it("leaves ordinary Python syntax untouched", async () => {
    await setUp('c = a % b\nd = a != b\nx = f"{v!r}"\n');
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    let binary = languageMode.getSyntaxNodeAtPosition(new Point(0, 6));
    while (binary && binary.type !== "binary_operator") binary = binary.parent;
    expect(binary.type).toBe("binary_operator");
  });

  it("highlights IPython statements with dedicated scopes", async () => {
    await setUp("%matplotlib inline\n!ls\nnp.mean?\n");
    expect(editor.scopeDescriptorForBufferPosition([0, 2]).toString()).toContain(
      "support.function.magic.ipython",
    );
    expect(editor.scopeDescriptorForBufferPosition([1, 1]).toString()).toContain(
      "string.unquoted.shell.ipython",
    );
    expect(editor.scopeDescriptorForBufferPosition([2, 2]).toString()).toContain(
      "keyword.operator.help.ipython",
    );
  });

  it("styles entire cell markers as comments", async () => {
    await setUp("# %%% [markdown] Overview\n");

    const commentScope = editor.scopeDescriptorForBufferPosition([0, 0]).toString();
    expect(commentScope).toContain("comment.line.number-sign.cell-marker.ipython");
    expect(commentScope).toContain("punctuation.definition.comment.python");
    for (const column of [3, 7, 18]) {
      expect(editor.scopeDescriptorForBufferPosition([0, column]).getScopesArray().at(-1)).toBe(
        "comment.line.number-sign.cell-marker.ipython",
      );
    }
  });

  it("keeps IPython markers compatible with the jupyter.cells service", async () => {
    const { mainModule } = await lumine.packages.activatePackage(packagePathFor("jupyter-cells"));
    const cells = mainModule.provideJupyterCells();
    await setUp("# %% Code\nvalue = 1\n# %%% [markdown] Notes\n# body\n");

    expect(cells.getBreakpoints(editor).map((point) => point.row)).toEqual([0, 2]);
    expect(cells.getMetadataForRow(editor, new Point(1, 0))).toBe("codecell");
    expect(cells.getMetadataForRow(editor, new Point(3, 0))).toBe("markdown");
  });

  it("keeps Python folds working", async () => {
    await setUp("doc.x('''\n11\n''')\n%pwd\n");
    expect(languageMode.tree.rootNode.hasError).toBe(false);
    expect(editor.isFoldableAtBufferRow(0)).toBe(true);
  });
});
