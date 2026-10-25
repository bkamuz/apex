import type { SceneDto, SheetDto, ViewDto } from '../types';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Vector sheet layout export (title block + viewport frames). */
export function exportSheetSvg(
  sheet: SheetDto,
  scene: SceneDto,
  projectTitle: string,
  viewportImages: Map<string, string>,
): string {
  const w = sheet.width_mm;
  const h = sheet.height_mm;
  const date = new Date().toISOString().slice(0, 10);
  const views = new Map((scene.views ?? []).map((v) => [v.id, v]));

  let body = '';
  for (const vp of sheet.viewports) {
    const view = views.get(vp.view_id);
    const x = vp.center_x_mm - vp.width_mm / 2;
    const y = h - (vp.center_y_mm + vp.height_mm / 2);
    const img = viewportImages.get(vp.id);
    body += `<rect x="${x}" y="${y}" width="${vp.width_mm}" height="${vp.height_mm}" fill="#fafafa" stroke="#333" stroke-width="0.5"/>`;
    if (img) {
      body += `<image href="${img}" x="${x}" y="${y}" width="${vp.width_mm}" height="${vp.height_mm}" preserveAspectRatio="xMidYMid slice"/>`;
    }
    if (view) {
      body += `<text x="${x + 2}" y="${y + 5}" font-size="3" fill="#222">${escapeXml(view.name)}</text>`;
      body += `<text x="${x + 2}" y="${y + 9}" font-size="2.5" fill="#555">1:${Math.round(view.settings.scale)}</text>`;
    }
  }

  const titleBlockW = 80;
  const titleBlockH = 40;
  const tbX = w - titleBlockW - 8;
  const tbY = h - titleBlockH - 8;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${body}
  <rect x="${tbX}" y="${tbY}" width="${titleBlockW}" height="${titleBlockH}" fill="none" stroke="#111" stroke-width="0.6"/>
  <text x="${tbX + 4}" y="${tbY + 8}" font-size="4" font-weight="bold" fill="#111">${escapeXml(projectTitle)}</text>
  <text x="${tbX + 4}" y="${tbY + 16}" font-size="3" fill="#333">${escapeXml(sheet.number)} — ${escapeXml(sheet.name)}</text>
  <text x="${tbX + 4}" y="${tbY + 24}" font-size="2.8" fill="#666">${date}</text>
</svg>`;
}

export function findViewById(views: ViewDto[] | undefined, id: string): ViewDto | undefined {
  return views?.find((v) => v.id === id);
}
