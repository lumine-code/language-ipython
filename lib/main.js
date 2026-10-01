const pythonContent = require("./python-injection");

let injectionRegistrations = [];
let sourceProjection;

// Python range projection excludes complete magic rows before combining cells.
exports.activate = function () {
  injectionRegistrations.push(
    lumine.grammars.addInjectionPoint("source.python.ipy", {
      type: "python_cell_body",
      language: () => "python",
      content: pythonContent,
      combined: true,
      includeChildren: true,
      newlinesBetween: true,
      coverShallowerScopes: true,
    }),
  );
};

exports.deactivate = function () {
  sourceProjection?.dispose();
  sourceProjection = null;
  for (const registration of injectionRegistrations.splice(0)) registration.dispose();
};

exports.provideIPythonSource = function () {
  sourceProjection ??= new (require("./source-projection").SourceProjectionService)();
  return sourceProjection;
};

exports.consumeHyperlinkInjection = (hyperlink) => {
  return hyperlink.addInjectionPoint("source.python.ipy", {
    types: ["cell_marker_name"],
  });
};

exports.consumeTodoInjection = (todo) => {
  return todo.addInjectionPoint("source.python.ipy", {
    types: ["cell_marker_name"],
  });
};
