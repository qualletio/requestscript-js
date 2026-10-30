/**
 * Orders versions numerically per dot-separated segment ('1.10' > '1.9');
 * missing segments count as 0, with the raw string as a final tie-break
 * so that e.g. '1' and '1.0' order deterministically.
 */
export function compareVersions(a: string, b: string): number {
  const aSegments = a.split('.');
  const bSegments = b.split('.');
  for (let i = 0; i < Math.max(aSegments.length, bSegments.length); i++) {
    const aValue = BigInt(aSegments[i] ?? '0');
    const bValue = BigInt(bSegments[i] ?? '0');
    if (aValue !== bValue) return aValue < bValue ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
