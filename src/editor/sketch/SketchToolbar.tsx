import React from 'react';
import styles from './SketchToolbar.module.css';
import type { SketchToolType } from './types';

interface SketchToolbarProps {
  activeTool: SketchToolType;
  onToolChange: (tool: SketchToolType) => void;
  snapToGrid: boolean;
  onSnapToggle: () => void;
  orthoMode: boolean;
  onOrthoToggle: () => void;
  elevation: number;
  onElevationChange: (z: number) => void;
  isDrawing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const SketchToolbar: React.FC<SketchToolbarProps> = ({
  activeTool,
  onToolChange,
  snapToGrid,
  onSnapToggle,
  orthoMode,
  onOrthoToggle,
  elevation,
  onElevationChange,
  isDrawing,
  onCancel,
  onConfirm,
}) => {
  return (
    <div className={styles.sketchToolbar}>
      {/* Drawing Tools */}
      <div className={styles.toolbarSection}>
        <div className={styles.toolbarSectionTitle}>Draw</div>
        
        <button
          className={`${styles.toolButton} ${activeTool === 'wall' ? styles.active : ''}`}
          onClick={() => onToolChange('wall')}
          disabled={isDrawing && activeTool !== 'wall'}
        >
          <WallIcon /> Wall
        </button>
        
        <button
          className={`${styles.toolButton} ${activeTool === 'beam' ? styles.active : ''}`}
          onClick={() => onToolChange('beam')}
          disabled={isDrawing && activeTool !== 'beam'}
        >
          <BeamIcon /> Beam
        </button>
        
        <button
          className={`${styles.toolButton} ${activeTool === 'column' ? styles.active : ''}`}
          onClick={() => onToolChange('column')}
          disabled={isDrawing && activeTool !== 'column'}
        >
          <ColumnIcon /> Column
        </button>
        
        <button
          className={`${styles.toolButton} ${activeTool === 'slab' ? styles.active : ''}`}
          onClick={() => onToolChange('slab')}
          disabled={isDrawing && activeTool !== 'slab'}
        >
          <SlabIcon /> Slab
        </button>

        <button
          className={`${styles.toolButton} ${activeTool === 'arcWall' ? styles.active : ''}`}
          onClick={() => onToolChange('arcWall')}
          disabled={isDrawing && activeTool !== 'arcWall'}
        >
          <ArcIcon /> Arc Wall
        </button>
      </div>

      {/* Placement Tools */}
      <div className={styles.toolbarSection}>
        <div className={styles.toolbarSectionTitle}>Place</div>
        
        <button
          className={`${styles.toolButton} ${activeTool === 'equipment' ? styles.active : ''}`}
          onClick={() => onToolChange('equipment')}
        >
          <EquipmentIcon /> Equipment
        </button>
      </div>

      {/* Drawing Controls */}
      {isDrawing && (
        <div className={styles.toolbarSection}>
          <div className={styles.toolbarSectionTitle}>Drawing</div>
          <div className={styles.drawingControls}>
            <button className={styles.cancelButton} onClick={onCancel}>
              Cancel
            </button>
            <button className={styles.confirmButton} onClick={onConfirm}>
              Finish
            </button>
          </div>
        </div>
      )}

      {/* Options */}
      <div className={styles.toolbarSection}>
        <div className={styles.toolbarSectionTitle}>Options</div>
        
        <label className={styles.toggleOption}>
          <input
            type="checkbox"
            checked={snapToGrid}
            onChange={onSnapToggle}
          />
          <span>Snap to Grid</span>
        </label>
        
        <label className={styles.toggleOption}>
          <input
            type="checkbox"
            checked={orthoMode}
            onChange={onOrthoToggle}
          />
          <span>Ortho Mode (90°)</span>
        </label>

        <div className={styles.elevationControl}>
          <label>Elevation (Z):</label>
          <input
            type="number"
            value={elevation}
            onChange={(e) => onElevationChange(parseFloat(e.target.value))}
            step={0.5}
          />
        </div>
      </div>

      {/* Help */}
      <div className={styles.helpSection}>
        {getHelpText(activeTool, isDrawing)}
      </div>
    </div>
  );
};

function getHelpText(tool: SketchToolType, isDrawing: boolean): string {
  if (!isDrawing) {
    switch (tool) {
      case 'wall':
      case 'beam':
        return 'Click to start, click to add points, right-click or "Finish" to complete';
      case 'slab':
        return 'Click to add points (min 3), "Finish" to complete polygon';
      case 'column':
      case 'equipment':
        return 'Click to place';
      case 'arcWall':
        return 'Click start, click end, click for arc height';
      default:
        return 'Select a tool to start drawing';
    }
  }
  
  return 'Continue drawing or click "Finish"';
}

// Icons
const WallIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 7h18M3 17h18M7 7v10M17 7v10" />
  </svg>
);

const BeamIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="10" width="18" height="4" rx="1" />
    <path d="M7 10v4M17 10v4" />
  </svg>
);

const ColumnIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="9" y="3" width="6" height="18" rx="1" />
  </svg>
);

const SlabIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 8l9-4 9 4-9 4-9-4z" />
    <path d="M3 8v8l9 4v-8" />
    <path d="M21 8v8l-9 4v-8" />
  </svg>
);

const ArcIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 12a8 8 0 0116 0" />
  </svg>
);

const EquipmentIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </svg>
);
