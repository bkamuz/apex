import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { apexExecuteCommand } from '../wasm/apex';
import { decodeGenusFile, importCommands, isBuiltInGenusId, type GenusFileErrorCode } from './apexgenus';
import { writeGenusFile, readGenusFile } from './genusFileIo';
import { deleteGenusFromLibrary, genusLibrary, subscribeGenusLibrary, type LibraryRecord } from './library';
import './genusEditor.css';

interface Props {
  /** After a genus was inserted into the live project. */
  onChanged: () => void;
}

function fileError(code: GenusFileErrorCode, version: number | undefined, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (code === 'versionNewer') return t('genusFile.err.versionNewer', { version: version ?? '?', supported: 1 });
  return t(`genusFile.err.${code}`);
}

/** «Моя библиотека» / My library, in the Роды browser. */
export function GenusLibraryPanel({ onChanged }: Props) {
  const { t } = useI18n();
  const [rows, setRows] = useState<LibraryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const reload = () => {
    void genusLibrary()
      .list()
      .then((list) => {
        setRows(list);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    reload();
    return subscribeGenusLibrary(reload);
  }, []);

  const insert = (record: LibraryRecord) => {
    if (isBuiltInGenusId(record.file.genus.id)) {
      setError(t('genusFile.err.builtIn'));
      return;
    }
    try {
      const steps = importCommands(record.file);
      apexExecuteCommand(steps.length === 1 ? steps[0] : { op: 'batch', commands: steps });
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const importFile = async () => {
    const picked = await readGenusFile();
    if (!picked) return;
    const decoded = decodeGenusFile(picked.text);
    if (!decoded.ok) {
      setError(fileError(decoded.code, decoded.version, t));
      return;
    }
    insert({ id: decoded.file.genus.id, name: decoded.file.genus.name, savedAt: '', file: decoded.file });
  };

  return (
    <section className="genus-library" data-testid="genus-library" aria-label={t('browser.library.title')}>
      <div className="genus-library-head">
        <b>{t('browser.library.title')}</b>
        <button type="button" className="panel-action" data-testid="genus-library-import" onClick={() => void importFile()}>
          {t('browser.library.import')}
        </button>
      </div>
      {rows.length === 0 ? <p className="genus-library-empty" data-testid="genus-library-empty">{t('browser.library.empty')}</p> : null}
      <ul className="genus-library-list">
        {rows.map((row) => (
          <li key={row.id} data-testid={`genus-library-row-${row.id}`}>
            <span className="genus-library-name" title={row.id}>
              {row.name}
            </span>
            <span className="genus-library-actions">
              <button type="button" className="panel-action" data-testid={`genus-library-insert-${row.id}`} onClick={() => insert(row)}>
                {t('browser.library.insert')}
              </button>
              <button
                type="button"
                className="panel-action"
                data-testid={`genus-library-export-${row.id}`}
                onClick={() => void writeGenusFile(`${row.id}.apexgenus`, `${JSON.stringify(row.file, null, 2)}\n`)}
              >
                {t('browser.library.export')}
              </button>
              {pendingDelete === row.id ? (
                <button
                  type="button"
                  className="panel-action"
                  data-testid={`genus-library-confirm-delete-${row.id}`}
                  onClick={() => {
                    void deleteGenusFromLibrary(row.id).then(() => setPendingDelete(null));
                  }}
                >
                  {t('browser.library.confirmDelete')}
                </button>
              ) : (
                <button type="button" className="panel-action" data-testid={`genus-library-delete-${row.id}`} onClick={() => setPendingDelete(row.id)}>
                  {t('browser.library.delete')}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="genus-library-error" data-testid="genus-library-error">{error}</p> : null}
    </section>
  );
}
