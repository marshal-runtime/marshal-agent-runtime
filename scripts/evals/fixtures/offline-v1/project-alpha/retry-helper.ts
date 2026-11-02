export function retryDelay(attempt: number, baseMs = 250): number {
  return baseMs * (2 ** attempt);
}
