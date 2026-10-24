import { useEffect, useMemo, useState } from 'react';
import type { ProjectionMode } from '../viewport/ViewportRenderer';
import type { Tool } from '../tools/Tool';
import {
  collectToolTabs,
  toolsInGroup,
  toolsInTab,
  untabbedCreateTools,
} from '../tools/tabs';

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
}: {
  tool: Tool;
  active: boolean;
  onActivate: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={active ? 'active' : ''}
      title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
      onClick={() => onActivate(tool.id)}
    >
      {tool.label}
    </button>
  );
}

function Sep() {
  return <span className="tools-sep" aria-hidden="true" />;
}

/**
 * Select / transform stay as flat group clusters. Create tools that declare a
 * `tab` appear under dynamically discovered tab chips (catalog or custom).
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

  return (
    <div className="tools" role="toolbar" aria-label="Tools">
      {selectTools.map((tool) => (
        <ToolButton
          key={tool.id}
          tool={tool}
          active={activeToolId === tool.id}
          onActivate={onActivateTool}
        />
      ))}

      {transformTools.length > 0 ? <Sep /> : null}
      {transformTools.map((tool) => (
        <ToolButton
          key={tool.id}
          tool={tool}
          active={activeToolId === tool.id}
          onActivate={onActivateTool}
        />
      ))}

      {tabs.length > 0 ? <Sep /> : null}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tools-tab${activeTabId === tab.id ? ' active' : ''}`}
          aria-pressed={activeTabId === tab.id}
          data-testid={`tools-tab-${tab.id}`}
          title={tab.label}
          onClick={() => setActiveTabId(tab.id)}
        >
          {tab.label}
        </button>
      ))}

      {tabTools.map((tool) => (
        <ToolButton
          key={tool.id}
          tool={tool}
          active={activeToolId === tool.id}
          onActivate={onActivateTool}
        />
      ))}

      {freeCreateTools.length > 0 ? <Sep /> : null}
      {freeCreateTools.map((tool) => (
        <ToolButton
          key={tool.id}
          tool={tool}
          active={activeToolId === tool.id}
          onActivate={onActivateTool}
        />
      ))}

      {activeTool?.modes && activeTool.modes.length > 0 ? (
        <>
          <Sep />
          {activeTool.modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`mode${drawMode === mode.id ? ' active' : ''}`}
              onClick={() => onActivateDrawMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </>
      ) : null}

      <Sep />
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
    </div>
  );
}
