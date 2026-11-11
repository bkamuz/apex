/**
 * Genus editor: ref / dim authoring in the ortho views — placing tools,
 * picking, flex by drag (writes param values for the previewed species),
 * Move / Copy / Delete. State lives here; the pure rules are in refs.ts.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { GenusDefDto, GenusDimDto, GenusRefDto } from '../types';
import type { ViewHit, ViewInteract } from './GenusOrthoView';
import type { GenusDraft } from './model';
import { setParam, setSpeciesValue, type DraftSpecies, type ParamRow } from './params';
import { project, type OrthoView, type P2 } from './projection';
import {
  AXES,
  axisIndex,
  bindDim,
  deleteDim,
  deleteRef,
  dimAxis,
  evalFormula,
  evalRef,
  flexContext,
  flexDim,
  flexDimValue,
  flexRefDrag,
  flexValues,
  listDims,
  listRefs,
  newDimAxis,
  newLineRef,
  newPlaneRef,
  newPointRef,
  newPolylineRef,
  nextId,
  offsetFormula,
  planeNormal,
  putDim,
  putRef,
  refPoints,
  refUsers,
  snap,
  takenIds,
  toGenus,
  VIEW_AXES,
  withPoints,
  type FlexResult,
  type PlaceTool,
  type V3,
} from './refs';

export type RefTool = PlaceTool | 'move';

/** Why the last edit did nothing (catalog key suffix genusEditor.flex.*). */
export type FlexNote = 'locked' | 'formula' | 'inUse' | null;

interface Args {
  draft: GenusDraft | null;
  parent: GenusDefDto | null;
  rows: ParamRow[];
  species: DraftSpecies | null;
  extra: Record<string, number>;
  /** Apply a change to the session draft / species list. */
  patch: (fn: (s: { draft: GenusDraft; species: DraftSpecies[] }) => { draft?: GenusDraft; species?: DraftSpecies[] }) => void;
  selected: string | null;
  setSelected: (id: string | null) => void;
  enabled: boolean;
}

interface DragState {
  hit: Extract<ViewHit, { kind: 'ref' | 'dim' }>;
  view: OrthoView;
  start: V3;
  /** The end's coordinate along the dim axis at drag start. */
  endAt: number;
  axis: number | null;
  ctx: ReturnType<typeof flexContext>;
  move: boolean;
  ref: GenusRefDto | null;
}

