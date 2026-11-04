import { localizedParamLabel, localizedUnit } from './paramLabels';
import { apexRunQuery } from '../wasm/apex';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ProvenanceBadge } from './inspector/ProvenanceBadge';
import { Section } from './inspector/Section';
import { ToolIconGlyph } from './ToolIcon';
import { COMPONENT_ICON_BY_ID } from '../tools/icons';
import {
  MIXED,
  canReset,
  checkNumber,
  commonParams,
  groupSpecs,
  provenanceIndex,
  stepFor,
  type ProvenanceRow,
} from './inspector/model';
import {
  componentDisplayName,
  useI18n,
} from '../i18n';
import type {
  ComponentDto,
  ConstructionLineDto,
  ElementDto,
  GridAxisDto,
  LevelDto,
  ParamSpecDto,
  ParamValue,
  ProfileTypeDto,
  ReferenceDto,
  SectionCutDto,
  SpaceDto,
} from '../types';
import {
  applyProfileChange,
  instanceSpecs,
  profileLabel,
  profilesForCategory,
  typeSpecs,
  typeValueMap,
} from './profileModel';

interface Props {
  selected: ElementDto | null;
  /** Total selection size (0, 1, or many). */
  selectedCount: number;
  selectedReference: ReferenceDto | null;
  selectedGridAxis: GridAxisDto | null;
  selectedConstructionLine: ConstructionLineDto | null;
  selectedSectionCut: SectionCutDto | null;
  selectedSpace: SpaceDto | null;
  /** Definition of the selected element's component, which supplies the schema. */
  component: ComponentDto | null;
  profiles: ProfileTypeDto[];
  references: ReferenceDto[];
  selectedLevel: LevelDto | null;
  /** Create-tool draft: profile + instance fields used for preview and place. */
  placement: { component: ComponentDto; params: Record<string, ParamValue> } | null;
  onUpdate: (params: Record<string, ParamValue>) => void;
  /** Sub-element shape editor for slabs / flat roofs. */
  shapeSection?: ReactNode;
  /** Genus/species picker for typed genera (doors, windows) — shown in the header. */
  genusSection?: ReactNode;
  /** Shared species values of a typed genus, with the "affects all N" note. */
  speciesSection?: ReactNode;
  /** Every selected element (multi-selection shows their common params). */
  selectedElements?: ElementDto[];
  components?: ComponentDto[];
  /** Apply one patch to every selected element (one undo step). */
  onUpdateMany?: (params: Record<string, ParamValue>) => void;
  /** Drop instance overrides so the params follow species / genus again. */
  onResetParams?: (params: string[]) => void;
  /** Element count per profile id (species usage for profiled elements). */
  profileUsage?: Record<string, number>;
  /** Attach Top/Base controls for walls and columns. */
  attachSection?: ReactNode;
  onUpdateGridAxis: (params: Record<string, ParamValue>) => void;
  onUpdateConstructionLine: (params: Record<string, ParamValue>) => void;
  onUpdateSectionCut: (params: Record<string, ParamValue>) => void;
  onUpdateSpace: (params: Record<string, ParamValue>) => void;
  onRenameSpace: (name: string) => void;
  onPlacementChange: (params: Record<string, ParamValue>) => void;
  onEditType: (profileId: string) => void;
  onNewProfile: (category: string) => void;
  onUpdateLevelElevation: (id: string, elevation: number) => void;
  onUpdateWallThickness: (thickness: number) => void;
  onDelete: () => void;
  /** Display name of the selected element's parent, when it has one. */
  parentName?: string | null;
  /** For a boolean: its operands by display name, in A/B order. */
  booleanOperands?: { key: string; id: string; name: string }[] | null;
  /** Select another element (used to jump to a boolean operand). */
  onSelectElement?: (id: string) => void;
  /** Clear the selected element's parent (same as the Detach tool). */
  onDetach?: () => void;
  onDeleteGridAxis: () => void;
  onDeleteConstructionLine: () => void;
  onDeleteSectionCut: () => void;
  onDeleteSpace: () => void;
}

/** Readable name for a species id (tool dropdowns list species by id). */
function speciesName(id: string): string {
  try {
    const rows = apexRunQuery({ op: 'list_genus_species' }) as { id: string; name: string }[];
    return rows.find((row) => row.id === id)?.name ?? id;
  } catch {
    return id;
  }
}

