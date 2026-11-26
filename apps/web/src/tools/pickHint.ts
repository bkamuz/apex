/**
 * Status line while a tool is collecting picks.
 * The first click uses the placing sentence. Each later click uses the
 * counted sentence, so a single remaining pick can stay singular.
 */
export function remainingPickHint(
  pendingCount: number,
  required: number,
  placing: string,
  clicks: (remaining: number) => string,
): string {
  if (pendingCount === 0) return placing;
  return clicks(Math.max(required - pendingCount, 0));
}
