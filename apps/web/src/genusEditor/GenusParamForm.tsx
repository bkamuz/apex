import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { localizedParamLabel } from '../ui/paramLabels';
import type { GenusParamInput } from './model';
import { NumInput, SourceChip, TextInput } from './GenusParamsDock';
import { ID_PATTERN, PARAM_KINDS, groupOf, kindOf, sourceOf, type ParamIssue, type ParamKindInput, type ParamRow, type ParamSource } from './params';
import { issueMessage } from './paramText';

export const KNOWN_GROUPS = ['dimensions', 'visibility', 'materials', 'other'];

export interface GenusParamFormProps {
  row: ParamRow;
  issues: ParamIssue[];
  /** Used by the genus's own geometry: cannot be deleted / renamed. */
  usedBy: boolean;
  baseName: string | null;
  onPatch: (patch: Partial<GenusParamInput>) => void;
  onRename: (id: string) => void;
  onSource: (source: ParamSource) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** One param's definition: name, id, kind, group, where it is set, range, formula. */
export function GenusParamForm(props: GenusParamFormProps) {
  const { t } = useI18n();
  const { row } = props;
  const p = row.input;
  const kind = kindOf(p);
  const numeric = kind === 'length' || kind === 'number';
  const src = sourceOf(p);
  const issuesOf = (field: ParamIssue['field']) => props.issues.filter((i) => i.field === field);
  const err = (field: ParamIssue['field']) =>
    issuesOf(field).map((i, n) => (
      <div className="genus-field-err" key={n} data-testid={`genus-param-error-${field}`}>
        {issueMessage(i, t)}
      </div>
    ));
  // The id is renamed on commit (Enter / blur), so references are not
  // rewritten letter by letter.
  const [idText, setIdText] = useState(row.id);
  useEffect(() => setIdText(row.id), [row.id]);
  const idBad = idText !== row.id && !ID_PATTERN.test(idText);
  const field = (label: string, control: React.ReactNode, extra?: React.ReactNode) => (
    <label className="genus-field">
      <span className="genus-field-k">{label}</span>
      <span className="genus-field-v">{control}</span>
      {extra}
    </label>
  );
  const group = groupOf(p);
  const groups = KNOWN_GROUPS.includes(group) ? KNOWN_GROUPS : [...KNOWN_GROUPS, group];

  return (
    <div className="genus-props genus-param-form" data-testid="genus-param-form">
      <div className="genus-props-head">
        <small>{t('genusEditor.kind.param')}</small>
        <div>{localizedParamLabel({ label: p.label ?? row.id }, t)}</div>
        <button type="button" className="genus-btn is-small genus-props-close" onClick={props.onClose} title={t('genusEditor.close')}>
          ✕
        </button>
      </div>
      <div className="genus-props-sec">
        {row.inherited ? (
          <p className="genus-props-note">
            {t(row.overridden ? 'genusEditor.param.overrideNote' : 'genusEditor.param.inheritedNote', { name: props.baseName ?? '' })}
          </p>
        ) : null}
        {row.locked ? <p className="genus-props-note">{t('genusEditor.param.lockedNote')}</p> : null}
        {field(
          t('genusEditor.param.label'),
          <TextInput
            value={row.inherited && !row.overridden ? localizedParamLabel({ label: p.label ?? row.id }, t) : (p.label ?? '')}
            placeholder={row.id}
            testId="genus-param-label"
            onChange={(v) => props.onPatch({ label: v })}
          />,
        )}
        {field(
          t('genusEditor.param.id'),
          row.inherited ? (
            <span className="is-mono">{row.id}</span>
          ) : (
            <TextInput
              value={idText}
              mono
              invalid={idBad}
              testId="genus-param-id"
              title={props.usedBy ? t('genusEditor.param.usedByGeometry') : undefined}
              onChange={setIdText}
              onDone={() => {
                if (idText !== row.id && ID_PATTERN.test(idText)) props.onRename(idText);
                else setIdText(row.id);
              }}
            />
          ),
          <>
            {idBad ? <div className="genus-field-err">{t('genusEditor.issue.idChars')}</div> : null}
            {err('id')}
          </>,
        )}
        {field(
          t('genusEditor.param.kind'),
          <select value={kind} data-testid="genus-param-kind" disabled={row.locked} onChange={(e) => props.onPatch({ kind: e.target.value as ParamKindInput })}>
            {PARAM_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`genusEditor.paramKind.${k}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          t('genusEditor.param.group'),
          <select value={group} data-testid="genus-param-group" onChange={(e) => props.onPatch({ group: e.target.value })}>
            {groups.map((g) => (
              <option key={g} value={g}>
                {t(`genusEditor.paramGroup.${g}`, undefined, g)}
              </option>
            ))}
          </select>,
        )}
        <div className="genus-field">
          <span className="genus-field-k">{t('genusEditor.param.source')}</span>
          <span className="genus-field-v genus-seg-mini" role="radiogroup" aria-label={t('genusEditor.param.source')}>
            {(['species', 'instance', 'genus'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={src === s}
                className={src === s ? 'is-active' : ''}
                data-testid={`genus-param-source-${s}`}
                disabled={row.locked || (s === 'genus' && kind === 'text')}
                title={t(`genusEditor.source.${s}Hint`)}
                onClick={() => props.onSource(s)}
              >
                {t(`genusEditor.source.${s}`)}
              </button>
            ))}
          </span>
        </div>
        {src === 'genus'
          ? field(
              t('genusEditor.param.formula'),
              <TextInput
                value={p.formula ?? ''}
                mono
                invalid={issuesOf('formula').length > 0}
                testId="genus-param-formula"
                placeholder={t('genusEditor.param.formulaPlaceholder')}
                onChange={(v) => props.onPatch({ formula: v })}
              />,
              <>
                {err('formula')}
                <div className="genus-field-hint">{t('genusEditor.param.formulaHint')}</div>
              </>,
            )
          : null}
        {src !== 'genus'
          ? field(
              t(src === 'species' ? 'genusEditor.param.defaultSpecies' : 'genusEditor.param.default'),
              kind === 'bool' ? (
                <input type="checkbox" checked={Boolean(p.default)} data-testid="genus-param-default" disabled={row.locked} onChange={(e) => props.onPatch({ default: e.target.checked })} />
              ) : kind === 'text' ? (
                <TextInput value={String(p.default)} testId="genus-param-default" onChange={(v) => props.onPatch({ default: v })} />
              ) : (
                <NumInput value={Number(p.default)} length={kind === 'length'} testId="genus-param-default" invalid={issuesOf('default').length > 0} disabled={row.locked} onCommit={(v) => props.onPatch({ default: v })} />
              ),
              err('default'),
            )
          : null}
        {numeric ? (
          <>
            {field(
              `${t('genusEditor.param.min')}${kind === 'length' ? `, ${t('genusEditor.mm')}` : ''}`,
              <NumInput value={p.min ?? NaN} length={kind === 'length'} testId="genus-param-min" onCommit={(v) => props.onPatch({ min: v })} />,
            )}
            {field(
              `${t('genusEditor.param.max')}${kind === 'length' ? `, ${t('genusEditor.mm')}` : ''}`,
              <NumInput value={p.max ?? NaN} length={kind === 'length'} testId="genus-param-max" invalid={issuesOf('max').length > 0} onCommit={(v) => props.onPatch({ max: v })} />,
              err('max'),
            )}
            {(p.min !== undefined || p.max !== undefined) && !row.locked ? (
              <button type="button" className="genus-btn is-small" data-testid="genus-param-clear-range" onClick={() => props.onPatch({ min: undefined, max: undefined })}>
                {t('genusEditor.param.clearRange')}
              </button>
            ) : null}
          </>
        ) : null}
        <div className="genus-field-row">
          <SourceChip source={src} />
          <span className="genus-status-spacer" />
          {row.overridden ? (
            <button type="button" className="genus-btn is-small" data-testid="genus-param-reset" onClick={props.onDelete}>
              {t('genusEditor.param.reset')}
            </button>
          ) : !row.inherited ? (
            <button
              type="button"
              className="genus-btn is-small is-danger"
              data-testid="genus-param-delete"
              disabled={props.usedBy}
              title={props.usedBy ? t('genusEditor.param.usedByGeometry') : undefined}
              onClick={props.onDelete}
            >
              {t('genusEditor.param.delete')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