function optionLabel(
  spec: ParamSpecDto,
  option: string,
  profiles: ProfileTypeDto[],
  references: ReferenceDto[],
): string {
  if (spec.kind === 'profile') return profileLabel(profiles, option);
  if (spec.kind === 'reference' && option) {
    return references.find((reference) => reference.id === option)?.name ?? option;
  }
  if (spec.id === 'species' && option) return speciesName(option);
  return option;
}

/** Numeric input that keeps the typed text, flags invalid input and never commits NaN. */
function NumberInput({
  spec,
  value,
  mixed,
  readOnly,
  onChange,
  onCommit,
}: {
  spec: ParamSpecDto;
  value: ParamValue;
  mixed?: boolean;
  readOnly?: boolean;
  onChange: (value: ParamValue) => void;
  onCommit: (value?: ParamValue) => void;
}) {
  const { t } = useI18n();
  const shown = mixed ? '' : String(Number(Number(value ?? 0).toFixed(4)));
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const check = checkNumber(text, spec);
  const invalid = focused && !check.ok && !(mixed && text.trim() === '');
  const error = !check.ok
    ? t(`inspector.invalid.${check.reason}`, { limit: check.limit ?? '' })
    : undefined;
  const commit = () => {
    if (check.ok) onCommit(check.value);
    else setText(shown);
  };
  return (
    <>
      <input
        type="number"
        min={spec.min}
        max={spec.max}
        step={stepFor(spec)}
        value={text}
        placeholder={mixed ? t('inspector.mixed') : undefined}
        title={mixed ? t('inspector.mixedTitle') : invalid ? error : undefined}
        aria-invalid={invalid || undefined}
        className={invalid ? 'is-invalid' : undefined}
        disabled={readOnly}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setText(e.target.value);
          const next = checkNumber(e.target.value, spec);
          if (next.ok) onChange(next.value);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setText(shown);
        }}
      />
      {invalid ? <div className="field-error">{error}</div> : null}
    </>
  );
}

/** One control per parameter, chosen from the declared kind. */
export function ParamField({
  spec,
  value,
  profiles,
  references,
  readOnly,
  provenance,
  mixed,
  onReset,
  onChange,
  onCommit,
}: {
  spec: ParamSpecDto;
  value: ParamValue;
  profiles: ProfileTypeDto[];
  references: ReferenceDto[];
  readOnly?: boolean;
  /** Where the value comes from (badge + tooltip); formula values are read-only. */
  provenance?: ProvenanceRow;
  /** Multi-selection: the elements disagree, show "—". */
  mixed?: boolean;
  /** Drop the instance override (shown only for overrides). */
  onReset?: () => void;
  onChange: (value: ParamValue) => void;
  /** Immediate commit, used when the new value is known in this event (select/checkbox). */
  onCommit: (value?: ParamValue) => void;
}) {
  const { t } = useI18n();
  const unit = localizedUnit(spec, t);
  const formula = provenance?.source === 'formula';
  const locked = readOnly || formula;
  const label = (
    <label title={spec.id}>
      <span className="field-label-text">{localizedParamLabel(spec, t)}</span>
      {unit ? <span className="field-unit">{unit}</span> : null}
      {provenance ? <ProvenanceBadge row={provenance} /> : null}
      {onReset && canReset(provenance) && !locked ? (
        <button
          type="button"
          className="field-reset"
          data-testid={`reset-${spec.id}`}
          title={t('inspector.reset')}
          aria-label={t('inspector.reset')}
          onClick={onReset}
        >
          ↺
        </button>
      ) : null}
    </label>
  );
  const formulaNote =
    formula && provenance?.formula ? (
      <div className="field-formula" title={t('inspector.prov.formula', { formula: provenance.formula })}>
        = {provenance.formula}
      </div>
    ) : null;

  switch (spec.kind) {
    case 'bool':
      return (
        <div className="field field-bool" data-param={spec.id}>
          {label}
          <input
            type="checkbox"
            checked={!mixed && Boolean(value)}
            ref={(el) => {
              if (el) el.indeterminate = Boolean(mixed);
            }}
            title={mixed ? t('inspector.mixedTitle') : undefined}
            disabled={locked}
            onChange={(e) => onCommit(e.target.checked)}
          />
        </div>
      );

    case 'choice':
    case 'profile':
    case 'reference':
      return (
        <div className="field" data-param={spec.id}>
          {label}
          <select
            value={mixed ? '__mixed' : String(value ?? '')}
            disabled={locked}
            onChange={(e) => onCommit(e.target.value)}
          >
            {mixed ? (
              <option value="__mixed" disabled>
                {t('inspector.mixed')}
              </option>
            ) : null}
            {(spec.options ?? []).map((option) => (
              <option key={option || '__none'} value={option}>
                {spec.kind === 'reference' && option === ''
                  ? t('inspector.placementRef')
                  : optionLabel(spec, option, profiles, references)}
              </option>
            ))}
          </select>
        </div>
      );

    case 'text':
      return (
        <div className="field" data-param={spec.id}>
          {label}
          <input
            type="text"
            value={mixed ? '' : String(value ?? '')}
            placeholder={mixed ? t('inspector.mixed') : undefined}
            disabled={locked}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onCommit()}
            onKeyDown={(e) => e.key === 'Enter' && onCommit()}
          />
        </div>
      );

    case 'length':
    case 'angle':
    case 'number':
      return (
        <div className={`field${formula ? ' field-formula-row' : ''}`} data-param={spec.id}>
          {label}
          <NumberInput
            spec={spec}
            value={value}
            mixed={mixed}
            readOnly={locked}
            onChange={onChange}
            onCommit={onCommit}
          />
          {formulaNote}
        </div>
      );

    default: {
      const exhaustive: never = spec.kind;
      void exhaustive;
      return null;
    }
  }
}

