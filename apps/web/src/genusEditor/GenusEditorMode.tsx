import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { componentDisplayName, speciesDisplayName, useI18n } from '../i18n';
import { useTheme } from '../theme/useTheme';
import { THEME_PREFERENCES } from '../theme/theme';
import type { ComponentDto, GenusDefDto, GenusPreviewDto, ParamSpecDto, ParamValue } from '../types';
import { currentKernel, pumpKernelJobs } from '../kernel/geometryKernel';
import { apexExecuteCommand, apexPreviewGenus, apexRunQuery } from '../wasm/apex';
import { Genus3DView } from './Genus3DView';
import { GenusOrthoView } from './GenusOrthoView';
import { GenusStructureTree } from './GenusStructureTree';
import { GenusIcon } from './icons';
import { GenusParamForm } from './GenusParamForm';
import { GenusParamsDock } from './GenusParamsDock';
import { GenusDimForm, GenusRefForm } from './GenusRefPanel';
import { useRefTools } from './useRefTools';
import { bindDim, dimAxis, evalRef, measure, paramDeps, putDim, putRef, refPoints, renameRef, takenIds, formulaNames } from './refs';
import { localizedParamLabel } from '../ui/paramLabels';
import {
  addParam,
  addSpecies,
  copySpecies,
  deleteParam,
  deleteSpecies,
  kindOf,
  paramRows,
  renameParam,
  renameSpecies,
  setParam,
  setSpeciesValue,
  speciesCommands,
  speciesKey,
  speciesValues,
  usedByGeometry,
  validateParams,
  type DraftSpecies,
  type ParamSource,
} from './params';
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
  type GenusParamInput,
  type GetGenusDto,
} from './model';
import { buildView, type OrthoView } from './projection';
import { setGenusEditorOpen } from './session';
import './genusEditor.css';

type OkPreview = Extract<GenusPreviewDto, { ok: true }>;
type RibbonTab = 'create' | 'modify' | 'params' | 'view';
type Layout = 'all' | OrthoView | '3d';
type PaneView = OrthoView | '3d';

interface SpeciesRow {
  id: string;
  name: string;
  genus?: string;
  default?: boolean;
  instances?: number;
  values?: Record<string, unknown>;
}

/** Rebuild this long after the last edit (typing a formula, a value). */
const REBUILD_DEBOUNCE_MS = 180;

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
  /** The parent's (merged) param specs, for inherited rows. */
  parentSpecs: ParamSpecDto[];
  /** Species being edited, and as registered (written on Save). */
  species: DraftSpecies[];
  savedSpecies: DraftSpecies[];
  /** Species with instances in the project (not deletable). */
  usedSpecies: Set<string>;
}

function toDraftSpecies(rows: SpeciesRow[]): DraftSpecies[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    values: Object.fromEntries(
      Object.entries(r.values ?? {}).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string'),
    ) as Record<string, ParamValue>,
  }));
}

