import * as THREE from 'three';
import type { BeamProfile } from './sketch/sketchGeometry';

/** Метаданные балки из эскиза: концы в мировых координатах, профиль, опорный уровень. */
export interface ApexBeamUserData {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  profile: BeamProfile;
  levelId: string;
  /** Мировая координата Y опорного уровня на момент создания (для «высоты от уровня»). */
  levelBaseY: number;
}

export function isApexBeamMesh(
  obj: THREE.Object3D
): obj is THREE.Mesh & { userData: { apexBeam: ApexBeamUserData } } {
  return obj instanceof THREE.Mesh && obj.userData.apexBeam != null;
}
