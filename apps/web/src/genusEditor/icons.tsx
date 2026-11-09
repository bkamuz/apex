/** Ribbon glyphs for the genus editor (18×18, stroke = currentColor). */
const ICONS: Record<string, string> = {
  select: '<path d="M5 3l10 6-5 1 3 6-2 1-3-6-3 3z"/>',
  plane: '<path d="M3 15L15 3" stroke-dasharray="3 2"/><path d="M3 3h4M3 3v4"/>',
  line: '<path d="M3 15L15 3"/><circle cx="3" cy="15" r="1.5"/><circle cx="15" cy="3" r="1.5"/>',
  point: '<path d="M9 3v12M3 9h12"/><circle cx="9" cy="9" r="2.5"/>',
  extrude: '<path d="M3 12l4-3h8l-4 3z"/><path d="M3 12v3h8v-3M15 9v3l-4 3"/><path d="M9 7V2M7 4l2-2 2 2"/>',
  sweep: '<path d="M3 15c3-8 7-10 12-12"/><rect x="2" y="12" width="4" height="4"/>',
  revolve: '<ellipse cx="9" cy="13" rx="6" ry="2"/><path d="M3 13V6M15 13V6"/><ellipse cx="9" cy="6" rx="6" ry="2"/>',
  box: '<path d="M3 6l6-3 6 3v7l-6 3-6-3z"/><path d="M3 6l6 3 6-3M9 9v7"/>',
  cut: '<rect x="3" y="3" width="12" height="12" stroke-dasharray="2 2"/><path d="M6 6l6 6M12 6l-6 6"/>',
  nest: '<rect x="2" y="2" width="14" height="14"/><rect x="6" y="6" width="6" height="6"/>',
  dim: '<path d="M2 12h14M2 9v6M16 9v6"/><path d="M6 7h6"/>',
  label: '<path d="M2 12h14M2 9v6M16 9v6"/><path d="M6 6h6" stroke-width="2"/>',
  move: '<path d="M9 2v14M2 9h14M9 2l-2 2M9 2l2 2M9 16l-2-2M9 16l2-2M2 9l2-2M2 9l2 2M16 9l-2-2M16 9l-2 2"/>',
  copy: '<rect x="2" y="5" width="9" height="9"/><path d="M6 5V2h10v10h-5"/>',
  mirror: '<path d="M9 2v14" stroke-dasharray="2 2"/><path d="M7 4L2 14h5zM11 4l5 10h-5z"/>',
  delete: '<path d="M3 5h12M7 5V3h4v2M5 5l1 11h6l1-11"/>',
  visibility: '<path d="M1 9s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="9" cy="9" r="2.4"/>',
  material: '<rect x="2" y="2" width="14" height="14"/><path d="M2 8l6-6M2 14L14 2M8 16l8-8"/>',
  params: '<path d="M3 4h12M3 9h12M3 14h12"/><circle cx="6" cy="4" r="1.6"/><circle cx="12" cy="9" r="1.6"/><circle cx="8" cy="14" r="1.6"/>',
  addParam: '<path d="M3 5h8M3 10h6M3 15h5"/><path d="M14 10v6M11 13h6"/>',
  formula: '<text x="2" y="14" font-size="12" font-style="italic" stroke="none" fill="currentColor">fx</text>',
  species: '<rect x="2" y="3" width="14" height="12"/><path d="M2 7h14M7 3v12"/>',
  addSpecies: '<rect x="2" y="3" width="10" height="10"/><path d="M2 7h10M6 3v10"/><path d="M14 11v6M11 14h6"/>',
  layoutAll: '<rect x="2" y="2" width="14" height="14"/><path d="M9 2v14M2 9h14"/>',
  front: '<rect x="3" y="2" width="12" height="14"/><rect x="6" y="5" width="6" height="7"/>',
  plan: '<path d="M2 7h5M11 7h5M2 11h5M11 11h5M7 7v4M11 7v4"/><path d="M7 9h4"/>',
  side: '<path d="M7 2v14M11 2v14M7 6h4M7 12h4"/>',
  threeD: '<path d="M3 6l6-3 6 3v7l-6 3-6-3z"/><path d="M3 6l6 3 6-3M9 9v7"/>',
  host: '<rect x="2" y="4" width="14" height="11"/><rect x="7" y="7" width="4" height="5"/>',
  refs: '<path d="M2 6h14M2 12h14M6 2v14" stroke-dasharray="3 2"/>',
  fit: '<path d="M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4"/><rect x="6" y="6" width="6" height="6"/>',
  save: '<path d="M3 3h10l2 2v10H3z"/><path d="M6 3v4h6V3M6 15v-5h6v5"/>',
  exit: '<path d="M7 3H3v12h4M11 6l3 3-3 3M14 9H7"/>',
  structure: '<path d="M3 3h5M3 9h5M3 15h5M8 3v12M8 9h7"/>',
};

export function GenusIcon({ name }: { name: string }) {
  const body = ICONS[name];
  if (!body) return null;
  return (
    <svg
      className="genus-icon"
      viewBox="0 0 18 18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
