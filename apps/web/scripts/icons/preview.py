"""Preview sheets for the Poché icon set (needs `pip install resvg-py pillow` and DejaVu fonts).

    python3 scripts/icons/preview.py   # writes scripts/icons/previews/*.png

Rendered with resvg (cairosvg gets the masks wrong).
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import resvg_py  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import engine  # noqa: E402
from generate import catalog  # noqa: E402
from meta import FUTURE, GENUS, GENUS_ALIAS, MAIN  # noqa: E402

OUT = os.path.join(HERE, 'previews')
LIGHT = ('#f6f5f2', '#1f2328')
DARK = ('#1d1f23', '#e9e9e6')
FR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FB = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
f10, f11, f12, fb14, fb20 = (ImageFont.truetype(FR, 10), ImageFont.truetype(FR, 11), ImageFont.truetype(FR, 12),
                             ImageFont.truetype(FB, 14), ImageFont.truetype(FB, 20))


def entries():
    """(kind, id, ru, en, status, registry key)"""
    out = [('main', i, ru, en, st, i) for i, ru, en, st, _ in MAIN + FUTURE]
    for gid, ru, en, _ in GENUS:
        out.append(('genus', gid, ru, en, 'genus', GENUS_ALIAS.get(gid) or 'ge:' + gid))
    return out


def raster(svg, px, color):
    svg = svg.replace('<svg ', f'<svg color="{color}" ', 1)
    return Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=px, height=px)))).convert('RGBA')


def write_svgs():
    svgs = {}
    shutil.rmtree(f'{ROOT}/svg', ignore_errors=True)
    for kind, iid, _ru, _en, _st, key in entries():
        for px in engine.SIZES:
            d = f'{ROOT}/svg/{px}' + ('/genus-editor' if kind == 'genus' else '')
            os.makedirs(d, exist_ok=True)
            uid = key.replace('ge:', 'ge-')
            svg = engine.render(uid, poche.draw(key), px, 'p')
            open(f'{d}/{iid}.svg', 'w').write(svg)
            svgs[(kind, iid, px)] = svg
    return svgs


def write_manifest():
    m = {'concept': 'b-poche', 'version': 2, 'sizes': list(engine.SIZES), 'tone_opacity': engine.TONE,
         'gap_px': engine.GAP,
         'main': [dict(id=i, ru=ru, en=en, status=st, source=src, files={str(px): f'svg/{px}/{i}.svg' for px in engine.SIZES})
                  for i, ru, en, st, src in MAIN + FUTURE],
         'genus_editor': [dict(id=g, ru=ru, en=en, repo_name=rn, reuses_main=GENUS_ALIAS.get(g),
                               files={str(px): f'svg/{px}/genus-editor/{g}.svg' for px in engine.SIZES})
                          for g, ru, en, rn in GENUS]}
    json.dump(m, open(f'{ROOT}/manifest.json', 'w'), ensure_ascii=False, indent=1)


def sections():
    e = entries()
    return [('Главная лента / Main ribbon', [x for x in e if x[0] == 'main' and x[4] != 'future']),
            ('БУДУЩИЕ / FUTURE tools', [x for x in e if x[4] == 'future']),
            ('Редактор рода / Genus editor ribbon', [x for x in e if x[0] == 'genus'])]


def overview(svgs, theme, path):
    bg, fg = theme
    cols, cw, ch = 11, 96, 118
    rows = sum((len(items) + cols - 1) // cols for _, items in sections())
    W = cols * cw + 20
    H = 60 + rows * ch + 3 * 34 + 10
    im = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(im)
    d.text((10, 14), 'Poché — 32 / 24 / 16 px (each a separate drawing)', font=fb20, fill=fg)
    y = 50
    for title, items in sections():
        d.text((10, y + 8), title, font=fb14, fill='#e0564c' if 'FUTURE' in title else fg)
        y += 34
        for k, (kind, iid, ru, en, st) in enumerate(items):
            x = 10 + (k % cols) * cw
            yy = y + (k // cols) * ch
            xx = x + 4
            for px in (32, 24, 16):
                t = raster(svgs[(kind, iid, px)], px, fg)
                im.paste(t, (xx, yy + 4 + (32 - px) // 2), t)
                xx += px + 6
            d.text((x + 4, yy + 44), ru[:16], font=f11, fill=fg)
            d.text((x + 4, yy + 60), en[:16], font=f10, fill=fg)
            d.text((x + 4, yy + 76), iid[:16], font=f10, fill='#8a8a8a')
        y += ((len(items) + cols - 1) // cols) * ch
    im.save(path)


def toolbar_mock(svgs, path):
    """Real pixel sizes: ribbon big buttons with 24 px glyphs, context bar at 16 px."""
    labels = {i: ru for i, ru, *_ in MAIN + FUTURE}
    arch = ['select', 'wall', 'column', 'beam', 'slab', 'door', 'window', 'opening', 'stair', 'roof',
            'roof-pitched', 'space', 'detect-rooms', 'level', 'ref-point', 'ref-plane', 'construction-line', 'grid']
    eng = ['pipe', 'duct', 'cable', 'dimension', 'text-note', 'section-cut', 'fence', 'gate', 'site-surface', 'terrain',
           'view-3d', 'view-plan', 'view-fit', 'thin-lines', 'move', 'copy', 'parent', 'detach', 'boolean']
    fut = ['railing', 'ceiling', 'curtain-wall', 'foundation', 'wall-opening', 'component', 'genus-editor']
    bw = 64
    W = 16 + bw * max(len(arch), len(eng))
    im = Image.new('RGB', (W, 2 * (3 * 62 + 40) + 20), '#ffffff')
    d = ImageDraw.Draw(im)
    y = 6
    for bg, fg in (LIGHT, DARK):
        for row in (arch, eng, fut):
            d.rectangle([0, y, W, y + 58], fill=bg)
            for k, iid in enumerate(row):
                x = 8 + k * bw
                t = raster(svgs[('main', iid, 24)], 24, fg)
                im.paste(t, (x + (bw - 24) // 2, y + 6), t)
                lab = labels[iid]
                lab = lab if len(lab) <= 10 else lab[:9] + '…'
                tw = d.textlength(lab, font=f10)
                d.text((x + (bw - tw) / 2, y + 36), lab, font=f10, fill=fg)
            y += 60
        # context bar at 16 px
        d.rectangle([0, y, W, y + 30], fill=bg)
        x = 8
        for iid in ['select', 'move', 'copy', 'parent', 'detach', 'boolean', 'wall', 'door', 'window', 'dimension', 'text-note']:
            t = raster(svgs[('main', iid, 16)], 16, fg)
            im.paste(t, (x, y + 7), t)
            lab = labels[iid]
            d.text((x + 20, y + 9), lab, font=f11, fill=fg)
            x += 26 + int(d.textlength(lab, font=f11)) + 12
        y += 40
    im.save(path)




def entries():
    """(kind, id, ru, en, status)"""
    out = [('main', i, ru, en, st) for i, ru, en, st, _ in MAIN + FUTURE]
    out += [('genus', g, ru, en, 'genus') for g, ru, en, _ in GENUS]
    return out


def raster(svg, px, color):
    svg = svg.replace('<svg ', f'<svg color="{color}" ', 1)
    return Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=px, height=px)))).convert('RGBA')


def with_aliases(svgs):
    """Genus editor ids that reuse a main-ribbon glyph get that glyph in the sheets."""
    out = dict(svgs)
    for gid, main_id in GENUS_ALIAS.items():
        for px in engine.SIZES:
            out[('genus', gid, px)] = svgs[('main', main_id, px)]
    return out


def main():
    svgs = with_aliases(catalog())
    os.makedirs(OUT, exist_ok=True)
    overview(svgs, LIGHT, os.path.join(OUT, 'overview-light.png'))
    overview(svgs, DARK, os.path.join(OUT, 'overview-dark.png'))
    toolbar_mock(svgs, os.path.join(OUT, 'toolbar-mock.png'))
    print('wrote', os.path.relpath(OUT))


if __name__ == '__main__':
    main()
