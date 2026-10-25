import type { ReactNode } from 'react';
import type { SceneDto, SheetDto, StoredCameraDto } from '../types';
import { ViewTabBar, type DocumentTab } from './ViewTabBar';
import { SheetPaperView } from './SheetPaperView';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

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
  syncSheetViewportScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
  onSheetViewportStateChange: (
    viewportId: string,
    camera: StoredCameraDto | null,
    lockNavigation: boolean,
  ) => void;
  onExportActiveViewSvg?: () => void;
  onExportActiveViewDxf?: () => void;
  onExportActiveViewPdf?: () => void;
  activeViewIsPlan?: boolean;
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
  syncSheetViewportScene,
  onSheetViewportStateChange,
  onExportActiveViewSvg,
  onExportActiveViewDxf,
  onExportActiveViewPdf,
  activeViewIsPlan,
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
        onExportViewSvg={onExportActiveViewSvg}
        onExportViewDxf={onExportActiveViewDxf}
        onExportViewPdf={onExportActiveViewPdf}
        showViewExport={activeViewIsPlan ?? false}
      />
      {showSheet ? (
        <SheetPaperView
          sheet={activeSheet}
          scene={scene}
          onPlaceView={(viewId, cx, cy) => onPlaceViewOnSheet(viewId, cx, cy)}
          onMoveViewport={onMoveSheetViewport}
          syncScene={syncSheetViewportScene}
          onViewportStateChange={onSheetViewportStateChange}
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
