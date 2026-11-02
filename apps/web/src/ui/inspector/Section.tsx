import { useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';

const STORAGE_KEY = 'apex.inspector.sections';

function readClosed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Collapsible inspector section; the open/closed state persists per section id. */
export function Section({
  id,
  title,
  badge,
  children,
  dataSection,
}: {
  id: string;
  title: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  dataSection?: string;
}) {
  const { t } = useI18n();
  const [closed, setClosed] = useState(() => Boolean(readClosed()[id]));
  const toggle = () => {
    const next = !closed;
    setClosed(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readClosed(), [id]: next }));
    } catch {
      /* ignore */
    }
  };
  return (
    <section
      className={`inspector-group${closed ? ' is-closed' : ''}`}
      data-group={id}
      data-section={dataSection}
    >
      <button
        type="button"
        className="inspector-group-head"
        aria-expanded={!closed}
        title={closed ? t('inspector.expand') : t('inspector.collapse')}
        onClick={toggle}
      >
        <span className="inspector-group-caret" aria-hidden>
          {closed ? '▸' : '▾'}
        </span>
        <span className="inspector-group-title">{title}</span>
        {badge ? <span className="inspector-group-badge">{badge}</span> : null}
      </button>
      {closed ? null : <div className="inspector-group-body">{children}</div>}
    </section>
  );
}
