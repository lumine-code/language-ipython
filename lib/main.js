let sourceProjection;

exports.deactivate = function () {
  sourceProjection?.dispose();
  sourceProjection = null;
};

exports.provideIPythonSource = function () {
  sourceProjection ??= new (require("./source-projection").SourceProjectionService)();
  return sourceProjection;
};
