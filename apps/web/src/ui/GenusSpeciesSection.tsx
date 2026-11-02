import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { Section } from './inspector/Section';
import type { ComponentDto, ElementDto, SpeciesDto, ParamValue, SceneDto } from '../types';
import { apexExecuteCommand, apexRunQuery, apexSelectElement } from '../wasm/apex';
import { extensions } from '../extensions/sdk';
import { ParamField } from './PropertiesPanel';
import { isTypeBound } from './profileModel';

/**
 * `part="picker"` renders the genus / species selectors and species actions
 * (header); `part="params"` the shared species values with the
 * "affects all N instances" note. Genus & species block for genera (doors, windows, plugin
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
  part = 'picker',
}: {
  part?: 'picker' | 'params';
  element: ElementDto;
  component: ComponentDto;
  components: ComponentDto[];
  onScene: (scene: SceneDto) => void;
  onError?: (message: string) => void;
}) {
  const { t } = useI18n();
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
    const name = window.prompt(
      t('inspector.promptNewSpecies'),
      t('inspector.copyName', { name: current?.name ?? component.display_name }),
    );
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
    const name = window.prompt(t('inspector.promptRenameSpecies'), current.name);
    if (!name || name === current.name) return;
    run({ op: 'update_species', id: current.id, name });
    extensions.notifyCatalogChanged();
  };
  const remove = () => {
    if (!current || !component.default_species) return;
    if (!window.confirm(t('inspector.confirmDeleteSpecies', { name: current.name }))) return;
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

  if (part === 'params') {
    if (!current) return null;
    const shared = current.instances > 1;
    return (
      <Section id="species" title={t('inspector.group.species')} dataSection="species-values">
        <div className={`species-note${shared ? ' is-shared' : ''}`} data-testid="species-usage">
          {shared
            ? t('inspector.speciesAffects', { n: current.instances })
            : t('inspector.speciesAffectsOne')}
        </div>
        {specs.length === 0 ? <div className="empty">{t('inspector.speciesValuesEmpty')}</div> : null}
        {specs.map((spec) => (
          <ParamField
            key={spec.id}
            spec={spec}
            profiles={[]}
            references={[]}
            provenance={{
              id: spec.id,
              value: draft[spec.id] ?? spec.default,
              source: spec.id in current.values ? 'species' : 'genus',
              from: spec.id in current.values ? current.name : component.id,
            }}
            value={draft[spec.id] ?? spec.default}
            onChange={(value) => setDraft((prev) => ({ ...prev, [spec.id]: value }))}
            onCommit={(value) =>
              editSpecies({ [spec.id]: value === undefined ? draft[spec.id] : value })
            }
          />
        ))}
      </Section>
    );
  }

  const deletable = current && current.instances <= 1 && current.id !== component.default_species;
  return (
    <div className="genus-picker" data-section="genus-species">
      <div className="field">
        <label>{t('inspector.genus')}</label>
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
        <label>{t('inspector.species')}</label>
        <select data-testid="genus-species-select" value={speciesId} onChange={(e) => swap(e.target.value)}>
          {ownSpecies.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {row.instances > 0 ? ` · ${row.instances}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="button-row">
        <button
          type="button"
          data-testid="duplicate-species"
          title={t('inspector.duplicateSpeciesTitle')}
          onClick={duplicate}
        >
          {t('inspector.duplicateSpecies')}
        </button>
        <button
          type="button"
          data-testid="rename-species"
          title={t('inspector.renameSpeciesTitle')}
          onClick={rename}
          disabled={!current}
        >
          {t('inspector.renameSpecies')}
        </button>
        <button
          type="button"
          data-testid="delete-species"
          onClick={remove}
          disabled={!deletable}
          title={t('inspector.deleteSpeciesTitle')}
        >
          {t('inspector.deleteSpecies')}
        </button>
      </div>
    </div>
  );
}
