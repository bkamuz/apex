import { useEffect, useMemo, useState } from 'react';
import type { ComponentDto, ElementDto, SpeciesDto, ParamValue, SceneDto } from '../types';
import { apexExecuteCommand, apexRunQuery, apexSelectElement } from '../wasm/apex';
import { extensions } from '../extensions/sdk';
import { ParamField } from './PropertiesPanel';
import { isTypeBound } from './profileModel';

/**
 * Genus & species block for genera (doors, windows, plugin
 * openings): swap genus or species, edit the shared species (every instance
 * follows), duplicate, rename or delete it. Fields come from the genus's
 * species-bound specs. Hierarchy: genus -> species -> instance.
 */
export function GenusSpeciesSection({
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
  const speciesRows = useMemo(
    () => apexRunQuery({ op: 'list_genus_species' }) as SpeciesDto[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element, revision],
  );
  const speciesId = String(element.params.species ?? '');
  const current = speciesRows.find((t) => t.id === speciesId);
  const [draft, setDraft] = useState<Record<string, ParamValue>>({});
  useEffect(() => setDraft({ ...(current?.values ?? {}) }), [current]);

  const genera = components.filter(
    (c) => c.default_species && c.category === component.category && c.placement === component.placement,
  );
  const ownSpecies = speciesRows.filter((t) => t.genus === component.id);
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
  const swap = (species: string) => run({ op: 'set_element_species', id: element.id, species });
  const editSpecies = (patch: Record<string, ParamValue>) => {
    if (!current || Object.keys(patch).length === 0) return;
    run({ op: 'update_species', id: current.id, params: patch });
  };
  const duplicate = () => {
    const name = window.prompt('New species name', `${current?.name ?? component.display_name} copy`);
    if (!name) return;
    try {
      const out = apexExecuteCommand({
        op: 'create_species',
        genus: component.id,
        name,
        base: current?.id,
      }) as { species: string };
      extensions.notifyCatalogChanged();
      swap(out.species);
    } catch (error) {
      onError?.(String(error));
    }
  };

  const rename = () => {
    if (!current) return;
    const name = window.prompt('Rename species', current.name);
    if (!name || name === current.name) return;
    run({ op: 'update_species', id: current.id, name });
    extensions.notifyCatalogChanged();
  };
  const remove = () => {
    if (!current || !component.default_species) return;
    if (!window.confirm(`Delete species "${current.name}"? This instance moves to the genus default.`)) return;
    const doomed = current.id;
    try {
      apexExecuteCommand({ op: 'set_element_species', id: element.id, species: component.default_species });
      apexExecuteCommand({ op: 'delete_species', id: doomed });
      extensions.notifyCatalogChanged();
      onScene(apexSelectElement(element.id));
      setRevision((r) => r + 1);
    } catch (error) {
      onError?.(String(error));
    }
  };

  return (
    <div className="inspector-section" data-section="genus-species">
      <div className="section-title">Genus &amp; species</div>
      <div className="field">
        <label>Genus</label>
        <select
          data-testid="genus-select"
          value={component.id}
          onChange={(e) => {
            const genus = genera.find((f) => f.id === e.target.value);
            if (genus?.default_species) swap(genus.default_species);
          }}
        >
          {genera.map((f) => (
            <option key={f.id} value={f.id}>
              {f.display_name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Species</label>
        <select data-testid="genus-species-select" value={speciesId} onChange={(e) => swap(e.target.value)}>
          {ownSpecies.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {current ? (
        <>
          <div className="empty" style={{ padding: 0, marginBottom: 4 }}>
            Species values — shared by {current.instances} instance{current.instances === 1 ? '' : 's'}
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
                editSpecies({ [spec.id]: value === undefined ? draft[spec.id] : value })
              }
            />
          ))}
        </>
      ) : null}
      <div className="button-row" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" data-testid="duplicate-species" onClick={duplicate}>
          Duplicate…
        </button>
        <button type="button" data-testid="rename-species" onClick={rename} disabled={!current}>
          Rename…
        </button>
        <button
          type="button"
          data-testid="delete-species"
          onClick={remove}
          disabled={!current || current.instances > 1 || current.id === component.default_species}
          title="Delete an unused species: the instance moves to the genus default first"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
