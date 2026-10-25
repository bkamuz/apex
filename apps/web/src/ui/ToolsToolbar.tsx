import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProjectionMode, ViewNavigationMode } from '../viewport/ViewportRenderer';
import type { Tool } from '../tools/Tool';
import {
  collectToolTabs,
  toolsInGroup,
  toolsInTab,
  untabbedCreateTools,
} from '../tools/tabs';
import { ToolIconGlyph } from './ToolIcon';

export interface ToolsToolbarProps {
  tools: readonly Tool[];
  activeToolId: string;
  drawMode: string | null;
  projection: ProjectionMode;
  viewNavigation: ViewNavigationMode;
  onActivateTool: (id: string) => void;
  onActivateDrawMode: (id: string) => void;
  onSetProjection: (mode: ProjectionMode) => void;
  onSetViewNavigation: (mode: ViewNavigationMode) => void;
  onFitView: () => void;
}

function ToolButton({
  tool,
  active,
  onActivate,
  className,
}: {
  tool: Tool;
  active: boolean;
  onActivate: (id: string) => void;
  className?: string;
}) {
  const classes = [className, active ? 'active' : ''].filter(Boolean).join(' ');
  const title = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
  return (
    <button
      type="button"
      className={classes || undefined}
      aria-label={tool.label}
      title={title}
      onClick={() => onActivate(tool.id)}
    >
      <ToolIconGlyph icon={tool.icon} />
      <span className="tool-label">{tool.label}</span>
    </button>
  );
}

function ToolGroup({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div className={['tools-grp', className].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * Industrial chrome: plugin tabs on their own strip; Select / transform (and
 * similar always-on groups) stay pinned; create tools follow the active tab.
 */
export function ToolsToolbar({
  tools,
  activeToolId,
  drawMode,
  projection,
  viewNavigation,
  onActivateTool,
  onActivateDrawMode,
  onSetProjection,
  onSetViewNavigation,
  onFitView,
}: ToolsToolbarProps) {
  const activeTool = useMemo(
    () => tools.find((tool) => tool.id === activeToolId),
    [tools, activeToolId],
  );
  const tabs = useMemo(() => collectToolTabs(tools), [tools]);
  const selectTools = useMemo(() => toolsInGroup(tools, 'select'), [tools]);
  const transformTools = useMemo(() => toolsInGroup(tools, 'transform'), [tools]);
  const freeCreateTools = useMemo(() => untabbedCreateTools(tools), [tools]);

  const [activeTabId, setActiveTabId] = useState<string | null>(null);
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
    if (tabs.length === 0) {
      setActiveTabId(null);
      return;
    }
    setActiveTabId((current) => {
      if (current && tabs.some((tab) => tab.id === current)) return current;
      return tabs[0].id;
    });
  }, [tabs]);

  useEffect(() => {
    const tabId = activeTool?.tab?.id;
    if (tabId) setActiveTabId(tabId);
  }, [activeTool?.tab?.id, activeToolId]);

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
  }, [updateScrollHints, tools, activeTabId, activeToolId, drawMode]);

  const tabTools = activeTabId ? toolsInTab(tools, activeTabId) : [];
  const createTools = [...tabTools, ...freeCreateTools];
  const modes = activeTool?.modes ?? [];
  // Don't show Wall Line/Arc/… while browsing another tab's tools.
  const showModes =
    modes.length > 0 &&
    (!activeTool?.tab || createTools.some((tool) => tool.id === activeToolId));

  const scrollClass = [
    'tools-scroll',
    scrollHints.left ? 'can-scroll-left' : '',
    scrollHints.right ? 'can-scroll-right' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {tabs.length > 0 ? (
        <div className="tools-tabs" role="tablist" aria-label="Tool tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`tools-tab${activeTabId === tab.id ? ' active' : ''}`}
              aria-selected={activeTabId === tab.id}
              data-testid={`tools-tab-${tab.id}`}
              title={tab.label}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="tools-bar">
        <div className={scrollClass}>
          <div className="tools" ref={toolsScrollRef} role="toolbar" aria-label="Tools">
            {selectTools.length > 0 ? (
              <ToolGroup label="Select">
                {selectTools.map((tool) => (
                  <ToolButton
                    key={tool.id}
                    tool={tool}
                    active={activeToolId === tool.id}
                    onActivate={onActivateTool}
                  />
                ))}
              </ToolGroup>
            ) : null}

            {transformTools.length > 0 ? (
              <ToolGroup label="Transform">
                {transformTools.map((tool) => (
                  <ToolButton
                    key={tool.id}
                    tool={tool}
                    active={activeToolId === tool.id}
                    onActivate={onActivateTool}
                  />
                ))}
              </ToolGroup>
            ) : null}

            {createTools.length > 0 ? (
              <ToolGroup label="Create">
                {createTools.map((tool) => (
                  <ToolButton
                    key={tool.id}
                    tool={tool}
                    active={activeToolId === tool.id}
                    onActivate={onActivateTool}
                  />
                ))}
              </ToolGroup>
            ) : null}

            {showModes ? (
              <ToolGroup label="Draw mode" className="tools-grp-modes">
                {modes.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={`mode${drawMode === mode.id ? ' active' : ''}`}
                    aria-label={mode.label}
                    title={mode.label}
                    onClick={() => onActivateDrawMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </ToolGroup>
            ) : null}
          </div>
        </div>
        {/* View controls live outside the per-tab tools so they never move. */}
        <div className="tools-view" role="toolbar" aria-label="View" data-testid="view-controls">
          <ToolGroup label="View">
            <button
              type="button"
              className={viewNavigation === '3d' ? 'active' : ''}
              onClick={() => onSetViewNavigation('3d')}
              title="3D view (3)"
              data-testid="view-3d"
            >
              3D
            </button>
            <button
              type="button"
              className={viewNavigation === 'plan' ? 'active' : ''}
              onClick={() => onSetViewNavigation('plan')}
              title="Plan view — top-down cut (P)"
              data-testid="view-plan"
            >
              Plan
            </button>
            <button
              type="button"
              onClick={onFitView}
              title="Fit view / zoom extents (F)"
              data-testid="fit-view"
            >
              Fit
            </button>
          </ToolGroup>

          <ToolGroup label="Projection">
            <button
              type="button"
              className={projection === 'orthographic' ? 'active' : ''}
              disabled={viewNavigation === 'plan'}
              onClick={() => onSetProjection('orthographic')}
              title="Parallel axonometric projection"
            >
              Axon
            </button>
            <button
              type="button"
              className={projection === 'perspective' ? 'active' : ''}
              disabled={viewNavigation === 'plan'}
              onClick={() => onSetProjection('perspective')}
              title="Perspective projection"
            >
              Persp
            </button>
          </ToolGroup>
        </div>
      </div>
    </>
  );
}
