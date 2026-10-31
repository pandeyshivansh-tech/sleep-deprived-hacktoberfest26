const sameContent = (a, b) => a.type === b.type && a.sha256 === b.sha256;

// Compares two inventories by path. Output is sorted by path (UTF-16 code unit
// order) so the result is identical on every run. File mode is not part of the
// comparison; it is kept on the records for later analysis.
export function compareInventories(packageInventory, sourceInventory) {
  const paths = [...new Set([...packageInventory.files.keys(), ...sourceInventory.files.keys()])].sort();
  return paths.map((path) => {
    const inPackage = packageInventory.files.get(path) ?? null;
    const inSource = sourceInventory.files.get(path) ?? null;
    let status;
    if (inPackage && inSource) status = sameContent(inPackage, inSource) ? 'identical' : 'modified';
    else status = inPackage ? 'package-only' : 'source-only';
    return { path, status, package: inPackage, source: inSource };
  });
}
