import { Fragment, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { localizedParamLabel } from '../ui/paramLabels';
import type { ParamValue } from '../types';
import { GenusIcon } from './icons';
import {
  groupOf,
  kindOf,
  resolvedValues,
  sourceOf,
  type DraftSpecies,
  type ParamIssue,
  type ParamRow,
  type ParamSource,
} from './params';
import { formulaMessage } from './paramText';

export interface GenusParamsDockProps {
  rows: ParamRow[];
  issues: Map<string, ParamIssue[]>;
  species: DraftSpecies[];
  /** Species previewed in the views (its column is highlighted). */
  speciesId: string | null;
  selectedParam: string | null;
  /** Species with instances in the project cannot be deleted. */
  usedSpecies: Set<string>;
  compact?: boolean;
  onSelectParam: (id: string | null) => void;
  onSelectSpecies: (id: string) => void;
  onAddParam: () => void;
  onSetFormula: (id: string, formula: string) => void;
  onSetDefault: (id: string, value: ParamValue) => void;
  onSetSpeciesValue: (species: string, param: string, value: ParamValue) => void;
  onToggleBinding: (id: string) => void;
  onAddSpecies: () => void;
  onDuplicateSpecies: () => void;
  onRenameSpecies: (id: string, name: string) => void;
  onDeleteSpecies: () => void;
}

const MM = 1000;

/** Text for a value in the table: lengths in mm. */
export function showValue(value: ParamValue | undefined, kind: string, yes: string, no: string): string {
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? yes : no;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '—';
    const v = kind === 'length' ? value * MM : value;
    return String(Math.round(v * 1000) / 1000);
  }
  return value;
}

/** Number input that keeps the typed text while it is not a number yet. */
export function NumInput(props: {
  value: number;
  length: boolean;
  onCommit: (v: number) => void;
  invalid?: boolean;
  testId?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const shown = (v: number) => (Number.isFinite(v) ? String(Math.round((props.length ? v * MM : v) * 1000) / 1000) : '');
  const [text, setText] = useState(shown(props.value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown(props.value));
  }, [props.value, props.length]);
  return (
    <input
      className={`genus-cell-input${props.invalid ? ' is-invalid' : ''}`}
      inputMode="decimal"
      value={text}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        setText(shown(props.value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(',', '.').trim());
        if (e.target.value.trim() !== '' && Number.isFinite(n)) props.onCommit(props.length ? n / MM : n);
      }}
    />
  );
}

/** Text input that reports every keystroke (formulas, text values, names). */
export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  testId?: string;
  placeholder?: string;
  ariaLabel?: string;
  mono?: boolean;
  title?: string;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  return (
    <input
      className={`genus-cell-input${props.mono ? ' is-mono' : ''}${props.invalid ? ' is-invalid' : ''}`}
      value={props.value}
      placeholder={props.placeholder}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      aria-invalid={props.invalid || undefined}
      title={props.title}
      autoFocus={props.autoFocus}
      spellCheck={false}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onDone}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.stopPropagation();
          props.onDone?.();
        }
      }}
    />
  );
}

export function SourceChip(props: { source: ParamSource; onClick?: () => void; disabled?: boolean; testId?: string; title?: string }) {
  const { t } = useI18n();
  const label = t(`genusEditor.source.${props.source}`);
  if (!props.onClick) {
    return (
      <span className={`genus-chip is-${props.source}`} data-testid={props.testId} title={props.title}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`genus-chip is-${props.source} is-button`}
      data-testid={props.testId}
      title={props.title}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick?.();
      }}
    >
      {label}
    </button>
  );
}

/**
 * Parameters and species dock: one table, params as rows (grouped), species
 * as columns (as in a type catalogue). Species-bound params get a value per
 * species; instance params a default for every instance; computed params a
 * formula with the value it gives per species.
 */
