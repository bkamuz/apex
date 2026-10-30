import { useI18n } from '../i18n';

interface Props {
  onDismiss: () => void;
  onLoadSample: () => void;
}

export function GettingStartedPanel({ onDismiss, onLoadSample }: Props) {
  const { t } = useI18n();
  const body = t('gettingStarted.body', {
    w: 'W',
    p: 'P',
    f: 'F',
    m: 'M',
    c: 'C',
    undo: 'Ctrl+Z',
  });
  // Wrap hotkey tokens in <kbd> by splitting on known keys.
  const parts = body.split(/(W|P|F|M|C|Ctrl\+Z)/g);

  return (
    <div className="getting-started" data-testid="getting-started">
      <div className="getting-started-kicker">{t('gettingStarted.kicker')}</div>
      <div className="getting-started-title">{t('gettingStarted.title')}</div>
      <p>
        {parts.map((part, i) =>
          part === 'W' ||
          part === 'P' ||
          part === 'F' ||
          part === 'M' ||
          part === 'C' ||
          part === 'Ctrl+Z' ? (
            <kbd key={`${part}-${i}`}>{part}</kbd>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </p>
      <div className="getting-started-actions">
        <button type="button" data-testid="load-sample-project" onClick={onLoadSample}>
          {t('gettingStarted.loadSample')}
        </button>
        <button type="button" className="panel-action" onClick={onDismiss}>
          {t('gettingStarted.dismiss')}
        </button>
      </div>
    </div>
  );
}
