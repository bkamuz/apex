import { useMemo } from 'react';
import type { Tool } from '../tools/Tool';
import type { ComponentDto, ParamValue, ProfileTypeDto, SpeciesDto } from '../types';
import { modeDisplayLabel, speciesDisplayName, toolDisplayLabel, useI18n } from '../i18n';
import { ToolIconGlyph } from './ToolIcon';

export interface ContextBarProps {
  tool: Tool;
  drawMode: string | null;
  onActivateDrawMode: (id: string) => void;
  components: readonly ComponentDto[];
  /** `list_genus_species` rows; read lazily by the host. */
  species: readonly SpeciesDto[];
  /** Profile types: for profiled genera (walls) the profile is the Species. */
  profiles: readonly ProfileTypeDto[];
  /** Placement draft (instance values the next element gets). */
  draft: Readonly<Record<string, ParamValue>>;
  selectedCount: number;
  /** Status / hint text (was the ИНФО line). */
  statusText: string;
  notice: boolean;
}

const fmtLen = (v: ParamValue | undefined, mm: string): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 1000)} ${mm}` : null;

/**
 * Context bar for the active tool (replaces the ИНФО line): Genus › Species,
 * read-only key sizes, draw modes, chain / offset state and key hints. The hint
 * text keeps `data-testid="topbar-hint"`.
 */
export function ContextBar({
  tool,
  drawMode,
  onActivateDrawMode,
  components,
  species,
  profiles,
  draft,
  selectedCount,
  statusText,
  notice,
}: ContextBarProps) {
  const { t } = useI18n();
  const component = useMemo(
    () => (tool.componentId ? components.find((c) => c.id === tool.componentId) : undefined),
    [components, tool.componentId],
  );
  const placing = Boolean(component);
  const sp = useMemo(() => {
    if (!component) return undefined;
    const own = species.filter((s) => s.genus === component.id);
    return own.find((s) => s.id === component.default_species) ?? own.find((s) => s.default) ?? own[0];
  }, [component, species]);
  const profile = useMemo(() => {
    if (!component?.params.some((p) => p.id === 'profile')) return undefined;
    const id = String(draft.profile ?? component.params.find((p) => p.id === 'profile')?.default ?? '');
    return profiles.find((pr) => pr.id === id);
  }, [component, draft.profile, profiles]);
  const sizeOf = (id: string): string | null => {
    if (!component) return null;
    const own = component.params.find((p) => p.id === id);
    const prof = profile?.params.find((p) => p.id === id);
    if (!own && !prof && !(sp && id in sp.values)) return null;
    const v = draft[id] ?? sp?.values[id] ?? profile?.type_values[id] ?? own?.default ?? prof?.default;
    return fmtLen(v, t('ctx.mm'));
  };
  const speciesName = sp ? speciesDisplayName(sp) : profile?.display_name;
  const height = sizeOf('height');
  const thickness = sizeOf('thickness');
  const width = thickness ? null : sizeOf('width');
  const modes = tool.modes ?? [];
  const activeMode = modes.find((m) => m.id === drawMode) ?? modes[0];
  const kind = activeMode?.placement ?? component?.placement;
  const chain = component?.joinable === true && kind === 'two_point';
  const freeElevation = component?.placement_options?.seat_on_level === false;
  const isWall = component?.id === 'apex.wall';

  return (
    <div className={`context-bar${notice ? ' context-bar--notice' : ''}`} data-testid="context-bar">
      <span className="ctx-tool">
        <ToolIconGlyph icon={tool.icon} />
        <b>{toolDisplayLabel(tool)}</b>
      </span>
      {placing ? (
        <span className="ctx-item" title={t('ctx.genusSpecies')} data-testid="ctx-genus-species">
          <span className="ctx-k">{t('ctx.genusSpecies')}</span>
          <span>
            {toolDisplayLabel(tool)}
            {speciesName ? ` › ${speciesName}` : ''}
          </span>
        </span>
      ) : null}
      {height ? (
        <span className="ctx-item">
          <span className="ctx-k">{t('ctx.height')}</span>
          <span className="ctx-num">{height}</span>
        </span>
      ) : null}
      {thickness || width ? (
        <span className="ctx-item">
          <span className="ctx-k">{t(thickness ? 'ctx.thickness' : 'ctx.width')}</span>
          <span className="ctx-num">{thickness ?? width}</span>
        </span>
      ) : null}
      {isWall ? (
        <span className="ctx-item" data-ctx="align" title={t('ctx.alignmentTitle')}>
          <span className="ctx-k">{t('ctx.alignment')}</span>
          <span>{t('ctx.alignmentCenter')}</span>
        </span>
      ) : null}
      {modes.length > 0 ? (
        <span className="ctx-item ctx-modes" role="group" aria-label={t('toolbar.drawMode')}>
          {modes.map((mode) => {
            const label = modeDisplayLabel(mode);
            return (
              <button
                key={mode.id}
                type="button"
                className={`mode${drawMode === mode.id ? ' active' : ''}`}
                aria-label={label}
                aria-pressed={drawMode === mode.id}
                title={label}
                onClick={() => onActivateDrawMode(mode.id)}
              >
                {label}
              </button>
            );
          })}
        </span>
      ) : null}
      {chain ? (
        <span className="ctx-item" title={t('ctx.chainTitle')} data-testid="ctx-chain">
          <span className="ctx-k">{t('ctx.chain')}</span>
          <span className="ctx-on">{t('ctx.chainOn')}</span>
        </span>
      ) : null}
      {freeElevation ? (
        <span className="ctx-item" title={t('ctx.offsetTitle')}>
          <span className="ctx-k">{t('ctx.offset')}</span>
          <kbd>PgUp</kbd>
          <kbd>PgDn</kbd>
        </span>
      ) : null}
      {!placing && selectedCount > 0 ? (
        <span className="ctx-item">{t('ctx.selected', { count: selectedCount })}</span>
      ) : null}
      <span className="topbar-hint ctx-hint" data-testid="topbar-hint">
        <span>{statusText}</span>
      </span>
      <span className="ctx-keys" aria-label={t('ctx.keys')}>
        <span>
          <kbd>Esc</kbd> {t('ctx.key.esc')}
        </span>
        {placing ? (
          <>
            <span>
              <kbd>Enter</kbd> {t('ctx.key.enter')}
            </span>
            <span>
              <kbd>Shift</kbd> {t('ctx.key.shift')}
            </span>
            <span>
              <kbd>0–9</kbd> {t('ctx.key.digits')}
            </span>
          </>
        ) : null}
        <span>
          <kbd>Ctrl K</kbd> {t('ctx.key.palette')}
        </span>
      </span>
    </div>
  );
}
