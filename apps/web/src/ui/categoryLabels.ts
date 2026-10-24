import type { ComponentDto } from '../types';

const STATIC_CATEGORY_LABELS: Record<string, string> = {
  grid: 'Grid',
  construction: 'Construction line',
  section: 'Section cut',
  space: 'Space',
  point: 'Reference point',
  plane: 'Reference plane',
  uncategorized: 'Uncategorized',
};

/** User-facing label for internal category / kind strings in the project browser. */
export function categoryDisplayLabel(
  category: string,
  components: readonly ComponentDto[],
): string {
  if (!category) return '—';
  const fromComponent = components.find((c) => c.category === category);
  if (fromComponent) return fromComponent.display_name;
  if (STATIC_CATEGORY_LABELS[category]) return STATIC_CATEGORY_LABELS[category];
  const dot = category.lastIndexOf('.');
  if (dot >= 0 && dot < category.length - 1) {
    const tail = category.slice(dot + 1);
    return tail.charAt(0).toUpperCase() + tail.slice(1).replace(/_/g, ' ');
  }
  return category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, ' ');
}
