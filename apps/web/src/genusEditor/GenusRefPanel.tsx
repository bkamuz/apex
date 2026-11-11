import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { localizedParamLabel } from '../ui/paramLabels';
import type { GenusAxis, GenusFormula, GenusRefDto, GenusVec3 } from '../types';
import { parseFormula } from './formula';
import { NumInput } from './GenusParamsDock';
import { kindOf, type ParamRow } from './params';
import { formulaMessage } from './paramText';
import { AXES, axisIndex, evalFormula, formulaString, refPoints, withPoints, type ListedDim, type ListedRef } from './refs';

const mm = (m: number) => (Number.isFinite(m) ? String(Math.round(m * 1000)) : '—');

/** A coordinate formula (metres): kept as typed, committed once it parses and reads known params. */
function CoordInput(props: {
  value: GenusFormula;
  known: Set<string>;
  values: Record<string, unknown>;
  testId: string;
  ariaLabel: string;
  onCommit: (f: GenusFormula) => void;
}) {
  const { t } = useI18n();
  const shown = formulaString(props.value);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  const parsed = parseFormula(text.replace(',', '.'));
  const unknown = parsed.ok ? parsed.refs.find((r) => !props.known.has(r)) : undefined;
  const error = !parsed.ok
    ? formulaMessage({ field: 'formula', code: 'formula', formula: parsed.error }, t)
    : unknown
      ? formulaMessage({ field: 'formula', code: 'formula', formula: { code: 'unknown', detail: { id: unknown } } }, t)
      : null;
  const value = parsed.ok && !unknown ? evalFormula(text.replace(',', '.'), props.values) : NaN;
  return (
    <span className="genus-coord">
      <input
        className={`genus-cell-input is-mono${error ? ' is-invalid' : ''}`}
        value={text}
        spellCheck={false}
        data-testid={props.testId}
        aria-label={props.ariaLabel}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          setText(shown);
        }}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          const src = v.replace(',', '.').trim();
          const p = parseFormula(src);
          if (src && p.ok && p.refs.every((r) => props.known.has(r))) {
            const n = Number(src);
            props.onCommit(Number.isFinite(n) ? n : src);
          }
        }}
      />
      <span className="genus-coord-mm" data-testid={`${props.testId}-mm`}>
        {error ? '' : `${mm(value)} ${t('genusEditor.mm')}`}
      </span>
      {error ? <span className="genus-field-err" data-testid={`${props.testId}-error`}>{error}</span> : null}
    </span>
  );
}

const field = (label: string, control: React.ReactNode, extra?: React.ReactNode) => (
  <label className="genus-field">
    <span className="genus-field-k">{label}</span>
    <span className="genus-field-v">{control}</span>
    {extra}
  </label>
);

