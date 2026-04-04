import * as THREE from 'three';

export interface PrimitiveOptions {
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  heightTop?: number;
  heightBottom?: number;
  radialSegments?: number;
}

export class PrimitiveGenerator {
  static createBox(
    width = 1,
    height = 1,
    depth = 1,
    material?: THREE.Material
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const mat = material || new THREE.MeshStandardMaterial({ color: 0x808080 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'IfcBuildingElementProxy';
    return mesh;
  }

  static createCylinder(
    radius = 0.5,
    height = 1,
    radialSegments = 16,
    material?: THREE.Material
  ): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(radius, radius, height, radialSegments);
    const mat = material || new THREE.MeshStandardMaterial({ color: 0x808080 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'IfcColumn';
    return mesh;
  }

  static createSphere(
    radius = 0.5,
    radialSegments = 16,
    material?: THREE.Material
  ): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(radius, radialSegments, radialSegments);
    const mat = material || new THREE.MeshStandardMaterial({ color: 0x808080 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'IfcBuildingElementProxy';
    return mesh;
  }

  static createBeam(
    width = 0.3,
    height = 0.6,
    length = 6,
    material?: THREE.Material
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, length);
    const mat = material || new THREE.MeshStandardMaterial({ color: 0x8B4513 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'IfcBeam';
    return mesh;
  }

  static createSlab(
    width = 5,
    depth = 5,
    thickness = 0.2,
    material?: THREE.Material
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, thickness, depth);
    const mat = material || new THREE.MeshStandardMaterial({ color: 0x808080 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'IfcSlab';
    return mesh;
  }

  static createWall(
    width = 5,
    height = 3,
    thickness = 0.2,
    material?: THREE.Material
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, thickness);
    const mat = material || new THREE.MeshStandardMaterial({ color: 0xD3D3D3 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'IfcWall';
    return mesh;
  }
}
