import { apexRunQuery } from '../wasm/apex';
import { useEffect, useState, type ReactNode } from 'react';
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
  /** Genus/type block for typed genera (doors, windows). */
  genusSection?: ReactNode;
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

function stepFor(spec: ParamSpecDto): number {
  return spec.kind === 'angle' ? 0.05 : 0.05;
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

/** One control per parameter, chosen from the declared kind. */
export function ParamField({
  spec,
  value,
  profiles,
  references,
  readOnly,
  onChange,
  onCommit,
}: {
  spec: ParamSpecDto;
  value: ParamValue;
  profiles: ProfileTypeDto[];
  references: ReferenceDto[];
  readOnly?: boolean;
  onChange: (value: ParamValue) => void;
  /** Immediate commit, used when the new value is known in this event (select/checkbox). */
  onCommit: (value?: ParamValue) => void;
}) {
  const label = spec.unit ? `${spec.label} (${spec.unit})` : spec.label;

  switch (spec.kind) {
    case 'bool':
      return (
        <div className="field">
          <label>{label}</label>
          <input
            type="checkbox"
            checked={Boolean(value)}
            disabled={readOnly}
            onChange={(e) => onCommit(e.target.checked)}
          />
        </div>
      );

    case 'choice':
    case 'profile':
    case 'reference':
      return (
        <div className="field">
          <label>{label}</label>
          <select
            value={String(value ?? '')}
            disabled={readOnly}
            onChange={(e) => onCommit(e.target.value)}
          >
            {(spec.options ?? []).map((option) => (
              <option key={option || '__none'} value={option}>
                {spec.kind === 'reference' && option === ''
                  ? '(placement)'
                  : optionLabel(spec, option, profiles, references)}
              </option>
            ))}
          </select>
        </div>
      );

    case 'text':
      return (
        <div className="field">
          <label>{label}</label>
          <input
            type="text"
            value={String(value ?? '')}
            disabled={readOnly}
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
        <div className="field">
          <label>{label}</label>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            step={stepFor(spec)}
            value={Number(Number(value ?? 0).toFixed(4))}
            disabled={readOnly}
            onChange={(e) => onChange(Number(e.target.value))}
            onBlur={() => onCommit()}
            onKeyDown={(e) => e.key === 'Enter' && onCommit()}
          />
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
  onDraft,
  onCommit,
}: {
  specs: ParamSpecDto[];
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

function TypeBlock({
  profile,
  values,
  profiles,
  onEditType,
  onNewProfile,
}: {
  profile: ProfileTypeDto | undefined;
  values: Record<string, ParamValue>;
  profiles: ProfileTypeDto[];
  onEditType: (profileId: string) => void;
  onNewProfile?: () => void;
}) {
  const specs = typeSpecs(profile);
  const { t } = useI18n();
  return (
    <div className="inspector-section" data-section="type">
      <div className="section-title">{t('inspector.sharedType')}</div>
      <div className="empty" style={{ padding: 0, marginBottom: 4 }}>
        Same for every element of this profile
      </div>
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
            value={values[spec.id] ?? spec.default}
            onChange={() => undefined}
            onCommit={() => undefined}
          />
        ))
      )}
      {profile ? (
        <button type="button" data-testid="edit-type" onClick={() => onEditType(profile.id)}>
          Edit profile
        </button>
      ) : null}
      {onNewProfile ? (
        <button type="button" data-testid="new-profile" onClick={onNewProfile}>
          Draw new profile
        </button>
      ) : null}
    </div>
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
    return (
      <div className="inspector-body shell-scroll">
        <div className="empty">{t('inspector.nSelected', { n: selectedCount })}</div>
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
    // Genera: species-bound values live in the genus & species section.
    const typed = Boolean(component?.default_species);
    const specs = instanceSpecs(host, profile)
      .filter((spec) => !(shapeSection && spec.id === 'shape'))
      .filter((spec) => !typed || (spec.binding !== 'type' && spec.id !== 'species'))
      // Internal payload params (e.g. IFC `_mesh` tessellation JSON).
      .filter((spec) => !spec.id.startsWith('_'))
      .map((spec) =>
        component ? withProfileOptions(spec, component, profiles, profileId) : spec,
      );
    const apply = (patch: Record<string, ParamValue> = {}) => {
      let next = { ...draft, ...patch };
      if (typeof patch.profile === 'string' && component) {
        next = applyProfileChange(component, profiles, draft, patch.profile);
      }
      setDraft(next);
      onUpdate(next);
    };

    return (
      <div className="inspector-body shell-scroll">
        <div className="field">
          <label>{t('inspector.name')}</label>
          <div>{selected.name}</div>
        </div>
        <div className="field">
          <label>{t('inspector.type')}</label>
          <div>
            {component
              ? componentDisplayName(component.id, component.display_name)
              : selected.component_id}
          </div>
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
        {selected.length != null ? (
          <div className="field">
            <label>{t('inspector.length')}</label>
            <div>{selected.length.toFixed(3)} m</div>
          </div>
        ) : null}

        {selected.category === 'wall' ? (
          <div className="field" data-testid="wall-thickness-field">
            <label>{t('inspector.wallThickness')}</label>
            <input
              type="number"
              step={0.01}
              min={0.02}
              value={Number(wallThicknessValue(selected, profile).toFixed(3))}
              onChange={(e) => onUpdateWallThickness(Number(e.target.value))}
            />
            <div className="empty" style={{ padding: 0, marginTop: 4 }}>
              Assigns a dedicated profile variant for this wall only.
            </div>
          </div>
        ) : null}

        {booleanOperands ? (
          <div className="inspector-section" data-section="boolean-operands">
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

        <div className="inspector-section" data-section="instance">
          <div className="section-title">{t('inspector.thisElement')}</div>
          <SchemaFields
            specs={
              booleanOperands
                ? specs.filter((spec) => spec.id !== 'operand_a' && spec.id !== 'operand_b')
                : specs
            }
            values={draft}
            profiles={profiles}
            references={references}
            onDraft={(id, value) => setDraft((prev) => ({ ...prev, [id]: value }))}
            onCommit={(patch) => apply(patch)}
          />
        </div>

        {genusSection}

        {shapeSection}

        {attachSection}

        {typed ? null : (
          <TypeBlock
            profile={profile}
            values={selected.type_values ?? typeValueMap(profile)}
            profiles={profiles}
            onEditType={onEditType}
          />
        )}

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
