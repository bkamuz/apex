import type { LevelDto } from '../types';

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
  return (
    <div className="level-panel">
      <div className="panel-title-row">
        <div className="panel-title">Levels</div>
        <button type="button" className="panel-action" onClick={onCreate} title="Add level">
          + Level
        </button>
        {onClose ? (
          <button type="button" className="panel-close" onClick={onClose} title="Close">
            Close
          </button>
        ) : null}
      </div>
      {levels.length === 0 ? (
        <div className="empty">No levels.</div>
      ) : (
        <ul className="level-list">
          {levels.map((level) => {
            const active = level.id === activeLevelId;
            const selected = level.id === selectedLevelId;
            return (
              <li
                key={level.id}
                className={`${selected ? 'selected' : ''} ${active ? 'active-level' : ''}`.trim()}
                onClick={() => onSelect(level.id)}
                title={
                  active
                    ? 'Active work plane — double-click another level plane to switch'
                    : 'Select to edit elevation · double-click plane/contour to activate'
                }
              >
                <span>
                  {level.name}
                  {active ? <span className="level-badge">active</span> : null}
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