function withProfileOptions(
  spec: ParamSpecDto,
  component: ComponentDto,
  profiles: ProfileTypeDto[],
  current: string,
): ParamSpecDto {
  if (spec.kind !== 'profile') return spec;
  const ids = profilesForCategory(profiles, component.category).map((profile) => profile.id);
  if (current && !ids.includes(current)) ids.push(current);
  return { ...spec, options: ids };
}

function SchemaFields({
  specs,
  values,
  profiles,
  references,
  readOnly,
  live,
  provenance,
  onReset,
  onDraft,
  onCommit,
}: {
  specs: ParamSpecDto[];
  provenance?: Record<string, ProvenanceRow>;
  onReset?: (id: string) => void;
  values: Record<string, ParamValue>;
  profiles: ProfileTypeDto[];
  references: ReferenceDto[];
  readOnly?: boolean;
  /** Commit on every change, so a placement ghost tracks the inspector. */
  live?: boolean;
  onDraft: (id: string, value: ParamValue) => void;
  onCommit: (patch: Record<string, ParamValue>) => void;
}) {
  return (
    <>
      {specs.map((spec) => (
        <ParamField
          key={spec.id}
          spec={spec}
          profiles={profiles}
          references={references}
          readOnly={readOnly}
          provenance={provenance?.[spec.id]}
          onReset={onReset ? () => onReset(spec.id) : undefined}
          value={values[spec.id] ?? spec.default}
          onChange={(value) => {
            onDraft(spec.id, value);
            if (live) onCommit({ [spec.id]: value });
          }}
          onCommit={(value) => onCommit(value === undefined ? {} : { [spec.id]: value })}
        />
      ))}
    </>
  );
}

/** Shared species values of a profiled element (wall, slab, roof…): read-only here, edited in the species editor. */
function TypeBlock({
  profile,
  values,
  profiles,
  usage,
  onEditType,
  onNewProfile,
}: {
  profile: ProfileTypeDto | undefined;
  values: Record<string, ParamValue>;
  profiles: ProfileTypeDto[];
  /** How many elements use this species; null when unknown (placement). */
  usage?: number | null;
  onEditType: (profileId: string) => void;
  onNewProfile?: () => void;
}) {
  const specs = typeSpecs(profile);
  const { t } = useI18n();
  const speciesRow = (spec: ParamSpecDto): ProvenanceRow | undefined =>
    profile
      ? { id: spec.id, value: values[spec.id] ?? spec.default, source: 'species', from: profile.display_name || profile.id }
      : undefined;
  return (
    <Section id="species" title={t('inspector.group.species')} dataSection="type">
      {profile && usage != null ? (
        <div className={`species-note${usage > 1 ? ' is-shared' : ''}`} data-testid="species-usage">
          {usage > 1 ? t('inspector.speciesAffects', { n: usage }) : t('inspector.speciesAffectsOne')}
        </div>
      ) : null}
      {specs.length === 0 ? (
        <div className="empty" style={{ padding: 0 }}>
          {profile ? t('inspector.noTypeParams') : t('inspector.builtinDefaults')}
        </div>
      ) : (
        specs.map((spec) => (
          <ParamField
            key={spec.id}
            spec={spec}
            profiles={profiles}
            references={[]}
            readOnly
            provenance={speciesRow(spec)}
            value={values[spec.id] ?? spec.default}
            onChange={() => undefined}
            onCommit={() => undefined}
          />
        ))
      )}
      <div className="button-row">
        {profile ? (
          <button type="button" data-testid="edit-type" onClick={() => onEditType(profile.id)}>
            {t('inspector.editSpecies')}
          </button>
        ) : null}
        {onNewProfile ? (
          <button type="button" data-testid="new-profile" onClick={onNewProfile}>
            {t('inspector.drawSpecies')}
          </button>
        ) : null}
      </div>
    </Section>
  );
}

