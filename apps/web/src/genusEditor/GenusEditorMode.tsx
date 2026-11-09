import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { componentDisplayName, useI18n } from '../i18n';
import { useTheme } from '../theme/useTheme';
import { THEME_PREFERENCES } from '../theme/theme';
import type { ComponentDto, GenusDefDto, GenusPreviewDto } from '../types';
import { currentKernel, pumpKernelJobs } from '../kernel/geometryKernel';
import { apexExecuteCommand, apexPreviewGenus, apexRunQuery } from '../wasm/apex';
import { Genus3DView } from './Genus3DView';
import { GenusOrthoView } from './GenusOrthoView';
import { GenusStructureTree } from './GenusStructureTree';
import { GenusIcon } from './icons';
import {
  buildTree,
  defineGenusCommand,
  deriveDraft,
  draftFromGenus,
  draftKey,
  effectivePlacement,
  previewRequest,
  testHostFor,
  type GenusDraft,
  type GenusEditorTarget,
  type GetGenusDto,
} from './model';
import { buildView, type OrthoView } from './projection';
import { setGenusEditorOpen } from './session';
import './genusEditor.css';

type OkPreview = Extract<GenusPreviewDto, { ok: true }>;
type RibbonTab = 'create' | 'modify' | 'params' | 'view';
type Layout = 'all' | OrthoView | '3d';
type PaneView = OrthoView | '3d';
type SidePanel = 'properties' | 'params';

interface SpeciesRow {
  id: string;
  name: string;
  default?: boolean;
  values?: Record<string, unknown>;
}

export interface GenusEditorModeProps {
  target: GenusEditorTarget;
  components: ComponentDto[];
  isMobile: boolean;
  /** Project file name for the "back to project" crumb. */
  projectName: string;
  onExit: () => void;
  /** After define_genus ran: refresh the project's catalog / scene. */
  onSaved: (genusId: string) => void;
}

function getGenus(id: string): GetGenusDto | null {
  try {
    return apexRunQuery({ op: 'get_genus', id }) as GetGenusDto;
  } catch {
    return null;
  }
}

function listSpecies(genus: string): SpeciesRow[] {
  try {
    const rows = apexRunQuery({ op: 'list_genus_species', genus });
    return Array.isArray(rows) ? (rows as SpeciesRow[]) : [];
  } catch {
    return [];
  }
}

interface Session {
  draft: GenusDraft;
  /** draftKey of the saved state; null = never saved (new genus). */
  savedKey: string | null;
  parent: GenusDefDto | null;
}

function openSession(target: GenusEditorTarget, components: ComponentDto[], copyName: (base: string) => string): Session | null {
  if (target.kind === 'edit') {
    const component = components.find((c) => c.id === target.genusId);
    if (!component) return null;
    const info = getGenus(component.id);
    const draft = draftFromGenus(component, info?.authored);
    const parent = draft.extends ? (getGenus(draft.extends)?.resolved ?? null) : null;
    return { draft, savedKey: draftKey(draft), parent };
  }
  const base = components.find((c) => c.id === target.baseId);
  if (!base) return null;
  const draft = deriveDraft(
    base,
    components.map((c) => c.id),
    copyName(componentDisplayName(base.id, base.display_name)),
  );
  return { draft, savedKey: null, parent: getGenus(base.id)?.resolved ?? null };
}

/**
 * Genus editor mode: replaces the project workspace in the same window.
 * The project stays mounted underneath (camera, selection, undo untouched)
 * and comes back on exit. This first version shows the genus read-only:
 * structure, four views built from `preview_genus` with a sample host, and
 * the build status. Authoring tools arrive in later versions (disabled here).
 */
