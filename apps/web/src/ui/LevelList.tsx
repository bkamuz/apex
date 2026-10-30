import type { LevelDto } from '../types';
import { useI18n } from '../i18n';

interface Props {
  levels: LevelDto[];
  activeLevelId: string | null;
  selectedLevelId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose?: () => void;
}

export function LevelList({
  levels,
  activeLevelId,
  selectedLevelId,
  onSelect,
  onCreate,
  onClose,
}: Props) {
  const { t } = useI18n();
  return (
    <div className="level-panel">
      <div className="panel-title-row" title={t('panel.levelsRowTitle')}>
        <div className="panel-title">{t('panel.levels')}</div>
        <button type="button" className="panel-action" onClick={onCreate} title={t('panel.addLevelTitle')}>
          {t('panel.addLevel')}
        </button>
        {onClose ? (
          <button type="button" className="panel-close" onClick={onClose} title={t('panel.close')}>
            {t('panel.close')}
          </button>
        ) : null}
      </div>
      {levels.length === 0 ? (
        <div className="empty">{t('panel.noLevels')}</div>
      ) : (
        <ul className="level-list shell-scroll">
          {levels.map((level) => {
            const active = level.id === activeLevelId;
            const selected = level.id === selectedLevelId;
            return (
              <li
                key={level.id}
                className={`${selected ? 'selected' : ''} ${active ? 'active-level' : ''}`.trim()}
                onClick={() => onSelect(level.id)}
                onDoubleClick={() => onSelect(level.id)}
                title={active ? t('panel.activePlane') : t('panel.activateLevel')}
              >
                <span>
                  {level.name}
                  {active ? <span className="level-badge">{t('panel.activeBadge')}</span> : null}
                </span>
                <span className="cat">{level.elevation.toFixed(2)} m</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