function emptyComponent(): ComponentDto {
  return {
    id: '',
    display_name: '',
    category: '',
    source: 'visual',
    placement: 'point',
    params: [],
    recipe: {
      op: 'extrude',
      profile: { shape: 'rectangle', width: { op: 'const', value: 1 }, height: { op: 'const', value: 1 } },
      height: { op: 'const', value: 1 },
    },
  };
}

function wallThicknessValue(
  selected: ElementDto,
  profile: ProfileTypeDto | undefined,
): number {
  const fromType = selected.type_values?.thickness;
  if (typeof fromType === 'number') return fromType;
  const fromProfile = profile?.type_values?.thickness ?? profile?.params.find((p) => p.id === 'thickness')?.default;
  return typeof fromProfile === 'number' ? fromProfile : 0.2;
}

export function PropertiesPanel({
  selected,
  selectedCount,
  selectedReference,
  selectedGridAxis,
  selectedConstructionLine,
  selectedSectionCut,
  selectedSpace,
  component,
  profiles,
  references,
  selectedLevel,
  placement,
  onUpdate,
  shapeSection,
  genusSection,
  speciesSection,
  selectedElements = [],
  components = [],
  onUpdateMany,
  onResetParams,
  profileUsage,
  attachSection,
  onUpdateGridAxis,
  onUpdateConstructionLine,
  onUpdateSectionCut,
  onUpdateSpace,
  onRenameSpace,
  onPlacementChange,
  onEditType,
  onNewProfile,
  onUpdateLevelElevation,
  onUpdateWallThickness,
  onDelete,
  parentName = null,
  booleanOperands = null,
  onSelectElement,
  onDetach,
  onDeleteGridAxis,
  onDeleteConstructionLine,
  onDeleteSectionCut,
  onDeleteSpace,
}: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Record<string, ParamValue>>({});
  const [gridDraft, setGridDraft] = useState<Record<string, ParamValue>>({});
  const [lineDraft, setLineDraft] = useState<Record<string, ParamValue>>({});
  const [cutDraft, setCutDraft] = useState<Record<string, ParamValue>>({});
  const [spaceDraft, setSpaceDraft] = useState<Record<string, ParamValue>>({});
  const [elevation, setElevation] = useState(0);

  useEffect(() => {
    setDraft(selected ? { ...selected.params } : {});
  }, [selected]);

  // Where every param value comes from (genus / species / instance / formula / inherited).
  const provenance = useMemo(() => {
    if (!selected || selectedCount !== 1) return {};
    try {
      return provenanceIndex(apexRunQuery({ op: 'param_provenance', id: selected.id }) as ProvenanceRow[]);
    } catch {
      return {};
    }
  }, [selected, selectedCount]);

  const multi = useMemo(() => {
    if (selectedCount < 2 || selectedElements.length < 2) return null;
    const items = selectedElements.map((element) => {
      const host = components.find((c) => c.id === element.component_id);
      const profile = profiles.find(
        (item) => item.id === (element.profile_id ?? String(element.params.profile ?? '')),
      );
      const specs = (host ? instanceSpecs(host, profile) : []).filter(
        (spec) => !spec.id.startsWith('_') && spec.kind !== 'profile' && spec.id !== 'species' && spec.kind !== 'reference',
      );
      return { specs, values: element.params };
    });
    return {
      rows: commonParams(items),
      genera: new Set(selectedElements.map((e) => e.component_id)).size,
    };
  }, [selectedCount, selectedElements, components, profiles]);

  useEffect(() => {
    setGridDraft(selectedGridAxis ? { ...selectedGridAxis.params } : {});
  }, [selectedGridAxis]);

  useEffect(() => {
    setLineDraft(selectedConstructionLine ? { ...selectedConstructionLine.params } : {});
  }, [selectedConstructionLine]);

  useEffect(() => {
    setCutDraft(selectedSectionCut ? { ...selectedSectionCut.params } : {});
  }, [selectedSectionCut]);

  useEffect(() => {
    setSpaceDraft(selectedSpace ? { ...selectedSpace.params } : {});
  }, [selectedSpace]);

  useEffect(() => {
    if (!selectedLevel) return;
    setElevation(selectedLevel.elevation);
  }, [selectedLevel]);

  if (placement) {
    const profileId = String(placement.params.profile ?? '');
    const profile = profiles.find((item) => item.id === profileId);
    const specs = instanceSpecs(placement.component, profile).map((spec) =>
      withProfileOptions(spec, placement.component, profiles, profileId),
    );
    const apply = (patch: Record<string, ParamValue>) => {
      let next = { ...placement.params, ...patch };
      if (typeof patch.profile === 'string') {
        next = applyProfileChange(placement.component, profiles, placement.params, patch.profile);
      }
      onPlacementChange(next);
    };
    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label>{t('inspector.tool')}</label>
          <div>
            {componentDisplayName(placement.component.id, placement.component.display_name)}
          </div>
        </div>
        <div className="inspector-section" data-section="instance">
          <div className="section-title">{t('inspector.thisElement')}</div>
          <SchemaFields
            specs={specs}
            values={placement.params}
            profiles={profiles}
            references={references}
            live
            onDraft={() => undefined}
            onCommit={apply}
          />
        </div>
        <TypeBlock
          profile={profile}
          values={typeValueMap(profile)}
          profiles={profiles}
          onEditType={onEditType}
          onNewProfile={() => onNewProfile(placement.component.category)}
        />
      </div>
    );
  }

  if (selectedReference) {
    const [ox, oy, oz] = selectedReference.origin ?? selectedReference.anchors[0] ?? [0, 0, 0];
    const [nx, ny, nz] = selectedReference.normal ?? [0, 1, 0];
    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label>{t('inspector.name')}</label>
          <div>{selectedReference.name}</div>
        </div>
        <div className="field">
          <label>{t('inspector.type')}</label>
          <div>
            {selectedReference.kind === 'plane' ? t('inspector.refPlane') : t('inspector.refPoint')}
          </div>
        </div>
        <div className="field">
          <label>{t('inspector.origin')}</label>
          <div>
            {ox.toFixed(3)}, {oy.toFixed(3)}, {oz.toFixed(3)} m
          </div>
        </div>
        {selectedReference.kind === 'plane' ? (
          <>
            <div className="field">
              <label>{t('inspector.normal')}</label>
              <div>
                {nx.toFixed(3)}, {ny.toFixed(3)}, {nz.toFixed(3)}
              </div>
            </div>
            <div className="field">
              <label>{t('inspector.offset')}</label>
              <div>{(selectedReference.offset ?? 0).toFixed(3)} m</div>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  if (selectedGridAxis) {
    const applyGrid = (patch: Record<string, ParamValue> = {}) => {
      const next = { ...gridDraft, ...patch };
      setGridDraft(next);
      onUpdateGridAxis(next);
    };
    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label>{t('inspector.name')}</label>
          <div>{selectedGridAxis.name}</div>
        </div>
        <div className="field">
          <label>{t('inspector.type')}</label>
          <div>{t('inspector.gridAxis')}</div>
        </div>
        <div className="inspector-section" data-section="instance">
          <div className="section-title">{t('inspector.thisAxis')}</div>
          <SchemaFields
            specs={selectedGridAxis.param_specs}
            values={gridDraft}
            profiles={profiles}
            references={references}
            live
            onDraft={(id, value) => setGridDraft((prev) => ({ ...prev, [id]: value }))}
            onCommit={(patch) => applyGrid(patch)}
          />
        </div>
        <button type="button" className="danger" onClick={onDeleteGridAxis}>
          {t('inspector.delete')}
        </button>
      </div>
    );
  }

  if (selectedConstructionLine) {
    const applyLine = (patch: Record<string, ParamValue> = {}) => {
      const next = { ...lineDraft, ...patch };
      setLineDraft(next);
      onUpdateConstructionLine(next);
    };
    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label>{t('inspector.name')}</label>
          <div>{selectedConstructionLine.name}</div>
        </div>
        <div className="field">
          <label>{t('inspector.type')}</label>
          <div>{t('inspector.constructionLine')}</div>
        </div>
        <div className="inspector-section" data-section="instance">
          <div className="section-title">{t('inspector.thisLine')}</div>
          <SchemaFields
            specs={selectedConstructionLine.param_specs}
            values={lineDraft}
            profiles={profiles}
            references={references}
            live
            onDraft={(id, value) => setLineDraft((prev) => ({ ...prev, [id]: value }))}
            onCommit={(patch) => applyLine(patch)}
          />
        </div>
        <button type="button" className="danger" onClick={onDeleteConstructionLine}>
          {t('inspector.delete')}
        </button>
      </div>
    );
  }

  if (selectedSectionCut) {
    const applyCut = (patch: Record<string, ParamValue> = {}) => {
      const next = { ...cutDraft, ...patch };
      setCutDraft(next);
      onUpdateSectionCut(next);
    };
    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label>{t('inspector.name')}</label>
          <div>{selectedSectionCut.name}</div>
        </div>
        <div className="field">
          <label>{t('inspector.type')}</label>
          <div>{t('inspector.sectionCut')}</div>
        </div>
        <div className="inspector-section" data-section="instance">
          <div className="section-title">{t('inspector.thisSection')}</div>
          <SchemaFields
            specs={selectedSectionCut.param_specs}
            values={cutDraft}
            profiles={profiles}
            references={references}
            live
            onDraft={(id, value) => setCutDraft((prev) => ({ ...prev, [id]: value }))}
            onCommit={(patch) => applyCut(patch)}
          />
        </div>
        <button type="button" className="danger" onClick={onDeleteSectionCut}>
          {t('inspector.delete')}
        </button>
      </div>
    );
  }

  if (selectedSpace) {
    const applySpace = (patch: Record<string, ParamValue> = {}) => {
      const next = { ...spaceDraft, ...patch };
      setSpaceDraft(next);
      onUpdateSpace(next);
    };
    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label htmlFor="space-name">{t('inspector.name')}</label>
          <input
            id="space-name"
            data-testid="space-name"
            key={`${selectedSpace.id}:${selectedSpace.name}`}
            defaultValue={selectedSpace.name}
            onBlur={(e) => onRenameSpace(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.currentTarget.value = selectedSpace.name;
                e.currentTarget.blur();
              }
              e.stopPropagation();
            }}
          />
        </div>
        <div className="field">
          <label>{t('inspector.type')}</label>
          <div>{t('inspector.space')}</div>
        </div>
        <div className="inspector-section" data-section="instance">
          <div className="section-title">{t('inspector.thisSpace')}</div>
          <SchemaFields
            specs={selectedSpace.param_specs}
            values={spaceDraft}
            profiles={profiles}
            references={references}
            live
            onDraft={(id, value) => setSpaceDraft((prev) => ({ ...prev, [id]: value }))}
            onCommit={(patch) => applySpace(patch)}
          />
        </div>
        <button type="button" className="danger" onClick={onDeleteSpace}>
          {t('inspector.delete')}
        </button>
      </div>
    );
  }

  if (selectedCount > 1) {
    const rows = multi?.rows ?? [];
    const groups = groupSpecs(rows.map((row) => row.spec));
    const valueOf = new Map(rows.map((row) => [row.spec.id, row.value]));
    return (
      <div className="inspector-body shell-scroll" data-testid="inspector-multi">
        <div className="inspector-header">
          <div className="inspector-title">{t('inspector.nSelected', { n: selectedCount })}</div>
          {multi ? (
            <div className="inspector-lineage">
              {t('inspector.mixedKinds', { n: selectedCount, k: multi.genera })}
            </div>
          ) : null}
        </div>
        {multi && onUpdateMany ? (
          rows.length === 0 ? (
            <div className="empty">{t('inspector.noCommonParams')}</div>
          ) : (
            <div data-section="common">
              {groups.map((group) => (
                <Section key={group.id} id={`multi-${group.id}`} title={t(`inspector.group.${group.id}`)}>
                  {group.specs.map((spec) => {
                    const value = valueOf.get(spec.id);
                    const mixed = value === MIXED;
                    return (
                      <ParamField
                        key={spec.id}
                        spec={spec}
                        profiles={profiles}
                        references={references}
                        mixed={mixed}
                        value={mixed ? spec.default : (value as ParamValue)}
                        onChange={() => undefined}
                        onCommit={(next) => {
                          if (next !== undefined) onUpdateMany({ [spec.id]: next });
                        }}
                      />
                    );
                  })}
                </Section>
              ))}
            </div>
          )
        ) : null}
        <button type="button" className="danger" onClick={onDelete}>
          {t('inspector.delete')}
        </button>
      </div>
    );
  }

  if (selectedCount === 1 && selected) {
    const profileId = selected.profile_id ?? String(selected.params.profile ?? '');
    const host = component ?? emptyComponent();
    const profile = profiles.find((item) => item.id === profileId);
    // Genera: species-bound values live in the species section.
    const typed = Boolean(component?.default_species);
    const all = instanceSpecs(host, profile)
      .filter((spec) => !(shapeSection && spec.id === 'shape'))
      .filter((spec) => !typed || (spec.binding !== 'type' && spec.id !== 'species'))
      // Internal payload params (e.g. IFC `_mesh` tessellation JSON).
      .filter((spec) => !spec.id.startsWith('_'))
      .filter((spec) => !(booleanOperands && (spec.id === 'operand_a' || spec.id === 'operand_b')))
      .map((spec) =>
        component ? withProfileOptions(spec, component, profiles, profileId) : spec,
      );
    // The species of a profiled element (wall, slab…) is chosen in the header.
    const speciesSpec = all.find((spec) => spec.kind === 'profile');
    const specs = all.filter((spec) => spec !== speciesSpec);
    const userGenus = Boolean(component && !component.id.startsWith('apex.'));
    const groups = groupSpecs(specs, userGenus);
    const apply = (patch: Record<string, ParamValue> = {}) => {
      let next = { ...draft, ...patch };
      if (typeof patch.profile === 'string' && component) {
        next = applyProfileChange(component, profiles, draft, patch.profile);
      }
      setDraft(next);
      onUpdate(next);
    };
    const genusName = component
      ? componentDisplayName(component.id, component.display_name)
      : selected.component_id;
    const speciesLabel = typed
      ? speciesName(String(selected.params.species ?? ''))
      : profile
        ? profileLabel(profiles, profile.id)
        : null;
    const groupBody = (id: string) => {
      const group = groups.find((g) => g.id === id);
      return group ? (
        <SchemaFields
          specs={group.specs}
          values={draft}
          profiles={profiles}
          references={references}
          provenance={provenance}
          onReset={onResetParams ? (param) => onResetParams([param]) : undefined}
          onDraft={(param, value) => setDraft((prev) => ({ ...prev, [param]: value }))}
          onCommit={(patch) => apply(patch)}
        />
      ) : null;
    };
    const has = (id: string) => groups.some((g) => g.id === id);

    const speciesBlock = typed ? speciesSection : profile || speciesSpec ? (
      <TypeBlock
        profile={profile}
        values={selected.type_values ?? typeValueMap(profile)}
        profiles={profiles}
        usage={profile ? (profileUsage?.[profile.id] ?? null) : null}
        onEditType={onEditType}
      />
    ) : null;
    const icon = COMPONENT_ICON_BY_ID[selected.component_id];
    const categoryLabel = t(`inspector.cat.${selected.category}`, undefined, selected.category);

    return (
      <div className="inspector-body shell-scroll">
        <div className="inspector-header" data-testid="inspector-header">
          <div className="inspector-heading-row">
            <span className="inspector-cat-icon" title={categoryLabel} aria-label={categoryLabel} role="img">
              {icon ? <ToolIconGlyph icon={icon} /> : categoryLabel.slice(0, 1)}
            </span>
            <h2 className="inspector-lineage" data-testid="inspector-lineage">
              <span title={t('inspector.genus')}>{genusName}</span>
              {speciesLabel ? (
                <>
                  <span className="lineage-sep" aria-hidden>›</span>
                  <span title={t('inspector.species')}>{speciesLabel}</span>
                </>
              ) : null}
            </h2>
          </div>
          <div className="inspector-title" title={selected.id} data-testid="inspector-title">
            {selected.name}
          </div>
          {genusSection}
          {speciesSpec ? (
            <ParamField
              spec={{ ...speciesSpec, label: t('inspector.species') }}
              profiles={profiles}
              references={references}
              value={draft[speciesSpec.id] ?? speciesSpec.default}
              onChange={() => undefined}
              onCommit={(value) => value !== undefined && apply({ [speciesSpec.id]: value })}
            />
          ) : null}
        </div>

        {speciesBlock}

        <div className="inspector-groups" data-section="instance">
          {has('dimensions') || has('genus') || selected.length != null || selected.category === 'wall' || shapeSection ? (
            <Section id="dimensions" title={t('inspector.group.dimensions')}>
              {groupBody('dimensions')}
              {groupBody('genus')}
              {selected.length != null ? (
                <div className="field">
                  <label>
                    <span className="field-label-text">{t('inspector.length')}</span>
                    <span className="field-unit">m</span>
                  </label>
                  <div className="mono">{selected.length.toFixed(3)}</div>
                </div>
              ) : null}
              {selected.category === 'wall' ? (
                <div className="field" data-testid="wall-thickness-field">
                  <label>
                    <span className="field-label-text">{t('inspector.wallThickness')}</span>
                    <span className="field-unit">m</span>
                  </label>
                  <NumberInput
                    spec={{ id: 'thickness', label: '', kind: 'length', default: 0.2, min: 0.02 }}
                    value={wallThicknessValue(selected, profile)}
                    onChange={() => undefined}
                    onCommit={(value) => typeof value === 'number' && onUpdateWallThickness(value)}
                  />
                  <div className="field-hint">{t('inspector.wallThicknessHint')}</div>
                </div>
              ) : null}
              {shapeSection}
            </Section>
          ) : null}

          {has('constraints') || booleanOperands || attachSection ? (
            <Section id="constraints" title={t('inspector.group.constraints')}>
              {booleanOperands ? (
                <div data-section="boolean-operands">
                  {booleanOperands.map((operand) => (
                    <div className="field" key={operand.key}>
                      <label>
                        {operand.key === 'operand_a' ? t('inspector.solidA') : t('inspector.solidB')}
                      </label>
                      <div className="parent-row">
                        <span data-testid={`boolean-${operand.key}`}>{operand.name}</span>
                        {onSelectElement && operand.name !== t('inspector.missing') && operand.name !== '(missing)' ? (
                          <button type="button" onClick={() => onSelectElement(operand.id)}>
                            {t('tool.select.label')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {groupBody('constraints')}
              {attachSection}
            </Section>
          ) : null}

          <Section id="identity" title={t('inspector.group.identity')} defaultClosed>
            <div className="field">
              <label>{t('inspector.name')}</label>
              <div>{selected.name}</div>
            </div>
            <div className="field">
              <label>{t('inspector.genusId')}</label>
              <div className="mono">{selected.component_id}</div>
            </div>
            <div className="field" data-field="parent">
              <label>{t('inspector.parent')}</label>
              {parentName ? (
                <div className="parent-row">
                  <span data-testid="parent-name">{parentName}</span>
                  {onDetach ? (
                    <button type="button" onClick={onDetach}>
                      {t('inspector.detach')}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="muted">{t('inspector.none')}</div>
              )}
            </div>
            {groupBody('identity')}
          </Section>

          {has('materials') || has('analytics') ? (
            <Section id="more" title={t('inspector.group.more')} defaultClosed>
              {groupBody('materials')}
              {groupBody('analytics')}
            </Section>
          ) : null}
        </div>

        <button type="button" className="danger" onClick={onDelete}>
          {t('inspector.delete')}
        </button>
      </div>
    );
  }

  if (selectedLevel) {
    const applyLevel = () => onUpdateLevelElevation(selectedLevel.id, elevation);
    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label>{t('inspector.level')}</label>
          <div>{selectedLevel.name}</div>
        </div>
        <div className="field">
          <label>{t('inspector.elevation')}</label>
          <input
            type="number"
            step={0.1}
            value={Number(elevation.toFixed(3))}
            onChange={(e) => setElevation(Number(e.target.value))}
            onBlur={applyLevel}
            onKeyDown={(e) => e.key === 'Enter' && applyLevel()}
          />
        </div>
        <p className="panel-hint">{t('inspector.levelActivateHint')}</p>
      </div>
    );
  }

  return (
    <div className="inspector-empty">
      <div className="inspector-empty-title">{t('inspector.nothingSelected')}</div>
      <p className="panel-hint">{t('inspector.emptyHint')}</p>
    </div>
  );
}
