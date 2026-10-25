import { useMemo, useState } from 'react';
import type { LevelDto, PaperOrientation, PaperSize, SheetDto, ViewDto } from '../types';
import { viewsByType } from './viewModel';
import { SheetLayoutControls } from './SheetLayoutControls';

interface Props {
  views: ViewDto[];
  sheets: SheetDto[];
  levels: LevelDto[];
  activeLevelId: string | null;
  openViewId: string | null;
  openSheetId: string | null;
  onOpenView: (id: string) => void;
  onOpenSheet: (id: string) => void;
  onNewPlanView: (levelId: string) => void;
  onNewThreeDView: () => void;
  onDuplicateView: (id: string) => void;
  onRenameView: (id: string, name: string) => void;
  onDeleteView: (id: string) => void;
  onCreateSheetWithLayout: (
    paper: PaperSize,
    orientation: PaperOrientation,
    customWidthMm: number,
    customHeightMm: number,
  ) => void;
  onRenameSheet: (id: string, number: string, name: string) => void;
  onDeleteSheet: (id: string) => void;
}

function ViewsGroup({
  label,
  views,
  openViewId,
  onOpenView,
  onDuplicateView,
  onRenameView,
  onDeleteView,
}: {
  label: string;
  views: ViewDto[];
  openViewId: string | null;
  onOpenView: (id: string) => void;
  onDuplicateView: (id: string) => void;
  onRenameView: (id: string, name: string) => void;
  onDeleteView: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="browser-tree-group">
      <div className="browser-tree-group-header">
        <button type="button" className="browser-tree-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="browser-tree-chevron" aria-hidden="true" />
        </button>
        <span className="browser-tree-group-label">{label}</span>
        <span className="browser-tree-group-count">{views.length}</span>
      </div>
      {open ? (
        <ul className="browser-tree-items">
          {views.map((view) => (
            <li key={view.id}>
              <div
                className={`browser-tree-item${openViewId === view.id ? ' browser-tree-item--selected' : ''}`}
              >
                <button
                  type="button"
                  className="browser-tree-item-btn"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-apex-view-id', view.id);
                  }}
                  onDoubleClick={() => onOpenView(view.id)}
                  onClick={() => onOpenView(view.id)}
                  data-testid={`view-row-${view.id}`}
                >
                  {view.name}
                </button>
                <div className="browser-tree-item-actions">
                  <button type="button" title="Duplicate" onClick={() => onDuplicateView(view.id)}>
                    ⧉
                  </button>
                  <button
                    type="button"
                    title="Rename"
                    onClick={() => {
                      const name = window.prompt('View name', view.name);
                      if (name?.trim()) onRenameView(view.id, name.trim());
                    }}
                  >
                    ✎
                  </button>
                  <button type="button" title="Delete" onClick={() => onDeleteView(view.id)}>
                    ×
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ViewsSheetsPanel({
  views,
  sheets,
  levels,
  activeLevelId,
  openViewId,
  openSheetId,
  onOpenView,
  onOpenSheet,
  onNewPlanView,
  onNewThreeDView,
  onDuplicateView,
  onRenameView,
  onDeleteView,
  onCreateSheetWithLayout,
  onRenameSheet,
  onDeleteSheet,
}: Props) {
  const [viewsOpen, setViewsOpen] = useState(true);
  const [sheetsOpen, setSheetsOpen] = useState(true);
  const [newPaper, setNewPaper] = useState<PaperSize>('A3');
  const [newOrientation, setNewOrientation] = useState<PaperOrientation>('landscape');
  const [newCustomW, setNewCustomW] = useState(420);
  const [newCustomH, setNewCustomH] = useState(297);
  const grouped = useMemo(() => viewsByType(views), [views]);
  const levelId = activeLevelId ?? levels[0]?.id ?? '';

  return (
    <div className="views-sheets-panel" data-testid="views-sheets-panel">
      <div className="browser-tree-group">
        <div className="browser-tree-group-header">
          <button type="button" className="browser-tree-toggle" onClick={() => setViewsOpen((v) => !v)}>
            <span className="browser-tree-chevron" aria-hidden="true" />
          </button>
          <span className="browser-tree-group-label">Views</span>
          <span className="browser-tree-group-count">{views.length}</span>
          <button
            type="button"
            className="panel-action"
            data-testid="new-plan-view"
            disabled={!levelId}
            onClick={() => levelId && onNewPlanView(levelId)}
            title="New plan view for active level"
          >
            + Plan
          </button>
          <button type="button" className="panel-action" data-testid="new-3d-view" onClick={onNewThreeDView}>
            + 3D
          </button>
        </div>
        {viewsOpen ? (
          <div className="browser-tree">
            {Object.entries(grouped).map(([label, list]) => (
              <ViewsGroup
                key={label}
                label={label}
                views={list}
                openViewId={openViewId}
                onOpenView={onOpenView}
                onDuplicateView={onDuplicateView}
                onRenameView={onRenameView}
                onDeleteView={onDeleteView}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="browser-tree-group">
        <div className="browser-tree-group-header">
          <button type="button" className="browser-tree-toggle" onClick={() => setSheetsOpen((v) => !v)}>
            <span className="browser-tree-chevron" aria-hidden="true" />
          </button>
          <span className="browser-tree-group-label">Sheets</span>
          <span className="browser-tree-group-count">{sheets.length}</span>
        </div>
        {sheetsOpen ? (
          <div className="sheet-create-block">
            <SheetLayoutControls
              testIdPrefix="new-sheet"
              paper={newPaper}
              orientation={newOrientation}
              customWidthMm={newCustomW}
              customHeightMm={newCustomH}
              onPaperChange={setNewPaper}
              onOrientationChange={setNewOrientation}
              onCustomWidthChange={setNewCustomW}
              onCustomHeightChange={setNewCustomH}
            />
            <button
              type="button"
              className="panel-action"
              data-testid="new-sheet"
              onClick={() =>
                onCreateSheetWithLayout(newPaper, newOrientation, newCustomW, newCustomH)
              }
            >
              + Create sheet
            </button>
          </div>
        ) : null}
        {sheetsOpen ? (
          <ul className="browser-tree-items">
            {sheets.map((sheet) => (
              <li key={sheet.id}>
                <div
                  className={`browser-tree-item${openSheetId === sheet.id ? ' browser-tree-item--selected' : ''}`}
                >
                  <button
                    type="button"
                    className="browser-tree-item-btn"
                    onDoubleClick={() => onOpenSheet(sheet.id)}
                    onClick={() => onOpenSheet(sheet.id)}
                    data-testid={`sheet-row-${sheet.id}`}
                  >
                    {sheet.number} — {sheet.name}
                  </button>
                  <div className="browser-tree-item-actions">
                    <button
                      type="button"
                      title="Rename"
                      onClick={() => {
                        const number = window.prompt('Sheet number', sheet.number);
                        if (!number?.trim()) return;
                        const name = window.prompt('Sheet name', sheet.name);
                        if (name?.trim()) onRenameSheet(sheet.id, number.trim(), name.trim());
                      }}
                    >
                      ✎
                    </button>
                    <button type="button" title="Delete" onClick={() => onDeleteSheet(sheet.id)}>
                      ×
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
