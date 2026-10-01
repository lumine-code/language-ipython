const path = require("path");
const { Point, Range } = require("lumine");

describe("IPython source projection service", () => {
  let editor, service;
  const packagePath = (name) => path.resolve(__dirname, "..", "..", name);
  async function open(source, scope = "source.python.ipy") {
    editor = await lumine.workspace.open();
    editor.setText(source);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), scope);
    await editor.whenGrammarSettled();
    return service.project(editor);
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["language-ipython", "language-python", "language-gfm", "language-html"]) {
      await lumine.packages.activatePackage(packagePath(name));
    }
    service = lumine.packages
      .getActivePackage("language-ipython")
      .mainModule.provideIPythonSource();
  });
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("is passive for ordinary Python and notebook fragment roles", async () => {
    expect(await open("number = 1\n", "source.python")).toBe(null);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    await editor.whenGrammarSettled();
    spyOn(lumine.textEditors, "roleFor").and.returnValue("fragment");
    expect(service.isApplicable(editor)).toBe(false);
    expect(await service.project(editor)).toBe(null);
  });

  it("keeps ordinary Python, strings and comments byte-for-byte", async () => {
    const source = "text = '%%html 😀'\r\n# %pwd !shell\r\nvalue = 1\r\n";
    const projection = await open(source);
    expect(projection.source).toBe(source);
    expect(projection.text).toBe(source);
    expect(projection.isIdentity).toBe(true);
    expect(projection.protectedRanges.length).toBe(0);
    expect(projection.isPythonPosition([2, 3])).toBe(true);
  });

  it("prepares proven identity source without waiting for an unrelated editor parse", async () => {
    await open("value = 1\n");
    const mode = editor.getBuffer().getLanguageMode();
    const waits = spyOn(mode, "atGrammarSettlement").and.callThrough();
    editor.setText("value = 2\n# ordinary comment\n");
    const projection = await service.project(editor);
    expect(projection.text).toBe(editor.getText());
    expect(waits).not.toHaveBeenCalled();
    editor.setText("value = !x\n");
    const mixed = await service.project(editor);
    expect(mixed.text).toBe("value = eval('')\n");
    expect(waits).toHaveBeenCalled();
  });

  it("excludes all literal Markdown including fenced Python and raw bytes", async () => {
    const projection = await open(
      "# %% [markdown] Notes\r\n```python\r\nsecret = 1\r\n```\r\n# %% [raw]\r\nraw <😀>\r\n# %% [code]\r\nvisible = 2\r\n",
    );
    expect(projection.text).not.toContain("secret");
    expect(projection.isIdentity).toBe(false);
    expect(projection.text).not.toContain("raw <");
    expect(projection.text).toContain("visible = 2");
    expect(projection.text.length).toBe(projection.source.length);
    expect(projection.text.match(/\r\n/g).length).toBe(projection.source.match(/\r\n/g).length);
    expect(projection.isPythonPosition([2, 4])).toBe(false);
    expect(projection.isPythonPosition([5, 3])).toBe(false);
    expect(projection.isPythonPosition([7, 4])).toBe(true);
    expect((await projection.getFormattingBlocks()).map((block) => block.range.start.row)).toEqual([
      7,
    ]);
  });

  it("keeps Python wrapper and interpreter bodies while excluding foreign and unknown magics", async () => {
    const projection = await open(
      "%%time\nfirst = 1\n# %%\n%%python3\nsecond = 2\n# %%\n%%html\n<h1>foreign</h1>\n# %%\n%%custom\nunknown <body>\n# %%\nlast = 3\n",
    );
    expect(projection.text).toContain("first = 1");
    expect(projection.text).toContain("second = 2");
    expect(projection.text).toContain("last = 3");
    expect(projection.text).not.toContain("%%time");
    expect(projection.text).not.toContain("foreign");
    expect(projection.text).not.toContain("unknown <");
    expect((await projection.getFormattingBlocks()).map((block) => block.range.start.row)).toEqual([
      1, 4, 12,
    ]);
  });

  it("uses width-preserving statements even for one-character magics", async () => {
    const projection = await open("if ready:\n    !\n    %x\n    ?\nnext = 1\n");
    expect(projection.text).toBe("if ready:\n    0\n    0 \n    0\nnext = 1\n");
    expect(projection.syntheticRanges.length).toBe(3);
    expect(projection.isPythonPosition([1, 4])).toBe(false);
    expect(projection.isPythonPosition([1, 5])).toBe(false);
    expect(projection.isPythonPosition([4, 2])).toBe(true);
  });

  it("permits the first edit in empty Python bodies without exposing empty opaque bodies", async () => {
    await open("");
    for (const source of ["", "# %%\n", "%%time\n", "%%python3\n"]) {
      editor.setText(source);
      const projection = await service.project(editor);
      const end = editor.getBuffer().getEndPosition();
      expect(projection.isPythonPosition(end)).toBe(true);
      expect(
        projection.mapEdits([{ oldRange: new Range(end, end), newText: "value = 1" }]),
      ).not.toBe(null);
    }
    for (const source of ["# %%", "# %% [raw]\n", "# %% [markdown]\n", "%%html\n", "%%custom\n"]) {
      editor.setText(source);
      const projection = await service.project(editor);
      expect(projection.isPythonPosition(editor.getBuffer().getEndPosition())).toBe(false);
    }
  });

  it("maps expanding Any RHS endpoints but rejects edits and requests inside it", async () => {
    const projection = await open("value = !x\r\nafter = 1\r\n");
    expect(projection.text).toBe("value = eval('')\r\nafter = 1\r\n");
    expect(projection.toServerPosition([0, 10])).toEqual(new Point(0, 16));
    expect(projection.fromServerPosition([0, 16])).toEqual(new Point(0, 10));
    expect(projection.toServerPosition([0, 9])).toBe(null);
    expect(projection.fromServerPosition([0, 9])).toBe(null);
    expect(
      projection.fromServerRange([
        [0, 0],
        [0, 16],
      ]),
    ).toEqual(new Range([0, 0], [0, 10]));
    expect(
      projection.isPythonRange([
        [0, 0],
        [0, 10],
      ]),
    ).toBe(false);
    expect(projection.toServerPosition([1, 5])).toEqual(new Point(1, 5));
    expect(projection.mapEdits([{ oldRange: new Range([0, 9], [0, 10]), newText: "x" }])).toBe(
      null,
    );
  });

  it("maps only ordinary edits atomically and protects compact marker spellings", async () => {
    const projection = await open("#%%$$# Legacy\nvalue = !x\nother = 2\n");
    const ordinary = { oldRange: new Range([2, 8], [2, 9]), newText: "3" };
    expect(projection.mapEdits([ordinary])).toEqual([ordinary]);
    const header = { oldRange: new Range([0, 0], [0, 3]), newText: "# %%" };
    expect(projection.mapEdits([ordinary, header])).toBe(null);
    expect(
      projection.mapEdits([{ oldRange: new Range([1, 0], [2, 9]), newText: "replaced" }]),
    ).toBe(null);
    expect(
      projection.mapEdits([{ oldRange: new Range([0, 0], [3, 0]), newText: projection.text }]),
    ).toBe(null);
    expect(editor.getText()).toBe(projection.source);
  });

  it("converts codepoints and UTF16 in both original and projected text", async () => {
    const projection = await open("value = '😀'; name = !😀\nnext = '😀'\n");
    expect(projection.sourceToCodePointPosition([0, 14])).toEqual(new Point(0, 13));
    expect(projection.sourceFromCodePointPosition([0, 13])).toEqual(new Point(0, 14));
    expect(projection.toCodePointPosition([0, 14])).toEqual(new Point(0, 13));
    expect(projection.fromCodePointPosition([0, 13])).toEqual(new Point(0, 14));
    expect(projection.sourceToCodePointPosition([0, 10])).toBe(null);
    expect(projection.toCodePointPosition([1, 11])).toEqual(new Point(1, 10));
    expect(projection.fromCodePointPosition([1, 10])).toEqual(new Point(1, 11));
  });

  it("keeps ASCII endpoints and surrogate pairs correct across Unicode chunk boundaries", async () => {
    const prefix = "value = '";
    const source =
      prefix + "x".repeat(4095 - prefix.length) + "😀" + "x".repeat(8192 - 4097) + "😀tail'\n";
    const projection = await open(source);
    for (const mapper of [projection.sourceToCodePointPosition, projection.toCodePointPosition]) {
      expect(mapper([0, 0])).toEqual(new Point(0, 0));
      expect(mapper([0, 4095])).toEqual(new Point(0, 4095));
      expect(mapper([0, 4096])).toBe(null);
      expect(mapper([0, 4097])).toEqual(new Point(0, 4096));
      expect(mapper([0, 8192])).toEqual(new Point(0, 8191));
      expect(mapper([0, 8193])).toBe(null);
      expect(mapper([0, 8194])).toEqual(new Point(0, 8192));
      expect(mapper([0, source.length - 1])).toEqual(new Point(0, source.length - 3));
    }
    for (const mapper of [
      projection.sourceFromCodePointPosition,
      projection.fromCodePointPosition,
    ]) {
      expect(mapper([0, 4095])).toEqual(new Point(0, 4095));
      expect(mapper([0, 4096])).toEqual(new Point(0, 4097));
      expect(mapper([0, 8191])).toEqual(new Point(0, 8192));
      expect(mapper([0, 8192])).toEqual(new Point(0, 8194));
      expect(mapper([0, source.length - 3])).toEqual(new Point(0, source.length - 1));
    }
    editor.setText("value = 1\n");
    const ascii = await service.project(editor);
    expect(ascii.toCodePointPosition([0, 0])).toEqual(new Point(0, 0));
    expect(ascii.fromCodePointPosition([0, 9])).toEqual(new Point(0, 9));
    expect(ascii.fromCodePointPosition([0, 10])).toBe(null);
  });

  it("shares one AST snapshot per revision without creating another parser", async () => {
    const builds = spyOn(service, "buildSnapshot").and.callThrough();
    await open("value = 1\n%pwd\n");
    const mode = editor.getBuffer().getLanguageMode();
    const creates = spyOn(mode, "createParserForLanguage").and.callThrough();
    const [first, second] = await Promise.all([service.project(editor), service.project(editor)]);
    expect(first).toBe(second);
    expect(builds.calls.count()).toBe(1);
    expect(creates).not.toHaveBeenCalled();
    editor.setText("value = 2\n%pwd\n");
    expect(first.isCurrent()).toBe(false);
    expect(first.mapEdits([])).toBe(null);
    const latest = await service.project(editor);
    expect(builds.calls.count()).toBe(2);
    expect(latest.source).toBe(editor.getText());
    expect(latest.isCurrent()).toBe(true);
  });

  it("prepares one module from the scaffold without walking native Python injections", async () => {
    await open(
      "import os\n# %% [markdown]\nsecret = 'Markdown only'\n# %% Timing\n%%time\nvalue = !x\n# %% Result\nresult = os.getcwd()\n",
    );
    const mode = editor.getBuffer().getLanguageMode();
    const pythonLayers = mode.getAllLanguageLayers(
      (layer) => layer.grammar.scopeName === "source.python",
    );
    expect(pythonLayers.length).toBe(1);
    const walks = pythonLayers.map((layer) => spyOn(layer.tree, "walk").and.callThrough());
    const rootWalk = spyOn(mode.rootLanguageLayer.tree, "walk").and.callThrough();
    const creates = spyOn(mode, "createParserForLanguage").and.callThrough();
    // Use the current service generation, without its already prepared cache.
    const isolated = new service.constructor();
    try {
      const projection = await isolated.project(editor);
      expect(projection.text).toContain("import os\n");
      expect(projection.text).toContain("value = eval('')\n");
      expect(projection.text).toContain("result = os.getcwd()\n");
      expect(projection.text).not.toContain("Markdown only");
      expect(projection.text).not.toContain("%%time");
      expect(rootWalk.calls.count()).toBe(1);
      for (const walk of walks) expect(walk).not.toHaveBeenCalled();
      expect(creates).not.toHaveBeenCalled();
    } finally {
      isolated.dispose();
    }
  });

  it("keeps a shared-buffer snapshot current after its first split closes", async () => {
    const builds = spyOn(service, "buildSnapshot").and.callThrough();
    const first = await open("value = !x\n");
    const second = editor.copy();
    try {
      expect(second.getBuffer()).toBe(editor.getBuffer());
      expect(await service.project(second)).toBe(first);
      editor.destroy();
      expect(first.isCurrent()).toBe(true);
      expect(await service.project(second)).toBe(first);
      expect(builds.calls.count()).toBe(1);
      second.setText("value = !y\n");
      expect(first.isCurrent()).toBe(false);
      const latest = await service.project(second);
      expect(latest.source).toBe("value = !y\n");
      expect(builds.calls.count()).toBe(2);
    } finally {
      second.destroy();
    }
  });

  it("reads the whole buffer once when classifying many magic headers", async () => {
    const source = "# %%\n%%bash\necho foreign\n# %%\n%%time\nvalue = 1\n".repeat(100);
    const original = await service.projectText(source);
    try {
      const model = [...service.owned][0],
        buffer = model.getBuffer();
      service.stateFor(buffer).cached = null;
      const reads = spyOn(buffer, "getText").and.callThrough();
      const projection = await service.project(model);
      expect(reads.calls.count()).toBe(1);
      expect(projection.text).not.toContain("echo foreign");
      expect(projection.text).toContain("value = 1");
    } finally {
      original.dispose();
    }
  });

  it("builds formatting blocks lazily and shares concurrent formatter preparation", async () => {
    const projection = await open("# %%\nvalue = !x\n# %%\nother = 1\n");
    const positions = spyOn(editor.getBuffer(), "positionForCharacterIndex").and.callThrough();
    expect(projection.pythonFormattingRegions.map((item) => item.start.row)).toEqual([1, 3]);
    expect(positions).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      projection.getFormattingBlocks(),
      projection.getFormattingBlocks(),
    ]);
    expect(first).toBe(second);
    expect(first.length).toBe(2);
    expect(positions.calls.count()).toBe(4);
    const batch = await projection.getFormattingBatch();
    expect(batch.restore(batch.text)).toEqual(
      first.map((block) => ({
        range: block.range,
        text: block.restore(block.text),
      })),
    );
    expect(positions.calls.count()).toBe(4);
    const selected = await projection.getFormattingBatch([
      [
        [3, 0],
        [3, 9],
      ],
    ]);
    expect(selected.restore(selected.text)).toEqual([
      { range: first[1].range, text: "other = 1\n" },
    ]);
    editor.setText("changed = 2\n");
    expect(await projection.getFormattingBlocks()).toEqual([]);
    expect(await projection.getFormattingBatch()).toBe(null);
  });

  it("converts queried Python rows independently of a large opaque Unicode body", async () => {
    const projection = await open("# %% [raw]\n" + "😀".repeat(65536) + "\n# %%\nvalue = '😀'\n");
    expect(projection.toCodePointPosition([3, 12])).toEqual(new Point(3, 11));
    expect(projection.fromCodePointPosition([3, 11])).toEqual(new Point(3, 12));
    expect(projection.sourceToCodePointPosition([3, 12])).toEqual(new Point(3, 11));
    expect(projection.sourceFromCodePointPosition([3, 11])).toEqual(new Point(3, 12));
    expect(projection.toCodePointPosition([3, 10])).toBe(null);
    expect(projection.toCodePointPosition([1, 100])).toEqual(new Point(1, 100));
    expect(projection.sourceToCodePointPosition([1, 100])).toEqual(new Point(1, 50));
  });

  it("returns reversible formatting blocks without headers or foreign bodies", async () => {
    const source = "#%%$$# Code\nvalue=!x\nif ready:\n    %pwd\n# %% [raw]\nraw <payload>\n";
    const projection = await open(source);
    const blocks = await projection.getFormattingBlocks();
    expect(blocks.length).toBe(1);
    const block = blocks[0];
    expect(block.range).toEqual(new Range([1, 0], [4, 0]));
    expect(block.text).not.toContain("#%%");
    expect(block.text).not.toContain("raw <payload>");
    expect(block.restore(block.text)).toBe("value=!x\nif ready:\n    %pwd\n");
    expect(block.restore(block.text.replace("value=", "value = "))).toBe(
      "value = !x\nif ready:\n    %pwd\n",
    );
    expect(editor.getText()).toBe(source);
  });

  it("rejects missing, duplicated, quoted and wrapped formatting sentinels", async () => {
    const projection = await open("value = !x\n%pwd\n");
    const block = (await projection.getFormattingBlocks())[0];
    const calls = block.text.match(/__lumine_ipy_\d+_(?:rhs|statement)_\d+\(\)/g);
    expect(block.restore(block.text.replace(calls[0], "0"))).toBe(null);
    expect(block.restore(block.text + calls[1] + "\n")).toBe(null);
    expect(block.restore(block.text.replace(calls[1], '"' + calls[1] + '"'))).toBe(null);
    expect(block.restore(block.text.replace(calls[0], "(\n" + calls[0] + "\n)"))).toBe(null);
  });

  it("retries when the source changes during cooperative masking", async () => {
    await open("# %% [raw]\n" + "x".repeat(32768) + "\n# %%\nlast = 1\n");
    editor.setText("# %% [raw]\n" + "y".repeat(32768) + "\n# %%\nlast = 2\n");
    const pending = service.project(editor);
    setImmediate(() => editor.setText("# %% [raw]\nchanged\n# %%\nlast = 3\n"));
    const projection = await pending;
    expect(projection.source).toBe(editor.getText());
    expect(projection.text).toContain("last = 3");
    expect(projection.isCurrent()).toBe(true);
  });

  it("cancels one caller without cancelling a shared projection for another", async () => {
    await open("# %% [raw]\n" + "x".repeat(32768) + "\n# %%\nlast = 1\n");
    editor.setText("# %% [raw]\n" + "y".repeat(32768) + "\n# %%\nlast = 2\n");
    const controller = new AbortController();
    const cancelled = service.project(editor, { signal: controller.signal });
    const shared = service.project(editor);
    controller.abort();
    await expectAsync(cancelled).toBeRejected();
    expect((await shared).isCurrent()).toBe(true);
  });

  it("invalidates snapshots and releases cache subscriptions on package deactivation", async () => {
    const projection = await open("value = 1\n");
    await lumine.packages.deactivatePackage("language-ipython");
    expect(projection.isCurrent()).toBe(false);
    expect(service.live.size).toBe(0);
    expect(await projection.getFormattingBlocks()).toEqual([]);
    await lumine.packages.activatePackage(packagePath("language-ipython"));
    const fresh = lumine.packages
      .getActivePackage("language-ipython")
      .mainModule.provideIPythonSource();
    expect(fresh).not.toBe(service);
  });

  it("projects closed-file text through one detached core model without filesystem or registry changes", async () => {
    const count = lumine.textEditors.getEditors().length;
    const modelBuilds = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const projection = await service.projectText("# %% [raw]\nopaque\n# %%\nvalue = !x\n", {
      filePath: "/metadata-only/not-created.ipy",
    });
    expect(modelBuilds.calls.count()).toBe(1);
    expect(projection.filePath).toBe("/metadata-only/not-created.ipy");
    expect(projection.text).toContain("value = eval('')");
    expect(projection.text).not.toContain("opaque");
    expect(projection.isCurrent()).toBe(true);
    expect(service.owned.size).toBe(1);
    expect(lumine.textEditors.getEditors().length).toBe(count);
    projection.dispose();
    projection.dispose();
    expect(projection.isCurrent()).toBe(false);
    expect(service.owned.size).toBe(0);
    expect(lumine.textEditors.getEditors().length).toBe(count);
  });

  it("destroys detached models on cancellation and provider disposal", async () => {
    const count = lumine.textEditors.getEditors().length;
    const controller = new AbortController();
    controller.abort();
    await expectAsync(
      service.projectText("value = 1\n", { signal: controller.signal }),
    ).toBeRejected();
    expect(service.owned.size).toBe(0);
    const projection = await service.projectText("value = 1\n");
    expect(service.owned.size).toBe(1);
    await lumine.packages.deactivatePackage("language-ipython");
    expect(projection.isCurrent()).toBe(false);
    expect(service.owned.size).toBe(0);
    expect(lumine.textEditors.getEditors().length).toBe(count);
  });
});
