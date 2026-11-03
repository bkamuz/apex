import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOGS, useI18n } from '../i18n';
import { filterCommands, type PaletteCommand } from './commands';

/** Every catalog spelling of `key` (EN and RU), plus extras. */
export function bilingual(key: string, ...extra: (string | undefined)[]): string {
  const parts = [
    (CATALOGS.en as Record<string, string>)[key],
    (CATALOGS.ru as Record<string, string>)[key],
    ...extra,
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/** Ctrl+K palette over every command (tools, file, view, settings), RU/EN search. */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: readonly PaletteCommand[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;
  const run = (cmd: PaletteCommand | undefined) => {
    if (!cmd || cmd.disabled) return;
    onClose();
    // Let the dialog unmount (and focus return) before the command runs.
    requestAnimationFrame(() => cmd.run());
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose} data-testid="command-palette">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          data-testid="palette-input"
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.title')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(results[index]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <ul className="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 ? <li className="palette-empty">{t('palette.empty')}</li> : null}
          {results.map((cmd, i) => (
            <li
              key={cmd.id}
              role="option"
              aria-selected={i === index}
              aria-disabled={cmd.disabled || undefined}
              data-testid={`palette-cmd-${cmd.id}`}
              className={`palette-item${i === index ? ' active' : ''}${cmd.disabled ? ' disabled' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(cmd)}
            >
              <span className="palette-group">{cmd.group}</span>
              <span className="palette-label">{cmd.label}</span>
              {cmd.shortcut ? <kbd>{cmd.shortcut}</kbd> : null}
            </li>
          ))}
        </ul>
        <div className="palette-hint">{t('palette.hint')}</div>
      </div>
    </div>
  );
}
