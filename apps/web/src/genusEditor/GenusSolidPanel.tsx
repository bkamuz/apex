import { useI18n } from '../i18n';
import type { GenusAxis, GenusFormula, GenusSketchItemDto, GenusVec2, GenusVec3 } from '../types';
import { CoordInput, field } from './GenusRefPanel';
import { AXES, axisIndex, formulaString, type EvalRef } from './refs';
import { axisRefs, pathRefs, planeAxes, REF_PREFIX, sketchOf, solidKind, type ShapeItem, type SketchIssue, type SketchTool, type SolidKind } from './sketch';

/** Material ids offered in the picker (a material is data only for now). */
export const MATERIALS = ['wood', 'metal', 'glass', 'concrete', 'stone', 'brick', 'plastic', 'fabric'];

const mm = (m: number) => String(Math.round(m * 1000));

/** A formula with a "bind to reference" select for a plane coordinate along `axis`. */
function RefBound(props: {
  value: GenusFormula;
  axis: number;
  refs: EvalRef[];
  known: Set<string>;
  values: Record<string, unknown>;
  testId: string;
  label: string;
  onCommit: (f: GenusFormula) => void;
}) {
  const { t } = useI18n();
  const planes = props.refs.filter((r) => r.kind === 'plane' && r.normal && axisIndex(r.normal) === props.axis);
  const bound = typeof props.value === 'string' && props.value.startsWith(REF_PREFIX) ? props.value.slice(REF_PREFIX.length) : '';
  return (
    <span className="genus-refbound">
      <CoordInput
        value={props.value}
        known={props.known}
        values={props.values}
        testId={props.testId}
        ariaLabel={props.label}
        onCommit={(f) => f !== undefined && props.onCommit(f)}
      />
      {planes.length ? (
        <select
          className="genus-refbound-ref"
          data-testid={`${props.testId}-ref`}
          aria-label={t('genusEditor.solid.bindRef')}
          title={t('genusEditor.solid.bindRef')}
          value={planes.some((p) => p.id === bound) ? bound : ''}
          onChange={(e) => {
            const id = e.target.value;
            if (id) props.onCommit(`${REF_PREFIX}${id}`);
            else {
              const v = props.values[`${REF_PREFIX}${bound}`];
              if (typeof v === 'number') props.onCommit(Math.round(v * 1e4) / 1e4);
            }
          }}
        >
          <option value="">{t('genusEditor.solid.noRef')}</option>
          {planes.map((p) => (
            <option key={p.id} value={p.id}>
              🔒 {p.id}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}

const KIND_KEY: Record<SolidKind, string> = { extrude: 'extrude', revolve: 'revolve', sweep: 'sweep', box: 'box' };

/** Properties of an authored solid / void: kind, material, visibility, shape fields, sketch, delete. */
export function GenusSolidForm(props: {
  item: ShapeItem;
  refs: EvalRef[];
  known: Set<string>;
  values: Record<string, unknown>;
  textParams: { id: string; label: string }[];
  numberParams: { id: string; label: string }[];
  built: number;
  onChange: (item: ShapeItem) => void;
  onVoid: (makeVoid: boolean) => void;
  onEditSketch: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { item } = props;
  const kind = solidKind(item) as SolidKind;
  const isVoid = item.item === 'cut';
  const set = (patch: Record<string, unknown>) => {
    const next = { ...(item as unknown as Record<string, unknown>), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    props.onChange(next as unknown as ShapeItem);
  };
  const material = item.item === 'solid' ? (item.material ?? '') : '';
  const known = props.known;

  const shapeFields = () => {
    if (item.shape === 'prism') {
      const n = axisIndex(item.normal ?? 'z');
      return (
        <>
          {field(t('genusEditor.solid.plane'), <span className="genus-field-text">{t(`genusEditor.solid.planeOf.${item.normal ?? 'z'}`)}</span>)}
          {(['start', 'end'] as const).map((which, i) => (
            <div className="genus-field" key={which}>
              <span className="genus-field-k">{t(`genusEditor.solid.${which}`)}</span>
              <span className="genus-field-v">
                <RefBound
                  value={item.depth[i]}
                  axis={n}
                  refs={props.refs}
                  known={known}
                  values={props.values}
                  testId={`genus-solid-depth-${i}`}
                  label={t(`genusEditor.solid.${which}`)}
                  onCommit={(f) => set({ depth: item.depth.map((x, k) => (k === i ? f : x)) })}
                />
              </span>
            </div>
          ))}
        </>
      );
    }
    if (item.shape === 'revolve') {
      const axes = axisRefs(item.normal ?? 'z', props.refs);
      return (
        <>
          <label className="genus-field">
            <span className="genus-field-k">{t('genusEditor.solid.axis')}</span>
            <span className="genus-field-v">
              <select data-testid="genus-solid-axis" value={item.axis ?? ''} onChange={(e) => set({ axis: e.target.value || undefined })}>
                {!item.axis ? <option value="">—</option> : null}
                {axes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <div className="genus-field">
            <span className="genus-field-k">{t('genusEditor.solid.angle')}</span>
            <span className="genus-field-v genus-refbound">
              <CoordInput
                value={item.angle ?? 360}
                known={known}
                values={props.values}
                unit="deg"
                testId="genus-solid-angle"
                ariaLabel={t('genusEditor.solid.angle')}
                onCommit={(f) => set({ angle: f })}
              />
              {props.numberParams.length ? (
                <select
                  className="genus-refbound-ref"
                  data-testid="genus-solid-angle-param"
                  aria-label={t('genusEditor.solid.angleParam')}
                  title={t('genusEditor.solid.angleParam')}
                  value={props.numberParams.some((p) => p.id === item.angle) ? String(item.angle) : ''}
                  onChange={(e) => set({ angle: e.target.value || 360 })}
                >
                  <option value="">{t('genusEditor.solid.noParam')}</option>
                  {props.numberParams.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          </div>
          {!axes.length ? <p className="genus-props-note is-warn">{t('genusEditor.sketch.note.noAxis')}</p> : null}
        </>
      );
    }
    if (item.shape === 'sweep') {
      const paths = pathRefs(props.refs);
      return (
        <label className="genus-field">
          <span className="genus-field-k">{t('genusEditor.solid.path')}</span>
          <span className="genus-field-v">
            <select data-testid="genus-solid-path" value={item.along ?? ''} onChange={(e) => set({ along: e.target.value || undefined })}>
              {!item.along ? <option value="">—</option> : null}
              {paths.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          </span>
        </label>
      );
    }
    if (item.shape === 'box') {
      const corner = (which: 'min' | 'max') => (
        <div className="genus-field" key={which}>
          <span className="genus-field-k">{t(`genusEditor.prop.${which}`)}</span>
          <span className="genus-field-v genus-coords">
            {[0, 1, 2].map((k) => (
              <span className="genus-coord-row" key={k}>
                <span className="genus-coord-axis">{AXES[k].toUpperCase()}</span>
                <RefBound
                  value={item[which][k]}
                  axis={k}
                  refs={props.refs}
                  known={known}
                  values={props.values}
                  testId={`genus-solid-${which}-${AXES[k]}`}
                  label={`${t(`genusEditor.prop.${which}`)} ${AXES[k].toUpperCase()}`}
                  onCommit={(f) => set({ [which]: item[which].map((x, n) => (n === k ? f : x)) as GenusVec3 })}
                />
              </span>
            ))}
          </span>
        </div>
      );
      return (
        <>
          {corner('min')}
          {corner('max')}
        </>
      );
    }
    return null;
  };

  return (
    <div className="genus-props genus-solid-form" data-testid="genus-solid-form">
      <div className="genus-props-head">
        <small>{t(isVoid ? 'genusEditor.solid.void' : 'genusEditor.solid.solid')}</small>
        <div>
          {t(`genusEditor.solid.kind.${KIND_KEY[kind]}`)} · {item.id}
        </div>
        <button type="button" className="genus-btn is-small genus-props-close" onClick={props.onClose} title={t('genusEditor.close')}>
          ✕
        </button>
      </div>
      <div className="genus-props-sec">
      <div className="genus-field">
        <span className="genus-field-k">{t('genusEditor.solid.role')}</span>
        <span className="genus-field-v genus-seg-mini" role="radiogroup">
          <button type="button" className={!isVoid ? 'is-active' : ''} aria-pressed={!isVoid} data-testid="genus-solid-role-solid" onClick={() => props.onVoid(false)}>
            {t('genusEditor.solid.solid')}
          </button>
          <button type="button" className={isVoid ? 'is-active' : ''} aria-pressed={isVoid} data-testid="genus-solid-role-void" onClick={() => props.onVoid(true)}>
            {t('genusEditor.solid.void')}
          </button>
        </span>
      </div>
      {isVoid ? <p className="genus-props-note">{t('genusEditor.solid.voidNote')}</p> : null}
      {!isVoid ? (
        <label className="genus-field">
          <span className="genus-field-k">{t('genusEditor.prop.material')}</span>
          <span className="genus-field-v">
            <select
              className="genus-select"
              data-testid="genus-solid-material"
              value={material}
              onChange={(e) => set({ material: e.target.value || undefined })}
            >
              <option value="">{t('genusEditor.solid.noMaterial')}</option>
              {MATERIALS.map((m) => (
                <option key={m} value={m}>
                  {t(`genusEditor.material.${m}`)}
                </option>
              ))}
              {props.textParams.map((p) => (
                <option key={`p:${p.id}`} value={p.id}>
                  {t('genusEditor.solid.materialParam', { name: p.label })}
                </option>
              ))}
              {material && !MATERIALS.includes(material) && !props.textParams.some((p) => p.id === material) ? <option value={material}>{material}</option> : null}
            </select>
          </span>
        </label>
      ) : null}
      <div className="genus-field">
        <span className="genus-field-k">{t('genusEditor.prop.visible')}</span>
        <span className="genus-field-v">
          <CoordInput
            value={item.visible}
            known={known}
            values={props.values}
            unit="none"
            allowEmpty
            placeholder={t('genusEditor.solid.always')}
            testId="genus-solid-visible"
            ariaLabel={t('genusEditor.prop.visible')}
            onCommit={(f) => set({ visible: f })}
          />
        </span>
      </div>
      <p className="genus-props-note">{t('genusEditor.solid.visibleHint')}</p>
      {shapeFields()}
      {field(t('genusEditor.prop.built'), <span className="genus-field-text" data-testid="genus-solid-built">{isVoid ? '—' : t('genusEditor.prop.builtCount', { n: props.built })}</span>)}
      <div className="genus-field-row">
        {sketchOf(item) ? (
          <button type="button" className="genus-btn is-small" data-testid="genus-solid-edit-sketch" onClick={props.onEditSketch}>
            {t('genusEditor.solid.editSketch')}
          </button>
        ) : null}
        <span className="genus-status-spacer" />
        <button type="button" className="genus-btn is-small is-danger" data-testid="genus-solid-delete" onClick={props.onDelete}>
          {t('genusEditor.solid.delete')}
        </button>
      </div>
      </div>
    </div>
  );
}

/** Sketch in progress: status, vertices (formulas, lockable to refs), elements. */
export function GenusSketchForm(props: {
  kind: SolidKind;
  editing: string | null;
  normal: GenusAxis | null;
  items: GenusSketchItemDto[];
  vertices: { q: GenusVec2; at: [number, number]; locked: boolean }[];
  issue: SketchIssue | null;
  tried: boolean;
  known: Set<string>;
  values: Record<string, unknown>;
  tool: SketchTool;
  onTool: (tool: SketchTool) => void;
  onVertex: (from: GenusVec2, to: GenusVec2) => void;
  onItem: (i: number, item: GenusSketchItemDto) => void;
  onRemoveItem: (i: number) => void;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const axes = props.normal ? planeAxes(props.normal) : null;
  const status = props.items.length === 0 ? null : props.issue ? t(`genusEditor.sketch.err.${props.issue.code}`, props.issue.at ? { x: mm(props.issue.at[0]), y: mm(props.issue.at[1]) } : undefined) : t('genusEditor.sketch.closed');
  return (
    <div className="genus-props genus-sketch-form" data-testid="genus-sketch-form">
      <div className="genus-props-head">
        <small>{t('genusEditor.sketch.title')}</small>
        <div>
          {t(`genusEditor.solid.kind.${KIND_KEY[props.kind]}`)}
          {props.editing ? ` · ${props.editing}` : ''}
        </div>
      </div>
      <div className="genus-props-sec">
      {props.kind !== 'box' ? (
        <div className="genus-sketch-draw">
          <div className="genus-sketch-sub">{t('genusEditor.sketch.draw')}</div>
          <span className="genus-seg-mini genus-sketch-tools" role="group" aria-label={t('genusEditor.sketch.draw')}>
            {(['line', 'arc', 'rect', 'circle'] as SketchTool[]).map((tool) => (
              <button key={tool} type="button" className={props.tool === tool ? 'is-active' : ''} aria-pressed={props.tool === tool} data-testid={`genus-sketch-tool-${tool}`} onClick={() => props.onTool(tool)}>
                {t(`genusEditor.sketch.tool.${tool}`)}
              </button>
            ))}
          </span>
        </div>
      ) : null}
      {status ? (
        <p className={`genus-props-note${props.issue ? ' is-warn' : ' is-ok'}`} data-testid="genus-sketch-status" data-ok={props.issue ? 'false' : 'true'}>
          {status}
        </p>
      ) : (
        <p className="genus-props-note">{t(props.kind === 'box' ? 'genusEditor.sketch.hint.box' : 'genusEditor.sketch.hint.start')}</p>
      )}
      {props.kind !== 'box' ? <p className="genus-props-note">{t('genusEditor.sketch.lockHint')}</p> : null}
      {axes && props.vertices.length ? (
        <div className="genus-sketch-list" data-testid="genus-sketch-vertices">
          <h4 className="genus-sketch-sub">{t('genusEditor.sketch.vertices')}</h4>
          {props.vertices.map((v, i) => (
            <div className="genus-field" key={`${formulaString(v.q[0])}|${formulaString(v.q[1])}`}>
              <span className="genus-field-k">
                {v.locked ? '🔒 ' : ''}
                {t('genusEditor.sketch.vertex', { n: i + 1 })}
              </span>
              <span className="genus-field-v genus-coords">
                {[0, 1].map((k) => (
                  <span className="genus-coord-row" key={k}>
                    <span className="genus-coord-axis">{AXES[axes[k]].toUpperCase()}</span>
                    <CoordInput
                      value={v.q[k]}
                      known={props.known}
                      values={props.values}
                      testId={`genus-sketch-v${i}-${k}`}
                      ariaLabel={`${t('genusEditor.sketch.vertex', { n: i + 1 })} ${AXES[axes[k]].toUpperCase()}`}
                      onCommit={(f) => {
                        if (f === undefined) return;
                        const q: GenusVec2 = k === 0 ? [f, v.q[1]] : [v.q[0], f];
                        props.onVertex(v.q, q);
                      }}
                    />
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {props.items.length ? (
        <div className="genus-sketch-list" data-testid="genus-sketch-items">
          <h4 className="genus-sketch-sub">{t('genusEditor.sketch.items')}</h4>
          {props.items.map((it, i) => (
            <div className="genus-field genus-sketch-item" key={i} data-testid={`genus-sketch-item-${i}`}>
              <span className="genus-field-k">{t(`genusEditor.sketch.tool.${it.kind}`)}</span>
              <span className="genus-field-v">
                {it.kind === 'circle' ? (
                  <CoordInput value={it.r} known={props.known} values={props.values} testId={`genus-sketch-r-${i}`} ariaLabel={t('genusEditor.sketch.radius')} onCommit={(f) => f !== undefined && props.onItem(i, { ...it, r: f })} />
                ) : it.kind === 'arc' ? (
                  <CoordInput value={it.bulge} known={props.known} values={props.values} unit="none" testId={`genus-sketch-bulge-${i}`} ariaLabel={t('genusEditor.sketch.bulge')} onCommit={(f) => f !== undefined && props.onItem(i, { ...it, bulge: f })} />
                ) : null}
                <button type="button" className="genus-btn is-small" aria-label={t('genusEditor.sketch.removeItem')} title={t('genusEditor.sketch.removeItem')} onClick={() => props.onRemoveItem(i)}>
                  ×
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="genus-field-row">
        {props.kind !== 'box' ? (
          <button type="button" className="genus-btn is-small is-primary" data-testid="genus-sketch-finish" disabled={Boolean(props.issue) || !props.items.length} onClick={props.onFinish}>
            {t(props.editing ? 'genusEditor.sketch.apply' : 'genusEditor.sketch.finish')}
          </button>
        ) : null}
        <span className="genus-status-spacer" />
        <button type="button" className="genus-btn is-small" data-testid="genus-sketch-cancel" onClick={props.onCancel}>
          {t('genusEditor.sketch.cancel')}
        </button>
      </div>
      </div>
    </div>
  );
}
