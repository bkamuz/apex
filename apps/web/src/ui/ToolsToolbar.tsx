import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProjectionMode } from '../viewport/ViewportRenderer';
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
  onActivateTool: (id: string) => void;
  onActivateDrawMode: (id: string) => void;
  onSetProjection: (mode: ProjectionMode) => void;
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
  return (
    <button
      type="button"
      className={classes || undefined}
      title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
      onClick={() => onActivate(tool.id)}
    >
      <ToolIconGlyph icon={tool.icon} />
      <span className="tool-label">{tool.label}</span>
    </button>
  );
}

function ToolGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="tools-grp" role="group" aria-label={label}>
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
  onActivateTool,
  onActivateDrawMode,
  onSetProjection,
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

  const tabTools = activeTabId ? toolsInTab(tools, activeTabId) : [];
  const createTools = [...tabTools, ...freeCreateTools];
  const modes = activeTool?.modes ?? [];
  // Don't show Wall Line/Arc/… while browsing another tab's tools.
  const showModes =
    modes.length > 0 &&
    (!activeTool?.tab || createTools.some((tool) => tool.id === activeToolId));

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

      <div className="tools" role="toolbar" aria-label="Tools">
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
          <ToolGroup label="Draw mode">
            {modes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={`mode${drawMode === mode.id ? ' active' : ''}`}
                onClick={() => onActivateDrawMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </ToolGroup>
        ) : null}

        <ToolGroup label="Projection">
          <button
            type="button"
            className={projection === 'orthographic' ? 'active' : ''}
            onClick={() => onSetProjection('orthographic')}
            title="Parallel (axonometric) projection"
          >
            Ortho
          </button>
          <button
            type="button"
            className={projection === 'perspective' ? 'active' : ''}
            onClick={() => onSetProjection('perspective')}
            title="Perspective projection"
          >
            Persp
          </button>
        </ToolGroup>
      </div>
    </>
  );
}
