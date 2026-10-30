import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

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

export function MobileMenuSheet({
  open,
  tab,
  onTabChange,
  onClose,
  levels,
  elements,
  properties,
}: Props) {
  const { t } = useI18n();
  if (!open) return null;

  const tabs: { id: MobileMenuTab; label: string }[] = [
    { id: 'levels', label: t('mobile.levels') },
    { id: 'elements', label: t('mobile.project') },
    { id: 'properties', label: t('mobile.properties') },
  ];

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
      <button
        type="button"
        className="mobile-menu-backdrop"
        aria-label={t('mobile.closeMenu')}
        onClick={onClose}
      />
      <div
        className="mobile-menu-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('mobile.sceneMenu')}
      >
        <div className="mobile-menu-header">
          <div className="mobile-menu-tabs" role="tablist">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? 'active' : ''}
                onClick={() => onTabChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button type="button" className="mobile-menu-close" onClick={onClose} title={t('panel.close')}>
            {t('panel.close')}
          </button>
        </div>
        <div className="mobile-menu-content">{content}</div>
      </div>
    </>
  );
}
