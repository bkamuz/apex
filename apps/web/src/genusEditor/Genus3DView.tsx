import { useEffect, useMemo, useRef } from 'react';
import type { GenusPreviewDto } from '../types';
import { ViewportRenderer } from '../viewport/ViewportRenderer';
import type { TestHost } from './model';
import { topItemOfPath } from './model';
import { hostMesh } from './projection';

type OkPreview = Extract<GenusPreviewDto, { ok: true }>;

const HOST_PICK = 1000;

export interface Genus3DViewProps {
  preview: OkPreview | null;
  host: TestHost | null;
  showHost: boolean;
  selected: string | null;
  onSelect: (item: string | null) => void;
  label: string;
  fitKey: string;
}

function bounds(p: number[]): { min: [number, number, number]; max: [number, number, number] } | null {
  if (p.length < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k]);
      max[k] = Math.max(max[k], p[i + k]);
    }
  }
  return { min, max };
}

/** Per-triangle pick ids: solid i → i + 1, host → HOST_PICK. */
function sceneOf(preview: OkPreview, host: TestHost | null) {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const pickIds: number[] = [];
  const edges: number[] = [];
  const items: string[] = [];
  const push = (m: { positions: number[]; normals: number[]; indices: number[]; edges: number[] }, pick: number) => {
    const base = positions.length / 3;
    positions.push(...m.positions);
    if (m.normals.length === m.positions.length) normals.push(...m.normals);
    else for (let i = 0; i < m.positions.length; i += 1) normals.push(0);
    const idx = m.indices.length ? m.indices : Array.from({ length: m.positions.length / 3 }, (_, i) => i);
    for (let t = 0; t < idx.length; t += 3) {
      indices.push(base + idx[t], base + idx[t + 1], base + idx[t + 2]);
      pickIds.push(pick);
    }
    edges.push(...m.edges);
  };
  preview.solids.forEach((s, i) => {
    items[i + 1] = topItemOfPath(s.path);
    push(s.mesh, i + 1);
  });
  if (host) push(hostMesh(preview, host), HOST_PICK);
  return { positions, normals, indices, pickIds, edges, items };
}

/** The genus in 3D (the project renderer, orbit / zoom), with the sample host. */
export function Genus3DView(props: Genus3DViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const lastFit = useRef<string | null>(null);
  const scene = useMemo(
    () => (props.preview ? sceneOf(props.preview, props.host) : null),
    [props.preview, props.host],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: ViewportRenderer | null = null;
    try {
      renderer = new ViewportRenderer(canvas);
    } catch {
      return; // no WebGL2: the 2D views still work
    }
    rendererRef.current = renderer;
    lastFit.current = null; // a new renderer always fits once
    return () => {
      rendererRef.current = null;
      renderer?.dispose();
    };
  }, []);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    // Fit once per genus / Fit press, when there is geometry to fit.
    const fit = scene !== null && scene.positions.length > 0 && lastFit.current !== props.fitKey;
    if (fit) lastFit.current = props.fitKey;
    r.setScene({
      positions: new Float32Array(scene?.positions ?? []),
      normals: new Float32Array(scene?.normals ?? []),
      indices: new Uint32Array(scene?.indices ?? []),
      pickIds: scene?.pickIds ?? [],
      edgePositions: new Float32Array(scene?.edges ?? []),
      selectedPickIds: [],
      fitCamera: fit,
    });
    if (fit && scene) {
      // The pane may get its size after the first frame: fit again then.
      const b = bounds(scene.positions);
      requestAnimationFrame(() => {
        if (!b || rendererRef.current !== r) return;
        r.fitToAabb(b.min, b.max);
        // The project fit keeps at least 6 m away; a genus is small.
        const radius = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
        // Narrow (phone) panes need more room for the width.
        const c = canvasRef.current;
        const aspect = c && c.clientHeight > 0 ? c.clientWidth / c.clientHeight : 1;
        r.setCamera({ distance: Math.max((radius * 2.4) / Math.min(1, aspect), 0.6) });
      });
    }
  }, [scene, props.fitKey]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !scene) return;
    r.setHiddenPickIds(props.showHost ? [] : [HOST_PICK]);
  }, [scene, props.showHost]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !scene) return;
    const ids: number[] = [];
    scene.items.forEach((item, i) => {
      if (item && item === props.selected) ids.push(i);
    });
    r.setSelectedPickIds(ids);
  }, [scene, props.selected]);

  const down = useRef<{ x: number; y: number } | null>(null);
  return (
    <div className="genus-view genus-view--3d" data-testid="genus-view-3d">
      <span className="genus-view-label">{props.label}</span>
      <canvas
        ref={canvasRef}
        className="genus-view-canvas"
        onPointerDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const d = down.current;
          down.current = null;
          if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
          const r = rendererRef.current;
          if (!r || !scene) return;
          const pick = r.pick(e.clientX, e.clientY);
          props.onSelect(pick !== null && pick !== HOST_PICK ? (scene.items[pick] ?? null) : null);
        }}
      />
    </div>
  );
}