export function useRefTools(a: Args) {
  const { draft, parent, rows, species, extra, patch, selected, setSelected, enabled } = a;
  const [tool, setToolState] = useState<RefTool | null>(null);
  const [trace, setTrace] = useState<'h' | 'v'>('v');
  const [pending, setPending] = useState<{ view: OrthoView; pts: V3[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<FlexNote>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);

  const refs = useMemo(() => (draft ? listRefs(draft, parent) : []), [draft?.refs, draft?.remove, parent]);
  const dims = useMemo(() => (draft ? listDims(draft, parent) : []), [draft?.dims, draft?.remove, parent]);
  const values = useMemo(() => {
    if (!draft) return {};
    return flexValues(flexContext(draft, parent, rows, species, extra));
  }, [draft, parent, rows, species, extra]);

  const setTool = useCallback((t: RefTool | null) => {
    setToolState((cur) => (cur === t ? null : t));
    setPending(null);
    setPicked(null);
    setNote(null);
  }, []);

  /** Write flex results: params (species value or default), moved refs. */
  const apply = useCallback(
    (results: FlexResult[]) => {
      const blocked = results.find((r) => r.kind === 'blocked');
      setNote(blocked && blocked.kind === 'blocked' ? blocked.reason : null);
      const ok = results.filter((r) => r.kind !== 'blocked');
      if (!ok.length) return;
      patch((s) => {
        let d = s.draft;
        let list = s.species;
        for (const r of ok) {
          if (r.kind === 'move') d = putRef(d, r.ref);
          else if (r.kind === 'param') {
            const row = rows.find((x) => x.id === r.id);
            if (row?.input.species && species) list = setSpeciesValue(list, species.id, r.id, r.value);
            else d = setParam(d, rows, r.id, { default: r.value });
          }
        }
        return { draft: d, species: list };
      });
    },
    [patch, rows, species],
  );

  const ctxNow = () => (draft ? flexContext(draft, parent, rows, species, extra) : null);

  const place = (view: OrthoView, hit: ViewHit, p: P2) => {
    if (!draft || !tool || tool === 'move') return;
    const g = toGenus(view, snap(p[0]), snap(p[1]));
    const taken = takenIds(draft, parent);
    const add = (ref: GenusRefDto) => {
      patch((s) => ({ draft: putRef(s.draft, ref) }));
      setSelected(ref.id);
    };
    if (tool === 'point') add(newPointRef(nextId('point', taken), g));
    else if (tool === 'plane') add(newPlaneRef(nextId('plane', taken), g, planeNormal(view, trace)));
    else if (tool === 'line' || tool === 'polyline') {
      const pts = pending && pending.view === view ? [...pending.pts, g] : [g];
      if (tool === 'line' && pts.length === 2) {
        add(newLineRef(nextId('line', taken), pts[0], pts[1]));
        setPending(null);
      } else setPending({ view, pts });
    } else if (tool === 'dim') {
      if (hit.kind !== 'ref') return;
      if (!picked || picked === hit.id) {
        setPicked(hit.id);
        return;
      }
      const ra = refs.find((r) => r.ref.id === picked)?.ref;
      const rb = refs.find((r) => r.ref.id === hit.id)?.ref;
      if (!ra || !rb) return;
      const dim: GenusDimDto = { id: nextId('dim', taken), from: picked, to: hit.id, axis: newDimAxis(view, evalRef(ra, values), evalRef(rb, values)) };
      patch((s) => ({ draft: putDim(s.draft, dim) }));
      setPicked(null);
      setSelected(`dim:${dim.id}`);
    }
  };

  const finish = () => {
    if (!draft || !pending) return;
    if (tool === 'polyline' && pending.pts.length >= 2) {
      // A double click places the last point twice: drop repeats.
      const pts = pending.pts.filter((q, i, all) => i === 0 || q.some((v, k) => Math.abs(v - all[i - 1][k]) > 1e-9));
      if (pts.length >= 2) {
        const ref = newPolylineRef(nextId('polyline', takenIds(draft, parent)), pts);
        patch((s) => ({ draft: putRef(s.draft, ref) }));
        setSelected(ref.id);
      }
    }
    setPending(null);
  };

  const dragStart = (view: OrthoView, hit: ViewHit, p: P2): boolean => {
    const ctx = ctxNow();
    if (!ctx || !draft || (hit.kind !== 'ref' && hit.kind !== 'dim')) return false;
    setSelected(hit.kind === 'dim' ? `dim:${hit.id}` : hit.id);
    let endAt = 0;
    let axis: number | null = null;
    if (hit.kind === 'dim') {
      const dim = ctx.dims.find((d) => d.id === hit.id);
      const end = dim ? ctx.refs.get(hit.end === 'from' ? dim.from : dim.to) : undefined;
      axis = dim ? dimAxis(dim, ctx.refs.get(dim.from)) : null;
      if (!dim || !end || axis === null) return false;
      if (dim.locked) {
        setNote('locked');
        return false;
      }
      endAt = evalFormula(refPoints(end)[0][axis], flexValues(ctx));
    }
    drag.current = {
      hit,
      view,
      start: toGenus(view, p[0], p[1]),
      endAt,
      axis,
      ctx,
      move: tool === 'move',
      ref: hit.kind === 'ref' ? (ctx.refs.get(hit.id) ?? null) : null,
    };
    setDragging(true);
    return true;
  };

  const dragMove = (p: P2, fine: boolean) => {
    const d = drag.current;
    if (!d) return;
    const step = fine ? 0.001 : 0.005;
    const now = toGenus(d.view, p[0], p[1]);
    const delta = now.map((v, i) => snap(v - d.start[i], step)) as V3;
    const at = d.start.map((v, i) => v + delta[i]) as V3;
    if (d.hit.kind === 'dim' && d.axis !== null) {
      apply([flexDim(d.ctx, d.hit.id, d.hit.end, d.endAt + delta[d.axis])]);
      return;
    }
    if (d.move && d.ref) {
      // Move: shift the ref, keeping its formulas (constants stay numbers).
      const ax = VIEW_AXES[d.view];
      const axes = d.ref.ref === 'plane' ? [axisIndex(d.ref.normal ?? 'z')] : [ax.u[0], ax.v[0]];
      const pts = refPoints(d.ref).map((q) => q.map((f, k) => (axes.includes(k) ? offsetFormula(f, delta[k]) : f)) as typeof q);
      apply([{ kind: 'move', ref: withPoints(d.ref, pts) }]);
      return;
    }
    apply(flexRefDrag(d.ctx, d.hit.id, d.view, d.start, at));
  };

  const dragEnd = () => {
    drag.current = null;
    setDragging(false);
  };

  const interact = (view: OrthoView): ViewInteract | undefined => {
    if (!enabled) return undefined;
    const placing = Boolean(tool && tool !== 'move');
    return {
      placing,
      pending: pending && pending.view === view ? pending.pts.map((q) => project(view, q)) : [],
      picked,
      onPlace: (hit, p) => place(view, hit, p),
      onFinish: finish,
      onDragStart: (hit, p) => dragStart(view, hit, p),
      onDragMove: dragMove,
      onDragEnd: dragEnd,
    };
  };

  // —— Selection-based actions ——————————————————————————————————————
  const selectedDim = selected?.startsWith('dim:') ? (dims.find((d) => d.dim.id === selected.slice(4)) ?? null) : null;
  const selectedRef = selected && !selectedDim ? (refs.find((r) => r.ref.id === selected) ?? null) : null;

  const remove = () => {
    if (!draft) return;
    if (selectedDim) {
      patch((s) => ({ draft: deleteDim(s.draft, parent, selectedDim.dim.id) }));
      setSelected(null);
    } else if (selectedRef) {
      const next = deleteRef(draft, parent, selectedRef.ref.id);
      if (!next) {
        setNote('inUse');
        return;
      }
      patch((s) => ({ draft: deleteRef(s.draft, parent, selectedRef.ref.id) ?? s.draft }));
      setSelected(null);
    }
  };

  const copy = () => {
    if (!draft || !selectedRef) return;
    const r = selectedRef.ref;
    const axis = r.ref === 'plane' ? axisIndex(r.normal ?? 'z') : 0;
    const id = nextId(r.ref, takenIds(draft, parent));
    const pts = refPoints(r).map((q) => q.map((f, k) => (k === axis ? offsetFormula(f, 0.1) : f)) as typeof q);
    patch((s) => ({ draft: putRef(s.draft, withPoints({ ...r, id }, pts)) }));
    setSelected(id);
  };

  const bind = (dimId: string, param: string | null) => {
    patch((s) => ({ draft: bindDim(s.draft, parent, dimId, param, values).draft }));
  };

  const setDimValue = (dimId: string, value: number) => {
    const ctx = ctxNow();
    if (ctx) apply([flexDimValue(ctx, dimId, value)]);
  };

  const usersOf = (id: string) => (draft ? refUsers(draft, parent, id) : []);
  const axisName = (dim: GenusDimDto) => {
    const i = dimAxis(dim, refs.find((r) => r.ref.id === dim.from)?.ref);
    return i === null ? null : AXES[i];
  };

  const cancel = (): boolean => {
    if (pending || picked) {
      setPending(null);
      setPicked(null);
      return true;
    }
    if (tool) {
      setToolState(null);
      return true;
    }
    return false;
  };

  return {
    tool,
    setTool,
    trace,
    setTrace,
    pending,
    picked,
    note,
    setNote,
    dragging,
    refs,
    dims,
    values,
    selectedRef,
    selectedDim,
    interact,
    finish,
    cancel,
    remove,
    copy,
    bind,
    setDimValue,
    usersOf,
    axisName,
  };
}
