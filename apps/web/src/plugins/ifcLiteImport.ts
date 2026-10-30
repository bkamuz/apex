/**
 * Browser IFC Open via IFC-Lite (Rust+WASM tessellator with CSG openings).
 *
 * Parses storeys with `@ifc-lite/parser`, tessellates with `@ifc-lite/geometry`,
 * then hands Apex-Y-up metre meshes to WASM `importIfcMeshes`.
 */

import { GeometryProcessor } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import initIfcLiteWasm from '@ifc-lite/wasm';
import ifcLiteWasmUrl from '@ifc-lite/wasm/ifc-lite_bg.wasm?url';
import { apexImportIfcMeshes, type IfcImportSummary } from '../wasm/apex';
import type { SceneDto } from '../types';

/** Clutter / void types — hosts already have CSG openings applied. */
const SKIP_TYPES = new Set([
  'IfcOpeningElement',
  'IfcSpace',
  'IfcFurnishingElement',
  'IfcCovering',
  'IfcAnnotation',
  'IfcGrid',
  'IfcGridAxis',
  'IfcProxy',
]);

type StoreyInfo = { name: string; elevation: number; expressId: number };

type SpatialNode = {
  expressId?: number;
  type?: number | string;
  name?: string;
  elevation?: number;
  children?: SpatialNode[];
  elements?: number[];
};

let geometryProcessor: GeometryProcessor | null = null;
let wasmPrimed = false;

/**
 * Vite's dep optimizer rewrites `@ifc-lite/*` into `.vite/deps/`, breaking
 * wasm-bindgen's `new URL('ifc-lite_bg.wasm', import.meta.url)`. Prime the
 * engine with an explicit `?url` asset so later `GeometryProcessor.init()`
 * hits the already-initialized short-circuit.
 */
async function ensureIfcLiteWasm(): Promise<void> {
  if (wasmPrimed) return;
  await initIfcLiteWasm({ module_or_path: ifcLiteWasmUrl });
  wasmPrimed = true;
}

async function getGeometry(): Promise<GeometryProcessor> {
  await ensureIfcLiteWasm();
  if (!geometryProcessor) {
    geometryProcessor = new GeometryProcessor({ tessellationQuality: 'medium' });
    await geometryProcessor.init();
  }
  return geometryProcessor;
}

function collectStoreys(node: SpatialNode | undefined, out: StoreyInfo[]): void {
  if (!node) return;
  // IFC-Lite spatialHierarchy uses numeric type codes; storey is 4 in their enum.
  const isStorey =
    node.type === 4 ||
    (typeof node.type === 'string' && /buildingstorey/i.test(node.type));
  if (isStorey && typeof node.expressId === 'number') {
    out.push({
      expressId: node.expressId,
      name: (node.name && String(node.name).trim()) || `Level ${out.length + 1}`,
      elevation: typeof node.elevation === 'number' ? node.elevation : 0,
    });
  }
  for (const child of node.children ?? []) collectStoreys(child, out);
}

/** Map product expressId → storey index in the sorted-by-elevation levels list. */
function mapElementsToStoreys(
  node: SpatialNode | undefined,
  storeyIndexById: Map<number, number>,
  out: Map<number, number>,
  currentStorey: number | undefined,
): void {
  if (!node) return;
  const isStorey =
    node.type === 4 ||
    (typeof node.type === 'string' && /buildingstorey/i.test(node.type));
  const storey =
    isStorey && typeof node.expressId === 'number'
      ? storeyIndexById.get(node.expressId)
      : currentStorey;
  if (storey !== undefined) {
    for (const el of node.elements ?? []) out.set(el, storey);
  }
  for (const child of node.children ?? []) {
    mapElementsToStoreys(child, storeyIndexById, out, storey);
  }
}

function entityName(store: {
  getEntity?: (id: number) => { attributes?: unknown[] } | null;
}, expressId: number): string {
  const entity = store.getEntity?.(expressId);
  const attrs = entity?.attributes;
  if (!attrs || attrs.length < 3) return '';
  const name = attrs[2];
  return typeof name === 'string' ? name : '';
}

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Tessellate an IFC STEP string with IFC-Lite and load it into the live project.
 */
