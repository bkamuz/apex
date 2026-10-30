import { componentDisplayName, t } from '../i18n';
import type { ComponentDto } from '../types';

const STATIC_CATEGORY_KEYS: Record<string, string> = {
  grid: 'category.grid',
  construction: 'category.construction',
  section: 'category.section',
  space: 'category.space',
  point: 'category.point',
  plane: 'category.plane',
  uncategorized: 'category.uncategorized',
};

/** User-facing label for internal category / kind strings in the project browser. */
export function categoryDisplayLabel(
  category: string,
  components: readonly ComponentDto[],
): string {
  if (!category) return '—';
  const fromComponent = components.find((c) => c.category === category);
  if (fromComponent) {
    return componentDisplayName(fromComponent.id, fromComponent.display_name);
  }
  const key = STATIC_CATEGORY_KEYS[category];
  if (key) return t(key);
  const dot = category.lastIndexOf('.');
  if (dot >= 0 && dot < category.length - 1) {
    const tail = category.slice(dot + 1);
    return tail.charAt(0).toUpperCase() + tail.slice(1).replace(/_/g, ' ');
  }
  return category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, ' ');
}
