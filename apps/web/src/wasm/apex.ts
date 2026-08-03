import initWasm, {
  initApp,
  createWall,
  setWallParams,
  selectElement,
  pickById,
  getScene,
  getSelected,
  listElements,
  deleteSelected,
} from './pkg/apex_wasm.js';
import type { ElementDto, SceneDto } from '../types';

let ready = false;

export async function initApex(): Promise<void> {
  if (ready) return;
  await initWasm();
  initApp();
  ready = true;
}

function asScene(value: unknown): SceneDto {
  return value as SceneDto;
}

export function apexCreateWall(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  height: number,
  thickness: number,
): SceneDto {
  return asScene(createWall(x0, y0, z0, x1, y1, z1, height, thickness));
}

export function apexSetWallParams(
  id: string,
  height: number,
  thickness: number,
  start: [number, number, number],
  end: [number, number, number],
): SceneDto {
  return asScene(
    setWallParams(id, height, thickness, start[0], start[1], start[2], end[0], end[1], end[2]),
  );
}

export function apexSelectElement(id: string | null): SceneDto {
  return asScene(selectElement(id ?? ''));
}

export function apexPickById(pickId: number): SceneDto {
  return asScene(pickById(pickId));
}

export function apexGetScene(): SceneDto {
  return asScene(getScene());
}

export function apexGetSelected(): ElementDto | null {
  const value = getSelected();
  if (value === null || value === undefined) return null;
  return value as ElementDto;
}

export function apexListElements(): ElementDto[] {
  return listElements() as ElementDto[];
}

export function apexDeleteSelected(): SceneDto {
  return asScene(deleteSelected());
}
