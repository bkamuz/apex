import { useEffect, useMemo, useState } from 'react';
import type { ComponentDto, ElementDto, FamilyTypeDto, ParamValue, SceneDto } from '../types';
import { apexExecuteCommand, apexRunQuery, apexSelectElement } from '../wasm/apex';
import { extensions } from '../extensions/sdk';
import { ParamField } from './PropertiesPanel';
import { isTypeBound } from './profileModel';

/**
 * Revit-style family/type block for typed families (doors, windows, plugin
 * openings): swap family or type, edit the shared type (every instance
 * follows), or duplicate it. Fields come from the family's type-bound specs.
 */
export function FamilyTypeSection({
  element,
  component,
  components,
  onScene,
  onError,
}: {
  element: ElementDto;
  component: ComponentDto;
  components: ComponentDto[];
  onScene: (scene: SceneDto) => void;
  onError?: (message: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const types = useMemo(
    () => apexRunQuery({ op: 'list_family_types' }) as FamilyTypeDto[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element, revision],
  );
  const typeId = String(element.params.type ?? '');
  const current = types.find((t) => t.id === typeId);
  const [draft, setDraft] = useState<Record<string, ParamValue>>({});
  useEffect(() => setDraft({ ...(current?.values ?? {}) }), [current]);

  const families = components.filter(
    (c) => c.default_type && c.category === component.category && c.placement === component.placement,
  );
  const ownTypes = types.filter((t) => t.family === component.id);
  const specs = component.params.filter(isTypeBound);

  const run = (command: Record<string, unknown>) => {
    try {
      apexExecuteCommand(command);
      // Commands clear the selection; the element keeps its id, so reselect it.
      onScene(apexSelectElement(element.id));
      setRevision((r) => r + 1);
    } catch (error) {
      onError?.(String(error));
    }
  };
  const swap = (type: string) => run({ op: 'set_element_type', id: element.id, type });
  const editType = (patch: Record<string, ParamValue>) => {
    if (!current || Object.keys(patch).length === 0) return;
    run({ op: 'update_family_type', id: current.id, params: patch });
  };
  const duplicate = () => {
    const name = window.prompt('New type name', `${current?.name ?? component.display_name} copy`);
    if (!name) return;
    try {
      const out = apexExecuteCommand({
        op: 'create_family_type',
        family: component.id,
        name,
        base: current?.id,
      }) as { type: string };
      extensions.notifyCatalogChanged();
      swap(out.type);
    } catch (error) {
      onError?.(String(error));
    }
  };

  return (
    <div className="inspector-section" data-section="family-type">
      <div className="section-title">Family &amp; type</div>
      <div className="field">
        <label>Family</label>
        <select
          data-testid="family-select"
          value={component.id}
          onChange={(e) => {
            const family = families.find((f) => f.id === e.target.value);
            if (family?.default_type) swap(family.default_type);
          }}
        >
          {families.map((f) => (
            <option key={f.id} value={f.id}>
              {f.display_name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Type</label>
        <select data-testid="family-type-select" value={typeId} onChange={(e) => swap(e.target.value)}>
          {ownTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {current ? (
        <>
          <div className="empty" style={{ padding: 0, marginBottom: 4 }}>
            Type values — shared by {current.instances} element{current.instances === 1 ? '' : 's'}
          </div>
          {specs.map((spec) => (
            <ParamField
              key={spec.id}
              spec={spec}
              profiles={[]}
              references={[]}
              value={draft[spec.id] ?? spec.default}
              onChange={(value) => setDraft((prev) => ({ ...prev, [spec.id]: value }))}
              onCommit={(value) =>
                editType({ [spec.id]: value === undefined ? draft[spec.id] : value })
              }
            />
          ))}
        </>
      ) : null}
      <button type="button" data-testid="duplicate-type" onClick={duplicate}>
        Duplicate type…
      </button>
    </div>
  );
}
