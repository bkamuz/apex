import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Tool } from '../tools/Tool';
import { tabDisplayLabel, toolDisplayLabel, useI18n } from '../i18n';
import { ToolIconGlyph } from './ToolIcon';
import {
  buildRibbon,
  modifyTools,
  RIBBON_TABS,
  ribbonTabForTool,
  showModify,
  type RibbonGroup,
} from './ribbon';
import { shortcutForCommand } from './shortcuts';

export interface RibbonViewControls {
  viewNavigation: '3d' | 'plan';
  onSetViewNavigation: (mode: '3d' | 'plan') => void;
  onFitView: () => void;
  hairline: boolean;
  onToggleHairline: () => void;
}

export interface ToolsToolbarProps {
  tools: readonly Tool[];
  activeToolId: string;
  onActivateTool: (id: string) => void;
  /** Anything selected (elements, references, grid axes, …). */
  selectedCount: number;
  /** Selection-dependent commands appended to Modify (e.g. Attach top/base). */
  modifyExtra?: ReactNode;
  view: RibbonViewControls;
  onOpenPalette: () => void;
}

function shortcutHint(tool: Tool): string | undefined {
  return shortcutForCommand(`tool:${tool.id}`) ?? tool.shortcut;
}

function ToolButton({
  tool,
  active,
  onActivate,
}: {
  tool: Tool;
  active: boolean;
  onActivate: (id: string) => void;
}) {
  const label = toolDisplayLabel(tool);
  const key = shortcutHint(tool);
  const classes = ['rb-btn', 'rb-btn--big', active ? 'active' : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={active}
      title={key ? `${label} (${key})` : label}
      data-testid={`tool-${tool.id}`}
      onClick={() => onActivate(tool.id)}
    >
      <ToolIconGlyph icon={tool.icon} />
      <span className="tool-label">{label}</span>
    </button>
  );
}

