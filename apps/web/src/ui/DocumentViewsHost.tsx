import type { ReactNode } from 'react';
import type { SceneDto, SheetDto } from '../types';
import { ViewTabBar, type DocumentTab } from './ViewTabBar';
import { SheetPaperView } from './SheetPaperView';

interface Props {
  scene: SceneDto | null;
  tabs: DocumentTab[];
  activeTab: DocumentTab | null;
  splitTab: DocumentTab | null;
  splitEnabled: boolean;
  activeIsView: boolean;
  activeSheet: SheetDto | null;
  onSelectTab: (tab: DocumentTab) => void;
  onCloseTab: (tab: DocumentTab) => void;
  onToggleSplit: () => void;
  onSaveView: () => void;
  onPlaceViewOnSheet: (viewId: string, centerXmm: number, centerYmm: number) => void;
  onMoveSheetViewport: (viewportId: string, centerXmm: number, centerYmm: number) => void;
  captureViewportImage: (viewId: string, widthPx: number, heightPx: number) => Promise<string | null>;
  viewport: ReactNode;
  splitViewport?: ReactNode;
}

export function DocumentViewsHost({
  scene,
  tabs,
  activeTab,
  splitTab,
  splitEnabled,
  activeIsView,
  activeSheet,
  onSelectTab,
  onCloseTab,
  onToggleSplit,
  onSaveView,
  onPlaceViewOnSheet,
  onMoveSheetViewport,
  captureViewportImage,
  viewport,
  splitViewport,
}: Props) {
  const showSheet = activeTab?.kind === 'sheet' && activeSheet && scene;

  return (
    <>
      <ViewTabBar
        tabs={tabs}
        activeTab={activeTab}
        splitTab={splitTab}
        splitEnabled={splitEnabled}
        views={scene?.views ?? []}
        sheets={scene?.sheets ?? []}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onToggleSplit={onToggleSplit}
        onSaveView={onSaveView}
        activeIsView={activeIsView}
      />
      {showSheet ? (
        <SheetPaperView
          sheet={activeSheet}
          scene={scene}
          onPlaceView={(viewId, cx, cy) => onPlaceViewOnSheet(viewId, cx, cy)}
          onMoveViewport={onMoveSheetViewport}
          captureViewportImage={captureViewportImage}
        />
      ) : (
        <div className={`view-panes${splitEnabled ? ' view-panes--split' : ''}`}>
          <div className="view-pane view-pane--primary">{viewport}</div>
          {splitEnabled && splitViewport ? (
            <div className="view-pane view-pane--secondary">{splitViewport}</div>
          ) : null}
        </div>
      )}
    </>
  );
}
