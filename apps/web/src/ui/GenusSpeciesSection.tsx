import { useEffect, useMemo, useState } from 'react';
import { componentDisplayName, speciesDisplayName, useI18n } from '../i18n';
import { generaForCategorySwitch, genusTooltip } from '../tools/categorySlots';
import { specsForContent } from './inspector/model';
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

  const genera = generaForCategorySwitch(
    component,
    components,
    new Set(speciesRows.map((row) => row.genus)),
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
      t('inspector.copyName', { name: current ? speciesDisplayName(current) : component.display_name }),
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
    const name = window.prompt(t('inspector.promptRenameSpecies'), speciesDisplayName(current));
    if (!name || name === current.name) return;
    run({ op: 'update_species', id: current.id, name });
    extensions.notifyCatalogChanged();
  };
  const remove = () => {
    if (!current || !component.default_species) return;
    if (!window.confirm(t('inspector.confirmDeleteSpecies', { name: speciesDisplayName(current) }))) return;
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
    const content = current.values.content ?? specs.find((spec) => spec.id === 'content')?.default;
    const shown = specsForContent(component.id, specs, content);
    return (
      <Section id="species" title={t('inspector.group.species')} dataSection="species-values">
        <div className={`species-note${shared ? ' is-shared' : ''}`} data-testid="species-usage">
          {shared
            ? t('inspector.speciesAffects', { n: current.instances })
            : t('inspector.speciesAffectsOne')}
        </div>
        {shown.length === 0 ? <div className="empty">{t('inspector.speciesValuesEmpty')}</div> : null}
        {shown.map((spec) => (
          <ParamField
            key={spec.id}
            spec={spec}
            profiles={[]}
            references={[]}
            provenance={{
              id: spec.id,
              value: draft[spec.id] ?? spec.default,
              source: spec.id in current.values ? 'species' : 'genus',
              from: spec.id in current.values ? speciesDisplayName(current) : component.id,
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
          title={genusTooltip(component)}
          onChange={(e) => {
            const genus = genera.find((f) => f.id === e.target.value);
            if (!genus) return;
            const next =
              genus.default_species ?? speciesRows.find((row) => row.genus === genus.id)?.id;
            if (next) swap(next);
          }}
        >
          {genera.map((f) => (
            <option key={f.id} value={f.id}>
              {componentDisplayName(f.id, f.display_name)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{t('inspector.species')}</label>
        <select data-testid="genus-species-select" value={speciesId} onChange={(e) => swap(e.target.value)}>
          {ownSpecies.map((row) => (
            <option key={row.id} value={row.id}>
              {speciesDisplayName(row)}
            </option>
          ))}
        </select>
      </div>
      <div className="button-row button-row--compact">
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