export function GenusParamsDock(props: GenusParamsDockProps) {
  const { t } = useI18n();
  const { rows, species, issues } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const columns: (DraftSpecies | null)[] = species.length ? species : [null];
  const resolved = columns.map((s) => resolvedValues(rows, s));
  const yes = t('genusEditor.yes');
  const no = t('genusEditor.no');
  const groups: string[] = [];
  for (const r of rows) if (!groups.includes(groupOf(r.input))) groups.push(groupOf(r.input));
  const order = ['dimensions', 'visibility', 'materials'];
  groups.sort((a, b) => {
    const ia = order.indexOf(a) < 0 ? (a === 'other' ? 99 : 50) : order.indexOf(a);
    const ib = order.indexOf(b) < 0 ? (b === 'other' ? 99 : 50) : order.indexOf(b);
    return ia - ib;
  });
  const active = species.find((s) => s.id === props.speciesId) ?? null;
  const issueCount = [...issues.values()].reduce((n, l) => n + l.length, 0);

  const cell = (r: ParamRow, col: DraftSpecies | null) => {
    const kind = kindOf(r.input);
    const value = col && r.input.species ? (col.values[r.id] ?? r.input.default) : r.input.default;
    const commit = (v: ParamValue) => (col && r.input.species ? props.onSetSpeciesValue(col.id, r.id, v) : props.onSetDefault(r.id, v));
    const tid = `genus-cell-${r.id}-${col?.id ?? 'default'}`;
    if (r.locked) return <span className="genus-cell-ro">{showValue(value, kind, yes, no)}</span>;
    if (kind === 'bool') {
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          data-testid={tid}
          aria-label={`${localizedParamLabel({ label: r.input.label ?? r.id }, t)} · ${col?.name ?? t('genusEditor.species.defaults')}`}
          onChange={(e) => commit(e.target.checked)}
        />
      );
    }
    if (kind === 'text') return <TextInput value={String(value)} onChange={commit} testId={tid} />;
    const invalid = (issues.get(r.id) ?? []).some((x) => x.field === 'default') && !(col && r.input.species);
    return <NumInput value={Number(value)} length={kind === 'length'} onCommit={commit} invalid={invalid} testId={tid} ariaLabel={`${r.id} ${col?.name ?? ''}`} />;
  };

  return (
    <div className={`genus-dock${props.compact ? ' is-compact' : ''}`} data-testid="genus-params-dock">
      <div className="genus-dock-bar">
        <button type="button" className="genus-btn is-small" data-testid="genus-add-param" onClick={props.onAddParam}>
          <GenusIcon name="addParam" /> {t('genusEditor.dock.addParam')}
        </button>
        <span className="genus-dock-sep" />
        <button type="button" className="genus-btn is-small" data-testid="genus-add-species" onClick={props.onAddSpecies}>
          <GenusIcon name="addSpecies" /> {t('genusEditor.dock.addSpecies')}
        </button>
        <button type="button" className="genus-btn is-small" data-testid="genus-duplicate-species" disabled={!active} onClick={props.onDuplicateSpecies}>
          {t('genusEditor.dock.duplicateSpecies')}
        </button>
        <button type="button" className="genus-btn is-small" data-testid="genus-rename-species" disabled={!active} onClick={() => active && setRenaming(active.id)}>
          {t('genusEditor.dock.renameSpecies')}
        </button>
        <button
          type="button"
          className="genus-btn is-small"
          data-testid="genus-delete-species"
          disabled={!active || props.usedSpecies.has(active.id)}
          title={active && props.usedSpecies.has(active.id) ? t('genusEditor.dock.speciesInUse') : undefined}
          onClick={props.onDeleteSpecies}
        >
          {t('genusEditor.dock.deleteSpecies')}
        </button>
        <span className="genus-dock-spacer" />
        {issueCount ? (
          <span className="genus-dock-issues" data-testid="genus-param-issues">
            ⚠ {t('genusEditor.dock.issues', { n: issueCount })}
          </span>
        ) : props.compact ? null : (
          <span className="genus-dock-hint">{t('genusEditor.dock.hint')}</span>
        )}
      </div>
      <div className="genus-dock-scroll">
        <table className="genus-matrix" data-testid="genus-matrix">
          <thead>
            <tr>
              <th className="genus-matrix-name">{t('genusEditor.param.name')}</th>
              <th className="genus-matrix-formula">{t('genusEditor.param.formula')}</th>
              {columns.map((s) =>
                s ? (
                  <th
                    key={s.id}
                    className={`genus-matrix-species${s.id === props.speciesId ? ' is-active' : ''}`}
                    data-testid={`genus-species-col-${s.id}`}
                    onClick={() => props.onSelectSpecies(s.id)}
                    onDoubleClick={() => setRenaming(s.id)}
                    title={t('genusEditor.dock.speciesColTitle')}
                  >
                    {renaming === s.id ? (
                      <TextInput
                        value={s.name}
                        autoFocus
                        testId="genus-species-name-input"
                        ariaLabel={t('genusEditor.dock.renameSpecies')}
                        onChange={(v) => props.onRenameSpecies(s.id, v)}
                        onDone={() => setRenaming(null)}
                      />
                    ) : (
                      <>
                        {s.id === props.speciesId ? '● ' : ''}
                        {s.name || s.id}
                      </>
                    )}
                  </th>
                ) : (
                  <th key="default" className="genus-matrix-species is-active">
                    {t('genusEditor.species.defaults')}
                  </th>
                ),
              )}
              <th className="genus-matrix-source">{t('genusEditor.param.source')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr className="genus-matrix-group">
                  <td colSpan={columns.length + 3}>
                    <span>{t(`genusEditor.paramGroup.${g}`, undefined, g)}</span>
                  </td>
                </tr>
                {rows
                  .filter((r) => groupOf(r.input) === g)
                  .map((r) => {
                    const src = sourceOf(r.input);
                    const rowIssues = issues.get(r.id) ?? [];
                    const formulaIssue = rowIssues.find((x) => x.field === 'formula');
                    const label = localizedParamLabel({ label: r.input.label ?? r.id }, t);
                    return (
                      <tr
                        key={r.id}
                        className={`genus-matrix-row${props.selectedParam === r.id ? ' is-selected' : ''}${rowIssues.length ? ' is-invalid' : ''}`}
                        data-testid={`genus-param-row-${r.id}`}
                        data-source={src}
                        onClick={() => props.onSelectParam(r.id)}
                      >
                        <td className="genus-matrix-name">
                          <span className="genus-param-label">{label}</span>
                          <span className="genus-param-id">{r.id}</span>
                          {r.inherited ? (
                            <span className="genus-param-tag" title={t(r.overridden ? 'genusEditor.param.overriddenTitle' : 'genusEditor.param.inheritedTitle')}>
                              {t(r.overridden ? 'genusEditor.param.overridden' : 'genusEditor.param.inherited')}
                            </span>
                          ) : null}
                        </td>
                        <td className="genus-matrix-formula" onClick={(e) => e.stopPropagation()}>
                          {r.locked || kindOf(r.input) === 'text' ? (
                            <span className="genus-cell-ro">—</span>
                          ) : (
                            <>
                              <TextInput
                                value={r.input.formula ?? ''}
                                mono
                                placeholder={t('genusEditor.param.formulaPlaceholder')}
                                invalid={Boolean(formulaIssue)}
                                testId={`genus-formula-${r.id}`}
                                ariaLabel={t('genusEditor.param.formulaOf', { name: label })}
                                title={formulaIssue ? formulaMessage(formulaIssue, t) : undefined}
                                onChange={(v) => props.onSetFormula(r.id, v)}
                              />
                              {formulaIssue ? (
                                <div className="genus-cell-err" data-testid={`genus-formula-error-${r.id}`}>
                                  {formulaMessage(formulaIssue, t)}
                                </div>
                              ) : null}
                            </>
                          )}
                        </td>
                        {src === 'instance' ? (
                          <td colSpan={columns.length} className="genus-matrix-instance" onClick={(e) => e.stopPropagation()}>
                            {cell(r, null)}
                            <span className="genus-cell-note">{t('genusEditor.param.perInstance')}</span>
                          </td>
                        ) : (
                          columns.map((s, i) => (
                            <td
                              key={s?.id ?? 'default'}
                              className={`genus-matrix-value${s && s.id === props.speciesId ? ' is-active' : ''}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {src === 'genus' ? (
                                <span className="genus-cell-computed" data-testid={`genus-computed-${r.id}-${s?.id ?? 'default'}`}>
                                  {showValue(resolved[i][r.id], kindOf(r.input), yes, no)}
                                </span>
                              ) : (
                                cell(r, s)
                              )}
                            </td>
                          ))
                        )}
                        <td className="genus-matrix-source">
                          <SourceChip
                            source={src}
                            testId={`genus-source-${r.id}`}
                            disabled={src === 'genus' || r.locked}
                            title={src === 'genus' ? t('genusEditor.source.genusTitle') : t('genusEditor.source.toggleTitle')}
                            onClick={src === 'genus' || r.locked ? undefined : () => props.onToggleBinding(r.id)}
                          />
                        </td>
                      </tr>
                    );
                  })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