function RibbonPanel({
  label,
  children,
  className,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={['tools-grp', 'rb-panel', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      <div className="rb-panel-body">{children}</div>
      <div className="rb-panel-caption" aria-hidden="true">
        {label}
      </div>
    </div>
  );
}

function TextButton({
  label,
  glyph,
  title,
  active,
  onClick,
  testId,
}: {
  label: string;
  glyph: string;
  title: string;
  active?: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={`rb-btn rb-btn--big${active ? ' active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={title}
      data-testid={testId}
      onClick={onClick}
    >
      <span className="tool-icon rb-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="tool-label">{label}</span>
    </button>
  );
}

/**
 * Variant-A ribbon: tabs by task (Architecture, Engineering, Annotate, View +
 * plugin tabs), labelled panels, and a contextual Modify panel that only shows
 * while something is selected.
 */
export function ToolsToolbar({
  tools,
  activeToolId,
  onActivateTool,
  selectedCount,
  modifyExtra,
  view,
  onOpenPalette,
}: ToolsToolbarProps) {
  const { t, locale } = useI18n();
  const ribbon = useMemo(() => buildRibbon(tools), [tools]);
  const modify = useMemo(() => modifyTools(tools), [tools]);
  const modifyVisible = showModify(selectedCount, activeToolId, tools);

  const [activeTabId, setActiveTabId] = useState<string>(RIBBON_TABS.architecture);
  const toolsScrollRef = useRef<HTMLDivElement>(null);
  const [scrollHints, setScrollHints] = useState({ left: false, right: false });

  const updateScrollHints = useCallback(() => {
    const el = toolsScrollRef.current;
    if (!el) return;
    const canLeft = el.scrollLeft > 2;
    const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setScrollHints((prev) =>
      prev.left === canLeft && prev.right === canRight ? prev : { left: canLeft, right: canRight },
    );
  }, []);

  useEffect(() => {
    if (!ribbon.some((tab) => tab.id === activeTabId)) setActiveTabId(ribbon[0]?.id ?? RIBBON_TABS.view);
  }, [ribbon, activeTabId]);

  // Follow the active tool to its tab (palette / shortcuts can start any tool).
  useEffect(() => {
    const tabId = ribbonTabForTool(ribbon, activeToolId);
    if (tabId && tabId !== RIBBON_TABS.architecture) setActiveTabId(tabId);
    else if (tabId === RIBBON_TABS.architecture) {
      const sel = ribbon[0]?.groups.find((g) => g.id === 'select');
      if (!sel?.tools.some((tool) => tool.id === activeToolId)) setActiveTabId(tabId);
    }
  }, [ribbon, activeToolId]);

  useEffect(() => {
    updateScrollHints();
    const el = toolsScrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScrollHints, { passive: true });
    const observer = new ResizeObserver(updateScrollHints);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollHints);
      observer.disconnect();
    };
  }, [updateScrollHints, tools, activeTabId, activeToolId, locale, modifyVisible]);

  const activeTab = ribbon.find((tab) => tab.id === activeTabId) ?? ribbon[0];

  const groupLabel = (group: RibbonGroup) =>
    group.id === 'plugin' && group.label
      ? tabDisplayLabel(activeTab?.id ?? '', group.label)
      : t(`ribbon.group.${group.id}`);

  const scrollClass = [
    'tools-scroll',
    scrollHints.left ? 'can-scroll-left' : '',
    scrollHints.right ? 'can-scroll-right' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div className="tools-tabs" role="tablist" aria-label={t('toolbar.toolTabs')}>
        {ribbon.map((tab) => {
          const label = tabDisplayLabel(tab.id, tab.label ?? tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`tools-tab${activeTab?.id === tab.id ? ' active' : ''}`}
              aria-selected={activeTab?.id === tab.id}
              data-testid={`tools-tab-${tab.id}`}
              title={label}
              onClick={() => setActiveTabId(tab.id)}
            >
              {label}
            </button>
          );
        })}
        {modifyVisible ? (
          <span className="tools-tab tools-tab--context" data-testid="ribbon-context-tab" aria-hidden="true">
            {t('ribbon.group.modify')}
          </span>
        ) : null}
        <button
          type="button"
          className="tools-palette-btn"
          data-testid="palette-open"
          title={t('palette.openTitle')}
          aria-label={t('palette.title')}
          onClick={onOpenPalette}
        >
          <span aria-hidden="true">⌕</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>

      <div className="tools-bar">
        <div className={scrollClass}>
          <div className="tools" ref={toolsScrollRef} role="toolbar" aria-label={t('toolbar.tools')}>
            {activeTab?.groups
              .filter((group) => group.tools.length > 0)
              .map((group) => (
                <RibbonPanel
                  key={group.id + (group.label ?? '')}
                  label={groupLabel(group)}
                  testId={`ribbon-group-${group.id}`}
                >
                  {group.tools.map((tool) => (
                    <ToolButton
                      key={tool.id}
                      tool={tool}
                      active={activeToolId === tool.id}
                      onActivate={onActivateTool}
                    />
                  ))}
                </RibbonPanel>
              ))}

            {activeTab?.id === RIBBON_TABS.view ? (
              <>
                <RibbonPanel label={t('ribbon.group.navigate')} testId="ribbon-group-navigate">
                  <TextButton
                    label={t('cmd.view3d')}
                    glyph="3D"
                    title={t('toolbar.view3dTitle')}
                    active={view.viewNavigation === '3d'}
                    onClick={() => view.onSetViewNavigation('3d')}
                    testId="ribbon-view-3d"
                  />
                  <TextButton
                    label={t('cmd.plan')}
                    glyph="▭"
                    title={t('toolbar.planTitle')}
                    active={view.viewNavigation === 'plan'}
                    onClick={() => view.onSetViewNavigation('plan')}
                    testId="ribbon-view-plan"
                  />
                  <TextButton
                    label={t('cmd.fit')}
                    glyph="⤢"
                    title={t('toolbar.fitTitle')}
                    onClick={view.onFitView}
                    testId="ribbon-view-fit"
                  />
                </RibbonPanel>
                <RibbonPanel label={t('ribbon.group.graphics')} testId="ribbon-group-graphics">
                  <TextButton
                    label={t('cmd.thinLines')}
                    glyph="TL"
                    title={t('toolbar.thinLinesTitle')}
                    active={view.hairline}
                    onClick={view.onToggleHairline}
                    testId="ribbon-thin-lines"
                  />
                </RibbonPanel>
              </>
            ) : null}

            {modifyVisible && modify.length > 0 ? (
              <RibbonPanel
                label={t('ribbon.group.modify')}
                className="rb-panel--context"
                testId="ribbon-group-modify"
              >
                {modify.map((tool) => (
                  <ToolButton
                    key={tool.id}
                    tool={tool}
                    active={activeToolId === tool.id}
                    onActivate={onActivateTool}
                  />
                ))}
                {modifyExtra}
              </RibbonPanel>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
