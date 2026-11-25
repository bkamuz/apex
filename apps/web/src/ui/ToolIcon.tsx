import { useId } from 'react';
import { resolveToolIconSvg, scopeSvgIds, type ToolIcon } from '../tools/icons';

/**
 * Renders a catalog or custom tool glyph; returns null when missing.
 * `size` picks the 16 / 24 / 32 px drawing (CSS sets the box to match).
 */
export function ToolIconGlyph({ icon, size = 24 }: { icon: ToolIcon | undefined; size?: number }) {
  const scope = useId();
  const svg = resolveToolIconSvg(icon, size);
  if (!svg) return null;
  return (
    <span
      className="tool-icon"
      data-icon-size={size}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: scopeSvgIds(svg, scope) }}
    />
  );
}
