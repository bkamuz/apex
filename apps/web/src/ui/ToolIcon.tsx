import { resolveToolIconSvg, type ToolIcon } from '../tools/icons';

/** Renders a catalog or custom tool glyph; returns null when missing. */
export function ToolIconGlyph({ icon }: { icon: ToolIcon | undefined }) {
  const svg = resolveToolIconSvg(icon);
  if (!svg) return null;
  return (
    <span
      className="tool-icon"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
