/**
 * Genus editor: sketch mode and solids. A sketch is drawn in one ortho view
 * (lines, arcs, rectangles, circles), checked for closed loops, and turns
 * into an extrude / revolve / sweep body item; a box is two clicks. Clicks
 * snap to sketch vertices and lock to references (`ref.<id>` formulas).
 * State lives here; the pure rules are in sketch.ts.
 */
import { useCallback, useMemo, useState } from 'react';
import type { GenusDefDto, GenusSketchItemDto, GenusVec2 } from '../types';
import type { ViewHit, ViewInteract, ViewOverlay } from './GenusOrthoView';
import type { GenusDraft } from './model';
import type { OrthoView, P2 } from './projection';
import { formulaString, nextId, takenIds, type EvalRef } from './refs';
import {
  axisRefs,
  bulgeThrough,
  isShapeItem,
  newBox,
  newSketchShape,
  pathRefs,
  planeToView,
  setVoid,
  sketchLoops,
  sketchOf,
  sketchPaths,
  sketchVertices,
  sketchView,
  asCut,
  nearestRef,
  snapPoint,
  solidKind,
  viewNormal,
  viewToPlane,
  withSketch,
  type ShapeItem,
  type SketchIssue,
  type SketchTool,
  type SolidKind,
} from './sketch';

/** Why sketch mode did nothing (catalog key genusEditor.sketch.note.<code>). */
export type SketchNote = 'otherView' | 'noAxis' | 'noPath' | null;

interface Session {
  kind: SolidKind;
  /** Started from the Cut tool: the result cuts the host. */
  cut: boolean;
  /** Body item whose sketch is being edited; null = a new item. */
  editing: string | null;
  view: OrthoView | null;
  items: GenusSketchItemDto[];
  tool: SketchTool;
  pending: { q: GenusVec2; at: P2 }[];
}

interface Args {
  draft: GenusDraft | null;
  parent: GenusDefDto | null;
  /** Formula values incl. `ref.*` names. */
  values: Record<string, unknown>;
  refs: EvalRef[];
  patch: (fn: (d: GenusDraft) => GenusDraft) => void;
  setSelected: (id: string | null) => void;
  enabled: boolean;
}

const samePt = (a: GenusVec2, b: GenusVec2) => formulaString(a[0]) === formulaString(b[0]) && formulaString(a[1]) === formulaString(b[1]);

