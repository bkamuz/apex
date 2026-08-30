import type { ReactNode } from 'react';

export type MobileMenuTab = 'levels' | 'elements' | 'properties';

interface Props {
  open: boolean;
  tab: MobileMenuTab;
  onTabChange: (tab: MobileMenuTab) => void;
  onClose: () => void;
  levels: ReactNode;
  elements: ReactNode;
  properties: ReactNode;
}

const TABS: { id: MobileMenuTab; label: string }[] = [
  { id: 'levels', label: 'Levels' },
  { id: 'elements', label: 'Project' },
  { id: 'properties', label: 'Properties' },
];

export function MobileMenuSheet({
  open,
  tab,
  onTabChange,
  onClose,
  levels,
  elements,
  properties,
}: Props) {
  if (!open) return null;

  let content: ReactNode;
  switch (tab) {
    case 'levels':
      content = levels;
      break;
    case 'elements':
      content = elements;
      break;
    case 'properties':
      content = properties;
      break;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }

  return (
    <>
      <button type="button" className="mobile-menu-backdrop" aria-label="Close menu" onClick={onClose} />
      <div className="mobile-menu-sheet" role="dialog" aria-modal="true" aria-label="Scene menu">
        <div className="mobile-menu-header">
          <div className="mobile-menu-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={() => onTabChange(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="mobile-menu-close" onClick={onClose} title="Close">
            Close
          </button>
        </div>
        <div className="mobile-menu-content">{content}</div>
      </div>
    </>
  );
}
