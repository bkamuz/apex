import { useEffect, useState } from 'react';
import type {
  ComponentDto,
  ElementDto,
  LevelDto,
  ParamSpecDto,
  ParamValue,
  ProfileTypeDto,
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
  /** Definition of the selected element's component, which supplies the schema. */
  component: ComponentDto | null;
  profiles: ProfileTypeDto[];
  selectedLevel: LevelDto | null;
  /** Create-tool draft: profile + instance fields used for preview and place. */
  placement: { component: ComponentDto; params: Record<string, ParamValue> } | null;
  onUpdate: (params: Record<string, ParamValue>) => void;
  onPlacementChange: (params: Record<string, ParamValue>) => void;
  onEditType: (profileId: string) => void;
  onNewProfile: (category: string) => void;
  onUpdateLevelElevation: (id: string, elevation: number) => void;
  onDelete: () => void;
}

function stepFor(spec: ParamSpecDto): number {
  return spec.kind === 'angle' ? 0.05 : 0.05;
}

function optionLabel(kind: ParamSpecDto['kind'], option: string, profiles: ProfileTypeDto[]): string {
  if (kind !== 'profile') return option;
  return profileLabel(profiles, option);
}

/** One control per parameter, chosen from the declared kind. */
function ParamField({
  spec,
  value,
  profiles,
  readOnly,
  onChange,
  onCommit,
}: {
  spec: ParamSpecDto;
  value: ParamValue;
  profiles: ProfileTypeDto[];
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
      return (
        <div className="field">
          <label>{label}</label>
          <select
            value={String(value ?? '')}
            disabled={readOnly}
            onChange={(e) => onCommit(e.target.value)}
          >
            {(spec.options ?? []).map((option) => (
              <option key={option} value={option}>
                {optionLabel(spec.kind, option, profiles)}
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
  readOnly,
  live,
  onDraft,
  onCommit,
}: {
  specs: ParamSpecDto[];
  values: Record<string, ParamValue>;
  profiles: ProfileTypeDto[];
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
  return (
    <div className="inspector-section" data-section="type">
      <div className="section-title">Shared type</div>
      <div className="empty" style={{ padding: 0, marginBottom: 4 }}>
        Same for every element of this profile
      </div>
      {specs.length === 0 ? (
        <div className="empty" style={{ padding: 0 }}>
          {profile ? 'No type parameters' : 'Pick a profile'}
        </div>
      ) : (
        specs.map((spec) => (
          <ParamField
            key={spec.id}
            spec={spec}
            profiles={profiles}
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
    recipe: null,
  };
}

export function PropertiesPanel({
  selected,
  selectedCount,
  component,
  profiles,
  selectedLevel,
  placement,
  onUpdate,
  onPlacementChange,
  onEditType,
  onNewProfile,
  onUpdateLevelElevation,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<Record<string, ParamValue>>({});
  const [elevation, setElevation] = useState(0);

  useEffect(() => {
    setDraft(selected ? { ...selected.params } : {});
  }, [selected]);

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
      <div className="inspector-body">
        <div className="field">
          <label>Tool</label>
          <div>{placement.component.display_name}</div>
        </div>
        <div className="inspector-section" data-section="instance">
          <div className="section-title">This element</div>
          <SchemaFields
            specs={specs}
            values={placement.params}
            profiles={profiles}
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

  if (selectedCount > 1) {
    return (
      <div className="inspector-body">
        <div className="empty">{selectedCount} elements selected</div>
        <button type="button" className="danger" onClick={onDelete}>
          Delete selected
        </button>
      </div>
    );
  }

  if (selectedCount === 1 && selected) {
    const profileId = selected.profile_id ?? String(selected.params.profile ?? '');
    const host = component ?? emptyComponent();
    const profile = profiles.find((item) => item.id === profileId);
    const specs = instanceSpecs(host, profile).map((spec) =>
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
      <div className="inspector-body">
        <div className="field">
          <label>Name</label>
          <div>{selected.name}</div>
        </div>
        <div className="field">
          <label>Type</label>
          <div>{component?.display_name ?? selected.component_id}</div>
        </div>
        {selected.length != null ? (
          <div className="field">
            <label>Length</label>
            <div>{selected.length.toFixed(3)} m</div>
          </div>
        ) : null}

        <div className="inspector-section" data-section="instance">
          <div className="section-title">This element</div>
          <SchemaFields
            specs={specs}
            values={draft}
            profiles={profiles}
            onDraft={(id, value) => setDraft((prev) => ({ ...prev, [id]: value }))}
            onCommit={(patch) => apply(patch)}
          />
          {specs.length > 0 ? (
            <button type="button" onClick={() => apply()}>
              Apply
            </button>
          ) : null}
        </div>

        <TypeBlock
          profile={profile}
          values={selected.type_values ?? typeValueMap(profile)}
          profiles={profiles}
          onEditType={onEditType}
        />

        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    );
  }

  if (selectedLevel) {
    const applyLevel = () => onUpdateLevelElevation(selectedLevel.id, elevation);
    return (
      <div className="inspector-body">
        <div className="field">
          <label>Level</label>
          <div>{selectedLevel.name}</div>
        </div>
        <div className="field">
          <label>Elevation</label>
          <input
            type="number"
            step={0.1}
            value={Number(elevation.toFixed(3))}
            onChange={(e) => setElevation(Number(e.target.value))}
            onBlur={applyLevel}
            onKeyDown={(e) => e.key === 'Enter' && applyLevel()}
          />
        </div>
        <button type="button" onClick={applyLevel}>
          Apply elevation
        </button>
        <div className="empty" style={{ padding: 0 }}>
          Double-click the level plane (or its contour) in the viewport to activate it.
        </div>
      </div>
    );
  }

  return (
    <div className="empty">
      Select an element or a level. Double-click a level contour to activate its work plane.
    </div>
  );
}
