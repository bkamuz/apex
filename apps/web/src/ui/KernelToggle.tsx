import { useState } from 'react';
import { useI18n } from '../i18n';
import { currentKernel, selectKernel } from '../kernel/geometryKernel';
import type { GeometryKernelName } from '../wasm/apex';
import type { SceneDto } from '../types';

/** Settings: the geometry kernel (exact SMLib BRep or the mesh kernel). */
export function KernelToggle({ onScene }: { onScene: (scene: SceneDto) => void }) {
  const { t } = useI18n();
  const [kernel, setKernel] = useState<GeometryKernelName>(currentKernel());
  return (
    <label className="kernel-toggle" title={t('kernel.title')}>
      <span>{t('kernel.label')}</span>
      <select
        data-testid="kernel-toggle"
        value={kernel}
        onChange={(e) => {
          const name = e.target.value as GeometryKernelName;
          setKernel(name);
          onScene(selectKernel(name, true));
        }}
      >
        <option value="smlib">{t('kernel.smlib')}</option>
        <option value="mesh">{t('kernel.mesh')}</option>
      </select>
    </label>
  );
}
