import * as THREE from 'three';
import type { CSGRequest, CSGResponse } from './workers/csg.worker';

export class BooleanOperations {
  private static worker: Worker | null = null;
  private static currentId = 0;
  private static callbacks = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  private static getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./workers/csg.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<CSGResponse>) => {
        const { id, success, result, error } = e.data;
        const callback = this.callbacks.get(id);
        if (callback) {
          if (success) callback.resolve(result);
          else callback.reject(new Error(error || 'Unknown error'));
          this.callbacks.delete(id);
        }
      };
    }
    return this.worker;
  }

  private static extractMeshData(mesh: THREE.Mesh) {
    const geometry = mesh.geometry;
    const positions = geometry.getAttribute('position');
    const indices = geometry.getIndex();

    const numVerts = positions.count;
    const numTris = indices ? indices.count / 3 : 0;

    const vertProperties = new Float32Array(numVerts * 3);
    const arrayPos = positions.array as Float32Array;
    for (let i = 0; i < numVerts * 3; i++) {
      vertProperties[i] = arrayPos[i] || 0;
    }

    const triVerts = new Uint32Array(numTris * 3);
    if (indices) {
      const arrayInd = indices.array;
      for (let i = 0; i < numTris * 3; i++) {
        triVerts[i] = arrayInd[i];
      }
    }

    return { vertProperties, triVerts };
  }

  private static createMeshFromResult(result: { vertProperties: Float32Array; triVerts: Uint32Array }, originalMesh: THREE.Mesh): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(result.vertProperties, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.triVerts, 1));
    geometry.computeVertexNormals();

    const originalMaterial = originalMesh.material;
    const material = (Array.isArray(originalMaterial) ? originalMaterial[0] : originalMaterial).clone();
    return new THREE.Mesh(geometry, material);
  }

  private static async runOperation(operation: 'union' | 'subtract' | 'intersect', mesh1: THREE.Mesh, mesh2: THREE.Mesh): Promise<THREE.Mesh> {
    const worker = this.getWorker();
    const id = this.currentId++;

    const data1 = this.extractMeshData(mesh1);
    const data2 = this.extractMeshData(mesh2);

    return new Promise((resolve, reject) => {
      this.callbacks.set(id, {
        resolve: (result) => resolve(this.createMeshFromResult(result, mesh1)),
        reject
      });

      worker.postMessage({
        id,
        operation,
        mesh1: data1,
        mesh2: data2
      } as CSGRequest, [
        data1.vertProperties.buffer,
        data1.triVerts.buffer,
        data2.vertProperties.buffer,
        data2.triVerts.buffer
      ] as any);
    });
  }

  static async union(mesh1: THREE.Mesh, mesh2: THREE.Mesh): Promise<THREE.Mesh> {
    return this.runOperation('union', mesh1, mesh2);
  }

  static async subtract(mesh1: THREE.Mesh, mesh2: THREE.Mesh): Promise<THREE.Mesh> {
    return this.runOperation('subtract', mesh1, mesh2);
  }

  static async intersect(mesh1: THREE.Mesh, mesh2: THREE.Mesh): Promise<THREE.Mesh> {
    return this.runOperation('intersect', mesh1, mesh2);
  }
}

