import type { SceneDto, ViewDto } from '../types';
import { ViewportRenderer } from '../viewport/ViewportRenderer';
import { applyViewToRenderer, filterPickIdsForCategories, hiddenCategoriesForView } from './viewModel';

function toFloatArray(data: ArrayLike<number> | number[]): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function toUint32Array(data: ArrayLike<number> | number[]): Uint32Array {
  return data instanceof Uint32Array ? data : new Uint32Array(data);
}

function selectedPickIds(scene: SceneDto): number[] {
  const picks: number[] = [];
  for (const id of scene.selected_ids ?? []) {
    const hit = scene.elements.find((e) => e.id === id);
    if (hit) picks.push(hit.pick_id);
  }
  return picks;
}

/** Raster snapshot of a saved view (for sheet thumbnails / SVG export). */
export function captureViewImage(
  scene: SceneDto,
  view: ViewDto,
  width: number,
  height: number,
): Promise<string> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(32, width);
    canvas.height = Math.max(32, height);
    const renderer = new ViewportRenderer(canvas);
    const hidden = hiddenCategoriesForView(view);
    renderer.setScene({
      positions: toFloatArray(scene.positions),
      normals: toFloatArray(scene.normals),
      indices: toUint32Array(scene.indices),
      pickIds: filterPickIdsForCategories(scene, hidden),
      edgePositions: scene.edge_positions ? toFloatArray(scene.edge_positions) : [],
      selectedPickIds: selectedPickIds(scene),
      fitCamera: false,
    });
    renderer.setLevelPlanes(
      (scene.levels ?? []).map((level) => ({
        id: level.id,
        elevation: level.elevation,
        active: level.id === scene.active_level_id,
      })),
    );
    applyViewToRenderer(view, renderer);
    renderer.fitViewExtents();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const url = canvas.toDataURL('image/png');
        renderer.dispose();
        resolve(url);
      });
    });
  });
}
