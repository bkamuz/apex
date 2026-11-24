/**
 * Genus editor: the form of a nested genus — which genus and species, where
 * it sits (ref, offset, rotation, mirror), and the binding table that drives
 * the child's params from formulas over this genus's params.
 */
import { useI18n } from '../i18n';
import { componentDisplayName } from '../i18n/display';
import type { ComponentDto, GenusFormula, GenusVec3 } from '../types';
import { CoordInput, field } from './GenusRefPanel';
import { bindableParams, bindingSource, setBinding, type NestedItem } from './nested';
import { AXES, type EvalRef } from './refs';

export interface NestedSpecies {
  id: string;
  name: string;
}

export function GenusNestedForm(props: {
  item: NestedItem;
  /** Genera that can be nested here (no cycles). */
  nestable: ComponentDto[];
  components: ComponentDto[];
  species: NestedSpecies[];
  refs: EvalRef[];
  known: Set<string>;
  values: Record<string, unknown>;
  /** This genus's param ids (unbound child params with the same id take them). */
  ownParams: string[];
  built: number;
  onChange: (item: NestedItem) => void;
  /** Open the nested genus in the editor (user genera: edit; built-in: a copy). */
  onOpen: (genus: string, builtIn: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { item } = props;
  const child = props.components.find((c) => c.id === item.genus);
  const builtIn = child?.source === 'built_in';
  const set = (patch: Partial<NestedItem>) => {
    const next = { ...item, ...patch } as NestedItem & Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    props.onChange(next);
  };
  const off: GenusVec3 = item.offset ?? [0, 0, 0];
  const anchors = props.refs.filter((r) => r.kind === 'point' || r.kind === 'plane');
  const name = (c: ComponentDto) => componentDisplayName(c.id, c.display_name);
  const rows = bindableParams(child);

  return (
    <div className="genus-props genus-nested-form" data-testid="genus-nested-form">
      <div className="genus-props-head">
        <small>{t('genusEditor.kind.nested')}</small>
        <div>
          {child ? name(child) : item.genus} · {item.id}
        </div>
        <button type="button" className="genus-btn is-small genus-props-close" onClick={props.onClose} title={t('genusEditor.close')}>
          ✕
        </button>
      </div>
      <div className="genus-props-sec">
        <label className="genus-field">
          <span className="genus-field-k">{t('genusEditor.prop.genus')}</span>
          <span className="genus-field-v">
            <select value={item.genus} data-testid="genus-nested-genus" onChange={(e) => set({ genus: e.target.value, species: undefined, params: undefined })}>
              {props.nestable.some((c) => c.id === item.genus) ? null : <option value={item.genus}>{item.genus}</option>}
              {props.nestable.map((c) => (
                <option key={c.id} value={c.id}>
                  {name(c)}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="genus-field">
          <span className="genus-field-k">{t('genusEditor.prop.species')}</span>
          <span className="genus-field-v">
            <select value={item.species ?? ''} data-testid="genus-nested-species" onChange={(e) => set({ species: e.target.value || undefined })}>
              <option value="">{t('genusEditor.nested.noSpecies')}</option>
              {props.species.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="genus-field">
          <span className="genus-field-k">{t('genusEditor.nested.at')}</span>
          <span className="genus-field-v">
            <select value={item.at ?? ''} data-testid="genus-nested-at" onChange={(e) => set({ at: e.target.value || undefined })}>
              <option value="">{t('genusEditor.nested.origin')}</option>
              {anchors.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          </span>
        </label>
        {AXES.map((a, i) =>
          field(
            `${t('genusEditor.nested.offset')} ${a.toUpperCase()}`,
            <CoordInput
              value={off[i]}
              known={props.known}
              values={props.values}
              testId={`genus-nested-off-${a}`}
              ariaLabel={`${t('genusEditor.nested.offset')} ${a}`}
              onCommit={(f) => {
                if (f === undefined) return;
                const next = [...off] as GenusVec3;
                next[i] = f;
                set({ offset: next.every((v) => v === 0) ? undefined : next });
              }}
            />,
          ),
        )}
        {field(
          t('genusEditor.nested.rotation'),
          <CoordInput
            value={item.rotation ?? 0}
            known={props.known}
            values={props.values}
            unit="deg"
            testId="genus-nested-rot"
            ariaLabel={t('genusEditor.nested.rotation')}
            onCommit={(f) => f !== undefined && set({ rotation: f === 0 ? undefined : f })}
          />,
        )}
        <label className="genus-check">
          <input type="checkbox" checked={Boolean(item.mirror)} data-testid="genus-nested-mirror" onChange={(e) => set({ mirror: e.target.checked || undefined })} />
          <span>{t('genusEditor.nested.mirror')}</span>
        </label>
      </div>
      <div className="genus-props-sec">
        <div className="genus-sketch-sub">{t('genusEditor.nested.bindings')}</div>
        <p className="genus-props-note">{t('genusEditor.nested.bindHint')}</p>
        <table className="genus-bind-table" data-testid="genus-nested-bindings">
          <tbody>
            {rows.map((p) => {
              const bound = item.params?.[p.id];
              const src = bindingSource(p.id, props.ownParams);
              const placeholder = src === 'same' ? `= ${p.id}` : t('genusEditor.nested.default', { v: String(p.default) });
              return (
                <tr key={p.id} data-param={p.id}>
                  <th scope="row" title={p.id}>
                    {p.label || p.id}
                  </th>
                  <td>
                    <CoordInput
                      value={bound}
                      known={props.known}
                      values={props.values}
                      unit={p.kind === 'length' ? 'mm' : p.kind === 'angle' ? 'deg' : 'none'}
                      allowEmpty
                      placeholder={placeholder}
                      testId={`genus-nested-bind-${p.id}`}
                      ariaLabel={p.label || p.id}
                      onCommit={(f: GenusFormula | undefined) => props.onChange(setBinding(item, p.id, f))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length ? <p className="genus-props-note">{t('genusEditor.nested.noParams')}</p> : null}
      </div>
      <div className="genus-props-sec">
        {field(t('genusEditor.prop.built'), <span data-testid="genus-nested-built">{t('genusEditor.prop.builtCount', { n: props.built })}</span>)}
        <div className="genus-field-row">
          <button type="button" className="genus-btn is-small" data-testid="genus-nested-open" disabled={!child} onClick={() => props.onOpen(item.genus, builtIn)}>
            {t(builtIn ? 'genusEditor.nested.openCopy' : 'genusEditor.nested.open')}
          </button>
          <span className="genus-status-spacer" />
          <button type="button" className="genus-btn is-small is-danger" data-testid="genus-nested-delete" onClick={props.onDelete}>
            {t('genusEditor.nested.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
