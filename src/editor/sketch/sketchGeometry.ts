import * as THREE from 'three';
import { PrimitiveGenerator } from '../PrimitiveGenerator';
import type { SketchPoint } from './types';
import { SLAB_THICKNESS, WALL_HEIGHT, WALL_THICKNESS } from './types';

const MIN_SEGMENT = 1e-3;

export interface BeamProfile {
  width: number;
  height: number;
}

export function quaternionAlignZToDirection(dir: THREE.Vector3): THREE.Quaternion {
  const z = new THREE.Vector3(0, 0, 1);
  const d = dir.clone().normalize();
  const dot = z.dot(d);
  if (dot > 0.999999) {
    return new THREE.Quaternion();
  }
  if (dot < -0.999999) {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  }
  return new THREE.Quaternion().setFromUnitVectors(z, d);
}

export function buildSketchWallMesh(
  p1: SketchPoint,
  p2: SketchPoint
): THREE.Mesh | null {
  const length = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  if (length < MIN_SEGMENT) return null;
  const angle = Math.atan2(p2.z - p1.z, p2.x - p1.x);
  const mesh = PrimitiveGenerator.createWall(length, WALL_HEIGHT, WALL_THICKNESS);
  mesh.position.set(
    (p1.x + p2.x) / 2,
    p1.y + WALL_HEIGHT / 2,
    (p1.z + p2.z) / 2
  );
  mesh.rotation.y = -angle;
  return mesh;
}

/**
 * Балка вдоль отрезка p1–p2 в 3D (разный уровень у концов).
 * Локальная ось Z — длина балки; профиль в плоскости XY.
 */
export function buildSketchBeamMesh(
  p1: SketchPoint,
  p2: SketchPoint,
  profile: BeamProfile,
  style?: { isPreview?: boolean }
): THREE.Mesh | null {
  const ax = p2.x - p1.x;
  const ay = p2.y - p1.y;
  const az = p2.z - p1.z;
  const length = Math.hypot(ax, ay, az);
  if (length < MIN_SEGMENT) return null;

  const geometry = new THREE.BoxGeometry(profile.width, profile.height, length);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8b4513,
    opacity: style?.isPreview ? 0.42 : 1,
    transparent: Boolean(style?.isPreview),
    depthWrite: !style?.isPreview,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = 'IfcBeam';

  const mid = new THREE.Vector3(
    (p1.x + p2.x) / 2,
    (p1.y + p2.y) / 2,
    (p1.z + p2.z) / 2
  );
  mesh.position.copy(mid);
  mesh.quaternion.copy(quaternionAlignZToDirection(new THREE.Vector3(ax, ay, az)));

  return mesh;
}

/** Пересобрать геометрию и трансформ меша балки из `userData.apexBeam`. */
export function applyBeamGeometryToMesh(
  mesh: THREE.Mesh,
  beam: {
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    profile: BeamProfile;
    levelId: string;
    levelBaseY: number;
  }
): void {
  const { start, end, profile } = beam;
  const ax = end.x - start.x;
  const ay = end.y - start.y;
  const az = end.z - start.z;
  const length = Math.hypot(ax, ay, az);
  if (length < MIN_SEGMENT) return;

  const oldGeo = mesh.geometry;
  mesh.geometry = new THREE.BoxGeometry(profile.width, profile.height, length);
  oldGeo.dispose();

  const mid = new THREE.Vector3(
    (start.x + end.x) / 2,
    (start.y + end.y) / 2,
    (start.z + end.z) / 2
  );
  mesh.position.copy(mid);
  mesh.quaternion.copy(quaternionAlignZToDirection(new THREE.Vector3(ax, ay, az)));
  mesh.updateMatrixWorld(true);
}

export function buildSketchSlabMesh(points: SketchPoint[]): THREE.Mesh | null {
  if (points.length < 3) return null;
  const center = points.reduce(
    (acc, p) => ({
      x: acc.x + p.x / points.length,
      y: acc.y + p.y / points.length,
      z: acc.z + p.z / points.length,
    }),
    { x: 0, y: 0, z: 0 }
  );

  const shape = new THREE.Shape();
  points.forEach((p, i) => {
    const x = p.x - center.x;
    const z = p.z - center.z;
    if (i === 0) shape.moveTo(x, z);
    else shape.lineTo(x, z);
  });
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: SLAB_THICKNESS,
    bevelEnabled: false,
  });
  const material = new THREE.MeshStandardMaterial({ color: 0x808080 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(center.x, center.y, center.z);
  mesh.name = 'IfcSlab';
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

export function buildSketchArcWallMesh(
  p1: SketchPoint,
  p2: SketchPoint,
  _p3: SketchPoint
): THREE.Mesh {
  const radius = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  const arc = new THREE.EllipseCurve(
    p1.x,
    p1.z,
    radius,
    radius,
    0,
    Math.PI / 2,
    false,
    0
  );
  const arcPoints = arc.getPoints(20);
  const shape = new THREE.Shape();
  shape.moveTo(arcPoints[0].x, arcPoints[0].y);
  arcPoints.forEach((p) => shape.lineTo(p.x, p.y));

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: WALL_HEIGHT,
    bevelEnabled: false,
  });
  const material = new THREE.MeshStandardMaterial({ color: 0xd3d3d3 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, p1.y, 0);
  mesh.name = 'IfcWall';
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}