export async function importIfcWithIfcLite(
  text: string,
): Promise<SceneDto & { ifc_import?: IfcImportSummary }> {
  const bytes = toBytes(text);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  await ensureIfcLiteWasm();
  const parser = new IfcParser();
  const dataStore = await parser.parseColumnar(buffer);

  const storeys: StoreyInfo[] = [];
  const hierarchy = dataStore.spatialHierarchy as
    | { project?: SpatialNode }
    | SpatialNode
    | undefined;
  const root =
    hierarchy && 'project' in hierarchy && hierarchy.project
      ? hierarchy.project
      : (hierarchy as SpatialNode | undefined);
  collectStoreys(root, storeys);
  storeys.sort(
    (a, b) => a.elevation - b.elevation || a.name.localeCompare(b.name),
  );

  const storeyIndexById = new Map(storeys.map((s, i) => [s.expressId, i]));
  const elementToStorey = new Map<number, number>();
  mapElementsToStoreys(root, storeyIndexById, elementToStorey, undefined);

  // Fallback: entity attributes elevation when hierarchy missed a storey.
  if (storeys.length === 0) {
    const ids =
      dataStore.entityIndex?.byType?.get?.('IFCBUILDINGSTOREY') ??
      dataStore.getEntitiesByType?.('IFCBUILDINGSTOREY') ??
      [];
    for (const id of ids as number[]) {
      const entity = dataStore.getEntity?.(id);
      const attrs = entity?.attributes ?? [];
      const name = typeof attrs[2] === 'string' ? attrs[2] : `Storey ${id}`;
      const elevation = typeof attrs[9] === 'number' ? attrs[9] : 0;
      storeys.push({ expressId: id, name, elevation });
    }
    storeys.sort(
      (a, b) => a.elevation - b.elevation || a.name.localeCompare(b.name),
    );
  }

  const geometry = await getGeometry();
  const result = await geometry.process(bytes);

  // GeometryProcessor already emits metre coordinates; storey elevations from
  // the parser may still be in file units — scale those only.
  const unitScale =
    typeof dataStore.lengthUnitScale === 'number' && dataStore.lengthUnitScale > 0
      ? dataStore.lengthUnitScale
      : 1;

  const products: Array<{
    name: string;
    ifc_type: string;
    origin: [number, number, number];
    positions: number[];
    indices: number[];
    level_index?: number;
  }> = [];

  let skipped = 0;
  for (const mesh of result.meshes) {
    const ifcType = mesh.ifcType || 'IfcBuildingElementProxy';
    if (SKIP_TYPES.has(ifcType)) {
      skipped += 1;
      continue;
    }
    if (!mesh.positions?.length || !mesh.indices?.length) {
      skipped += 1;
      continue;
    }
    const ox = mesh.origin?.[0] ?? 0;
    const oy = mesh.origin?.[1] ?? 0;
    const oz = mesh.origin?.[2] ?? 0;
    const name = entityName(dataStore, mesh.expressId) || ifcType;
    const level_index = elementToStorey.get(mesh.expressId);
    products.push({
      name,
      ifc_type: ifcType,
      origin: [ox, oy, oz],
      positions: Array.from(mesh.positions),
      indices: Array.from(mesh.indices),
      ...(level_index !== undefined ? { level_index } : {}),
    });
  }

  if (products.length === 0) {
    throw new Error('IFC-Lite produced no importable meshes');
  }

  const payload = {
    levels: storeys.map((s) => ({
      name: s.name,
      elevation: s.elevation * unitScale,
    })),
    products,
  };

  const scene = apexImportIfcMeshes(JSON.stringify(payload));
  const summary = scene.ifc_import;
  if (summary && skipped > 0) {
    scene.ifc_import = {
      ...summary,
      skipped_no_mesh: summary.skipped_no_mesh + skipped,
      warnings: [
        ...summary.warnings,
        `skipped ${skipped} opening/space/furnishing/covering meshes (hosts already CSG-cut)`,
      ],
    };
  }
  return scene;
}
