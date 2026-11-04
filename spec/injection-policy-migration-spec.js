const fs = require("node:fs");
const path = require("node:path");

describe("Stable injection content edits", () => {
  let editor;
  const fixtures = [
    [
      "source.python.ipy",
      "%%bash\n    echo sampleword\n# %% Next\nvalue = 1\n",
      "language-shellscript",
    ],
  ];
  const packagePath = (name) => {
    const sibling = path.resolve(__dirname, "../..", name);
    return fs.existsSync(sibling) ? sibling : name;
  };
  afterEach(() => editor?.destroy());
  for (const [index, [scope, source, ...dependencies]] of fixtures.entries())
    it(`preserves real parser ownership while editing ${scope} (fixture ${index + 1})`, async () => {
      jasmine.useRealClock();
      for (const name of new Set(["language-ipython", ...dependencies]))
        await lumine.packages.activatePackage(packagePath(name));
      const policy = require("../lib/python-content-edit-policy");
      editor = await lumine.workspace.open();
      editor.setText(source);
      lumine.grammars.assignLanguageMode(editor.getBuffer(), scope);
      await editor.whenGrammarSettled();
      const buffer = editor.getBuffer();
      const layers = () =>
        editor.analyzeSyntax(require.resolve("./helpers/content-edit-inspection"), "layers");
      const initial = await layers();
      expect(initial.length).toBeGreaterThan(0);
      const originals = initial.map((layer) => ({
        scope: layer.scopeName,
        ranges: layer.ranges.map((range) => buffer.markRange(range, { invalidate: "never" })),
      }));
      const start = source.indexOf("sampleword") + 4;
      const point = buffer.positionForCharacterIndex(start);
      const originalLine = buffer.lineForRow(point.row);
      const before = originalLine.slice(0, point.column),
        after = originalLine.slice(point.column);
      try {
        for (const text of ["a", "r", "f", " "]) {
          expect(policy({ before, oldText: "", newText: text, after })).toBe(true);
          buffer.insert(point, text);
          await editor.whenGrammarSettled();
          expect((await layers()).map((layer) => [layer.scopeName, layer.ranges])).toEqual(
            originals.map((item) => [
              item.scope,
              item.ranges.map((marker) => marker.getRange().serialize()),
            ]),
          );
          buffer.delete([point, point.translate([0, text.length])]);
          await editor.whenGrammarSettled();
        }
        for (const text of ["\n", "\\", "'", "<", "{"])
          expect(policy({ before, oldText: "", newText: text, after })).toBe(false);
        expect(editor.getText()).toBe(source);
      } finally {
        for (const item of originals) for (const marker of item.ranges) marker.destroy();
      }
    });
});