export function useSketchTools(a: Args) {
  const { draft, parent, values, refs, patch, setSelected, enabled } = a;
  const [session, setSession] = useState<Session | null>(null);
  const [hover, setHover] = useState<{ view: OrthoView; q: GenusVec2; at: P2; locks: string[] } | null>(null);
  const [note, setNote] = useState<SketchNote>(null);
  const [tried, setTried] = useState(false);

  const check = useMemo(() => (session ? sketchLoops(session.items, values) : null), [session, values]);
  const issue: SketchIssue | null = check && !check.ok ? check.issue : null;

  const start = useCallback((kind: SolidKind, cut = false) => {
    setSession((cur) =>
      cur && cur.kind === kind && cur.cut === cut && !cur.editing
        ? null
        : { kind, cut, editing: null, view: null, items: [], tool: kind === 'box' ? 'rect' : 'line', pending: [] },
    );
    setNote(null);
    setTried(false);
    setHover(null);
  }, []);

  /** Re-enter the sketch of an authored item. */
  const edit = (item: ShapeItem) => {
    const kind = solidKind(item);
    const sketch = sketchOf(item);
    if (!kind || kind === 'box' || !sketch) return;
    setSession({ kind, cut: false, editing: item.id, view: sketchView(item), items: sketch, tool: 'line', pending: [] });
    setNote(null);
    setTried(false);
  };

  const setTool = (tool: SketchTool) => setSession((s) => (s ? { ...s, tool, pending: [] } : s));

  const cancel = (): boolean => {
    if (!session) return false;
    if (session.pending.length) setSession({ ...session, pending: [] });
    else setSession(null);
    setHover(null);
    return true;
  };

  /** Leave sketch mode without changes. */
  const close = () => {
    setSession(null);
    setHover(null);
    setNote(null);
  };

  const undo = () => setSession((s) => (s ? (s.pending.length ? { ...s, pending: [] } : { ...s, items: s.items.slice(0, -1) }) : s));

  const vertices = useMemo(() => (session ? sketchVertices(session.items, values) : []), [session, values]);

  const snapAt = (view: OrthoView, p: P2, k: number) => {
    const normal = viewNormal(view);
    const q = viewToPlane(view, p);
    // Only a line chain closes on its own pending points; a circle's radius or a
    // rectangle's far corner snapping onto the first click would be zero-size.
    const pend = session?.tool === 'line' ? session.pending : [];
    return snapPoint(normal, q, { vertices: [...vertices, ...pend].map((v) => ({ q: v.q, at: v.at })), refs }, 8 * k);
  };

  const commitBox = (view: OrthoView, p0: GenusVec2, p1: GenusVec2) => {
    if (!draft) return;
    const cut = Boolean(session?.cut);
    const id = nextId(cut ? 'cut' : 'box', takenIds(draft, parent));
    const box = newBox(id, view, p0, p1);
    patch((d) => ({ ...d, body: [...d.body, cut ? asCut(box, view) : box] }));
    setSession(null);
    setHover(null);
    setSelected(id);
  };

  const place = (view: OrthoView, _hit: ViewHit, p: P2, k: number) => {
    if (!session) return;
    if (session.view && session.view !== view) {
      setNote('otherView');
      return;
    }
    setNote(null);
    const pt = snapAt(view, p, k);
    const s: Session = { ...session, view };
    const pend = s.pending;
    const add = (item: GenusSketchItemDto, keep: { q: GenusVec2; at: P2 }[] = []) => setSession({ ...s, items: [...s.items, item], pending: keep });
    if (s.kind === 'box') {
      if (!pend.length) setSession({ ...s, pending: [pt] });
      else if (!samePt(pend[0].q, pt.q)) commitBox(view, pend[0].q, pt.q);
      return;
    }
    if (s.tool === 'line') {
      if (!pend.length) {
        setSession({ ...s, pending: [pt] });
        return;
      }
      const last = pend[pend.length - 1];
      if (samePt(last.q, pt.q)) return;
      // Closing on an existing vertex ends the chain.
      const closes = vertices.some((v) => samePt(v.q, pt.q)) || samePt(pend[0].q, pt.q);
      add({ kind: 'line', a: last.q, b: pt.q }, closes ? [] : [pt]);
      return;
    }
    if (s.tool === 'rect') {
      if (!pend.length) setSession({ ...s, pending: [pt] });
      else if (!samePt(pend[0].q, pt.q)) add({ kind: 'rect', a: pend[0].q, b: pt.q });
      return;
    }
    if (s.tool === 'circle') {
      if (!pend.length) setSession({ ...s, pending: [pt] });
      else {
        const r = Math.round(Math.hypot(pt.at[0] - pend[0].at[0], pt.at[1] - pend[0].at[1]) * 200) / 200;
        if (r > 0) add({ kind: 'circle', c: pend[0].q, r });
      }
      return;
    }
    // Arc: start, end, then a point it passes through.
    if (pend.length < 2) {
      if (pend.length === 1 && samePt(pend[0].q, pt.q)) return;
      setSession({ ...s, pending: [...pend, pt] });
      return;
    }
    const bulge = bulgeThrough(pend[0].at, viewToPlane(view, p), pend[1].at);
    if (bulge === 0) add({ kind: 'line', a: pend[0].q, b: pend[1].q });
    else add({ kind: 'arc', a: pend[0].q, b: pend[1].q, bulge });
  };

  /** Close the sketch into a body item (or update the edited one). */
  const finish = (): boolean => {
    if (!session || !draft) return false;
    setTried(true);
    if (session.kind === 'box') return false;
    if (session.pending.length && session.tool === 'line') {
      setSession({ ...session, pending: [] });
      return false;
    }
    if (!check?.ok || !session.view) return false;
    const view = session.view;
    if (session.editing) {
      const id = session.editing;
      patch((d) => ({ ...d, body: d.body.map((b) => (b.id === id && isShapeItem(b) ? withSketch(b, session.items) : b)) }));
      setSession(null);
      setSelected(id);
      return true;
    }
    let ref: string | undefined;
    if (session.kind === 'revolve') {
      ref = nearestRef(viewNormal(view), check.loops[0], axisRefs(viewNormal(view), refs), 'axis');
      if (!ref) {
        setNote('noAxis');
        return false;
      }
    }
    if (session.kind === 'sweep') {
      ref = nearestRef(viewNormal(view), check.loops[0], pathRefs(refs), 'start');
      if (!ref) {
        setNote('noPath');
        return false;
      }
    }
    const id = nextId(session.cut ? 'cut' : session.kind, takenIds(draft, parent));
    const shape = newSketchShape(id, session.kind as Exclude<SolidKind, 'box'>, view, session.items, ref);
    patch((d) => ({ ...d, body: [...d.body, session.cut ? asCut(shape, view) : shape] }));
    setSession(null);
    setHover(null);
    setSelected(id);
    return true;
  };

  /** Rewrite a shared vertex (every item using those formulas). */
  const setVertex = (from: GenusVec2, to: GenusVec2) =>
    setSession((s) => {
      if (!s) return s;
      const fix = (q: GenusVec2) => (samePt(q, from) ? to : q);
      const items = s.items.map((it): GenusSketchItemDto => (it.kind === 'circle' ? { ...it, c: fix(it.c) } : { ...it, a: fix(it.a), b: fix(it.b) }));
      return { ...s, items };
    });
  const setItem = (i: number, item: GenusSketchItemDto) => setSession((s) => (s ? { ...s, items: s.items.map((x, k) => (k === i ? item : x)) } : s));
  const removeItem = (i: number) => setSession((s) => (s ? { ...s, items: s.items.filter((_, k) => k !== i) } : s));

  const overlay = (view: OrthoView): ViewOverlay | undefined => {
    if (!session || (session.view && session.view !== view)) return undefined;
    const paths = sketchPaths(view, session.items, values);
    const verts = vertices.map((v) => ({ at: planeToView(view, v.at), locked: v.locked }));
    const pend = session.pending.map((p) => planeToView(view, p.at));
    const h = hover && hover.view === view ? hover : null;
    const rubber = h && pend.length ? [pend[pend.length - 1], planeToView(view, h.at)] : null;
    return {
      paths,
      vertices: verts,
      pending: pend,
      rubber,
      snap: h ? { at: planeToView(view, h.at), locked: h.locks.length > 0 } : null,
      ok: Boolean(check?.ok),
    };
  };

  const interact = (view: OrthoView): ViewInteract | undefined => {
    if (!enabled || !session) return undefined;
    return {
      placing: true,
      pending: [],
      picked: null,
      onPlace: (hit, p, k) => place(view, hit, p, k ?? 0.01),
      onFinish: () => {
        finish();
      },
      onDragStart: () => false,
      onDragMove: () => {},
      onDragEnd: () => {},
      onHover: (p, k) => {
        if (!p || (session.view && session.view !== view)) {
          setHover(null);
          return;
        }
        const s = snapAt(view, p, k);
        setHover({ view, ...s });
      },
      overlay: overlay(view),
    };
  };

  /** Solid ↔ void for an authored item. */
  const toggleVoid = (id: string, makeVoid: boolean) =>
    patch((d) => ({ ...d, body: d.body.map((b) => (b.id === id && isShapeItem(b) ? setVoid(b, makeVoid) : b)) }));

  const lockedCount = vertices.filter((v) => v.locked).length;

  return {
    session,
    active: Boolean(session),
    issue,
    tried,
    note,
    setNote,
    lockedCount,
    vertices,
    hoverLocks: hover?.locks ?? [],
    start,
    edit,
    setTool,
    cancel,
    close,
    undo,
    finish,
    interact,
    setVertex,
    setItem,
    removeItem,
    toggleVoid,
  };
}
