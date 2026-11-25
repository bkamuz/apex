"""Tiny icon DSL: author on a 24-unit grid, emit pixel-snapped 16/24/32 SVGs.

Layers
  hero     - solid currentColor
  sub      - currentColor at TONE opacity, cut by an even gap around the hero
  holes    - punched out of the hero (mask)
  subholes - punched out of the sub layer (mask)
Masks are the only place #000/#fff appear. Inside `with g.native():` a glyph is
drawn in that size's own pixel coordinates (no scaling, no rounding).
"""
import math
import re

TONE = 0.4
GAP = {16: 1.0, 24: 1.5, 32: 2.0}   # px gap between hero and sub
SIZES = (16, 24, 32)


def _fmt(v):
    v = round(v, 3)
    return ('%d' % v) if v == int(v) else ('%g' % v)


class Layer:
    def __init__(self, g):
        self.g = g
        self.items = []  # (kind, svg-fragment-builder)

    # every primitive takes 24-grid coordinates
    def rect(self, x, y, w, h):
        g = self.g
        # snap the origin, keep the size consistent (no 1px/2px wobble between twins)
        x0, y0 = g.sn(x), g.sn(y)
        x1, y1 = (x0 + w, y0 + h) if g.exact else (x0 + max(1, round(w * g.s)), y0 + max(1, round(h * g.s)))
        self.items.append(('fill', f'<rect x="{_fmt(x0)}" y="{_fmt(y0)}" width="{_fmt(x1-x0)}" height="{_fmt(y1-y0)}"/>',
                           f'<rect x="{_fmt(x0)}" y="{_fmt(y0)}" width="{_fmt(x1-x0)}" height="{_fmt(y1-y0)}"/>'))
        return self

    def poly(self, pts):
        g = self.g
        d = 'M' + 'L'.join(f'{_fmt(g.sn(x))} {_fmt(g.sn(y))}' for x, y in pts) + 'Z'
        self.items.append(('fill', f'<path d="{d}"/>', f'<path d="{d}"/>'))
        return self

    def path(self, d24):
        """Raw path (curves). Master: scaled from 24 units; native: pixel units as written."""
        s = self.g.s
        frag = f'<path transform="scale({_fmt(s)})" d="{d24}"/>' if s != 1 else f'<path d="{d24}"/>'
        self.items.append(('fill', frag, frag))
        return self

    def circ(self, cx, cy, r):
        g = self.g
        rr = r if g.exact else max(0.5, round(r * g.s * 2) / 2)
        c = g.cs
        f = f'<circle cx="{_fmt(c(cx))}" cy="{_fmt(c(cy))}" r="{_fmt(rr)}"/>'
        self.items.append(('fill', f, f))
        return self

    def sector(self, cx, cy, r, a0, a1):
        """Pie slice, angles in degrees, 0 = +x, 90 = +y (screen down)."""
        g = self.g
        X, Y, R = g.sn(cx), g.sn(cy), (r if g.exact else max(1, round(r * g.s)))
        p0 = (X + R * math.cos(math.radians(a0)), Y + R * math.sin(math.radians(a0)))
        p1 = (X + R * math.cos(math.radians(a1)), Y + R * math.sin(math.radians(a1)))
        large = 1 if (a1 - a0) % 360 > 180 else 0
        d = f'M{_fmt(X)} {_fmt(Y)}L{_fmt(p0[0])} {_fmt(p0[1])}A{_fmt(R)} {_fmt(R)} 0 {large} 1 {_fmt(p1[0])} {_fmt(p1[1])}Z'
        self.items.append(('fill', f'<path d="{d}"/>', f'<path d="{d}"/>'))
        return self

    def line(self, pts, w=2, cap='butt'):
        g = self.g
        W = g.sw(w)
        snap = g.snl if (W % 2 and not g.exact) else g.sn
        # axis-aligned lines get the odd-width half-pixel snap; others plain
        P = [(snap(x), snap(y)) for x, y in pts]
        d = 'M' + 'L'.join(f'{_fmt(x)} {_fmt(y)}' for x, y in P)
        frag = (f'<path d="{d}" fill="none" stroke="currentColor" stroke-width="{_fmt(W)}" '
                f'stroke-linecap="{cap}" stroke-linejoin="miter"/>')
        mfrag = (f'<path d="{d}" fill="none" stroke="#000" stroke-width="{_fmt(W)}" '
                 f'stroke-linecap="{cap}" stroke-linejoin="miter"/>')
        self.items.append(('stroke', frag, mfrag, W, d, cap))
        return self

    def arc(self, cx, cy, r, a0, a1, w=2):
        g = self.g
        W = g.sw(w)
        X, Y = g.sn(cx), g.sn(cy)
        R = r if g.exact else max(1, round(r * g.s * 2) / 2)
        p0 = (X + R * math.cos(math.radians(a0)), Y + R * math.sin(math.radians(a0)))
        p1 = (X + R * math.cos(math.radians(a1)), Y + R * math.sin(math.radians(a1)))
        large = 1 if (a1 - a0) % 360 > 180 else 0
        d = f'M{_fmt(p0[0])} {_fmt(p0[1])}A{_fmt(R)} {_fmt(R)} 0 {large} 1 {_fmt(p1[0])} {_fmt(p1[1])}'
        frag = f'<path d="{d}" fill="none" stroke="currentColor" stroke-width="{_fmt(W)}"/>'
        mfrag = f'<path d="{d}" fill="none" stroke="#000" stroke-width="{_fmt(W)}"/>'
        self.items.append(('stroke', frag, mfrag, W, d, 'butt'))
        return self

    def ring(self, cx, cy, r, w=2):
        g = self.g
        W = g.sw(w)
        c = g.cs
        R = r if g.exact else max(1, round(r * g.s * 2) / 2)
        frag = f'<circle cx="{_fmt(c(cx))}" cy="{_fmt(c(cy))}" r="{_fmt(R)}" fill="none" stroke="currentColor" stroke-width="{_fmt(W)}"/>'
        mfrag = frag.replace('currentColor', '#000')
        self.items.append(('ring', frag, mfrag, W, (c(cx), c(cy), R)))
        return self


