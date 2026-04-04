/// <reference lib="webworker" />
import Manifold from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';

let manifoldModule: any = null;

async function getManifold(): Promise<any> {
    if (!manifoldModule) {
        manifoldModule = await Manifold({
            locateFile: () => manifoldWasmUrl
        });
        manifoldModule.setup();
    }
    return manifoldModule;
}

export interface CSGMeshData {
    vertProperties: Float32Array;
    triVerts: Uint32Array;
}

export interface CSGRequest {
    id: number;
    operation: 'union' | 'subtract' | 'intersect';
    mesh1: CSGMeshData;
    mesh2: CSGMeshData;
}

export interface CSGResponse {
    id: number;
    success: boolean;
    result?: CSGMeshData;
    error?: string;
}

self.onmessage = async (e: MessageEvent<CSGRequest>) => {
    const { id, operation, mesh1, mesh2 } = e.data;

    try {
        const manifold = await getManifold();

        const m1 = manifold.Manifold.fromMesh({
            vertProperties: mesh1.vertProperties,
            triVerts: Array.from(mesh1.triVerts)
        });

        const m2 = manifold.Manifold.fromMesh({
            vertProperties: mesh2.vertProperties,
            triVerts: Array.from(mesh2.triVerts)
        });

        let resultManifold;
        if (operation === 'union') resultManifold = m1.add(m2);
        else if (operation === 'subtract') resultManifold = m1.subtract(m2);
        else if (operation === 'intersect') resultManifold = m1.intersect(m2);
        else throw new Error('Unknown operation');

        const resultMesh = resultManifold.toMesh();

        m1.delete();
        m2.delete();
        resultManifold.delete();

        // Convert back to arrays to ensure they are transferable buffers
        const outVerts = new Float32Array(resultMesh.vertProperties);
        const outTris = new Uint32Array(resultMesh.triVerts);

        const response: CSGResponse = {
            id,
            success: true,
            result: {
                vertProperties: outVerts,
                triVerts: outTris
            }
        };

        // Transfer buffers
        self.postMessage(response, [outVerts.buffer, outTris.buffer] as any);

    } catch (error) {
        self.postMessage({
            id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
};

export { };
