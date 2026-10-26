import type {
  OpeningRecipeDto,
  ComponentDto,
  ExprDto,
  GeometryRecipeDto,
  ParamSpecDto,
  ParamValue,
  PlacementKind,
  ProfileSpecDto,
} from '../types';
import type { Vec3 } from '../viewport/ViewportRenderer';

export type ComponentTemplate = 'box' | 'beam';

export function isUserAuthoredComponent(component: ComponentDto): boolean {
  return component.source !== 'built_in';
}

export function nextComponentId(components: ComponentDto[], category: string): string {
  const prefix = `user.${category || 'component'}`;
  const taken = new Set(components.map((item) => item.id));
  if (!taken.has(prefix)) return prefix;
  let n = 2;
  while (taken.has(`${prefix}.${n}`)) n += 1;
  return `${prefix}.${n}`;
}

function paramExpr(id: string): ExprDto {
  return { op: 'param', id };
}

function constExpr(value: number): ExprDto {
  return { op: 'const', value };
}

export function defaultNewComponent(id: string, template: ComponentTemplate): ComponentDto {
  if (template === 'beam') {
    return {
      id,
      display_name: 'Custom beam',
      category: 'beam',
      source: 'visual',
      placement: 'two_point',
      params: [
        { id: 'width', label: 'Width', kind: 'length', default: 0.2, binding: 'type' },
        { id: 'depth', label: 'Depth', kind: 'length', default: 0.4, binding: 'type' },
      ],
      recipe: {
        op: 'sweep',
        profile: {
          shape: 'rectangle',
          width: paramExpr('width'),
          height: paramExpr('depth'),
        },
        justification: 'top_center',
      },
      joinable: true,
    };
  }
  return {
    id,
    display_name: 'Custom box',
    category: 'custom',
    source: 'visual',
    placement: 'point',
    params: [
      { id: 'width', label: 'Width', kind: 'length', default: 0.5, binding: 'type' },
      { id: 'depth', label: 'Depth', kind: 'length', default: 0.5, binding: 'type' },
      { id: 'height', label: 'Height', kind: 'length', default: 1.0 },
    ],
    recipe: {
      op: 'extrude',
      profile: {
        shape: 'rectangle',
        width: paramExpr('width'),
        height: paramExpr('depth'),
      },
      frame: { from: 'work_plane' },
      height: paramExpr('height'),
    },
    joinable: false,
  };
}

export function inferTemplate(component: ComponentDto): ComponentTemplate | 'custom' {
  if (component.opening) return 'custom';
  const recipe = component.recipe;
  if (recipe.op === 'extrude' && recipe.profile.shape === 'rectangle') {
    const w = recipe.profile.width;
    const d = recipe.profile.height;
    if (w.op === 'param' && d.op === 'param' && recipe.height.op === 'param') {
      return 'box';
    }
  }
  if (recipe.op === 'sweep' && recipe.profile.shape === 'rectangle') {
    const w = recipe.profile.width;
    const d = recipe.profile.height;
    if (w.op === 'param' && d.op === 'param') return 'beam';
  }
  return 'custom';
}

export function syncTemplateRecipe(
  template: ComponentTemplate,
  params: ParamSpecDto[],
  prev: GeometryRecipeDto,
): GeometryRecipeDto {
  const ids = new Set(params.map((spec) => spec.id));
  const pick = (name: string, fallback: string) => (ids.has(name) ? name : fallback);
  if (template === 'beam') {
    const width = pick('width', 'width');
    const depth = pick('depth', 'depth');
    return {
      op: 'sweep',
      profile: {
        shape: 'rectangle',
        width: paramExpr(width),
        height: paramExpr(depth),
      },
      justification:
        prev.op === 'sweep' && prev.justification ? prev.justification : 'top_center',
    };
  }
  const width = pick('width', 'width');
  const depth = pick('depth', 'depth');
  const height = pick('height', 'height');
  return {
    op: 'extrude',
    profile: {
      shape: 'rectangle',
      width: paramExpr(width),
      height: paramExpr(depth),
    },
    frame: prev.op === 'extrude' && prev.frame ? prev.frame : { from: 'work_plane' },
    height: paramExpr(height),
  };
}

