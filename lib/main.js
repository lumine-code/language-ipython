let sourceProjection;

exports.deactivate = function () {
  sourceProjection?.dispose();
  sourceProjection = null;
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
