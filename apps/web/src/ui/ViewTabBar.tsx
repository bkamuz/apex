import type { SheetDto, ViewDto } from '../types';

export type DocumentTab =
  | { kind: 'view'; id: string }
  | { kind: 'sheet'; id: string };

interface Props {
  tabs: DocumentTab[];
  activeTab: DocumentTab | null;
  splitTab: DocumentTab | null;
  splitEnabled: boolean;
  views: ViewDto[];
  sheets: SheetDto[];
  onSelect: (tab: DocumentTab) => void;
  onClose: (tab: DocumentTab) => void;
  onToggleSplit: () => void;
  onSaveView?: () => void;
  activeIsView: boolean;
}

function tabLabel(tab: DocumentTab, views: ViewDto[], sheets: SheetDto[]): string {
  if (tab.kind === 'view') {
    return views.find((v) => v.id === tab.id)?.name ?? 'View';
  }
  const sheet = sheets.find((s) => s.id === tab.id);
  return sheet ? `${sheet.number} ${sheet.name}` : 'Sheet';
}

export function ViewTabBar({
  tabs,
  activeTab,
  splitTab,
  splitEnabled,
  views,
  sheets,
  onSelect,
  onClose,
  onToggleSplit,
  onSaveView,
  activeIsView,
}: Props) {
  return (
    <div className="view-tab-bar" data-testid="view-tab-bar">
      <div className="view-tab-list" role="tablist">
        {tabs.map((tab) => {
          const active =
            (activeTab?.kind === tab.kind && activeTab.id === tab.id) ||
            (splitEnabled &&
              splitTab?.kind === tab.kind &&
              splitTab.id === tab.id);
          return (
            <div
              key={`${tab.kind}-${tab.id}`}
              className={`view-tab${active ? ' view-tab--active' : ''}`}
              role="tab"
              aria-selected={active}
            >
              <button type="button" className="view-tab-open" onClick={() => onSelect(tab)}>
                {tab.kind === 'sheet' ? '▦ ' : '◫ '}
                {tabLabel(tab, views, sheets)}
              </button>
              <button
                type="button"
                className="view-tab-close"
                aria-label="Close tab"
                onClick={() => onClose(tab)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="view-tab-actions">
        {activeIsView && onSaveView ? (
          <button type="button" data-testid="save-view" onClick={onSaveView}>
            Save view
          </button>
        ) : null}
        <button
          type="button"
          data-testid="toggle-split"
          title="Split view side by side"
          onClick={onToggleSplit}
        >
          {splitEnabled ? 'Single pane' : 'Split'}
        </button>
      </div>
    </div>
  );
}