export function GenusEditorMode(props: GenusEditorModeProps) {
  const { t, locale, setLocale, locales } = useI18n();
  const { preference, resolved, setPreference } = useTheme();
  const { components, target } = props;

  const [session, setSession] = useState<Session | null>(() =>
    openSession(target, components, (base) => t('genusEditor.copyName', { name: base })),
  );
  const draft = session?.draft ?? null;
  const dirty = session ? session.savedKey === null || session.savedKey !== draftKey(session.draft) : false;

  const [tab, setTab] = useState<RibbonTab>('create');
  const [layout, setLayout] = useState<Layout>('all');
  const [mobileView, setMobileView] = useState<PaneView>('front');
  const [sidePanel, setSidePanel] = useState<SidePanel>('properties');
  const [mobileTree, setMobileTree] = useState(false);
  const [showHost, setShowHost] = useState(true);
  const [showRefs, setShowRefs] = useState(true);
  const [showDims, setShowDims] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [fitEpoch, setFitEpoch] = useState(0);
  const [confirmExit, setConfirmExit] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Mark the project inert while the mode is up; restore on exit.
  useEffect(() => {
    setGenusEditorOpen(true);
    const root = document.getElementById('root');
    const prevInert = root?.inert ?? false;
    if (root) root.inert = true;
    return () => {
      setGenusEditorOpen(false);
      if (root) root.inert = prevInert;
    };
  }, []);

  // Own species, else the parent's (a genus based on a window previews as
  // the window's species until it gets its own).
  const species = useMemo(() => {
    if (!draft) return [];
    const own = listSpecies(draft.id);
    return own.length || !draft.extends ? own : listSpecies(draft.extends);
  }, [draft?.id, draft?.extends]);
  const [speciesId, setSpeciesId] = useState<string | null>(null);
  useEffect(() => {
    if (species.length === 0) setSpeciesId(null);
    else if (!speciesId || !species.some((s) => s.id === speciesId)) {
      setSpeciesId((species.find((s) => s.default) ?? species[0]).id);
    }
  }, [species, speciesId]);

  const placement = draft ? effectivePlacement(draft, session?.parent) : { kind: 'point' as const };
  const host = useMemo(() => testHostFor(placement), [JSON.stringify(placement)]);

  // —— Build ————————————————————————————————————————————————
  const [preview, setPreview] = useState<OkPreview | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildMs, setBuildMs] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [buildEpoch, setBuildEpoch] = useState(0);
  const request = useMemo(
    () =>
      draft
        ? previewRequest(draft, {
            species: speciesId,
            hostDepth: host?.depth,
            length: placement.kind === 'line' ? 2 : undefined,
          })
        : null,
    [draft, speciesId, host, placement.kind],
  );

  useEffect(() => {
    if (!request) return;
    const t0 = performance.now();
    let result: GenusPreviewDto;
    try {
      result = apexPreviewGenus(request);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    setBuildMs(performance.now() - t0);
    if (result.ok) {
      setPreview(result);
      setBuildError(null);
      setPending(result.pending ?? 0);
    } else {
      setBuildError(result.error);
      setPending(0);
    }
  }, [request, buildEpoch]);

  // Exact-kernel booleans run in workers (mesh stand-ins meanwhile): send
  // the queued jobs and rebuild until the results are cached.
  const retries = useRef(0);
  useEffect(() => {
    retries.current = 0;
  }, [request]);
  useEffect(() => {
    if (pending <= 0 || retries.current >= 30) return;
    pumpKernelJobs();
    // Back off: the first run also waits for the worker to load SMLib.
    const delay = Math.min(1000, 150 * 1.3 ** retries.current);
    const timer = window.setTimeout(() => {
      retries.current += 1;
      setBuildEpoch((n) => n + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [pending, buildEpoch]);

  const fitKey = `${draft?.id ?? ''}:${fitEpoch}`;
  const views = useMemo(() => {
    if (!preview) return null;
    return {
      front: buildView('front', preview, host),
      plan: buildView('plan', preview, host),
      side: buildView('side', preview, host),
    };
  }, [preview, host]);

  const tree = useMemo(() => (draft ? buildTree(draft, session?.parent) : null), [draft, session?.parent]);

  const nameOf = useCallback(
    (id: string) => {
      const comp = components.find((c) => c.id === id);
      if (comp) return componentDisplayName(comp.id, comp.display_name);
      return t(`genusItem.${id}`, undefined, id);
    },
    [components, t, locale],
  );

  const baseComp = draft?.extends ? components.find((c) => c.id === draft.extends) : null;
  const baseName = baseComp ? componentDisplayName(baseComp.id, baseComp.display_name) : (draft?.extends ?? null);
  const hostLabel = host
    ? t(`genusEditor.host.${host.category}`, { mm: Math.round(host.depth * 1000) }, t('genusEditor.host.generic', { category: host.category, mm: Math.round(host.depth * 1000) }))
    : null;

  // —— Save / exit ——————————————————————————————————————————
  const save = (): boolean => {
    if (!session) return false;
    try {
      apexExecuteCommand(defineGenusCommand(session.draft));
      setSession({ ...session, savedKey: draftKey(session.draft) });
      setSaveError(null);
      props.onSaved(session.draft.id);
      setBuildEpoch((n) => n + 1);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const requestExit = () => {
    if (dirty) setConfirmExit(true);
    else props.onExit();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmExit) setConfirmExit(false);
        else if (mobileTree) setMobileTree(false);
        else setSelected(null);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmExit, mobileTree]);

  if (!session || !draft || !tree) {
    return createPortal(
      <div className="genus-mode" data-testid="genus-editor">
        <div className="genus-mode-missing">
          {t('genusEditor.notFound')}
          <button type="button" className="genus-btn" onClick={props.onExit}>
            {t('genusEditor.backToProject')}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  const soon = t('genusEditor.soon');
  type Tool = { id: string; icon: string; label: string; title?: string; on?: boolean; disabled?: boolean; run?: () => void };
  type Group = { id: string; label: string; tools: Tool[] };
  const disabledTool = (id: string, icon: string): Tool => ({
    id,
    icon,
    label: t(`genusEditor.tool.${id}`),
    title: `${t(`genusEditor.tool.${id}.title`)} — ${soon}`,
    disabled: true,
  });
  const selectTool: Tool = { id: 'select', icon: 'select', label: t('genusEditor.tool.select'), title: t('genusEditor.tool.select.title'), on: true, run: () => {} };
  const layoutTool = (id: Layout, icon: string): Tool => ({
    id: `layout-${id}`,
    icon,
    label: t(`genusEditor.layout.${id}`),
    title: t(`genusEditor.layout.${id}.title`),
    on: layout === id,
    run: () => setLayout(id),
  });
  const ribbon: Record<RibbonTab, Group[]> = {
    create: [
      { id: 'select', label: t('genusEditor.group.select'), tools: [selectTool] },
      { id: 'refs', label: t('genusEditor.group.refs'), tools: [disabledTool('plane', 'plane'), disabledTool('line', 'line'), disabledTool('point', 'point')] },
      {
        id: 'body',
        label: t('genusEditor.group.body'),
        tools: [disabledTool('extrude', 'extrude'), disabledTool('sweep', 'sweep'), disabledTool('revolve', 'revolve'), disabledTool('box', 'box')],
      },
      { id: 'cuts', label: t('genusEditor.group.cuts'), tools: [disabledTool('cut', 'cut')] },
      { id: 'nested', label: t('genusEditor.group.nested'), tools: [disabledTool('nest', 'nest')] },
      { id: 'constraints', label: t('genusEditor.group.constraints'), tools: [disabledTool('dim', 'dim'), disabledTool('label', 'label')] },
    ],
    modify: [
      { id: 'select', label: t('genusEditor.group.select'), tools: [selectTool] },
      {
        id: 'modify',
        label: t('genusEditor.group.modify'),
        tools: [disabledTool('move', 'move'), disabledTool('copy', 'copy'), disabledTool('mirror', 'mirror'), disabledTool('delete', 'delete')],
      },
      { id: 'item', label: t('genusEditor.group.item'), tools: [disabledTool('visibility', 'visibility'), disabledTool('material', 'material')] },
    ],
    params: [
      {
        id: 'params',
        label: t('genusEditor.group.params'),
        tools: [
          {
            id: 'params-list',
            icon: 'params',
            label: t('genusEditor.tool.paramsList'),
            title: t('genusEditor.tool.paramsList.title'),
            on: sidePanel === 'params',
            run: () => setSidePanel((p) => (p === 'params' ? 'properties' : 'params')),
          },
          disabledTool('addParam', 'addParam'),
          disabledTool('formula', 'formula'),
        ],
      },
      { id: 'species', label: t('genusEditor.group.species'), tools: [disabledTool('addSpecies', 'addSpecies')] },
    ],
    view: [
      {
        id: 'layout',
        label: t('genusEditor.group.layout'),
        tools: [layoutTool('all', 'layoutAll'), layoutTool('front', 'front'), layoutTool('plan', 'plan'), layoutTool('side', 'side'), layoutTool('3d', 'threeD')],
      },
      {
        id: 'show',
        label: t('genusEditor.group.show'),
        tools: [
          { id: 'show-host', icon: 'host', label: t('genusEditor.show.host'), title: t('genusEditor.show.host.title'), on: showHost, disabled: !host, run: () => setShowHost((v) => !v) },
          { id: 'show-refs', icon: 'refs', label: t('genusEditor.show.refs'), title: t('genusEditor.show.refs.title'), on: showRefs, run: () => setShowRefs((v) => !v) },
          { id: 'show-dims', icon: 'dim', label: t('genusEditor.show.dims'), title: t('genusEditor.show.dims.title'), on: showDims, run: () => setShowDims((v) => !v) },
        ],
      },
      { id: 'fit', label: t('genusEditor.group.zoom'), tools: [{ id: 'fit', icon: 'fit', label: t('genusEditor.tool.fit'), title: t('genusEditor.tool.fit.title'), run: () => setFitEpoch((n) => n + 1) }] },
    ],
  };

  const speciesSelect = (
    <label className="genus-species-select" title={t('genusEditor.species.title')}>
      <span>{t('genusEditor.species')}</span>
      <select
        value={speciesId ?? ''}
        data-testid="genus-species"
        disabled={species.length === 0}
        onChange={(e) => setSpeciesId(e.target.value || null)}
      >
        {species.length === 0 ? <option value="">{t('genusEditor.species.none')}</option> : null}
        {species.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );

  const pane = (view: PaneView, className = '') => {
    const label = t(`genusEditor.view.${view}`);
    if (view === '3d') {
      return (
        <div className={`genus-pane ${className}`} key="3d">
          <Genus3DView
            preview={preview}
            host={host}
            showHost={showHost}
            selected={selected}
            onSelect={setSelected}
            label={label}
            fitKey={fitKey}
          />
        </div>
      );
    }
    return (
      <div className={`genus-pane ${className}`} key={view}>
        {views ? (
          <GenusOrthoView
            view={view}
            model={views[view]}
            label={label}
            selected={selected}
            onSelect={setSelected}
            showHost={showHost}
            showRefs={showRefs}
            showDims={showDims}
            nameOf={nameOf}
            hostLabel={hostLabel}
            levelLabel={t('genusEditor.level')}
            fitKey={fitKey}
          />
        ) : (
          <div className="genus-view genus-view--empty">{buildError ?? t('genusEditor.building')}</div>
        )}
      </div>
    );
  };

  // —— Properties (read-only) ———————————————————————————————————
  const selectedBody =
    selected && selected !== '#host'
      ? (draft.body.find((b) => b.id === selected) ?? session.parent?.body?.find((b) => b.id === selected) ?? null)
      : null;
  const selectedRef =
    selected && !selectedBody
      ? (draft.refs.find((r) => r.id === selected) ?? session.parent?.refs?.find((r) => r.id === selected) ?? null)
      : null;
  const inherited = Boolean(selected && !draft.body.some((b) => b.id === selected) && !draft.refs.some((r) => r.id === selected));
  const solidsOf = (id: string) => preview?.solids.filter((s) => s.path === id || s.path.startsWith(`${id}/`) || s.path.startsWith(`${id}#`)) ?? [];

  const kv = (k: string, v: React.ReactNode, mono = false) => (
    <div className="genus-kv-row" key={k}>
      <span className="genus-kv-k">{k}</span>
      <span className={`genus-kv-v${mono ? ' is-mono' : ''}`}>{v}</span>
    </div>
  );
  const fmt = (v: unknown): string => (typeof v === 'number' ? String(v) : Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : String(v ?? '—'));

  const properties = (
    <div className="genus-props" data-testid="genus-properties">
      {selectedBody ? (
        <>
          <div className="genus-props-head">
            <small>{t(`genusEditor.kind.${selectedBody.item}`)}</small>
            <div>{nameOf(selectedBody.id)}</div>
          </div>
          <div className="genus-props-sec">
            {kv(t('genusEditor.prop.id'), selectedBody.id, true)}
            {inherited ? kv(t('genusEditor.prop.source'), t('genusEditor.prop.inheritedFrom', { name: baseName ?? '' })) : null}
            {'shape' in selectedBody ? kv(t('genusEditor.prop.shape'), t(`genusEditor.shape.${selectedBody.shape}`, undefined, String(selectedBody.shape))) : null}
            {selectedBody.item === 'nested' ? kv(t('genusEditor.prop.genus'), nameOf(selectedBody.genus)) : null}
            {selectedBody.item === 'nested' && selectedBody.species ? kv(t('genusEditor.prop.species'), selectedBody.species, true) : null}
            {selectedBody.item === 'cut'
              ? kv(
                  t('genusEditor.prop.targets'),
                  [
                    selectedBody.targets?.host ? t('genusEditor.target.host') : null,
                    selectedBody.targets?.self ? t('genusEditor.target.self') : null,
                    selectedBody.targets?.neighbours ? t('genusEditor.target.neighbours') : null,
                  ]
                    .filter(Boolean)
                    .join(', ') || t('genusEditor.target.none'),
                )
              : null}
            {selectedBody.item === 'solid' && selectedBody.material ? kv(t('genusEditor.prop.material'), selectedBody.material, true) : null}
            {selectedBody.item === 'solid' && selectedBody.glass ? kv(t('genusEditor.prop.glass'), t('genusEditor.yes')) : null}
            {kv(t('genusEditor.prop.visible'), selectedBody.visible !== undefined ? fmt(selectedBody.visible) : t('genusEditor.always'), selectedBody.visible !== undefined)}
            {kv(t('genusEditor.prop.plan'), t(`genusEditor.plan.${selectedBody.plan?.show ?? 'auto'}`))}
            {'min' in selectedBody && selectedBody.min ? kv(t('genusEditor.prop.min'), fmt(selectedBody.min), true) : null}
            {'max' in selectedBody && selectedBody.max ? kv(t('genusEditor.prop.max'), fmt(selectedBody.max), true) : null}
            {selectedBody.item !== 'cut' ? kv(t('genusEditor.prop.built'), t('genusEditor.prop.builtCount', { n: solidsOf(selectedBody.id).length })) : null}
          </div>
        </>
      ) : selectedRef ? (
        <>
          <div className="genus-props-head">
            <small>{t('genusEditor.kind.ref')}</small>
            <div>{nameOf(selectedRef.id)}</div>
          </div>
          <div className="genus-props-sec">
            {kv(t('genusEditor.prop.id'), selectedRef.id, true)}
            {kv(t('genusEditor.prop.refKind'), t(`genusEditor.refKind.${selectedRef.ref}`))}
            {selectedRef.ref === 'plane' ? kv(t('genusEditor.prop.origin'), fmt(selectedRef.origin), true) : null}
            {selectedRef.ref === 'plane' ? kv(t('genusEditor.prop.normal'), selectedRef.normal ?? 'y', true) : null}
            {selectedRef.ref === 'point' ? kv(t('genusEditor.prop.at'), fmt(selectedRef.at), true) : null}
            {selectedRef.ref === 'line' ? kv(t('genusEditor.prop.from'), fmt(selectedRef.from), true) : null}
            {selectedRef.ref === 'line' ? kv(t('genusEditor.prop.to'), fmt(selectedRef.to), true) : null}
            {inherited ? kv(t('genusEditor.prop.source'), t('genusEditor.prop.inheritedFrom', { name: baseName ?? '' })) : null}
          </div>
        </>
      ) : selected === '#host' && host ? (
        <>
          <div className="genus-props-head">
            <small>{t('genusEditor.tree.host')}</small>
            <div>{hostLabel}</div>
          </div>
          <div className="genus-props-sec">
            {kv(t('genusEditor.prop.depth'), `${Math.round(host.depth * 1000)} ${t('genusEditor.mm')}`)}
            {kv(t('genusEditor.prop.height'), `${Math.round(host.height * 1000)} ${t('genusEditor.mm')}`)}
            <p className="genus-props-note">{t('genusEditor.host.note')}</p>
          </div>
        </>
      ) : (
        <>
          <div className="genus-props-head">
            <small>{t('genusEditor.kind.genus')}</small>
            <div>{draft.name}</div>
          </div>
          <div className="genus-props-sec">
            {kv(t('genusEditor.prop.id'), draft.id, true)}
            {kv(t('genusEditor.prop.category'), draft.category ?? '—')}
            {kv(t('genusEditor.prop.extends'), baseName ?? '—')}
            {kv(t('genusEditor.prop.placement'), t(`genusEditor.placement.${placement.kind}`))}
            {kv(t('genusEditor.prop.params'), String(preview?.params.length ?? draft.params.length))}
            {kv(t('genusEditor.prop.species'), String(species.length))}
          </div>
          <p className="genus-props-note">{t('genusEditor.readOnlyNote')}</p>
        </>
      )}
    </div>
  );

  const paramsPanel = (
    <div className="genus-params" data-testid="genus-params">
      <div className="genus-props-head">
        <small>{t('genusEditor.group.params')}</small>
        <div>{draft.name}</div>
      </div>
      <table className="genus-params-table">
        <thead>
          <tr>
            <th>{t('genusEditor.param.id')}</th>
            <th>{t('genusEditor.param.value')}</th>
            <th>{t('genusEditor.param.binding')}</th>
          </tr>
        </thead>
        <tbody>
          {(preview?.params ?? []).filter((p) => p.id !== 'species').map((p) => (
            <tr key={p.id}>
              <td className="is-mono" title={p.label}>
                {p.id}
              </td>
              <td className="is-mono">{fmt(p.value)}</td>
              <td>
                <span className={`genus-chip is-${p.binding === 'type' ? 'species' : 'instance'}`}>
                  {t(p.binding === 'type' ? 'genusEditor.binding.species' : 'genusEditor.binding.instance')}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const nextTheme = THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(preference) + 1) % THEME_PREFERENCES.length];
  const nextLocale = locales[(locales.indexOf(locale) + 1) % locales.length];
  const solidsCount = preview?.solids.length ?? 0;
  const cutsCount = preview?.cuts.length ?? 0;
  const warnings = preview?.warnings ?? [];
  const kernelName = currentKernel();

  const statusBar = (
    <footer className="genus-status" data-testid="genus-status">
      <span className="genus-status-id">
        {t('genusEditor.status.genus')} <b>{draft.id}</b>
        {draft.extends ? ` · ${t('genusEditor.status.extends', { id: draft.extends })}` : ''}
      </span>
      {buildError ? (
        <span className="genus-status-err" data-testid="genus-build-error">
          ✕ {buildError}
        </span>
      ) : (
        <span className={warnings.length ? 'genus-status-warn' : 'genus-status-ok'} data-testid="genus-build-status">
          {warnings.length ? '⚠' : '✓'} {t('genusEditor.status.solids', { solids: solidsCount, cuts: cutsCount })}
          {warnings.length ? ` · ${t('genusEditor.status.warnings', { n: warnings.length })}` : ''}
        </span>
      )}
      <span data-testid="genus-build-time">
        {t('genusEditor.status.build', { ms: buildMs === null ? '—' : buildMs.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })}
        {pending > 0 ? ` · ${t('genusEditor.status.pending', { n: pending })}` : ''}
      </span>
      <span className="genus-status-spacer" />
      <span className="genus-status-chip" title={t('genusEditor.status.kernelTitle')}>
        {t(`genusEditor.kernel.${kernelName}`)}
      </span>
      <span className="genus-status-chip">{t('status.unitsMetres')}</span>
      <button type="button" className="genus-status-chip" onClick={() => setPreference(nextTheme)} title={t('status.themeTitle', { next: t(`chrome.theme.${nextTheme}`) })}>
        {resolved === 'dark' ? '☾' : '☀'} {t(`chrome.theme.${preference}`)}
      </button>
      <button type="button" className="genus-status-chip" data-testid="genus-language" onClick={() => setLocale(nextLocale)}>
        {locale.toUpperCase()}
      </button>
    </footer>
  );

  const exitDialog = confirmExit ? (
    <div className="genus-dialog-backdrop" role="presentation">
      <div className="genus-dialog" role="dialog" aria-modal="true" aria-labelledby="genus-exit-title" data-testid="genus-exit-dialog">
        <h2 id="genus-exit-title">{t('genusEditor.exit.title')}</h2>
        <p>{t(session.savedKey === null ? 'genusEditor.exit.newBody' : 'genusEditor.exit.body', { name: draft.name })}</p>
        {saveError ? <p className="genus-status-err">{saveError}</p> : null}
        <div className="genus-dialog-actions">
          <button
            type="button"
            className="genus-btn is-primary"
            data-testid="genus-exit-save"
            onClick={() => {
              if (save()) {
                setConfirmExit(false);
                props.onExit();
              }
            }}
          >
            {t('genusEditor.exit.save')}
          </button>
          <button
            type="button"
            className="genus-btn"
            data-testid="genus-exit-discard"
            onClick={() => {
              setConfirmExit(false);
              props.onExit();
            }}
          >
            {t('genusEditor.exit.discard')}
          </button>
          <button type="button" className="genus-btn" data-testid="genus-exit-cancel" autoFocus onClick={() => setConfirmExit(false)}>
            {t('genusEditor.exit.cancel')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const topBar = (
    <header className="genus-top">
      <button type="button" className="genus-back" data-testid="genus-back" onClick={requestExit} title={t('genusEditor.backTitle')}>
        ← <span className="genus-back-label">{props.isMobile ? t('genusEditor.back') : t('genusEditor.backTo', { name: props.projectName })}</span>
      </button>
      <span className="genus-mode-badge" data-testid="genus-mode-badge">
        {t('genusEditor.badge')}
      </span>
      <span className="genus-title" data-testid="genus-title">
        {draft.name}
      </span>
      {dirty ? (
        <span className="genus-dirty" data-testid="genus-dirty" title={t('genusEditor.dirtyTitle')}>
          ● {t(session.savedKey === null ? 'genusEditor.dirtyNew' : 'genusEditor.dirty')}
        </span>
      ) : null}
      {!props.isMobile ? (
        <nav className="genus-tabs" role="tablist" aria-label={t('genusEditor.ribbonLabel')}>
          {(['create', 'modify', 'params', 'view'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`genus-tab${tab === id ? ' is-active' : ''}`}
              data-testid={`genus-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {t(`genusEditor.tab.${id}`)}
            </button>
          ))}
        </nav>
      ) : null}
    </header>
  );

  if (props.isMobile) {
    const order: PaneView[] = ['front', 'plan', 'side', '3d'];
    return createPortal(
      <div className="genus-mode is-mobile" data-testid="genus-editor" data-dirty={dirty ? 'true' : 'false'}>
        {topBar}
        <div className="genus-mobile-bar">
          <div className="genus-seg" role="tablist">
            {order.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={mobileView === v}
                className={mobileView === v ? 'is-active' : ''}
                data-testid={`genus-mobile-view-${v}`}
                onClick={() => setMobileView(v)}
              >
                {t(`genusEditor.viewShort.${v}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="genus-mobile-main">{pane(mobileView, 'is-single')}</div>
        <div className="genus-mobile-foot">
          {speciesSelect}
          <button type="button" className="genus-btn" data-testid="genus-mobile-structure" onClick={() => setMobileTree(true)}>
            <GenusIcon name="structure" /> {t('genusEditor.structure')}
          </button>
        </div>
        <div className="genus-mobile-status">
          {buildError ? <span className="genus-status-err">✕ {buildError}</span> : <span className="genus-status-ok">✓ {t('genusEditor.status.solids', { solids: solidsCount, cuts: cutsCount })}</span>}
          <span>{t('genusEditor.status.build', { ms: buildMs === null ? '—' : buildMs.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })}</span>
        </div>
        {mobileTree ? (
          <div className="genus-sheet-backdrop" onClick={() => setMobileTree(false)} role="presentation">
            <div className="genus-sheet" role="dialog" aria-label={t('genusEditor.structure')} onClick={(e) => e.stopPropagation()}>
              <div className="genus-sheet-head">
                <b>{t('genusEditor.structure')}</b>
                <button type="button" className="genus-btn" onClick={() => setMobileTree(false)}>
                  {t('genusEditor.close')}
                </button>
              </div>
              <GenusStructureTree tree={tree} host={host} selected={selected} onSelect={setSelected} nameOf={nameOf} baseName={baseName} />
              {properties}
            </div>
          </div>
        ) : null}
        {exitDialog}
      </div>,
      document.body,
    );
  }

  const panes: PaneView[] = layout === 'all' ? ['front', '3d', 'plan', 'side'] : [layout];

  return createPortal(
    <div className="genus-mode" data-testid="genus-editor" data-dirty={dirty ? 'true' : 'false'}>
      {topBar}
      <div className="genus-ribbon" role="toolbar" aria-label={t(`genusEditor.tab.${tab}`)} data-testid="genus-ribbon" data-tab={tab}>
        {ribbon[tab].map((g) => (
          <div className="genus-ribbon-group" key={g.id}>
            <div className="genus-ribbon-tools">
              {g.tools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  className={`genus-tool${tool.on ? ' is-on' : ''}`}
                  data-testid={`genus-tool-${tool.id}`}
                  disabled={tool.disabled}
                  aria-pressed={tool.on}
                  title={tool.title}
                  onClick={tool.run}
                >
                  <GenusIcon name={tool.icon} />
                  <span>{tool.label}</span>
                </button>
              ))}
              {g.id === 'species' ? speciesSelect : null}
            </div>
            <div className="genus-ribbon-cap">{g.label}</div>
          </div>
        ))}
        <div className="genus-ribbon-group is-mode">
          <div className="genus-ribbon-tools">
            <button
              type="button"
              className="genus-tool is-primary"
              data-testid="genus-save"
              disabled={!dirty}
              title={dirty ? t(session.savedKey === null ? 'genusEditor.saveNewTitle' : 'genusEditor.saveTitle') : t('genusEditor.savedTitle')}
              onClick={() => save()}
            >
              <GenusIcon name="save" />
              <span>{t('genusEditor.save')}</span>
            </button>
            <button type="button" className="genus-tool" data-testid="genus-exit" title={t('genusEditor.backTitle')} onClick={requestExit}>
              <GenusIcon name="exit" />
              <span>{t('genusEditor.exitMode')}</span>
            </button>
          </div>
          <div className="genus-ribbon-cap">{t('genusEditor.group.mode')}</div>
        </div>
      </div>
      <div className="genus-main">
        <aside className="genus-left">
          <div className="genus-left-head">{t('genusEditor.structure')}</div>
          <div className="genus-left-scroll">
            <GenusStructureTree tree={tree} host={host} selected={selected} onSelect={setSelected} nameOf={nameOf} baseName={baseName} />
          </div>
        </aside>
        <section className="genus-center">
          <div className="genus-vtabs" role="tablist">
            {(['all', 'front', '3d', 'plan', 'side'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={layout === id}
                className={`genus-vtab${layout === id ? ' is-active' : ''}`}
                data-testid={`genus-layout-${id}`}
                onClick={() => setLayout(id)}
              >
                {t(`genusEditor.layout.${id}`)}
              </button>
            ))}
            <span className="genus-vtabs-spacer" />
            {tab !== 'params' ? speciesSelect : null}
          </div>
          <div className={`genus-views${layout === 'all' ? ' is-grid' : ''}`} data-testid="genus-views" data-layout={layout}>
            {panes.map((v) => pane(v))}
          </div>
        </section>
        <aside className="genus-right">{sidePanel === 'params' ? paramsPanel : properties}</aside>
      </div>
      {saveError && !confirmExit ? <div className="genus-error-bar">{saveError}</div> : null}
      {statusBar}
      {exitDialog}
    </div>,
    document.body,
  );
}
