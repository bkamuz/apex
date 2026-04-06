import * as THREE from 'three';
import type { ApexBeamUserData } from './beamTypes';

const SPHERE_R = 0.12;
const LINE_COLOR = 0x2a9fd8;
const START_COLOR = 0x22c55e;
const START_ACTIVE = 0x86efac;
const END_COLOR = 0xf97316;
const END_ACTIVE = 0xfdba74;

function lineFromBeam(beam: ApexBeamUserData): THREE.BufferGeometry {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(beam.start.x, beam.start.y, beam.start.z),
    new THREE.Vector3(beam.end.x, beam.end.y, beam.end.z),
  ]);
}

export function createBeamGizmoGroup(beam: ApexBeamUserData): THREE.Group {
  const group = new THREE.Group();
  group.name = 'apexBeamGizmoGroup';

  const lineMat = new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: true });
  const line = new THREE.Line(lineFromBeam(beam), lineMat);
  line.userData.apexSceneGizmo = true;
  line.userData.apexBeamGizmoLine = true;
  group.add(line);

  const s1 = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_R, 14, 14),
    new THREE.MeshBasicMaterial({ color: START_COLOR, depthTest: true })
  );
  s1.position.set(beam.start.x, beam.start.y, beam.start.z);
  s1.userData.apexSceneGizmo = true;
  s1.userData.apexBeamEnd = 'start' as const;

  const s2 = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_R, 14, 14),
    new THREE.MeshBasicMaterial({ color: END_COLOR, depthTest: true })
  );
  s2.position.set(beam.end.x, beam.end.y, beam.end.z);
  s2.userData.apexSceneGizmo = true;
  s2.userData.apexBeamEnd = 'end' as const;

  group.add(s1, s2);
  return group;
}

export function syncBeamGizmoGroup(
  group: THREE.Group,
  beam: ApexBeamUserData,
  activeEnd: 'start' | 'end' | null
): void {
  for (const child of group.children) {
    if (child instanceof THREE.Line && child.userData.apexBeamGizmoLine) {
      child.geometry.dispose();
      child.geometry = lineFromBeam(beam);
      continue;
    }
    if (child instanceof THREE.Mesh && child.userData.apexBeamEnd === 'start') {
      child.position.set(beam.start.x, beam.start.y, beam.start.z);
      const m = child.material as THREE.MeshBasicMaterial;
      m.color.setHex(activeEnd === 'start' ? START_ACTIVE : START_COLOR);
      continue;
    }
    if (child instanceof THREE.Mesh && child.userData.apexBeamEnd === 'end') {
      child.position.set(beam.end.x, beam.end.y, beam.end.z);
      const m = child.material as THREE.MeshBasicMaterial;
      m.color.setHex(activeEnd === 'end' ? END_ACTIVE : END_COLOR);
    }
  }
}

export function getBeamGizmoPickMeshes(group: THREE.Group): THREE.Mesh[] {
  return group.children.filter(
    (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData.apexBeamEnd != null
  );
}

export function disposeBeamGizmoGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
    if (obj instanceof THREE.Line) {
      obj.geometry?.dispose();
      (obj.material as THREE.Material)?.dispose?.();
    }
  });
}
