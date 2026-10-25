import type {
  DetailLevel,
  EdgeStyle,
  SceneDto,
  StoredCameraDto,
  StoredProjection,
  ViewDto,
  ViewKindDto,
} from '../types';

export function filterPickIdsForCategories(
  scene: SceneDto,
  hiddenCategories: Set<string>,
): ArrayLike<number> | number[] {
  if (hiddenCategories.size === 0 || !scene.pick_ids?.length) {
    return scene.pick_ids;
  }
  const pickToCategory = new Map(scene.elements.map((e) => [e.pick_id, e.category]));
  const src = scene.pick_ids;
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const pid = Number(src[i] ?? 0);
    const cat = pickToCategory.get(pid);
    out[i] = cat && hiddenCategories.has(cat) ? 0 : pid;
  }
  return out;
}
import type {
  CameraState,
  ProjectionMode,
  ViewNavigationMode,
  ViewportRenderer,
} from '../viewport/ViewportRenderer';

export function viewKindLabel(kind: ViewKindDto): string {
  switch (kind.kind) {
    case 'plan':
      return 'Plan';
    case 'three_d':
      return '3D';
    case 'section':
      return 'Section';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function projectionFromStored(stored: StoredProjection): ProjectionMode {
  return stored === 'perspective' ? 'perspective' : 'orthographic';
}

export function storedFromProjection(mode: ProjectionMode): StoredProjection {
  return mode === 'perspective' ? 'perspective' : 'orthographic';
}

export function cameraToStored(camera: CameraState): StoredCameraDto {
  return {
    target: [...camera.target],
    distance: camera.distance,
    yaw: camera.yaw,
    pitch: camera.pitch,
  };
}

export function applyStoredCamera(renderer: ViewportRenderer, stored: StoredCameraDto): void {
  renderer.setCamera({
    target: stored.target as CameraState['target'],
    distance: stored.distance,
    yaw: stored.yaw,
    pitch: stored.pitch,
  });
}

/** Apply a saved view to the viewport (plan vs 3D navigation + camera). */
export function applyViewToRenderer(view: ViewDto, renderer: ViewportRenderer): void {
  const kind = view.kind;
  switch (kind.kind) {
    case 'plan': {
      renderer.setViewNavigation('plan');
      renderer.setPlanCutHeight(kind.cut_height);
      applyStoredCamera(renderer, {
        target: [0, kind.cut_height, 0],
        distance: renderer.getCamera().distance,
        yaw: 0,
        pitch: Math.PI / 2 - 0.001,
      });
      renderer.fitViewExtents();
      break;
    }
    case 'three_d': {
      renderer.setViewNavigation('3d');
      renderer.setProjection(projectionFromStored(kind.projection));
      applyStoredCamera(renderer, kind.camera);
      break;
    }
    case 'section': {
      renderer.setViewNavigation('3d');
      applyStoredCamera(renderer, kind.camera);
      break;
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function buildViewKindFromRenderer(
  view: ViewDto,
  renderer: ViewportRenderer,
  navigation: ViewNavigationMode,
): ViewKindDto {
  const camera = cameraToStored(renderer.getCamera());
  if (navigation === 'plan' && view.kind.kind === 'plan') {
    const plan = view.kind;
    return {
      kind: 'plan',
      level_id: plan.level_id,
      cut_height: renderer.getPlanCutHeight(),
      view_range_top: plan.view_range_top,
      view_range_bottom: plan.view_range_bottom,
    };
  }
  if (view.kind.kind === 'section') {
    return { ...view.kind, camera };
  }
  return {
    kind: 'three_d',
    camera,
    projection: storedFromProjection(renderer.getProjection()),
  };
}

export function hiddenCategoriesForView(view: ViewDto | undefined): Set<string> {
  const hidden = new Set<string>();
  if (!view?.settings?.category_visible) return hidden;
  for (const [cat, visible] of Object.entries(view.settings.category_visible)) {
    if (!visible) hidden.add(cat);
  }
  return hidden;
}

export function defaultViewSettings(): {
  scale: number;
  category_visible: Record<string, boolean>;
  detail_level: DetailLevel;
  edge_style: EdgeStyle;
} {
  return {
    scale: 100,
    category_visible: {},
    detail_level: 'medium',
    edge_style: 'simple',
  };
}

export function viewsByType(views: ViewDto[]): Record<string, ViewDto[]> {
  const groups: Record<string, ViewDto[]> = {};
  for (const view of views) {
    const key = view.type_label || viewKindLabel(view.kind);
    if (!groups[key]) groups[key] = [];
    groups[key].push(view);
  }
  return groups;
}

export function findView(scene: SceneDto | null, id: string | null): ViewDto | undefined {
  if (!scene?.views || !id) return undefined;
  return scene.views.find((v) => v.id === id);
}
