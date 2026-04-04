import React from 'react';
import styles from './LevelPanel.module.css';
import type { Level } from './types';

interface LevelPanelProps {
  levels: Level[];
  activeLevelId: string | null;
  onLevelSelect: (levelId: string) => void;
  onLevelAdd: (name: string, elevation: number) => void;
  onLevelRemove: (levelId: string) => void;
  onLevelRename: (levelId: string, name: string) => void;
  onLevelElevationChange: (levelId: string, elevation: number) => void;
  onToggleVisibility: (levelId: string, visible: boolean) => void;
  allVisible: boolean;
  onToggleAllVisibility: (visible: boolean) => void;
}

export const LevelPanel: React.FC<LevelPanelProps> = ({
  levels,
  activeLevelId,
  onLevelSelect,
  onLevelAdd,
  onLevelRemove,
  onLevelRename,
  onLevelElevationChange,
  onToggleVisibility,
  allVisible,
  onToggleAllVisibility,
}) => {
  const [newLevelName, setNewLevelName] = React.useState('');
  const [newLevelElevation, setNewLevelElevation] = React.useState(0);

  const handleAddLevel = () => {
    if (!newLevelName.trim()) return;
    onLevelAdd(newLevelName, newLevelElevation);
    setNewLevelName('');
    setNewLevelElevation(0);
  };

  return (
    <div className={styles.levelPanel}>
      <div className={styles.panelHeader}>
        <h3>Levels</h3>
        <button
          className={styles.toggleAllButton}
          onClick={() => onToggleAllVisibility(!allVisible)}
          title={allVisible ? 'Hide all' : 'Show all'}
        >
          {allVisible ? '👁️' : '🚫'}
        </button>
      </div>

      <div className={styles.levelList}>
        {levels.map((level) => (
          <div
            key={level.id}
            className={`${styles.levelItem} ${
              activeLevelId === level.id ? styles.active : ''
            }`}
          >
            <div
              className={styles.levelColor}
              style={{ backgroundColor: level.color }}
            />
            
            <button
              className={styles.levelInfo}
              onClick={() => onLevelSelect(level.id)}
            >
              <input
                className={styles.levelName}
                value={level.name}
                onChange={(e) => onLevelRename(level.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              <span className={styles.levelElevation}>
                {(level.elevation * 1000).toFixed(0)}mm
              </span>
            </button>

            <div className={styles.levelActions}>
              <input
                type="number"
                className={styles.elevationInput}
                value={Math.round(level.elevation * 1000)}
                onChange={(e) =>
                  onLevelElevationChange(level.id, parseFloat(e.target.value) / 1000)
                }
                step={100}
                onClick={(e) => e.stopPropagation()}
              />
              
              <button
                className={styles.visibilityButton}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleVisibility(level.id, !level.visible);
                }}
              >
                {level.visible ? '👁️' : '🚫'}
              </button>
              
              <button
                className={styles.removeButton}
                onClick={(e) => {
                  e.stopPropagation();
                  onLevelRemove(level.id);
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.addLevelForm}>
        <input
          type="text"
          placeholder="Level name"
          value={newLevelName}
          onChange={(e) => setNewLevelName(e.target.value)}
          className={styles.nameInput}
        />
        <input
          type="number"
          placeholder="Elevation (mm)"
          value={newLevelElevation * 1000}
          onChange={(e) => setNewLevelElevation(parseFloat(e.target.value) / 1000)}
          className={styles.elevationInput}
          step={100}
        />
        <button onClick={handleAddLevel} className={styles.addButton}>
          + Add Level
        </button>
      </div>

      <div className={styles.levelInfo}>
        <small>
          Active: <strong>{levels.find((l) => l.id === activeLevelId)?.name || 'None'}</strong> at{' '}
          <strong>{Math.round((levels.find((l) => l.id === activeLevelId)?.elevation || 0) * 1000)}mm</strong>
        </small>
      </div>
    </div>
  );
};