/** Properties of one ref: id, kind, normal, coordinates (formulas in metres), delete. */
export function GenusRefForm(props: {
  item: ListedRef;
  known: Set<string>;
  values: Record<string, unknown>;
  users: string[];
  baseName: string | null;
  nameOf: (id: string) => string;
  onChange: (ref: GenusRefDto) => void;
  onRename: (to: string) => void;
  onDelete: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { ref, inherited, overrides } = props.item;
  const [idText, setIdText] = useState(ref.id);
  useEffect(() => setIdText(ref.id), [ref.id]);
  const idOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(idText);
  const pts = refPoints(ref);
  const setCoord = (i: number, k: number, f: GenusFormula) => {
    const next = pts.map((p, j) => (j === i ? (p.map((x, n) => (n === k ? f : x)) as GenusVec3) : p));
    props.onChange(withPoints(ref, next));
  };
  const coordRow = (i: number, label: string, only?: number) => (
    <div className="genus-field" key={`p${i}`}>
      <span className="genus-field-k">{label}</span>
      <span className="genus-field-v genus-coords">
        {[0, 1, 2]
          .filter((k) => only === undefined || k === only)
          .map((k) => (
            <span className="genus-coord-row" key={k}>
              <span className="genus-coord-axis">{AXES[k].toUpperCase()}</span>
              <CoordInput
                value={pts[i][k]}
                known={props.known}
                values={props.values}
                testId={`genus-ref-coord-${i}-${AXES[k]}`}
                ariaLabel={`${label} ${AXES[k].toUpperCase()}`}
                onCommit={(f) => setCoord(i, k, f)}
              />
            </span>
          ))}
      </span>
    </div>
  );
  return (
    <div className="genus-props genus-param-form" data-testid="genus-ref-form">
      <div className="genus-props-head">
        <small>{t(`genusEditor.refKind.${ref.ref}`)}</small>
        <div>{props.nameOf(ref.id)}</div>
        <button type="button" className="genus-btn is-small genus-props-close" onClick={props.onClose} title={t('genusEditor.close')}>
          ✕
        </button>
      </div>
      <div className="genus-props-sec">
        {inherited || overrides ? (
          <p className="genus-props-note">{t(overrides ? 'genusEditor.ref.overrideNote' : 'genusEditor.ref.inheritedNote', { name: props.baseName ?? '' })}</p>
        ) : null}
        {field(
          t('genusEditor.prop.id'),
          inherited || overrides ? (
            <span className="is-mono">{ref.id}</span>
          ) : (
            <input
              className={`genus-cell-input is-mono${idOk ? '' : ' is-invalid'}`}
              value={idText}
              data-testid="genus-ref-id"
              spellCheck={false}
              onChange={(e) => setIdText(e.target.value)}
              onBlur={() => (idOk && idText !== ref.id ? props.onRename(idText) : setIdText(ref.id))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          ),
          idOk ? null : <div className="genus-field-err">{t('genusEditor.issue.idChars')}</div>,
        )}
        {ref.ref === 'plane'
          ? field(
              t('genusEditor.prop.normal'),
              <select
                value={ref.normal ?? 'z'}
                data-testid="genus-ref-normal"
                onChange={(e) => props.onChange({ ...ref, normal: e.target.value as GenusAxis })}
              >
                {AXES.map((a) => (
                  <option key={a} value={a}>
                    {t(`genusEditor.axis.${a}`)}
                  </option>
                ))}
              </select>,
            )
          : null}
        {ref.ref === 'plane' ? coordRow(0, t('genusEditor.ref.offset'), axisIndex(ref.normal ?? 'z')) : null}
        {ref.ref === 'point' ? coordRow(0, t('genusEditor.prop.at')) : null}
        {ref.ref === 'line' ? [coordRow(0, t('genusEditor.prop.from')), coordRow(1, t('genusEditor.prop.to'))] : null}
        {ref.ref === 'polyline' ? pts.map((_, i) => coordRow(i, t('genusEditor.ref.pointN', { n: i + 1 }))) : null}
        <div className="genus-field-hint">{t('genusEditor.ref.coordHint')}</div>
        {props.users.length ? (
          <p className="genus-props-note" data-testid="genus-ref-users">
            {t('genusEditor.ref.usedBy', { names: props.users.map(props.nameOf).join(', ') })}
          </p>
        ) : null}
        <div className="genus-field-row">
          <span className="genus-status-spacer" />
          {overrides ? (
            <button type="button" className="genus-btn is-small" data-testid="genus-ref-reset" onClick={props.onReset}>
              {t('genusEditor.param.reset')}
            </button>
          ) : null}
          <button
            type="button"
            className="genus-btn is-small is-danger"
            data-testid="genus-ref-delete"
            disabled={props.users.length > 0}
            onClick={props.onDelete}
          >
            {t('genusEditor.ref.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Properties of one dim: refs, axis, value (typing flexes the genus), label param, equal to, locked. */
export function GenusDimForm(props: {
  item: ListedDim;
  value: number;
  axis: GenusAxis | null;
  rows: ParamRow[];
  others: ListedDim[];
  baseName: string | null;
  nameOf: (id: string) => string;
  /** The label param also drives the distance (a ref reads it). */
  driving: boolean;
  onAxis: (axis: GenusAxis) => void;
  onValue: (v: number) => void;
  onBind: (param: string | null) => void;
  onNewParam: () => void;
  onEqual: (dimId: string) => void;
  onLocked: (locked: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { dim, inherited } = props.item;
  const numeric = props.rows.filter((r) => {
    const k = kindOf(r.input);
    return k === 'length' || k === 'number';
  });
  const label = (r: ParamRow) => localizedParamLabel({ label: r.input.label ?? r.id }, t);
  return (
    <div className="genus-props genus-param-form" data-testid="genus-dim-form">
      <div className="genus-props-head">
        <small>{t('genusEditor.kind.dim')}</small>
        <div>{dim.param ? label(props.rows.find((r) => r.id === dim.param) ?? ({ id: dim.param, input: { id: dim.param, default: 0 } } as ParamRow)) : dim.id}</div>
        <button type="button" className="genus-btn is-small genus-props-close" onClick={props.onClose} title={t('genusEditor.close')}>
          ✕
        </button>
      </div>
      <div className="genus-props-sec">
        {inherited ? <p className="genus-props-note">{t('genusEditor.dim.inheritedNote', { name: props.baseName ?? '' })}</p> : null}
        {field(t('genusEditor.prop.id'), <span className="is-mono">{dim.id}</span>)}
        {field(t('genusEditor.dim.between'), <span data-testid="genus-dim-refs">{`${props.nameOf(dim.from)} → ${props.nameOf(dim.to)}`}</span>)}
        {field(
          t('genusEditor.dim.axis'),
          <select value={props.axis ?? ''} data-testid="genus-dim-axis" onChange={(e) => props.onAxis(e.target.value as GenusAxis)}>
            {props.axis === null ? <option value="">{t('genusEditor.dim.straight')}</option> : null}
            {AXES.map((a) => (
              <option key={a} value={a}>
                {t(`genusEditor.axis.${a}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          `${t('genusEditor.dim.value')}, ${t('genusEditor.mm')}`,
          <NumInput value={props.value} length testId="genus-dim-value" disabled={Boolean(dim.locked)} onCommit={props.onValue} />,
          <div className="genus-field-hint">{t(dim.locked ? 'genusEditor.dim.lockedHint' : 'genusEditor.dim.valueHint')}</div>,
        )}
        {field(
          t('genusEditor.dim.label'),
          <select
            value={dim.param ?? ''}
            data-testid="genus-dim-param"
            onChange={(e) => (e.target.value === '+new' ? props.onNewParam() : props.onBind(e.target.value || null))}
          >
            <option value="">{t('genusEditor.dim.noLabel')}</option>
            {numeric.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
            <option value="+new">{t('genusEditor.dim.newParam')}</option>
          </select>,
          dim.param && !props.driving ? <div className="genus-field-hint" data-testid="genus-dim-not-driving">{t('genusEditor.dim.notDriving')}</div> : null,
        )}
        {props.others.length
          ? field(
              t('genusEditor.dim.equal'),
              <select value="" data-testid="genus-dim-equal" onChange={(e) => e.target.value && props.onEqual(e.target.value)}>
                <option value="">—</option>
                {props.others.map((o) => (
                  <option key={o.dim.id} value={o.dim.id}>
                    {o.dim.param ? label(props.rows.find((r) => r.id === o.dim.param) ?? ({ id: o.dim.param, input: { id: o.dim.param, default: 0 } } as ParamRow)) : o.dim.id}
                  </option>
                ))}
              </select>,
              <div className="genus-field-hint">{t('genusEditor.dim.equalHint')}</div>,
            )
          : null}
        <label className="genus-field">
          <span className="genus-field-k">{t('genusEditor.dim.locked')}</span>
          <span className="genus-field-v">
            <input type="checkbox" checked={Boolean(dim.locked)} data-testid="genus-dim-locked" onChange={(e) => props.onLocked(e.target.checked)} />
          </span>
          <div className="genus-field-hint">{t('genusEditor.dim.lockedNote')}</div>
        </label>
        <div className="genus-field-row">
          <span className="genus-status-spacer" />
          <button type="button" className="genus-btn is-small is-danger" data-testid="genus-dim-delete" onClick={props.onDelete}>
            {t('genusEditor.dim.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
