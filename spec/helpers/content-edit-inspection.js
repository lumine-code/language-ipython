// Run beside either parser owner and return data, never syntax handles.
exports.layers = (context) =>
  context
    .getLanguageLayers()
    .slice(1)
    .map(({ scopeName, ranges }) => ({
      scopeName,
      ranges: ranges.map((range) => range.serialize()),
    }));