function openSession(target: GenusEditorTarget, components: ComponentDto[], copyName: (base: string) => string): Session | null {
  const specsOf = (id: string | undefined) => (id ? (components.find((c) => c.id === id)?.params ?? []) : []);
  if (target.kind === 'edit') {
    const component = components.find((c) => c.id === target.genusId);
    if (!component) return null;
    const info = getGenus(component.id);
    const extendsId = (info?.authored ?? component.genus)?.extends;
    const own = extendsId && info?.params ? info.params.filter((p) => p.from === component.id).map((p) => p.id) : undefined;
    const draft = draftFromGenus(component, info?.authored, own);
    const parent = draft.extends ? (getGenus(draft.extends)?.resolved ?? null) : null;
    const rows = listSpecies(component.id);
    // Open on the species copied from the parent's default, if there is one.
    const parentDefault = draft.extends ? listSpecies(draft.extends).find((r) => r.default)?.id.split('.').pop() : undefined;
    const species = toDraftSpecies(rows).sort((a, b) => Number(b.id.split('.').pop() === parentDefault) - Number(a.id.split('.').pop() === parentDefault));
    return {
      draft,
      savedKey: draftKey(draft),
      parent,
      parentSpecs: specsOf(draft.extends),
      species,
      savedSpecies: species,
      usedSpecies: new Set(rows.filter((r) => (r.instances ?? 0) > 0).map((r) => r.id)),
    };
  }
  const base = components.find((c) => c.id === target.baseId);
  if (!base) return null;
  const draft = deriveDraft(
    base,
    components.map((c) => c.id),
    copyName(componentDisplayName(base.id, base.display_name)),
  );
  // A new genus starts with copies of its parent's species.
  const species = copySpecies(draft.id, listSpecies(base.id), speciesDisplayName);
  return {
    draft,
    savedKey: null,
    parent: getGenus(base.id)?.resolved ?? null,
    parentSpecs: base.params,
    species,
    savedSpecies: [],
    usedSpecies: new Set(),
  };
}

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setOut(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return out;
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
  const dirty = session
    ? session.savedKey === null || session.savedKey !== draftKey(session.draft) || speciesKey(session.species) !== speciesKey(session.savedSpecies)
    : false;
  const patchSession = useCallback((fn: (s: Session) => Partial<Session>) => {
    setSession((s) => (s ? { ...s, ...fn(s) } : s));
  }, []);

  const [tab, setTab] = useState<RibbonTab>('create');
  const [layout, setLayout] = useState<Layout>('all');
  const [mobileView, setMobileView] = useState<PaneView>('front');
  const [mobileTree, setMobileTree] = useState(false);
  const [showHost, setShowHost] = useState(true);
  const [showRefs, setShowRefs] = useState(true);
  const [showDims, setShowDims] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [fitEpoch, setFitEpoch] = useState(0);
  const [confirmExit, setConfirmExit] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dockOpen, setDockOpen] = useState(true);
  const [selectedParam, setSelectedParam] = useState<string | null>(null);
  const [mobileParams, setMobileParams] = useState(false);

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

  // —— Params & species ——————————————————————————————————————
  const species = session?.species ?? [];
  const rows = useMemo(() => (session ? paramRows(session.draft, session.parentSpecs) : []), [session?.draft, session?.parentSpecs]);
  const issues = useMemo(() => validateParams(rows), [rows]);
  const geometryNames = useMemo(() => (draft ? usedByGeometry(draft) : new Set<string>()), [draft?.body, draft?.refs, draft?.dims]);
  const [speciesId, setSpeciesId] = useState<string | null>(null);
  useEffect(() => {
    if (species.length === 0) setSpeciesId(null);
    else if (!speciesId || !species.some((s) => s.id === speciesId)) setSpeciesId(species[0].id);
  }, [species, speciesId]);
  const activeSpecies = species.find((s) => s.id === speciesId) ?? null;
  useEffect(() => {
    if (selectedParam && !rows.some((r) => r.id === selectedParam)) setSelectedParam(null);
  }, [rows, selectedParam]);
  // One thing in the right panel: picking a ref / dim / item closes the param form.
  useEffect(() => {
    if (selected) setSelectedParam(null);
  }, [selected]);

  const editDraft = (fn: (d: GenusDraft) => GenusDraft) => patchSession((s) => ({ draft: fn(s.draft) }));
  const onPatchParam = (id: string, patch: Partial<GenusParamInput>) =>
    patchSession((s) => ({ draft: setParam(s.draft, paramRows(s.draft, s.parentSpecs), id, patch) }));
  const onSource = (id: string, source: ParamSource) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (source === 'genus') {
      const d = row.input.default;
      const seed = typeof d === 'boolean' ? (d ? 'true' : 'false') : String(d);
      onPatchParam(id, { formula: row.input.formula || seed, species: false });
    } else {
      onPatchParam(id, { formula: undefined, species: source === 'species' });
    }
  };
  const onAddParam = () => {
    let added = '';
    patchSession((s) => {
      const r = addParam(s.draft, paramRows(s.draft, s.parentSpecs), 'length', t('genusEditor.param.newLabel'));
      added = r.id;
      return { draft: r.draft };
    });
    window.setTimeout(() => setSelectedParam(added), 0);
  };
  const onDeleteParam = (id: string) => {
    editDraft((d) => deleteParam(d, id));
    setSelectedParam(null);
  };
  const onRenameParam = (from: string, to: string) => {
    patchSession((s) => renameParam(s.draft, s.species, paramRows(s.draft, s.parentSpecs), from, to));
    setSelectedParam(to);
  };
  const onAddSpecies = (copy: boolean) => {
    let added = '';
    patchSession((s) => {
      const from = copy ? s.species.find((x) => x.id === speciesId) : undefined;
      const name = from ? t('genusEditor.copyName', { name: from.name }) : t('genusEditor.species.newName', { n: s.species.length + 1 });
      const r = addSpecies(s.draft.id, s.species, paramRows(s.draft, s.parentSpecs), name, from);
      added = r.id;
      return { species: r.species };
    });
    window.setTimeout(() => setSpeciesId(added), 0);
  };
  const onDeleteSpecies = () => {
    if (!speciesId) return;
    patchSession((s) => ({ species: deleteSpecies(s.species, speciesId) }));
    setSpeciesId(null);
  };

  const placement = draft ? effectivePlacement(draft, session?.parent) : { kind: 'point' as const };
  const host = useMemo(() => testHostFor(placement), [JSON.stringify(placement)]);

  // —— Refs & dims (desktop authoring; phones only view them) ————————————
  const flexExtra = useMemo(() => ({ host_depth: host?.depth ?? 0.2, length: 2 }), [host]);
  const patchDraftSpecies = useCallback(
    (fn: (s: { draft: GenusDraft; species: DraftSpecies[] }) => { draft?: GenusDraft; species?: DraftSpecies[] }) =>
      patchSession((s) => fn({ draft: s.draft, species: s.species })),
    [patchSession],
  );
  const refTools = useRefTools({
    draft,
    parent: session?.parent ?? null,
    rows,
    species: activeSpecies,
    extra: flexExtra,
    patch: patchDraftSpecies,
    selected,
    setSelected,
    enabled: !props.isMobile,
  });

  // —— Build ————————————————————————————————————————————————
  const [preview, setPreview] = useState<OkPreview | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildMs, setBuildMs] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [buildEpoch, setBuildEpoch] = useState(0);
  const liveRequest = useMemo(
    () =>
      draft && issues.size === 0
        ? previewRequest(draft, {
            speciesValues: speciesValues(rows, activeSpecies),
            hostDepth: host?.depth,
            length: placement.kind === 'line' ? 2 : undefined,
          })
        : null,
    [draft, rows, issues, activeSpecies, host, placement.kind],
  );
  // Rebuild once edits pause; the first build runs at once.
  const debounced = useDebounced(liveRequest, REBUILD_DEBOUNCE_MS);
  const [first, setFirst] = useState(true);
  // While dragging, rebuild on every step (no debounce).
  const request = first || refTools.dragging ? liveRequest : debounced;
  useEffect(() => {
    if (first && liveRequest) setFirst(false);
  }, [first, liveRequest]);
  const stale = JSON.stringify(liveRequest) !== JSON.stringify(request);

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

  const paramLabel = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id);
      return row ? localizedParamLabel({ label: row.input.label ?? row.id }, t) : id;
    },
    [rows, t],
  );
  const nameOf = useCallback(
    (id: string) => {
      if (id.startsWith('dim:')) {
        const dim = refTools.dims.find((d) => d.dim.id === id.slice(4))?.dim;
        return dim?.param ? paramLabel(dim.param) : id.slice(4);
      }
      const comp = components.find((c) => c.id === id);
      if (comp) return componentDisplayName(comp.id, comp.display_name);
      return t(`genusItem.${id}`, undefined, id);
    },
    [components, t, locale, refTools.dims, paramLabel],
  );

  const baseComp = draft?.extends ? components.find((c) => c.id === draft.extends) : null;
  const baseName = baseComp ? componentDisplayName(baseComp.id, baseComp.display_name) : (draft?.extends ?? null);
  const hostLabel = host
    ? t(`genusEditor.host.${host.category}`, { mm: Math.round(host.depth * 1000) }, t('genusEditor.host.generic', { category: host.category, mm: Math.round(host.depth * 1000) }))
    : null;

  // —— Save / exit ——————————————————————————————————————————
  const save = (): boolean => {
    if (!session) return false;
    if (issues.size > 0) {
      setSaveError(t('genusEditor.saveBlocked', { n: issues.size }));
      return false;
    }
    try {
      // One undo step in the project: the genus and its species together.
      const steps = [
        defineGenusCommand(session.draft),
        ...speciesCommands(session.draft.id, session.savedSpecies, session.species, rows),
      ];
      apexExecuteCommand(steps.length === 1 ? steps[0] : { op: 'batch', commands: steps });
      setSession({ ...session, savedKey: draftKey(session.draft), savedSpecies: session.species });
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
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]');
      if (!typing && !confirmExit && (e.key === 'Delete' || e.key === 'Backspace') && (refTools.selectedRef || refTools.selectedDim)) {
        refTools.remove();
        e.preventDefault();
        return;
      }
      if (!typing && e.key === 'Enter' && refTools.pending) {
        refTools.finish();
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (confirmExit) setConfirmExit(false);
        else if (refTools.cancel()) {
          /* tool / pick cancelled */
        }
        else if (mobileTree) setMobileTree(false);
        else if (mobileParams) setMobileParams(false);
        else if (selectedParam) setSelectedParam(null);
        else setSelected(null);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmExit, mobileTree, mobileParams, selectedParam, refTools]);

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
  const selectedRow = selectedParam ? (rows.find((r) => r.id === selectedParam) ?? null) : null;
  type Tool = { id: string; icon: string; label: string; title?: string; on?: boolean; disabled?: boolean; run?: () => void };
  type Group = { id: string; label: string; tools: Tool[] };
  const disabledTool = (id: string, icon: string): Tool => ({
    id,
    icon,
    label: t(`genusEditor.tool.${id}`),
    title: `${t(`genusEditor.tool.${id}.title`)} — ${soon}`,
    disabled: true,
  });
  const selectTool: Tool = {
    id: 'select',
    icon: 'select',
    label: t('genusEditor.tool.select'),
    title: t('genusEditor.tool.select.title'),
    on: !refTools.tool,
    run: () => refTools.tool && refTools.setTool(refTools.tool),
  };
  const placeTool = (id: 'plane' | 'line' | 'point' | 'polyline' | 'dim' | 'move', icon: string, disabled = false): Tool => ({
    id,
    icon,
    label: t(`genusEditor.tool.${id}`),
    title: t(`genusEditor.tool.${id}.title`),
    on: refTools.tool === id,
    disabled,
    run: () => refTools.setTool(id),
  });
  const hasRefs = refTools.refs.length > 0;
  const actionTool = (id: string, icon: string, enabled: boolean, run: () => void): Tool => ({
    id,
    icon,
    label: t(`genusEditor.tool.${id}`),
    title: t(`genusEditor.tool.${id}.title`),
    disabled: !enabled,
    run,
  });
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
      {
        id: 'refs',
        label: t('genusEditor.group.refs'),
        tools: [placeTool('plane', 'plane'), placeTool('line', 'line'), placeTool('polyline', 'polyline'), placeTool('point', 'point')],
      },
      {
        id: 'body',
        label: t('genusEditor.group.body'),
        tools: [disabledTool('extrude', 'extrude'), disabledTool('sweep', 'sweep'), disabledTool('revolve', 'revolve'), disabledTool('box', 'box')],
      },
      { id: 'cuts', label: t('genusEditor.group.cuts'), tools: [disabledTool('cut', 'cut')] },
      { id: 'nested', label: t('genusEditor.group.nested'), tools: [disabledTool('nest', 'nest')] },
      {
        id: 'constraints',
        label: t('genusEditor.group.constraints'),
        tools: [
          placeTool('dim', 'dim', refTools.refs.length < 2),
          actionTool('label', 'label', Boolean(refTools.selectedDim), () =>
            window.setTimeout(() => (document.querySelector('[data-testid="genus-dim-param"]') as HTMLElement | null)?.focus(), 0),
          ),
        ],
      },
    ],
    modify: [
      { id: 'select', label: t('genusEditor.group.select'), tools: [selectTool] },
      {
        id: 'modify',
        label: t('genusEditor.group.modify'),
        tools: [
          placeTool('move', 'move', !hasRefs),
          actionTool('copy', 'copy', Boolean(refTools.selectedRef), refTools.copy),
          disabledTool('mirror', 'mirror'),
          actionTool('delete', 'delete', Boolean(refTools.selectedRef || refTools.selectedDim), refTools.remove),
        ],
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
            on: dockOpen,
            run: () => setDockOpen((v) => !v),
          },
          { id: 'addParam', icon: 'addParam', label: t('genusEditor.tool.addParam'), title: t('genusEditor.tool.addParam.title'), run: onAddParam },
          {
            id: 'formula',
            icon: 'formula',
            label: t('genusEditor.tool.formula'),
            title: t('genusEditor.tool.formula.title'),
            disabled: !selectedRow || selectedRow.locked || kindOf(selectedRow.input) === 'text',
            on: Boolean(selectedRow?.input.formula),
            run: () => selectedRow && onSource(selectedRow.id, selectedRow.input.formula ? 'instance' : 'genus'),
          },
        ],
      },
      {
        id: 'species',
        label: t('genusEditor.group.species'),
        tools: [
          { id: 'addSpecies', icon: 'addSpecies', label: t('genusEditor.tool.addSpecies'), title: t('genusEditor.tool.addSpecies.title'), run: () => onAddSpecies(false) },
          { id: 'copySpecies', icon: 'copy', label: t('genusEditor.tool.copySpecies'), title: t('genusEditor.tool.copySpecies.title'), disabled: !activeSpecies, run: () => onAddSpecies(true) },
        ],
      },
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
        {species.length === 0 ? <option value="">{t('genusEditor.species.defaults')}</option> : null}
        {species.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name || s.id}
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
            paramLabel={paramLabel}
            interact={refTools.interact(view)}
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

  const dock = (compact = false) => (
    <GenusParamsDock
      rows={rows}
      issues={issues}
      species={species}
      speciesId={speciesId}
      selectedParam={selectedParam}
      usedSpecies={session.usedSpecies}
      compact={compact}
      onSelectParam={(id) => {
        setSelectedParam(id);
        if (id) setSelected(null);
      }}
      onSelectSpecies={setSpeciesId}
      onAddParam={onAddParam}
      onSetFormula={(id, formula) => onPatchParam(id, { formula, species: false })}
      onSetDefault={(id, value) => onPatchParam(id, { default: value })}
      onSetSpeciesValue={(sp, param, value) => patchSession((s) => ({ species: setSpeciesValue(s.species, sp, param, value) }))}
      onToggleBinding={(id) => {
        const row = rows.find((r) => r.id === id);
        if (row) onSource(id, row.input.species ? 'instance' : 'species');
      }}
      onAddSpecies={() => onAddSpecies(false)}
      onDuplicateSpecies={() => onAddSpecies(true)}
      onRenameSpecies={(id, name) => patchSession((s) => ({ species: renameSpecies(s.species, id, name) }))}
      onDeleteSpecies={onDeleteSpecies}
    />
  );
  const paramForm = selectedRow ? (
    <GenusParamForm
      key={selectedRow.id}
      row={selectedRow}
      issues={issues.get(selectedRow.id) ?? []}
      usedBy={geometryNames.has(selectedRow.id)}
      baseName={baseName}
      onPatch={(patch) => onPatchParam(selectedRow.id, patch)}
      onRename={(to) => onRenameParam(selectedRow.id, to)}
      onSource={(src) => onSource(selectedRow.id, src)}
      onDelete={() => onDeleteParam(selectedRow.id)}
      onClose={() => setSelectedParam(null)}
    />
  ) : null;

  const knownNames = new Set([...rows.map((r) => r.id), 'host_depth', 'length']);
  const sr = refTools.selectedRef;
  const refForm =
    sr && !props.isMobile ? (
      <GenusRefForm
        key={sr.ref.id}
        item={sr}
        known={knownNames}
        values={refTools.values}
        users={refTools.usersOf(sr.ref.id)}
        baseName={baseName}
        nameOf={nameOf}
        onChange={(ref) => editDraft((d) => putRef(d, ref))}
        onRename={(to) => {
          if (takenIds(draft, session.parent).includes(to)) return;
          editDraft((d) => renameRef(d, sr.ref.id, to));
          setSelected(to);
        }}
        onDelete={refTools.remove}
        onReset={() => editDraft((d) => ({ ...d, refs: d.refs.filter((r) => r.id !== sr.ref.id) }))}
        onClose={() => setSelected(null)}
      />
    ) : null;
  const sd = refTools.selectedDim;
  const dimInfo = (() => {
    if (!sd) return null;
    const a = refTools.refs.find((r) => r.ref.id === sd.dim.from)?.ref;
    const b = refTools.refs.find((r) => r.ref.id === sd.dim.to)?.ref;
    const axis = dimAxis(sd.dim, a);
    const value = a && b ? measure(evalRef(a, refTools.values), evalRef(b, refTools.values), axis) : NaN;
    const reads = [a, b].flatMap((r) => (r && axis !== null ? refPoints(r).flatMap((p) => formulaNames(p[axis])) : []));
    const driving = Boolean(sd.dim.param && (reads.includes(sd.dim.param) || paramDeps(reads, rows).includes(sd.dim.param)));
    return { axis, value, driving };
  })();
  /** A new length param seeded with `value`, set per species when the genus has species. */
  const newParamFor = (d: GenusDraft, value: number): { draft: GenusDraft; id: string } => {
    const r = addParam(d, paramRows(d, session.parentSpecs), 'length', t('genusEditor.dim.newParamLabel'));
    const next = setParam(r.draft, paramRows(r.draft, session.parentSpecs), r.id, {
      default: Math.round(value * 1000) / 1000,
      species: species.length > 0,
      group: 'dimensions',
    });
    return { draft: next, id: r.id };
  };
  const dimForm =
    sd && dimInfo && !props.isMobile ? (
      <GenusDimForm
        key={sd.dim.id}
        item={sd}
        value={dimInfo.value}
        axis={dimInfo.axis === null ? null : (['x', 'y', 'z'] as const)[dimInfo.axis]}
        rows={rows}
        others={refTools.dims.filter((d) => d.dim.id !== sd.dim.id)}
        baseName={baseName}
        nameOf={nameOf}
        driving={dimInfo.driving}
        onAxis={(axis) => editDraft((d) => putDim(d, { ...sd.dim, axis }))}
        onValue={(v) => refTools.setDimValue(sd.dim.id, v)}
        onBind={(param) => refTools.bind(sd.dim.id, param)}
        onNewParam={() =>
          editDraft((d) => {
            const r = newParamFor(d, dimInfo.value);
            return bindDim(r.draft, session.parent, sd.dim.id, r.id, { ...refTools.values, [r.id]: dimInfo.value }).draft;
          })
        }
        onEqual={(otherId) => {
          const other = refTools.dims.find((d) => d.dim.id === otherId)?.dim;
          if (!other) return;
          if (other.param) {
            refTools.bind(sd.dim.id, other.param);
            return;
          }
          const oa = refTools.refs.find((r) => r.ref.id === other.from)?.ref;
          const ob = refTools.refs.find((r) => r.ref.id === other.to)?.ref;
          const ov = oa && ob ? measure(evalRef(oa, refTools.values), evalRef(ob, refTools.values), dimAxis(other, oa)) : dimInfo.value;
          editDraft((d) => {
            const r = newParamFor(d, ov);
            const vals = { ...refTools.values, [r.id]: ov };
            const first = bindDim(r.draft, session.parent, other.id, r.id, vals).draft;
            return bindDim(first, session.parent, sd.dim.id, r.id, vals).draft;
          });
        }}
        onLocked={(locked) => editDraft((d) => putDim(d, { ...sd.dim, locked }))}
        onDelete={refTools.remove}
        onClose={() => setSelected(null)}
      />
    ) : null;

  const toolHint = refTools.tool ? (
    <div className="genus-tool-hint" data-testid="genus-tool-hint" data-tool={refTools.tool}>
      <b>{t(`genusEditor.tool.${refTools.tool}`)}</b>
      <span>{t(`genusEditor.hint.${refTools.tool}${refTools.tool === 'dim' && refTools.picked ? '2' : ''}`)}</span>
      {refTools.tool === 'plane' ? (
        <span className="genus-seg-mini" role="radiogroup" aria-label={t('genusEditor.hint.trace')}>
          {(['v', 'h'] as const).map((tr) => (
            <button
              key={tr}
              type="button"
              role="radio"
              aria-checked={refTools.trace === tr}
              className={refTools.trace === tr ? 'is-active' : ''}
              data-testid={`genus-plane-trace-${tr}`}
              onClick={() => refTools.setTrace(tr)}
            >
              {t(`genusEditor.hint.trace.${tr}`)}
            </button>
          ))}
        </span>
      ) : null}
      <span className="genus-status-spacer" />
      <button type="button" className="genus-btn is-small" onClick={() => refTools.setTool(refTools.tool)}>
        {t('genusEditor.hint.done')}
      </button>
    </div>
  ) : refTools.note ? (
    <div className="genus-tool-hint is-warn" data-testid="genus-flex-note">
      <span>⚠ {t(`genusEditor.flex.${refTools.note}`)}</span>
      <span className="genus-status-spacer" />
      <button type="button" className="genus-btn is-small" onClick={() => refTools.setNote(null)}>
        ✕
      </button>
    </div>
  ) : (
    <div className="genus-tool-hint is-idle" data-testid="genus-tool-hint-idle">
      <span>{t('genusEditor.hint.select')}</span>
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
      {issues.size > 0 ? (
        <span className="genus-status-warn" data-testid="genus-build-paused">
          ⚠ {t('genusEditor.status.paused', { n: issues.size })}
        </span>
      ) : buildError ? (
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
        {stale && issues.size === 0 ? ` · ${t('genusEditor.status.updating')}` : ''}
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
          <button type="button" className="genus-btn" data-testid="genus-mobile-params" onClick={() => setMobileParams(true)}>
            <GenusIcon name="params" /> {t('genusEditor.paramsShort')}
            {issues.size ? <span className="genus-badge-err">{issues.size}</span> : null}
          </button>
          <button type="button" className="genus-btn" data-testid="genus-mobile-structure" onClick={() => setMobileTree(true)}>
            <GenusIcon name="structure" /> {t('genusEditor.structure')}
          </button>
        </div>
        <div className="genus-mobile-status">
          {issues.size > 0 ? (
            <span className="genus-status-warn">⚠ {t('genusEditor.status.paused', { n: issues.size })}</span>
          ) : buildError ? (
            <span className="genus-status-err">✕ {buildError}</span>
          ) : (
            <span className="genus-status-ok">✓ {t('genusEditor.status.solids', { solids: solidsCount, cuts: cutsCount })}</span>
          )}
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
        {mobileParams ? (
          <div className="genus-sheet-backdrop" onClick={() => setMobileParams(false)} role="presentation">
            <div className="genus-sheet is-tall" role="dialog" aria-label={t('genusEditor.paramsAndSpecies')} data-testid="genus-mobile-params-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="genus-sheet-head">
                <b>{t('genusEditor.paramsAndSpecies')}</b>
                {dirty ? (
                  <button type="button" className="genus-btn is-primary" data-testid="genus-mobile-save" onClick={() => save()}>
                    {t('genusEditor.save')}
                  </button>
                ) : null}
                <button type="button" className="genus-btn" onClick={() => setMobileParams(false)}>
                  {t('genusEditor.close')}
                </button>
              </div>
              {dock(true)}
              {paramForm}
              {saveError ? <div className="genus-error-bar">{saveError}</div> : null}
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
          {toolHint}
          <div className={`genus-views${layout === 'all' ? ' is-grid' : ''}`} data-testid="genus-views" data-layout={layout}>
            {panes.map((v) => pane(v))}
          </div>
          {dockOpen ? dock() : null}
        </section>
        <aside className="genus-right">{paramForm ?? refForm ?? dimForm ?? properties}</aside>
      </div>
      {saveError && !confirmExit ? <div className="genus-error-bar">{saveError}</div> : null}
      {statusBar}
      {exitDialog}
    </div>,
    document.body,
  );
}
