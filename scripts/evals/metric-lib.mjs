export function roundUnitMetric(value, digits = 4) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Unit metric must be a finite number between 0 and 1.');
  }
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) {
    throw new RangeError('Metric precision must be an integer from 0 through 12.');
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
