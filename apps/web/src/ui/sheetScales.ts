/** Matches `STANDARD_VIEW_SCALES` in apex-core. */
export const STANDARD_VIEW_SCALES = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000,
] as const;

export function formatViewScale(scale: number): string {
  const rounded = Math.round(scale);
  return `1:${rounded}`;
}
