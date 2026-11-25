"""Concept B "Poché", v2: flat plan / section / elevation glyphs.

Hero (solid) = what the cut passes through, or the active symbol.
Sub (40 %)   = what lies beyond: floor, host, neighbouring datums.

Every glyph has a 24-unit master (used for 24 px and snapped for 32 px)
and a hand-drawn 16 px version in native pixel coordinates.
"""
R = {}


def master(name):
    def deco(fn):
        R.setdefault(name, {})['m'] = fn
        return fn
    return deco


def px16(name):
    def deco(fn):
        R.setdefault(name, {})[16] = fn
        return fn
    return deco


def draw(name):
    entry = R[name]

    def fn(g):
        if g.px == 16 and 16 in entry:
            with g.native():
                entry[16](g)
        else:
            entry['m'](g)
    return fn


def corners(g, x0, y0, x1, y1, arm, t):
    for (x, y, dx, dy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        g.hero.poly([(x, y), (x + arm * dx, y), (x + arm * dx, y + t * dy), (x + t * dx, y + t * dy),
                     (x + t * dx, y + arm * dy), (x, y + arm * dy)])


# ======================= modify =======================
@master('select')
def _(g):
    g.sub.rect(10, 10, 11, 11)
    g.hero.poly([(3, 3), (18, 9.5), (11.5, 11.5), (9.5, 18)])


@px16('select')
def _(g):
    g.sub.rect(7, 7, 8, 8)
    g.hero.poly([(1, 1), (13, 6), (8, 8), (6, 13)])


@master('move')
def _(g):
    g.sub.rect(8, 8, 8, 8)
    g.hero.rect(11, 6, 2, 12)
    g.hero.rect(6, 11, 12, 2)
    g.hero.poly([(12, 2), (16, 7), (8, 7)])
    g.hero.poly([(12, 22), (8, 17), (16, 17)])
    g.hero.poly([(2, 12), (7, 8), (7, 16)])
    g.hero.poly([(22, 12), (17, 16), (17, 8)])


@px16('move')
def _(g):
    g.sub.rect(5, 5, 6, 6)
    g.hero.rect(7, 4, 2, 8)
    g.hero.rect(4, 7, 8, 2)
    g.hero.poly([(8, 1), (11, 4), (5, 4)])
    g.hero.poly([(8, 15), (5, 12), (11, 12)])
    g.hero.poly([(1, 8), (4, 5), (4, 11)])
    g.hero.poly([(15, 8), (12, 11), (12, 5)])


@master('copy')
def _(g):
    g.sub.rect(3, 3, 12, 12)
    g.hero.rect(9, 9, 12, 12)
    g.holes.rect(14, 11.5, 2, 7)
    g.holes.rect(11.5, 14, 7, 2)


@px16('copy')
def _(g):
    g.sub.rect(1, 1, 9, 9)
    g.hero.rect(6, 6, 9, 9)
    g.holes.rect(10, 8, 1, 5)
    g.holes.rect(8, 10, 5, 1)


@master('parent')
def _(g):
    g.hero.rect(7, 2, 10, 7)
    g.hero.rect(11, 9, 2, 3)
    g.hero.rect(4, 12, 16, 2)
    g.sub.rect(2, 16, 8, 6)
    g.sub.rect(14, 16, 8, 6)


@px16('parent')
def _(g):
    g.hero.rect(4, 1, 8, 5)
    g.hero.rect(7, 6, 2, 2)
    g.hero.rect(2, 8, 12, 2)
    g.sub.rect(1, 11, 5, 4)
    g.sub.rect(10, 11, 5, 4)


@master('detach')
def _(g):
    g.sub.rect(2, 6, 8, 12)
    g.hero.poly([(12, 6), (22, 6), (22, 18), (12, 18), (14.5, 15), (12, 12), (14.5, 9)])


@px16('detach')
def _(g):
    g.sub.rect(1, 4, 5, 8)
    g.hero.poly([(8, 4), (15, 4), (15, 12), (8, 12), (10, 10), (8, 8), (10, 6)])


@master('boolean')
def _(g):
    g.hero.rect(2, 2, 14, 14)
    g.holes.circ(16, 16, 6)
    g.sub.circ(16, 16, 6)


@px16('boolean')
def _(g):
    g.hero.rect(1, 1, 10, 10)
    g.holes.circ(11, 11, 4.5)
    g.sub.circ(11, 11, 4)


# ======================= build =======================
@master('wall')
def _(g):
    # L-shaped wall poché with the room floor beyond
    g.sub.rect(9.5, 2, 12.5, 12.5)
    g.hero.poly([(2, 2), (8, 2), (8, 16), (22, 16), (22, 22), (2, 22)])


@px16('wall')
def _(g):
    g.sub.rect(6, 1, 9, 9)
    g.hero.poly([(1, 1), (5, 1), (5, 11), (15, 11), (15, 15), (1, 15)])


@master('column')
def _(g):
    g.sub.rect(11, 2, 2, 20)
    g.sub.rect(2, 11, 20, 2)
    g.hero.rect(6, 6, 12, 12)
    g.holes.poly([(8, 9.5), (9.5, 8), (16, 14.5), (14.5, 16)])
    g.holes.poly([(14.5, 8), (16, 9.5), (9.5, 16), (8, 14.5)])


@px16('column')
def _(g):
    g.sub.rect(7, 1, 2, 14)
    g.sub.rect(1, 7, 14, 2)
    g.hero.rect(4, 4, 8, 8)
    # 1px diagonals on whole-pixel steps
    g.holes.poly([(5, 6), (6, 5), (11, 10), (10, 11)])
    g.holes.poly([(10, 5), (11, 6), (6, 11), (5, 10)])


@master('beam')
def _(g):
    g.sub.rect(2, 10, 20, 4)
    g.hero.rect(6, 3, 12, 4)
    g.hero.rect(6, 17, 12, 4)
    g.hero.rect(10.5, 7, 3, 10)


@px16('beam')
def _(g):
    g.sub.rect(1, 7, 14, 2)
    g.hero.rect(4, 2, 8, 3)
    g.hero.rect(4, 11, 8, 3)
    g.hero.rect(7, 5, 2, 6)


@master('slab')
def _(g):
    g.hero.rect(2, 8, 20, 5)
    g.sub.rect(4, 14.5, 4, 7.5)
    g.sub.rect(16, 14.5, 4, 7.5)
    g.sub.rect(4, 2, 4, 4.5)
    g.sub.rect(16, 2, 4, 4.5)


@px16('slab')
def _(g):
    g.hero.rect(1, 5, 14, 4)
    g.sub.rect(2, 10, 3, 5)
    g.sub.rect(11, 10, 3, 5)
    g.sub.rect(2, 1, 3, 3)
    g.sub.rect(11, 1, 3, 3)


@master('door')
def _(g):
    # plan: jambs and swing beyond (40 %), leaf solid
    g.sub.rect(2, 18, 4, 4)
    g.sub.rect(19, 18, 3, 4)
    g.sub.sector(6, 18, 13, -90, 0)
    g.hero.rect(6, 4, 3, 14)


@px16('door')
def _(g):
    g.sub.rect(1, 12, 2, 3)
    g.sub.rect(13, 12, 2, 3)
    g.sub.sector(3, 12, 10, -90, 0)
    g.hero.rect(3, 2, 2, 10)


@master('window')
def _(g):
    g.sub.rect(2, 7, 4, 10)
    g.sub.rect(18, 7, 4, 10)
    g.hero.rect(7.5, 7, 9, 10)
    g.holes.rect(9.5, 11, 5, 2)


@px16('window')
def _(g):
    g.sub.rect(1, 5, 2, 6)
    g.sub.rect(13, 5, 2, 6)
    g.hero.rect(4, 5, 8, 6)
    g.holes.rect(6, 7, 4, 2)


@master('opening')
def _(g):
    g.sub.rect(2, 2, 20, 20)
    g.subholes.rect(5, 5, 14, 14)
    g.hero.line([(6, 6), (18, 18)], 3)
    g.hero.line([(18, 6), (6, 18)], 3)


@px16('opening')
def _(g):
    g.sub.path('M1 1H15V15H1ZM3 3V13H13V3Z')
    g.hero.poly([(4, 5), (5, 4), (12, 11), (11, 12)])
    g.hero.poly([(11, 4), (12, 5), (5, 12), (4, 11)])
    g.hero.rect(4, 4, 1, 1)
    g.hero.rect(11, 4, 1, 1)
    g.hero.rect(4, 11, 1, 1)
    g.hero.rect(11, 11, 1, 1)


@master('stair')
def _(g):
    for i in range(5):
        g.sub.rect(3, 3 + i * 4, 18, 2.5)
    g.hero.rect(10.5, 8, 3, 14)
    g.hero.poly([(12, 2), (17.5, 9), (6.5, 9)])


@px16('stair')
def _(g):
    for y in (2, 6, 10, 14):
        g.sub.rect(2, y, 12, 2)
    g.hero.rect(7, 6, 2, 9)
    g.hero.poly([(8, 1), (12, 6), (4, 6)])


@master('roof')
def _(g):
    g.sub.rect(5, 12.5, 14, 9.5)
    g.hero.rect(2, 7, 20, 4)
    g.hero.rect(2, 3, 3, 4)
    g.hero.rect(19, 3, 3, 4)


@px16('roof')
def _(g):
    g.sub.rect(3, 9, 10, 6)
    g.hero.rect(1, 5, 14, 3)
    g.hero.rect(1, 2, 2, 3)
    g.hero.rect(13, 2, 2, 3)


@master('roof-pitched')
def _(g):
    g.sub.rect(5, 14, 14, 8)
    g.hero.poly([(12, 2), (23, 12), (20, 14), (12, 6.5), (4, 14), (1, 12)])


@px16('roof-pitched')
def _(g):
    g.sub.rect(4, 10, 8, 5)
    g.hero.poly([(8, 1), (15, 8), (13, 9.5), (8, 4.5), (3, 9.5), (1, 8)])


@master('pipe')
def _(g):
    g.sub.rect(12, 8, 10, 8)
    g.hero.ring(9, 12, 5.5, 3)


@px16('pipe')
def _(g):
    g.sub.rect(9, 5, 6, 6)
    g.hero.ring(6, 8, 4, 2)


@master('duct')
def _(g):
    g.sub.rect(14, 8, 8, 8)
    g.hero.path('M2 5H16V19H2ZM5 8V16H13V8Z')


@px16('duct')
def _(g):
    g.sub.rect(11, 5, 4, 6)
    g.hero.path('M1 3H10V13H1ZM3 5V11H8V5Z')


@master('cable')
def _(g):
    # cable tray in section: wide flat base, side walls with inward return lips,
    # cables (40 %) lying on the base
    g.hero.path('M2 7H7V9.5H4.5V17H19.5V9.5H17V7H22V19.5H2Z')
    g.sub.circ(9, 14, 2.5)
    g.sub.circ(15, 14, 2.5)
    g.sub.circ(12, 11, 2.5)


@px16('cable')
def _(g):
    g.hero.path('M1 4H5V6H3V12H13V6H11V4H15V14H1Z')
    g.sub.rect(4, 8, 8, 3)


# ======================= datums =======================
@master('ref-point')
def _(g):
    g.sub.circ(12, 12, 8)
    g.hero.rect(11, 2, 2, 6)
    g.hero.rect(11, 16, 2, 6)
    g.hero.rect(2, 11, 6, 2)
    g.hero.rect(16, 11, 6, 2)
    g.hero.rect(9.5, 9.5, 5, 5)


@px16('ref-point')
def _(g):
    g.sub.circ(8, 8, 5.5)
    g.hero.rect(7, 1, 2, 4)
    g.hero.rect(7, 11, 2, 4)
    g.hero.rect(1, 7, 4, 2)
    g.hero.rect(11, 7, 4, 2)
    g.hero.rect(6, 6, 4, 4)


@master('ref-plane')
def _(g):
    # elevation-style datum: thin plane edge, the 40 % side it faces, a pick marker
    g.sub.rect(2, 2, 20, 8)
    g.hero.rect(2, 11.5, 20, 2)
    g.hero.poly([(12, 15), (16.5, 21), (7.5, 21)])


@px16('ref-plane')
def _(g):
    g.sub.rect(1, 1, 14, 5)
    g.hero.rect(1, 7, 14, 2)
    g.hero.poly([(8, 10), (11, 14), (5, 14)])


@master('grid')
def _(g):
    g.sub.rect(2, 16, 20, 2)
    g.sub.rect(17, 9, 2, 13)
    g.hero.ring(8, 6.5, 4.5, 2)
    g.hero.rect(7, 11, 2, 11)


@px16('grid')
def _(g):
    g.sub.rect(1, 11, 14, 2)
    g.sub.rect(11, 6, 2, 9)
    g.hero.ring(5, 4.5, 3, 2)
    g.hero.rect(4, 8.5, 2, 6.5)


@master('level')
def _(g):
    g.sub.rect(2, 3, 20, 2)
    g.sub.rect(2, 19, 20, 2)
    g.hero.rect(2, 13, 20, 2.5)
    g.hero.poly([(13, 7), (21, 7), (17, 13)])


@px16('level')
def _(g):
    g.sub.rect(1, 1, 14, 2)
    g.sub.rect(1, 13, 14, 2)
    g.hero.rect(1, 9, 14, 2)
    g.hero.poly([(9, 4), (15, 4), (12, 8)])


@master('construction-line')
def _(g):
    # an endless line through two picks (40 %)
    g.sub.rect(3, 14, 7, 7)
    g.sub.rect(14, 3, 7, 7)
    g.hero.line([(0, 24), (24, 0)], 2.5)


@px16('construction-line')
def _(g):
    g.sub.rect(2, 9, 5, 5)
    g.sub.rect(9, 2, 5, 5)
    g.hero.poly([(0, 14.5), (14.5, 0), (16, 0), (16, 1.5), (1.5, 16), (0, 16)])


@master('section-cut')
def _(g):
    g.sub.rect(11, 9, 2, 6)
    g.hero.rect(10.5, 2, 3, 6)
    g.hero.rect(10.5, 16, 3, 6)
    g.hero.poly([(13.5, 2), (20, 5), (13.5, 8)])
    g.hero.poly([(13.5, 16), (20, 19), (13.5, 22)])


@px16('section-cut')
def _(g):
    g.sub.rect(7, 6, 2, 4)
    g.hero.rect(6, 1, 2, 4)
    g.hero.rect(6, 11, 2, 4)
    g.hero.poly([(8, 1), (13, 3), (8, 5)])
    g.hero.poly([(8, 11), (13, 13), (8, 15)])


@master('space')
def _(g):
    g.sub.path('M2 2H22V22H2ZM4.5 4.5V19.5H19.5V4.5Z')
    g.hero.poly([(7, 7), (17, 7), (17, 17), (12, 17), (12, 12), (7, 12)])


@px16('space')
def _(g):
    g.sub.path('M1 1H15V15H1ZM3 3V13H13V3Z')
    g.hero.poly([(5, 5), (11, 5), (11, 11), (8, 11), (8, 8), (5, 8)])


@master('detect-rooms')
def _(g):
    g.sub.path('M2 2H22V22H2ZM4.5 4.5V19.5H11V4.5ZM13 4.5V19.5H19.5V4.5Z')
    g.hero.rect(6, 7, 3.5, 10)
    g.hero.rect(14.5, 7, 3.5, 10)


@px16('detect-rooms')
def _(g):
    g.sub.path('M1 1H15V15H1ZM3 3V13H7V3ZM9 3V13H13V3Z')
    g.hero.rect(4, 5, 2, 6)
    g.hero.rect(10, 5, 2, 6)


# ======================= site =======================
@master('fence')
def _(g):
    g.sub.rect(2, 20, 20, 2)
    for x in (3, 10.5, 18):
        g.hero.rect(x, 3, 3, 15.5)
    g.hero.rect(2, 6.5, 20, 2.5)
    g.hero.rect(2, 12.5, 20, 2.5)


@px16('fence')
def _(g):
    g.sub.rect(1, 13, 14, 2)
    for x in (2, 7, 12):
        g.hero.rect(x, 2, 2, 10)
    g.hero.rect(1, 4, 14, 2)
    g.hero.rect(1, 8, 14, 2)


@master('gate')
def _(g):
    g.sub.rect(2, 3, 3, 19)
    g.sub.rect(19, 3, 3, 19)
    g.hero.rect(6.5, 6, 11, 14)
    g.holes.rect(9.5, 9, 2, 8)
    g.holes.rect(12.5, 9, 2, 8)


@px16('gate')
def _(g):
    g.sub.rect(1, 2, 2, 13)
    g.sub.rect(13, 2, 2, 13)
    g.hero.rect(4, 4, 8, 10)
    g.holes.rect(6, 6, 1, 6)
    g.holes.rect(9, 6, 1, 6)


@master('site-surface')
def _(g):
    # paving in running bond on the plot (40 %)
    g.sub.rect(2, 2, 20, 20)
    g.hero.rect(5, 6, 14, 12)
    g.holes.rect(5, 11, 14, 2)
    g.holes.rect(11, 6, 2, 5)
    g.holes.rect(7.5, 13, 2, 5)
    g.holes.rect(14.5, 13, 2, 5)


@px16('site-surface')
def _(g):
    g.sub.rect(1, 1, 14, 14)
    g.hero.rect(3, 4, 10, 8)
    g.holes.rect(3, 7, 10, 1)
    g.holes.rect(8, 4, 1, 3)
    g.holes.rect(5, 8, 1, 4)
    g.holes.rect(10, 8, 1, 4)


@master('terrain')
def _(g):
    # ground in section: near ridge solid, far ridge 40 %
    g.sub.poly([(2, 12), (8, 5), (13, 9), (18, 3.5), (22, 8), (22, 22), (2, 22)])
    g.hero.poly([(2, 22), (2, 16), (7, 11.5), (12, 15.5), (17, 9.5), (22, 13.5), (22, 22)])


@px16('terrain')
def _(g):
    g.sub.poly([(1, 8), (5, 3), (9, 6), (12, 2), (15, 5), (15, 15), (1, 15)])
    g.hero.poly([(1, 15), (1, 11), (5, 8), (8, 10), (11, 6), (15, 9), (15, 15)])


# ======================= annotate / misc =======================
@master('dimension')
def _(g):
    g.sub.rect(4, 14, 16, 8)
    g.hero.rect(2, 7, 20, 2)
    g.hero.rect(3, 3, 2, 9)
    g.hero.rect(19, 3, 2, 9)
    g.hero.line([(2.5, 11.5), (7.5, 4.5)], 2)
    g.hero.line([(16.5, 11.5), (21.5, 4.5)], 2)


@px16('dimension')
def _(g):
    g.sub.rect(3, 10, 10, 5)
    g.hero.rect(1, 4, 14, 2)
    g.hero.rect(1, 1, 2, 7)
    g.hero.rect(13, 1, 2, 7)
    g.hero.poly([(3, 7), (6, 3), (7, 3), (7, 4), (4, 8), (3, 8)])
    g.hero.poly([(9, 7), (12, 3), (13, 3), (13, 4), (10, 8), (9, 8)])


@master('text-note')
def _(g):
    g.hero.rect(2, 3, 14, 3)
    g.hero.rect(7.5, 6, 3, 15)
    g.sub.rect(14, 11, 8, 2.5)
    g.sub.rect(14, 15.5, 8, 2.5)
    g.sub.rect(14, 20, 8, 2)


@px16('text-note')
def _(g):
    g.hero.rect(1, 1, 10, 2)
    g.hero.rect(5, 3, 2, 12)
    g.sub.rect(9, 6, 6, 2)
    g.sub.rect(9, 9.5, 6, 2)
    g.sub.rect(9, 13, 6, 2)


@master('component')
def _(g):
    # a module with connection tabs, docked against a 40 % neighbour
    g.hero.rect(2, 8, 12, 12)
    g.hero.rect(6, 4, 4, 4)
    g.hero.rect(14, 12, 4, 4)
    g.sub.rect(19, 8, 3, 12)
    g.sub.rect(11, 2, 11, 4)


@px16('component')
def _(g):
    g.hero.rect(1, 6, 8, 8)
    g.hero.rect(3, 3, 4, 3)
    g.hero.rect(9, 8, 3, 4)
    g.sub.rect(13, 6, 2, 8)
    g.sub.rect(8, 1, 7, 3)


@master('genus-editor')
def _(g):
    g.sub.rect(2, 7, 15, 15)
    g.hero.poly([(17, 2), (22, 7), (11, 18), (5.5, 18.5), (6, 13)])
    g.holes.line([(15, 4), (20, 9)], 1.2)


@px16('genus-editor')
def _(g):
    g.sub.rect(1, 5, 9, 10)
    g.hero.poly([(11, 1), (15, 5), (7, 13), (3, 13), (3, 9)])
    g.holes.poly([(10, 3), (11, 2), (14, 5), (13, 6)])


@master('view-3d')
def _(g):
    g.sub.poly([(12, 2), (21, 6.5), (12, 11), (3, 6.5)])
    g.hero.poly([(3, 7.5), (11.5, 11.75), (11.5, 22), (3, 17.5)])
    g.hero.poly([(21, 7.5), (12.5, 11.75), (12.5, 22), (21, 17.5)])


@px16('view-3d')
def _(g):
    g.sub.poly([(8, 1), (14, 4), (8, 7), (2, 4)])
    g.hero.poly([(1, 5), (7.5, 8.25), (7.5, 15), (1, 11.75)])
    g.hero.poly([(15, 5), (8.5, 8.25), (8.5, 15), (15, 11.75)])


@master('view-plan')
def _(g):
    g.sub.rect(5, 5, 14, 14)
    g.hero.path('M2 2H22V22H14V19.5H19.5V4.5H4.5V19.5H10V22H2Z')


@px16('view-plan')
def _(g):
    g.sub.rect(4, 4, 8, 8)
    g.hero.path('M1 1H15V15H10V13H13V3H3V13H6V15H1Z')


@master('view-fit')
def _(g):
    g.sub.rect(8, 8, 8, 8)
    corners(g, 2, 2, 22, 22, 6, 2.5)


@px16('view-fit')
def _(g):
    g.sub.rect(5, 5, 6, 6)
    corners(g, 1, 1, 15, 15, 4, 2)


@master('thin-lines')
def _(g):
    g.sub.rect(2, 3, 20, 5)
    g.hero.rect(2, 12, 20, 1)
    g.hero.rect(2, 16, 20, 1)
    g.hero.rect(2, 20, 20, 1)


@px16('thin-lines')
def _(g):
    g.sub.rect(1, 1, 14, 4)
    g.hero.rect(1, 8, 14, 1)
    g.hero.rect(1, 11, 14, 1)
    g.hero.rect(1, 14, 14, 1)


# ======================= future =======================
@master('railing')
def _(g):
    g.sub.rect(2, 19.5, 20, 2.5)
    g.hero.rect(2, 3, 20, 3)
    g.hero.rect(2, 6, 3, 12)
    g.hero.rect(19, 6, 3, 12)
    g.hero.rect(8.5, 6, 2, 12)
    g.hero.rect(13.5, 6, 2, 12)


@px16('railing')
def _(g):
    g.sub.rect(1, 13, 14, 2)
    g.hero.rect(1, 2, 14, 2)
    g.hero.rect(1, 4, 2, 8)
    g.hero.rect(13, 4, 2, 8)
    g.hero.rect(6, 4, 1, 8)
    g.hero.rect(9, 4, 1, 8)


@master('ceiling')
def _(g):
    g.sub.rect(2, 20, 20, 2)
    g.sub.rect(2, 12, 2.5, 8)
    g.sub.rect(19.5, 12, 2.5, 8)
    g.hero.rect(2, 2, 20, 2.5)
    g.hero.rect(6, 4.5, 2, 3)
    g.hero.rect(16, 4.5, 2, 3)
    g.hero.rect(4, 7.5, 16, 2.5)


@px16('ceiling')
def _(g):
    g.sub.rect(1, 14, 14, 1)
    g.sub.rect(1, 9, 2, 6)
    g.sub.rect(13, 9, 2, 6)
    g.hero.rect(1, 1, 14, 2)
    g.hero.rect(4, 3, 2, 2)
    g.hero.rect(10, 3, 2, 2)
    g.hero.rect(3, 5, 10, 2)


@master('curtain-wall')
def _(g):
    g.sub.rect(4, 4, 16, 16)
    g.hero.path('M2 2H22V22H2ZM4.5 4.5V10.75H10.75V4.5ZM13.25 4.5V10.75H19.5V4.5ZM4.5 13.25V19.5H10.75V13.25ZM13.25 13.25V19.5H19.5V13.25Z')


@px16('curtain-wall')
def _(g):
    g.sub.rect(3, 3, 10, 10)
    g.hero.path('M1 1H15V15H1ZM3 3V7H7V3ZM9 3V7H13V3ZM3 9V13H7V9ZM9 9V13H13V9Z')


@master('foundation')
def _(g):
    g.sub.rect(9, 2, 6, 9.5)
    g.sub.rect(2, 20.5, 20, 1.5)
    g.hero.poly([(8, 13), (16, 13), (16, 15), (21, 15), (21, 19), (3, 19), (3, 15), (8, 15)])


@px16('foundation')
def _(g):
    g.sub.rect(6, 1, 4, 6)
    g.sub.rect(1, 14, 14, 1)
    g.hero.poly([(5, 8), (11, 8), (11, 9), (14, 9), (14, 13), (2, 13), (2, 9), (5, 9)])


@master('wall-opening')
def _(g):
    g.hero.rect(2, 9, 7, 6)
    g.hero.rect(15, 9, 7, 6)
    g.sub.rect(10.5, 9, 3, 6)
    g.hero.rect(8, 4, 8, 2)
    g.hero.rect(8, 18, 8, 2)


@px16('wall-opening')
def _(g):
    g.hero.rect(1, 6, 4, 4)
    g.hero.rect(11, 6, 4, 4)
    g.sub.rect(7, 6, 2, 4)
    g.hero.rect(5, 2, 6, 2)
    g.hero.rect(5, 12, 6, 2)


# ======================= genus editor ribbon =======================
# ids are prefixed "ge:" in the registry; meta.GENUS_ALIAS lists the ones that reuse main glyphs.

def oblique(g, featured, d=6):
    """Oblique box: front square, top and side parallelograms. `featured` face(s) are hero."""
    if g.px == 16:
        faces = dict(front=('rect', (1, 6, 9, 9)),
                     top=('poly', [(1, 5), (5, 1), (14, 1), (10, 5)]),
                     side=('poly', [(11, 6), (15, 2), (15, 11), (11, 15)]))
    else:
        faces = dict(front=('rect', (2, 9, 13, 13)),
                     top=('poly', [(2, 8), (8, 2), (21, 2), (15, 8)]),
                     side=('poly', [(16, 9), (22, 3), (22, 16), (16, 22)]))
    for name, (kind, args) in faces.items():
        layer = g.hero if (featured == 'all' or name == featured) else g.sub
        if kind == 'rect':
            layer.rect(*args)
        else:
            layer.poly(args)


@master('ge:line')
def _(g):
    g.sub.rect(2, 17, 20, 3)
    g.hero.rect(2, 6, 6, 6)
    g.hero.rect(16, 6, 6, 6)
    g.hero.rect(8, 7.75, 8, 2.5)


@px16('ge:line')
def _(g):
    g.sub.rect(1, 12, 14, 2)
    g.hero.rect(1, 4, 4, 4)
    g.hero.rect(11, 4, 4, 4)
    g.hero.rect(5, 5, 6, 2)


@master('ge:polyline')
def _(g):
    g.hero.line([(4.5, 19.5), (9, 7), (15, 15), (19.5, 4.5)], 2.5)
    g.hero.rect(2, 17, 5, 5)
    g.hero.rect(17, 2, 5, 5)
    g.sub.rect(2, 2, 7, 3)
    g.sub.rect(15, 19, 7, 3)


@px16('ge:polyline')
def _(g):
    g.hero.line([(3, 13), (6, 5), (10, 11), (13, 3)], 2)
    g.hero.rect(1, 11, 4, 4)
    g.hero.rect(11, 1, 4, 4)
    g.sub.rect(1, 1, 4, 2)
    g.sub.rect(11, 13, 4, 2)


@master('ge:extrude')
def _(g):
    g.sub.rect(3, 19, 18, 3)
    g.hero.rect(6, 10, 12, 7.5)
    g.hero.rect(10.75, 6, 2.5, 4)
    g.hero.poly([(12, 1.5), (16.5, 7), (7.5, 7)])


@px16('ge:extrude')
def _(g):
    g.sub.rect(2, 13, 12, 2)
    g.hero.rect(4, 7, 8, 5)
    g.hero.rect(7, 4, 2, 3)
    g.hero.poly([(8, 1), (11, 4.5), (5, 4.5)])


@master('ge:sweep')
def _(g):
    g.hero.path('M3 22V14C3 7.5 7.5 3 14 3H22V7H14C10 7 7 10 7 14V22Z')
    g.sub.rect(14, 10, 8, 8)


@px16('ge:sweep')
def _(g):
    g.hero.path('M1 15V9C1 4.5 4.5 1 9 1H15V4H9C6.5 4 4 6.5 4 9V15Z')
    g.sub.rect(9, 7, 6, 6)


@master('ge:revolve')
def _(g):
    # turn arrow around a 40 % axis
    g.sub.rect(11, 1, 2, 22)
    g.hero.arc(12, 12, 7, -150, 150, 2.5)
    g.hero.poly([(4.2, 12.4), (8.6, 14), (3.3, 17)])


@px16('ge:revolve')
def _(g):
    g.sub.rect(7, 1, 2, 14)
    g.hero.arc(8, 8, 5, -150, 150, 2)
    g.hero.poly([(2.4, 8.2), (5.5, 9.6), (1.8, 11.6)])


@master('ge:box')
def _(g):
    oblique(g, 'all')


@px16('ge:box')
def _(g):
    oblique(g, 'all')


@master('ge:front')
def _(g):
    oblique(g, 'front')


@px16('ge:front')
def _(g):
    oblique(g, 'front')


@master('ge:side')
def _(g):
    oblique(g, 'side')


@px16('ge:side')
def _(g):
    oblique(g, 'side')


@master('ge:cut')
def _(g):
    # a void frame biting into a 40 % solid
    g.sub.rect(2, 7, 15, 15)
    g.subholes.rect(12.5, 4.5, 7, 7)
    g.hero.path('M10 2H22V14H10ZM12.5 4.5V11.5H19.5V4.5Z')


@px16('ge:cut')
def _(g):
    g.sub.rect(1, 5, 10, 10)
    g.subholes.rect(9, 3, 4, 4)
    g.hero.path('M7 1H15V9H7ZM9 3V7H13V3Z')


@master('ge:nest')
def _(g):
    g.sub.rect(2, 2, 20, 20)
    g.hero.rect(11, 11, 8, 8)


@px16('ge:nest')
def _(g):
    g.sub.rect(1, 1, 14, 14)
    g.hero.rect(7, 7, 6, 6)


@master('ge:mirror')
def _(g):
    g.sub.poly([(10, 4), (10, 20), (2, 20)])
    g.hero.poly([(14, 4), (14, 20), (22, 20)])
    g.sub.rect(11.25, 2, 1.5, 3)
    g.sub.rect(11.25, 19, 1.5, 3)


@px16('ge:mirror')
def _(g):
    g.sub.poly([(7, 2), (7, 14), (1, 14)])
    g.hero.poly([(9, 2), (9, 14), (15, 14)])


@master('ge:host')
def _(g):
    g.sub.rect(2, 4, 20, 16)
    g.hero.rect(8, 7, 8, 10)
    g.holes.rect(11, 9.5, 2, 7.5)


@px16('ge:host')
def _(g):
    g.sub.rect(1, 2, 14, 12)
    g.hero.rect(5, 4, 6, 8)
    g.holes.rect(7, 6, 2, 6)


@master('ge:refs')
def _(g):
    g.sub.rect(5, 5, 14, 14)
    g.hero.rect(2, 8, 20, 2.5)
    g.hero.rect(13.5, 2, 2.5, 20)


@px16('ge:refs')
def _(g):
    g.sub.rect(3, 3, 10, 10)
    g.hero.rect(1, 5, 14, 2)
    g.hero.rect(9, 1, 2, 14)


@master('ge:layout-all')
def _(g):
    g.hero.rect(2, 2, 9, 9)
    g.sub.rect(13, 2, 9, 9)
    g.sub.rect(2, 13, 9, 9)
    g.sub.rect(13, 13, 9, 9)


@px16('ge:layout-all')
def _(g):
    g.hero.rect(1, 1, 6, 6)
    g.sub.rect(9, 1, 6, 6)
    g.sub.rect(1, 9, 6, 6)
    g.sub.rect(9, 9, 6, 6)


@master('ge:place')
def _(g):
    g.sub.rect(2, 18, 20, 4)
    g.hero.rect(7, 9.5, 10, 7)
    g.hero.poly([(8, 2), (16, 2), (12, 7)])


@px16('ge:place')
def _(g):
    g.sub.rect(1, 12, 14, 3)
    g.hero.rect(4, 6, 8, 5)
    g.hero.poly([(5, 1), (11, 1), (8, 4)])


@master('ge:material')
def _(g):
    g.hero.rect(3, 3, 18, 18)
    for k in (-6, 0, 6, 12):
        g.holes.line([(3 + k, 21), (21 + k, 3)], 2)


@px16('ge:material')
def _(g):
    g.hero.rect(2, 2, 12, 12)
    for k in (-4, 0, 4, 8):
        g.holes.poly([(2 + k, 14), (14 + k, 2), (15.5 + k, 2), (3.5 + k, 14)])


# ---------- concept-neutral UI actions ----------
@master('ge:delete')
def _(g):
    g.hero.rect(3, 4.5, 18, 2.5)
    g.hero.rect(9, 2, 6, 2.5)
    g.hero.poly([(5, 8.5), (19, 8.5), (17.5, 22), (6.5, 22)])
    g.holes.rect(9, 11.5, 2, 7.5)
    g.holes.rect(13, 11.5, 2, 7.5)


@px16('ge:delete')
def _(g):
    g.hero.rect(1, 3, 14, 2)
    g.hero.rect(6, 1, 4, 2)
    g.hero.poly([(3, 6), (13, 6), (12, 15), (4, 15)])
    g.holes.rect(6, 8, 1, 5)
    g.holes.rect(9, 8, 1, 5)


@master('ge:visibility')
def _(g):
    # outline almond (counter cut by winding) + solid pupil + 40 % iris
    g.hero.path('M1 12C4 6 8 4 12 4S20 6 23 12C20 18 16 20 12 20S4 18 1 12Z'
                'M4.4 12C6.7 16 9.3 17.4 12 17.4S17.3 16 19.6 12C17.3 8 14.7 6.6 12 6.6S6.7 8 4.4 12Z')
    g.hero.circ(12, 12, 3)
    g.sub.circ(12, 12, 6)


@px16('ge:visibility')
def _(g):
    g.hero.path('M0.5 8C2.5 4 5.5 2.5 8 2.5S13.5 4 15.5 8C13.5 12 10.5 13.5 8 13.5S2.5 12 0.5 8Z'
                'M2.9 8C4.5 10.6 6.2 11.5 8 11.5S11.5 10.6 13.1 8C11.5 5.4 9.8 4.5 8 4.5S4.5 5.4 2.9 8Z')
    g.hero.circ(8, 8, 2.5)


@master('ge:formula')
def _(g):
    g.hero.poly([(10, 6), (13, 2.5), (20, 2.5), (19.4, 5.5), (13.6, 5.5), (13, 6)])
    g.hero.poly([(6, 21.5), (9, 21.5), (13, 5.5), (10, 5.5)])
    g.hero.rect(5, 9, 10, 2.5)
    g.sub.line([(14, 14), (21, 21)], 2.5)
    g.sub.line([(21, 14), (14, 21)], 2.5)


@px16('ge:formula')
def _(g):
    g.hero.poly([(6, 4), (8, 1), (13, 1), (12.5, 3), (8.5, 3), (8, 4)])
    g.hero.poly([(3, 15), (5, 15), (8, 3), (6, 3)])
    g.hero.rect(3, 6, 6, 2)
    g.sub.poly([(10, 9), (11, 9), (15, 13), (15, 15), (14, 15), (10, 11)])
    g.sub.poly([(15, 9), (15, 11), (11, 15), (10, 15), (10, 14), (14, 9)])


@master('ge:params')
def _(g):
    for y in (4, 11, 18):
        g.sub.rect(2, y, 20, 2)
    g.hero.rect(13, 2, 4, 6)
    g.hero.rect(5, 9, 4, 6)
    g.hero.rect(15, 16, 4, 6)


@px16('ge:params')
def _(g):
    for y in (2, 7, 12):
        g.sub.rect(1, y, 14, 2)
    g.hero.rect(9, 1, 3, 4)
    g.hero.rect(3, 6, 3, 4)
    g.hero.rect(10, 11, 3, 4)


@master('ge:add-param')
def _(g):
    g.sub.rect(2, 4, 20, 2)
    g.sub.rect(2, 11, 9, 2)
    g.hero.rect(13, 2, 4, 6)
    g.hero.rect(15.5, 11, 3, 11)
    g.hero.rect(11.5, 15, 11, 3)


@px16('ge:add-param')
def _(g):
    g.sub.rect(1, 2, 14, 2)
    g.sub.rect(1, 7, 7, 2)
    g.hero.rect(9, 1, 3, 4)
    g.hero.rect(11, 8, 2, 7)
    g.hero.rect(9, 10, 6, 2)


@master('ge:export')
def _(g):
    g.sub.path('M2 13H5V19H19V13H22V22H2Z')
    g.hero.rect(10.75, 8, 2.5, 9)
    g.hero.poly([(12, 2), (18, 9), (6, 9)])


@px16('ge:export')
def _(g):
    g.sub.path('M1 9H3V13H13V9H15V15H1Z')
    g.hero.rect(7, 5, 2, 6)
    g.hero.poly([(8, 1), (12, 6), (4, 6)])


@master('ge:import')
def _(g):
    g.sub.path('M2 13H5V19H19V13H22V22H2Z')
    g.hero.rect(10.75, 2, 2.5, 9)
    g.hero.poly([(12, 17), (18, 10), (6, 10)])


@px16('ge:import')
def _(g):
    g.sub.path('M1 9H3V13H13V9H15V15H1Z')
    g.hero.rect(7, 1, 2, 6)
    g.hero.poly([(8, 11), (12, 6), (4, 6)])


@master('ge:save')
def _(g):
    g.sub.rect(2, 2, 20, 20)
    g.hero.poly([(5, 12), (8, 9), (11, 12), (17, 5), (20, 8), (11, 18)])


@px16('ge:save')
def _(g):
    g.sub.rect(1, 1, 14, 14)
    g.hero.poly([(3, 8), (5, 6), (7, 8), (11, 3), (13, 5), (7, 12)])


@master('ge:exit')
def _(g):
    g.sub.path('M9 2H22V22H9V18H19V6H9Z')
    g.hero.rect(7, 10.75, 9, 2.5)
    g.hero.poly([(2, 12), (9, 6), (9, 18)])


@px16('ge:exit')
def _(g):
    g.sub.path('M6 1H15V15H6V12H13V4H6Z')
    g.hero.rect(5, 7, 6, 2)
    g.hero.poly([(1, 8), (6, 4), (6, 12)])


@master('ge:structure')
def _(g):
    g.hero.rect(2, 2, 8, 5)
    g.hero.rect(4.5, 7, 2.5, 13)
    g.hero.rect(7, 10.75, 4, 2.5)
    g.hero.rect(7, 17.5, 4, 2.5)
    g.sub.rect(12.5, 9, 9.5, 6)
    g.sub.rect(12.5, 16, 9.5, 6)


@px16('ge:structure')
def _(g):
    g.hero.rect(1, 1, 6, 3)
    g.hero.rect(2, 4, 2, 10)
    g.hero.rect(4, 7, 3, 2)
    g.hero.rect(4, 12, 3, 2)
    g.sub.rect(8, 5, 7, 5)
    g.sub.rect(8, 11, 7, 4)


@master('ge:library')
def _(g):
    g.hero.rect(2, 4, 4, 18)
    g.hero.rect(7.5, 2, 4, 20)
    g.sub.poly([(13, 6), (17, 5), (21.5, 21), (17.5, 22)])


@px16('ge:library')
def _(g):
    g.hero.rect(1, 3, 3, 12)
    g.hero.rect(5, 1, 3, 14)
    g.sub.poly([(9, 4), (12, 3), (15, 14), (12, 15)])


@master('ge:test')
def _(g):
    g.sub.rect(2, 2, 13, 20)
    g.hero.poly([(9, 6), (22, 12), (9, 18)])


@px16('ge:test')
def _(g):
    g.sub.rect(1, 1, 8, 14)
    g.hero.poly([(6, 4), (15, 8), (6, 12)])


@master('ge:label')
def _(g):
    g.sub.rect(2, 18, 20, 2.5)
    g.hero.poly([(2, 4), (16, 4), (21.5, 9.5), (16, 15), (2, 15)])
    g.holes.rect(5, 8.5, 7, 2)


@px16('ge:label')
def _(g):
    g.sub.rect(1, 13, 14, 2)
    g.hero.poly([(1, 2), (11, 2), (15, 6), (11, 10), (1, 10)])
    g.holes.rect(3, 5, 5, 2)


@master('ge:species')
def _(g):
    # genus bar (40 %) with one active species card (solid) beside a sibling (40 %)
    g.sub.rect(2, 2, 20, 6)
    g.hero.rect(2, 10, 9, 12)
    g.sub.rect(13, 10, 9, 12)


@px16('ge:species')
def _(g):
    g.sub.rect(1, 1, 14, 4)
    g.hero.rect(1, 7, 6, 8)
    g.sub.rect(9, 7, 6, 8)


@master('ge:add-species')
def _(g):
    g.sub.rect(2, 2, 20, 6)
    g.sub.rect(2, 10, 9, 12)
    g.hero.rect(15.5, 10, 3, 12)
    g.hero.rect(12, 14.5, 10, 3)


@px16('ge:add-species')
def _(g):
    g.sub.rect(1, 1, 14, 4)
    g.sub.rect(1, 7, 6, 8)
    g.hero.rect(10, 7, 2, 8)
    g.hero.rect(8, 10, 6, 2)
