import React from 'react';
import styles from './EditorToolbar.module.css';
import type { ToolType, BooleanOperationType, SelectedObject } from './types';

interface EditorToolbarProps {
  activeTool: ToolType;
  onToolChange: (tool: ToolType) => void;
  onBooleanOperation: (operation: BooleanOperationType) => void;
  onCreatePrimitive: (type: string) => void;
  selectedObject: SelectedObject | null;
  onPropertyChange: (key: string, value: any) => void;
  canBoolean: boolean;
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  activeTool,
  onToolChange,
  onBooleanOperation,
  onCreatePrimitive,
  selectedObject,
  onPropertyChange,
  canBoolean,
}) => {
  return (
    <>
      <div className={styles.editorToolbar}>
        {/* Selection & Transform Tools */}
        <div className={styles.toolbarSection}>
          <div className={styles.toolbarSectionTitle}>Tools</div>
          <button
            className={`${styles.toolButton} ${activeTool === 'select' ? styles.active : ''}`}
            onClick={() => onToolChange('select')}
          >
            <SelectIcon /> Select
          </button>
          <button
            className={`${styles.toolButton} ${activeTool === 'move' ? styles.active : ''}`}
            onClick={() => onToolChange('move')}
          >
            <MoveIcon /> Move
          </button>
          <button
            className={`${styles.toolButton} ${activeTool === 'rotate' ? styles.active : ''}`}
            onClick={() => onToolChange('rotate')}
          >
            <RotateIcon /> Rotate
          </button>
          <button
            className={`${styles.toolButton} ${activeTool === 'scale' ? styles.active : ''}`}
            onClick={() => onToolChange('scale')}
          >
            <ScaleIcon /> Scale
          </button>
        </div>

        {/* Boolean Operations */}
        <div className={styles.toolbarSection}>
          <div className={styles.toolbarSectionTitle}>Boolean</div>
          <div className={styles.booleanButtons}>
            <button
              className={styles.toolButton}
              onClick={() => onBooleanOperation('union')}
              disabled={!canBoolean}
              title="Union (A + B)"
            >
              <UnionIcon />
            </button>
            <button
              className={styles.toolButton}
              onClick={() => onBooleanOperation('subtract')}
              disabled={!canBoolean}
              title="Subtract (A - B)"
            >
              <SubtractIcon />
            </button>
            <button
              className={styles.toolButton}
              onClick={() => onBooleanOperation('intersect')}
              disabled={!canBoolean}
              title="Intersect (A ∩ B)"
            >
              <IntersectIcon />
            </button>
          </div>
        </div>

        {/* Create Primitives */}
        <div className={styles.toolbarSection}>
          <div className={styles.toolbarSectionTitle}>Create</div>
          <button
            className={styles.toolButton}
            onClick={() => onCreatePrimitive('box')}
          >
            <BoxIcon /> Box
          </button>
          <button
            className={styles.toolButton}
            onClick={() => onCreatePrimitive('cylinder')}
          >
            <CylinderIcon /> Cylinder
          </button>
          <button
            className={styles.toolButton}
            onClick={() => onCreatePrimitive('sphere')}
          >
            <SphereIcon /> Sphere
          </button>
          <button
            className={styles.toolButton}
            onClick={() => onCreatePrimitive('beam')}
          >
            <BeamIcon /> Beam
          </button>
          <button
            className={styles.toolButton}
            onClick={() => onCreatePrimitive('slab')}
          >
            <SlabIcon /> Slab
          </button>
          <button
            className={styles.toolButton}
            onClick={() => onCreatePrimitive('wall')}
          >
            <WallIcon /> Wall
          </button>
        </div>
      </div>

      {/* Property Panel */}
      {selectedObject ? (
        <div className={styles.propertyPanel}>
          <h3>Properties</h3>
          <div className={styles.propertyRow}>
            <span className={styles.propertyLabel}>Type</span>
            <span className={styles.propertyValue}>{selectedObject.ifcType}</span>
          </div>
          <div className={styles.propertyRow}>
            <span className={styles.propertyLabel}>ID</span>
            <span className={styles.propertyValue}>{selectedObject.id.slice(0, 8)}...</span>
          </div>
          <div className={styles.propertyRow}>
            <span className={styles.propertyLabel}>Position X</span>
            <span className={styles.propertyValue}>
              <input
                type="number"
                value={selectedObject.object.position.x.toFixed(2)}
                onChange={(e) =>
                  onPropertyChange('position.x', parseFloat(e.target.value))
                }
              />
            </span>
          </div>
          <div className={styles.propertyRow}>
            <span className={styles.propertyLabel}>Position Y</span>
            <span className={styles.propertyValue}>
              <input
                type="number"
                value={selectedObject.object.position.y.toFixed(2)}
                onChange={(e) =>
                  onPropertyChange('position.y', parseFloat(e.target.value))
                }
              />
            </span>
          </div>
          <div className={styles.propertyRow}>
            <span className={styles.propertyLabel}>Position Z</span>
            <span className={styles.propertyValue}>
              <input
                type="number"
                value={selectedObject.object.position.z.toFixed(2)}
                onChange={(e) =>
                  onPropertyChange('position.z', parseFloat(e.target.value))
                }
              />
            </span>
          </div>
        </div>
      ) : (
        <div className={styles.propertyPanel}>
          <div className={styles.noSelection}>No object selected</div>
        </div>
      )}
    </>
  );
};

// Icons
const SelectIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
  </svg>
);

const MoveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M19 9l3 3-3 3M15 19l-3 3-3-3M2 12h20M12 2v20" />
  </svg>
);

const RotateIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12a9 9 0 11-9-9c2.52 0 4.81 1.03 6.48 2.69M21 3v6h-6" />
  </svg>
);

const ScaleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 3l-6 6M21 3v6M21 3h-6M3 21l6-6M3 21v-6M3 21h6M14 10l-4 4M10 14l4-4" />
  </svg>
);

const UnionIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="9" cy="12" r="5" />
    <circle cx="15" cy="12" r="5" />
  </svg>
);

const SubtractIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="9" cy="12" r="5" />
    <circle cx="15" cy="12" r="5" fill="currentColor" opacity="0.3" />
  </svg>
);

const IntersectIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" opacity="0.5" stroke="currentColor" strokeWidth="2">
    <path d="M9 12a5 5 0 015-5 5 5 0 010 10 5 5 0 01-5-5z" />
  </svg>
);

const BoxIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" />
  </svg>
);

const CylinderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
  </svg>
);

const SphereIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 010 16M4 12h16" />
  </svg>
);

const BeamIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="10" width="18" height="4" rx="1" />
  </svg>
);

const SlabIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 8h18v8H3z" />
  </svg>
);

const WallIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 4v16M18 4v16M4 12h16M4 6h16M4 18h16" />
  </svg>
);