class Glyph:
    def __init__(self, px):
        self.px = px
        self.s = px / 24.0
        self.hero = Layer(self)
        self.sub = Layer(self)
        self.holes = Layer(self)
        self.subholes = Layer(self)
        self.gap_extra = Layer(self)  # extra gap-only cutters (cut sub, not hero)

        self.exact = False

    def native(self):
        """Hand-drawn pixel coordinates for this size: no scaling, no rounding."""
        g = self

        class _Ctx:
            def __enter__(self_):
                self_.prev = (g.s, g.exact)
                g.s, g.exact = 1.0, True

            def __exit__(self_, *a):
                g.s, g.exact = self_.prev
        return _Ctx()

    # snapping helpers
    def sn(self, v):
        return v if self.exact else round(v * self.s)

    def snl(self, v):
        return v if self.exact else math.floor(v * self.s) + 0.5

    def sw(self, w):
        return w if self.exact else max(1, round(w * self.s))

    def cs(self, v):
        return v if self.exact else round(v * self.s * 2) / 2

    @property
    def small(self):
        return self.px <= 16

    @property
    def big(self):
        return self.px >= 32


def _mask_hero_dilated(g, uid):
    gap = GAP[g.px]
    parts = []
    for it in g.hero.items + g.gap_extra.items:
        if it[0] == 'fill':
            frag = it[2]
            sw = 2 * gap
            m = re.search(r'transform="scale\(([\d.]+)\)"', frag)
            if m:  # stroke inside a scaled path is scaled too
                sw = sw / float(m.group(1))
            parts.append(frag.replace('/>', f' fill="#000" stroke="#000" stroke-width="{_fmt(sw)}" stroke-linejoin="miter"/>', 1))
        else:
            W = it[3]
            frag = it[2].replace(f'stroke-width="{_fmt(W)}"', f'stroke-width="{_fmt(W + 2*gap)}"')
            parts.append(frag)
    return ''.join(parts)


def render(icon_id, fn, px, concept):
    g = Glyph(px)
    fn(g)
    uid = f'apx-{concept}-{icon_id}-{px}'
    S = px
    defs = []
    body = []
    holes = ''.join(it[2].replace('/>', ' fill="#000"/>', 1) if it[0] == 'fill' else it[2] for it in g.holes.items)
    hero_mask = None
    subholes = ''.join(it[2].replace('/>', ' fill="#000"/>', 1) if it[0] == 'fill' else it[2] for it in g.subholes.items)
    if holes:
        hero_mask = f'{uid}-h'
        defs.append(f'<mask id="{hero_mask}" maskUnits="userSpaceOnUse" x="0" y="0" width="{S}" height="{S}">'
                    f'<rect width="{S}" height="{S}" fill="#fff"/>{holes}</mask>')
    if g.sub.items:
        gm = f'{uid}-g'
        defs.append(f'<mask id="{gm}" maskUnits="userSpaceOnUse" x="0" y="0" width="{S}" height="{S}">'
                    f'<rect width="{S}" height="{S}" fill="#fff"/>{_mask_hero_dilated(g, uid)}{subholes}</mask>')
        sub = ''.join(it[1] for it in g.sub.items)
        body.append(f'<g fill="currentColor" opacity="{TONE}" mask="url(#{gm})">{sub}</g>')
    hero = ''.join(it[1] for it in g.hero.items)
    m = f' mask="url(#{hero_mask})"' if hero_mask else ''
    body.append(f'<g fill="currentColor"{m}>{hero}</g>')
    d = f'<defs>{"".join(defs)}</defs>' if defs else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}" '
            f'fill="none" aria-hidden="true">{d}{"".join(body)}</svg>')


