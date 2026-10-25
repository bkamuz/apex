import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SceneDto } from '../types';
import type { DocumentTab } from '../ui/ViewTabBar';

const TABS_KEY = 'apex.documentTabs';

function loadTabs(): DocumentTab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DocumentTab[];
  } catch {
    return [];
  }
}

function storeTabs(tabs: DocumentTab[]): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* ignore */
  }
}

export function useDocumentTabs(scene: SceneDto | null) {
  const [openTabs, setOpenTabs] = useState<DocumentTab[]>(loadTabs);
  const [activeTab, setActiveTab] = useState<DocumentTab | null>(null);
  const [splitTab, setSplitTab] = useState<DocumentTab | null>(null);
  const [splitEnabled, setSplitEnabled] = useState(false);
  const seededRef = useRef(false);

  const views = scene?.views ?? [];
  const sheets = scene?.sheets ?? [];

  useEffect(() => {
    storeTabs(openTabs);
  }, [openTabs]);

  useEffect(() => {
    if (!scene || seededRef.current) return;
    if (views.length === 0) return;
    seededRef.current = true;
    if (openTabs.length === 0) {
      const plan = views.find((v) => v.kind.kind === 'plan') ?? views[0];
      const threeD = views.find((v) => v.kind.kind === 'three_d');
      const tabs: DocumentTab[] = [{ kind: 'view', id: plan.id }];
      if (threeD && threeD.id !== plan.id) tabs.push({ kind: 'view', id: threeD.id });
      setOpenTabs(tabs);
      setActiveTab(tabs[0] ?? null);
      if (tabs.length > 1) {
        setSplitTab(tabs[1] ?? null);
      }
    } else {
      setActiveTab((prev) => prev ?? openTabs[0] ?? null);
    }
  }, [scene, views, openTabs]);

  const openTab = useCallback((tab: DocumentTab) => {
    setOpenTabs((prev) => {
      if (prev.some((t) => t.kind === tab.kind && t.id === tab.id)) return prev;
      return [...prev, tab];
    });
    setActiveTab(tab);
  }, []);

  const closeTab = useCallback(
    (tab: DocumentTab) => {
      setOpenTabs((prev) => prev.filter((t) => !(t.kind === tab.kind && t.id === tab.id)));
      if (activeTab?.kind === tab.kind && activeTab.id === tab.id) {
        const remaining = openTabs.filter((t) => !(t.kind === tab.kind && t.id === tab.id));
        setActiveTab(remaining[0] ?? null);
      }
      if (splitTab?.kind === tab.kind && splitTab.id === tab.id) {
        setSplitTab(null);
        setSplitEnabled(false);
      }
    },
    [activeTab, openTabs, splitTab],
  );

  const toggleSplit = useCallback(() => {
    setSplitEnabled((on) => {
      if (on) return false;
      const second = openTabs.find(
        (t) => !(activeTab && t.kind === activeTab.kind && t.id === activeTab.id),
      );
      setSplitTab(second ?? null);
      return Boolean(second);
    });
  }, [activeTab, openTabs]);

  const activeIsView = activeTab?.kind === 'view';

  const activeViewId = activeTab?.kind === 'view' ? activeTab.id : null;
  const activeSheetId = activeTab?.kind === 'sheet' ? activeTab.id : null;

  const activeSheet = useMemo(
    () => sheets.find((s) => s.id === activeSheetId) ?? null,
    [activeSheetId, sheets],
  );

  return {
    openTabs,
    activeTab,
    splitTab,
    splitEnabled,
    activeIsView,
    activeViewId,
    activeSheet,
    openTab,
    closeTab,
    setActiveTab,
    toggleSplit,
    views,
    sheets,
  };
}