export function defaultPreviewPoints(placement: PlacementKind): Vec3[] {
  switch (placement) {
    case 'point':
      return [[0, 0, 0]];
    case 'two_point':
      return [
        [0, 0, 0],
        [3, 0, 0],
      ];
    case 'polyline':
      return [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 0],
        [0, 2, 0],
      ];
    case 'three_point_arc':
      return [
        [0, 0, 0],
        [1.5, 0, 1.5],
        [3, 0, 0],
      ];
    case 'path':
      return [
        [0, 0, 0],
        [3, 0, 0],
      ];
    case 'free':
      return [[0, 0, 0]];
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
}

export function defaultPreviewParams(component: ComponentDto): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const spec of component.params) out[spec.id] = spec.default;
  return out;
}

export function profileSpecFromEditor(
  shape: ProfileSpecDto['shape'],
  params: ParamSpecDto[],
): ProfileSpecDto {
  const ids = params.map((spec) => spec.id);
  const first = (fallback: string) => ids[0] ?? fallback;
  switch (shape) {
    case 'rectangle':
      return {
        shape: 'rectangle',
        width: paramExpr(ids.includes('width') ? 'width' : first('width')),
        height: paramExpr(ids.includes('depth') ? 'depth' : ids.includes('height') ? 'height' : first('depth')),
      };
    case 'circle':
      return {
        shape: 'circle',
        radius: paramExpr(ids.includes('radius') ? 'radius' : first('radius')),
        segments: 24,
      };
    case 'hollow_rectangle':
      return {
        shape: 'hollow_rectangle',
        width: paramExpr('width'),
        height: paramExpr('depth'),
        wall: paramExpr('wall'),
      };
    case 'hollow_circle':
      return {
        shape: 'hollow_circle',
        radius: paramExpr('radius'),
        wall: paramExpr('wall'),
        segments: 24,
      };
    default:
      return {
        shape: 'rectangle',
        width: constExpr(0.4),
        height: constExpr(0.4),
      };
  }
}

export function recipeProfileShape(recipe: GeometryRecipeDto): ProfileSpecDto['shape'] | null {
  if (recipe.op === 'extrude' || recipe.op === 'sweep') return recipe.profile.shape;
  return null;
}

export function validateComponentDraft(component: ComponentDto): string | null {
  if (!component.id.trim()) return 'Component id is required.';
  if (!component.display_name.trim()) return 'Display name is required.';
  if (!component.recipe) return 'Geometry recipe is required.';
  return null;
}

/** Opening recipe fields editable as an expression (param id or number). */
export const OPENING_EXPR_FIELDS: { key: keyof OpeningRecipeDto; label: string }[] = [
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
  { key: 'sill', label: 'Sill' },
  { key: 'arch_rise', label: 'Arch rise' },
  { key: 'frame_width', label: 'Frame width' },
  { key: 'columns', label: 'Columns' },
  { key: 'rows', label: 'Rows' },
  { key: 'mullion_width', label: 'Mullion width' },
  { key: 'transom_height', label: 'Transom height' },
  { key: 'sash_width', label: 'Sash width' },
  { key: 'sash_depth', label: 'Sash depth' },
  { key: 'bars_x', label: 'Vertical bars' },
  { key: 'bars_y', label: 'Horizontal bars' },
  { key: 'bar_width', label: 'Bar width' },
  { key: 'leaf_thickness', label: 'Leaf thickness' },
];

/** Show an expression as a param id or a number (others as JSON). */
export function exprText(expr: ExprDto | null | undefined): string {
  if (!expr) return '';
  if (expr.op === 'param') return expr.id;
  if (expr.op === 'const') return String(expr.value);
  return JSON.stringify(expr);
}

/** Parse a param id, a number, or an expression JSON. */
export function parseExprText(text: string): ExprDto | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t) as ExprDto;
    } catch {
      return undefined;
    }
  }
  const n = Number(t);
  if (Number.isFinite(n)) return constExpr(n);
  return paramExpr(t);
}

/**
 * A new opening genus built from a built-in one (`apex.window` / `apex.door`):
 * same params, host cut and void, own id/name; types are seeded on save.
 */
export function openingGenusFrom(
  base: ComponentDto,
  id: string,
  displayName: string,
  descriptor: ComponentDto['descriptor'],
): ComponentDto {
  return {
    ...base,
    id,
    display_name: displayName || `${base.display_name} genus`,
    source: 'visual',
    default_species: null,
    params: base.params.map((spec) =>
      spec.id === 'type' ? { ...spec, kind: 'text', options: undefined, default: '' } : spec,
    ),
    descriptor: descriptor?.purpose ? descriptor : base.descriptor,
  };
}
