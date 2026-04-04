import { create } from 'zustand';

export type ViewerMode = 'view' | 'edit' | 'sketch';

interface ViewerState {
    // Modes
    mode: ViewerMode;
    setMode: (mode: ViewerMode) => void;

    // UI Panels
    isTreeVisible: boolean;
    setTreeVisible: (visible: boolean) => void;

    // Loading State
    isLoading: boolean;
    loadingProgress: number;
    loadingError: string | null;
    setLoadingState: (isLoading: boolean, progress?: number, error?: string | null) => void;

    // Level Management
    activeLevelId: string | null;
    setActiveLevelId: (id: string | null) => void;
}

export const useViewerStore = create<ViewerState>()((set) => ({
    mode: 'view',
    setMode: (mode: ViewerMode) => set({ mode }),

    isTreeVisible: false,
    setTreeVisible: (isTreeVisible: boolean) => set({ isTreeVisible }),

    isLoading: false,
    loadingProgress: 0,
    loadingError: null,
    setLoadingState: (isLoading: boolean, loadingProgress = 0, loadingError = null) =>
        set({ isLoading, loadingProgress, loadingError }),

    activeLevelId: null,
    setActiveLevelId: (activeLevelId: string | null) => set({ activeLevelId }),
}));
