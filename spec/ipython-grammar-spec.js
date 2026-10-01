const fs = require("fs");
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
    await editor.whenGrammarSettled();
  };

  const packagePathFor = (name) => {
    const sibling = path.resolve(__dirname, "..", "..", name);
    return fs.existsSync(sibling) ? sibling : name;
  };

  const ancestorAt = (position, type) => {
    let node = editor.getSyntaxNodeAtBufferPosition(position);
    while (node && node.type !== type) node = node.parent;
    return node;
  };

  beforeEach(async () => {
    await lumine.packages.activatePackage(packagePathFor("language-python"));
    await lumine.packages.activatePackage("language-ipython");
  });

  afterEach(() => editor?.destroy());

  it("parses magics, shell escapes, and help requests without errors", async () => {
    await setUp("%matplotlib inline\n!pip install numpy\nnp.mean??\n?np.mean\n");
    expect(languageMode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);
    expect(editor.getSyntaxNodeAtBufferPosition(new Point(0, 2)).type).toBe("magic_statement");
    expect(editor.getSyntaxNodeAtBufferPosition(new Point(1, 2)).type).toBe("shell_statement");
    expect(editor.getSyntaxNodeAtBufferPosition(new Point(2, 2)).type).toBe("help_statement");
    expect(editor.getSyntaxNodeAtBufferPosition(new Point(3, 2)).type).toBe("help_statement");
  });

  it("keeps statements after a magic line intact", async () => {
    await setUp("a = 1\n%cd ..\nb = 2\n");
    expect(languageMode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);

    let node = editor.getSyntaxNodeAtBufferPosition(new Point(2, 0));
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
    expect(languageMode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);

    const markers = Array.from({ length: 7 }, (_, row) => ancestorAt([row, 2], "cell_marker"));
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

    expect([ancestorAt([7, 2], "comment").text, ancestorAt([8, 12], "comment").text]).toEqual([
      "# ordinary comment",
      "# %% inline comment",
    ]);
  });

  it("exposes module assignments to symbol consumers", async () => {
    await setUp("doc = factory()\n%pwd\nlater = 2\n");
    const groups = await editor.getGrammarQueryCaptureGroups("tagsQuery");
    const captures = groups.flatMap((group) => group.captures);
    const definitions = captures.filter((capture) => capture.name === "definition.constant");
    expect(definitions.map((capture) => capture.node.text)).toEqual([
      "doc = factory()",
      "later = 2",
    ]);
  });

  it("keeps bracketed code metadata and unlimited prefixes separate from literal bodies", async () => {
    const spacing = " ".repeat(10000);
    const prefix = `#${spacing}${"%".repeat(5000)}`;
    await setUp(`# %% [raw]\npayload\n${prefix}${spacing}[code] Title${spacing}\nvalue = 1\n`);
    const root = languageMode.rootLanguageLayer.tree.rootNode;
    expect(root.hasError).toBe(false);
    expect(root.namedChildren.map((node) => node.type)).toEqual(["raw_cell", "code_cell"]);
    const marker = root.namedChild(1).childForFieldName("marker");
    expect(marker.childForFieldName("marker").text).toBe(prefix);
    expect(marker.childForFieldName("metadata").text).toBe("[code]");
    expect(marker.childForFieldName("name").text).toBe("Title");
    expect(root.namedChild(0).childForFieldName("body").text).toBe("payload\n");
  });

  it("parses comment-first code cells and Python magic bodies through repeated markers", async () => {
    await setUp("# %% [code]\n# first\nvalue = 1\n# %%\n%%time\n# timed\nnext = 2\n# %%\n# last");
    const root = languageMode.rootLanguageLayer.tree.rootNode;
    expect(root.hasError).toBe(false);
    const python = languageMode
      .getAllInjectionLayers()
      .find((layer) => layer.depth === 1 && layer.grammar.scopeName === "source.python");
    expect(python.tree.rootNode.descendantsOfType("comment").map((node) => node.text)).toEqual([
      "# first",
      "# timed",
      "# last",
    ]);
    const magic = root.descendantsOfType("cell_magic")[0];
    expect(magic.childForFieldName("body").type).toBe("python_cell_body");
    expect(
      python.tree.rootNode
        .descendantsOfType("assignment")
        .find((node) => node.childForFieldName("left").text === "next")
        .childForFieldName("left").text,
    ).toBe("next");
  });

  it("recovers typed boundaries after an incomplete assignment without treating them as comments", async () => {
    await setUp(
      "# %% Broken\nvalue =\n# %% [markdown]\n# Heading\n# %% [raw]\nraw <bytes>\n# %% [code]\ngood = 1\n",
    );
    const root = languageMode.rootLanguageLayer.tree.rootNode;
    expect(root.hasError).toBe(false);
    const cells = root.namedChildren.filter((node) =>
      ["code_cell", "markdown_cell", "raw_cell"].includes(node.type),
    );
    expect(cells.map((node) => node.type)).toEqual([
      "code_cell",
      "markdown_cell",
      "raw_cell",
      "code_cell",
    ]);
    expect(cells[1].childForFieldName("body").text).toBe("# Heading\n");
    expect(cells[2].childForFieldName("body").text).toBe("raw <bytes>\n");
    expect(root.namedChildren.at(-1).childForFieldName("body").text).toBe("good = 1\n");
  });

  it("exposes only named cell markers to symbol consumers", async () => {
    await setUp(
      "# %% Setup\n# %%% [markdown] Details\n# %% markdown Legacy\n# %% markdown\n# %%\n# %% mda title\nvalue = 1\n",
    );
    const groups = await editor.getGrammarQueryCaptureGroups("tagsQuery");
    const captures = groups.flatMap((group) => group.captures);

    expect(
      captures
        .filter((capture) => capture.name === "definition.cell")
        .map((capture) => capture.node.text),
    ).toEqual([
      "# %% Setup",
      "# %%% [markdown] Details",
      "# %% markdown Legacy",
      "# %% markdown",
      "# %% mda title",
    ]);
    expect(
      captures
        .filter((capture) => capture.name === "name" && capture.node.type === "cell_marker_name")
        .map((capture) => capture.node.text),
    ).toEqual(["Setup", "Details", "markdown Legacy", "markdown", "mda title"]);

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
      "markdown Legacy",
      "markdown",
      "mda title",
    ]);
  });

  it("leaves ordinary Python syntax untouched", async () => {
    await setUp('c = a % b\nd = a != b\nx = f"{v!r}"\n');
    expect(languageMode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);
    let binary = editor.getSyntaxNodeAtBufferPosition(new Point(0, 6));
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

  it("highlights TODO markers in comments and cell titles", async () => {
    await lumine.packages.activatePackage("language-todo");
    await setUp("# TODO comment\n# %% TODO title\n");
    await languageMode.atGrammarSettlement();

    expect(editor.scopeDescriptorForBufferPosition([0, 2]).getScopesArray()).toContain(
      "storage.type.class.todo",
    );
    expect(editor.scopeDescriptorForBufferPosition([1, 5]).getScopesArray()).toContain(
      "storage.type.class.todo",
    );
  });

  it("keeps IPython markers compatible with the jupyter.cells service", async () => {
    const { mainModule } = await lumine.packages.activatePackage(packagePathFor("jupyter-cells"));
    const cells = mainModule.provideJupyterCells();
    await setUp("# %% Code\nvalue = 1\n# %%% [markdown] Notes\n# body\n");

    const descriptors = await cells.getCellDescriptors(editor);
    expect(cells.getBreakpoints(editor).map((point) => point.row)).toEqual([0, 2]);
    expect(descriptors.map((descriptor) => descriptor.cellType)).toEqual(["code", "markdown"]);
    expect(descriptors.map((descriptor) => descriptor.source)).toEqual(["value = 1", "# body\n"]);
  });

  it("keeps Python folds working", async () => {
    await setUp("doc.x('''\n11\n''')\n%pwd\n");
    expect(languageMode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);
    expect(editor.isFoldableAtBufferRow(0)).toBe(true);
  });
});
