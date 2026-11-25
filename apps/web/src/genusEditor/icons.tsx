import { useId } from 'react';
import { GENUS_ICON_ALIAS, GENUS_ICON_SVG, TOOL_ICON_SVG, type ToolIconSize } from '../tools/iconCatalog.generated';
import { scopeSvgIds } from '../tools/icons';

/** `addParam` → `add-param`, `threeD` → `three-d` (file ids of the Poché set). */
function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function genusIconSvg(name: string, size: ToolIconSize): string | undefined {
  const id = kebab(name);
  const alias = GENUS_ICON_ALIAS[id];
  return alias ? TOOL_ICON_SVG[size][alias] : GENUS_ICON_SVG[size][id];
}

/** Ribbon glyphs for the genus editor (Poché set, two tones of currentColor). */
export function GenusIcon({ name, size = 24 }: { name: string; size?: ToolIconSize }) {
  const scope = useId();
  const svg = genusIconSvg(name, size);
  if (!svg) return null;
  return (
    <span
      className="genus-icon"
      data-icon-size={size}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: scopeSvgIds(svg, scope) }}
    />
  );
}
