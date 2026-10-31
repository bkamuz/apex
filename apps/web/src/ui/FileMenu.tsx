import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

type Props = {
  dirty: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
};

/**
 * Industrial Option C File menu: New / Open / Save / Save As.
 * Keeps document ops out of flat export buttons; exporters stay siblings.
 */
export function FileMenu({ dirty, onNew, onOpen, onSave, onSaveAs }: Props) {
  const { t } = useI18n();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = detailsRef.current;
      if (!el?.open) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.open = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const run = (action: () => void) => {
    close();
    action();
  };

  return (
    <details ref={detailsRef} className="file-menu" data-testid="file-menu">
      <summary
        className="file-menu-summary"
        data-testid="file-menu-summary"
        title={t('chrome.fileTitle')}
      >
        {t('chrome.file')}
        {dirty ? <span className="file-menu-dirty" aria-hidden="true">*</span> : null}
      </summary>
      <div className="file-menu-panel" role="menu">
        <button
          type="button"
          role="menuitem"
          data-testid="new-project"
          title={t('chrome.newTitle')}
          onClick={() => run(onNew)}
        >
          {t('chrome.new')}
          <kbd>{t('chrome.newShortcut')}</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="open-project"
          title={t('chrome.openTitle')}
          onClick={() => run(onOpen)}
        >
          {t('chrome.open')}
          <kbd>{t('chrome.openShortcut')}</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="save-project"
          title={t('chrome.saveTitle')}
          onClick={() => run(onSave)}
        >
          {t('chrome.save')}
          <kbd>{t('chrome.saveShortcut')}</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="save-project-as"
          title={t('chrome.saveAsTitle')}
          onClick={() => run(onSaveAs)}
        >
          {t('chrome.saveAs')}
          <kbd>{t('chrome.saveAsShortcut')}</kbd>
        </button>
      </div>
    </details>
  );
}
