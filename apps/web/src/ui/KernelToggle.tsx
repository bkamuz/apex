import { useState } from 'react';
import { currentKernel, selectKernel } from '../kernel/geometryKernel';
import type { GeometryKernelName } from '../wasm/apex';
import type { SceneDto } from '../types';

/** Settings: the geometry kernel (exact SMLib BRep or the mesh kernel). */
export function KernelToggle({ onScene }: { onScene: (scene: SceneDto) => void }) {
  const [kernel, setKernel] = useState<GeometryKernelName>(currentKernel());
  return (
    <label className="kernel-toggle" title="Geometry kernel: exact BRep booleans (SMLib) or the mesh kernel">
      <span>Kernel</span>
      <select
        data-testid="kernel-toggle"
        value={kernel}
        onChange={(e) => {
          const name = e.target.value as GeometryKernelName;
          setKernel(name);
          onScene(selectKernel(name, true));
        }}
      >
        <option value="smlib">Exact (SMLib)</option>
        <option value="mesh">Mesh</option>
      </select>
    </label>
  );
}
