const path = require("path");

const PACKAGE_NAME = "language-ipython";
const EXPECTED_GRAMMARS = 1;

describe(`${PACKAGE_NAME} Tree-sitter queries`, () => {
  let grammars;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage(path.resolve(__dirname, ".."));

    const packageDir = path.resolve(__dirname, "..");
    grammars = lumine.grammars
      .getGrammars()
      .filter((grammar) => grammar.constructor.name === "TreeSitterGrammar")
      .filter((grammar) => grammar.grammarFilePath?.startsWith(packageDir));
  });

  it(`registers all ${EXPECTED_GRAMMARS} Tree-sitter grammar config(s)`, () => {
    expect(grammars.length).toBe(EXPECTED_GRAMMARS);
  });

  it("loads the parser and compiles every query", async () => {
    const failures = [];
    for (const grammar of grammars) {
      await grammar.getLanguage();

      for (const key of Object.keys(grammar.queryPaths ?? {})) {
        if (!key.endsWith("Query")) continue;
        try {
          await grammar.getQuery(key);
        } catch (error) {
          const descriptor = error.queryDescriptor ?? grammar.describeQueryError(error, key);
          failures.push(grammar.constructor.formatQueryErrorDescriptor(descriptor));
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
