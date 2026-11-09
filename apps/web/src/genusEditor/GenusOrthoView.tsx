import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DimShape, OrthoView, P2, ViewModel } from './projection';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GenusOrthoViewProps {
  view: OrthoView;
  model: ViewModel;
  label: string;
  selected: string | null;
  onSelect: (item: string | null) => void;
  showHost: boolean;
  showRefs: boolean;
  showDims: boolean;
  /** Display name for a ref / item id. */
  nameOf: (id: string) => string;
  /** Text under the host (e.g. "Test host: wall 250 mm"). */
  hostLabel: string | null;
  levelLabel: string;
  /** Changes when the view should refit (new genus, Fit). */
  fitKey: string;
}

const Y = (v: number) => -v;
const mm = (m: number) => String(Math.round(m * 1000));

function fitBox(model: ViewModel, aspect: number): Box {
  const { min, max } = model.bounds;
  let w = Math.max(max[0] - min[0], 0.2);
  let h = Math.max(max[1] - min[1], 0.2);
  const pad = Math.max(w, h) * 0.14 + 0.15;
  w += pad * 2;
  h += pad * 2;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const cx = (min[0] + max[0]) / 2;
  const cy = Y((min[1] + max[1]) / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function trisPath(tris: P2[][]): string {
  let d = '';
  for (const t of tris) {
    d += `M${t[0][0]} ${Y(t[0][1])}L${t[1][0]} ${Y(t[1][1])}L${t[2][0]} ${Y(t[2][1])}Z`;
  }
  return d;
}

function edgesPath(edges: number[][]): string {
  let d = '';
  for (const [u0, v0, u1, v1] of edges) d += `M${u0} ${Y(v0)}L${u1} ${Y(v1)}`;
  return d;
}

function loopsPath(loops: P2[][]): string {
  return loops
    .map((l) => `M${l.map(([u, v]) => `${u} ${Y(v)}`).join('L')}Z`)
    .join('');
}

/**
 * One orthographic genus view (elevation, plan or side) as SVG: sample host,
 * solids (painter's order), cuts as dashed outlines, reference traces,
 * dimensions and overall sizes. Wheel zooms, drag pans, double-click fits.
 */
export function GenusOrthoView(props: GenusOrthoViewProps) {
  const { model, selected, onSelect, showHost, showRefs, showDims, nameOf } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [box, setBox] = useState<Box | null>(null);
  const drag = useRef<{ x: number; y: number; box: Box; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => setBox(fitBox(model, size.w / size.h)), [model, size.w, size.h]);
  // Refit on a new genus / explicit Fit and when the pane is resized.
  useEffect(() => {
    setBox(fitBox(model, size.w / size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey, size.w, size.h]);

  const vb = box ?? fitBox(model, size.w / size.h);
  /** Metres per screen pixel. */
  const k = Math.max(vb.w / size.w, vb.h / size.h);
  const fs = 11 * k;

  const onWheel = (e: React.WheelEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const f = Math.exp(Math.sign(e.deltaY) * 0.15);
    const w = vb.w * f;
    const h = vb.h * f;
    setBox({ x: vb.x + (vb.w - w) * fx, y: vb.y + (vb.h - h) * fy, w, h });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, box: vb, moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    setBox({ ...d.box, x: d.box.x - dx * k, y: d.box.y - dy * k });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const target = (e.target as Element).closest('[data-item]');
      onSelect(target ? target.getAttribute('data-item') : null);
    }
  };

  const solids = useMemo(
    () =>
      model.solids.map((s) => ({
        ...s,
        fill: trisPath(s.tris),
        stroke: edgesPath(s.edges),
      })),
    [model],
  );

  const dimEls = (dims: DimShape[], cls: string) =>
    dims.map((d) => {
      const off = 22 * k;
      if (d.dir === 'h') {
        const y = Y(Math.max(d.a[1], d.b[1])) - off;
        const x0 = Math.min(d.a[0], d.b[0]);
        const x1 = Math.max(d.a[0], d.b[0]);
        return (
          <g key={d.id} className={cls} data-dim={d.id}>
            <path d={`M${x0} ${y}H${x1}M${x0} ${y - 4 * k}v${8 * k}M${x1} ${y - 4 * k}v${8 * k}`} />
            <text x={(x0 + x1) / 2} y={y - 4 * k} fontSize={fs} textAnchor="middle">
              {d.param ? `${d.param} = ${mm(d.value)}` : mm(d.value)}
            </text>
          </g>
        );
      }
      const x = d.before ? Math.min(d.a[0], d.b[0]) - off : Math.max(d.a[0], d.b[0]) + off;
      const y0 = Y(Math.max(d.a[1], d.b[1]));
      const y1 = Y(Math.min(d.a[1], d.b[1]));
      return (
        <g key={d.id} className={cls} data-dim={d.id}>
          <path d={`M${x} ${y0}V${y1}M${x - 4 * k} ${y0}h${8 * k}M${x - 4 * k} ${y1}h${8 * k}`} />
          <text
            x={x + 4 * k}
            y={(y0 + y1) / 2}
            fontSize={fs}
            textAnchor="middle"
            transform={`rotate(-90 ${x + 4 * k} ${(y0 + y1) / 2})`}
            dy={-2 * k}
          >
            {d.param ? `${d.param} = ${mm(d.value)}` : mm(d.value)}
          </text>
        </g>
      );
    });

  // Overall sizes of the genus (and its height above the level).
  const overall: DimShape[] = [];
  const ext = model.extents;
  if (showDims && ext) {
    const w = ext.max[0] - ext.min[0];
    const h = ext.max[1] - ext.min[1];
    const top = ext.max[1];
    if (w > 1e-4) overall.push({ id: 'overall-w', a: [ext.min[0], top], b: [ext.max[0], top], dir: 'h', value: w });
    if (h > 1e-4) overall.push({ id: 'overall-h', a: [ext.max[0], ext.min[1]], b: [ext.max[0], ext.max[1]], dir: 'v', value: h });
    if (model.level !== null && ext.min[1] > 1e-3) {
      overall.push({ id: 'overall-elev', a: [ext.min[0], 0], b: [ext.min[0], ext.min[1]], dir: 'v', value: ext.min[1], before: true });
    }
  }

  const left = vb.x;
  const right = vb.x + vb.w;
  const topY = vb.y;
  const bottomY = vb.y + vb.h;

  return (
    <div
      ref={wrapRef}
      className="genus-view"
      data-testid={`genus-view-${props.view}`}
      onWheel={onWheel}
      onDoubleClick={fit}
    >
      <span className="genus-view-label">{props.label}</span>
      <svg
        className="genus-view-svg"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <defs>
          <pattern
            id={`genus-hatch-${props.view}`}
            width={7 * k}
            height={7 * k}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2={7 * k} className="genus-hatch-line" />
          </pattern>
        </defs>
        {model.level !== null ? (
          <g className="genus-level">
            <line x1={left} x2={right} y1={Y(model.level)} y2={Y(model.level)} />
            <text x={right - 6 * k} y={Y(model.level) - 4 * k} fontSize={fs * 0.9} textAnchor="end">
              {props.levelLabel}
            </text>
          </g>
        ) : null}
        {showHost && model.host ? (
          <g className={`genus-host${model.host.section ? ' is-section' : ''}`} data-testid="genus-host">
            <path d={loopsPath(model.host.loops)} fillRule="evenodd" fill={`url(#genus-hatch-${props.view})`} />
            {props.hostLabel && props.view !== 'side' ? (
              <text
                x={Math.min(...model.host.loops.flat().map((p) => p[0])) + 4 * k}
                y={Y(Math.min(...model.host.loops.flat().map((p) => p[1]))) + 14 * k}
                fontSize={fs * 0.9}
              >
                {props.hostLabel}
              </text>
            ) : null}
          </g>
        ) : null}
        {solids.map((s) => (
          <g
            key={s.path}
            data-item={s.item}
            data-path={s.path}
            className={`genus-shape is-${s.kind}${selected === s.item ? ' is-selected' : ''}`}
          >
            {s.kind !== 'cut' ? <path className="genus-shape-fill" d={s.fill} /> : null}
            <path className="genus-shape-edge" d={s.stroke} />
          </g>
        ))}
        {model.symbols.length ? (
          <path
            className="genus-symbol"
            d={model.symbols.map(([u0, v0, u1, v1]) => `M${u0} ${Y(v0)}L${u1} ${Y(v1)}`).join('')}
          />
        ) : null}
        {showRefs
          ? model.refs.map((r) => {
              if (r.infinite) {
                const [u, v] = r.points[0];
                return (
                  <g key={r.id} className={`genus-ref${selected === r.id ? ' is-selected' : ''}`} data-ref={r.id}>
                    {r.infinite === 'h' ? (
                      <line x1={left} x2={right} y1={Y(v)} y2={Y(v)} />
                    ) : (
                      <line x1={u} x2={u} y1={topY} y2={bottomY} />
                    )}
                    <text
                      x={r.infinite === 'h' ? left + 6 * k : u + 3 * k}
                      y={r.infinite === 'h' ? Y(v) - 3 * k : bottomY - 6 * k}
                      fontSize={fs * 0.9}
                    >
                      {nameOf(r.id)}
                    </text>
                  </g>
                );
              }
              if (r.point) {
                const [u, v] = r.points[0];
                const s = 5 * k;
                return (
                  <g key={r.id} className={`genus-ref is-point${selected === r.id ? ' is-selected' : ''}`} data-ref={r.id}>
                    <path d={`M${u - s} ${Y(v)}h${2 * s}M${u} ${Y(v) - s}v${2 * s}`} />
                    <text x={u + s} y={Y(v) - s} fontSize={fs * 0.9}>
                      {nameOf(r.id)}
                    </text>
                  </g>
                );
              }
              return (
                <g key={r.id} className={`genus-ref${selected === r.id ? ' is-selected' : ''}`} data-ref={r.id}>
                  <polyline points={r.points.map(([u, v]) => `${u},${Y(v)}`).join(' ')} />
                </g>
              );
            })
          : null}
        {showDims ? dimEls(model.dims, 'genus-dim') : null}
        {showDims ? dimEls(overall, 'genus-dim is-overall') : null}
      </svg>
    </div>
  );
}
