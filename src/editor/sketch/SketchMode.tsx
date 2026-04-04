import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { SketchManager } from './SketchManager';
import { SketchToolbar } from './SketchToolbar';
import { PrimitiveGenerator } from '../PrimitiveGenerator';
import { LevelManager } from '../levels/LevelManager';
import { LevelPanel } from '../levels/LevelPanel';
import type { SketchToolType, SketchPoint } from './types';
import type { Level } from '../levels/types';
import {
  WALL_HEIGHT,
  WALL_THICKNESS,
  BEAM_WIDTH,
  BEAM_HEIGHT,
  COLUMN_SIZE,
  SLAB_THICKNESS,
} from './types';

interface SketchModeProps {
  containerRef: React.RefObject<HTMLDivElement>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  isActive: boolean;
}

export const SketchMode: React.FC<SketchModeProps> = ({
  containerRef,
  scene,
  camera,
  isActive,
}) => {
  const [activeTool, setActiveTool] = useState<SketchToolType>('select');
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [orthoMode, setOrthoMode] = useState(false);
  const [elevation, setElevation] = useState(0);
  const [isDrawing, setIsDrawing] = useState(false);
  
  // Level system
  const [levels, setLevels] = useState<Level[]>([]);
  const [activeLevelId, setActiveLevelId] = useState<string | null>(null);
  const [allLevelsVisible, setAllLevelsVisible] = useState(true);
  const levelManagerRef = useRef<LevelManager | null>(null);

  const sketchManagerRef = useRef<SketchManager | null>(null);
  const mouseRef = useRef(new THREE.Vector2());

  // Initialize sketch manager and levels
  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    sketchManagerRef.current = new SketchManager(scene, camera, { elevation });
    
    // Initialize level manager
    levelManagerRef.current = new LevelManager(scene);
    setLevels(levelManagerRef.current.getAllLevels());
    const firstLevel = levelManagerRef.current.getActiveLevel();
    if (firstLevel) {
      setActiveLevelId(firstLevel.id);
      setElevation(firstLevel.elevation);
    }

    return () => {
      sketchManagerRef.current?.dispose();
      levelManagerRef.current?.dispose();
    };
  }, [isActive, scene, camera, containerRef]);

  // Update elevation
  useEffect(() => {
    if (sketchManagerRef.current) {
      sketchManagerRef.current.setElevation(elevation);
    }
  }, [elevation]);

  // Level management handlers
  const handleLevelSelect = useCallback((levelId: string) => {
    if (!levelManagerRef.current) return;
    
    levelManagerRef.current.setActiveLevel(levelId);
    setActiveLevelId(levelId);
    
    const level = levelManagerRef.current.getLevel(levelId);
    if (level) {
      setElevation(level.elevation);
    }
  }, []);

  const handleLevelAdd = useCallback((name: string, elevation: number) => {
    if (!levelManagerRef.current) return;
    
    const newLevel: Level = {
      id: `level-${Date.now()}`,
      name,
      elevation: elevation || levelManagerRef.current.getNextLevelElevation(),
      color: '#3a7bd5',
      visible: true,
    };
    
    levelManagerRef.current.addLevel(newLevel);
    setLevels(levelManagerRef.current.getAllLevels());
  }, []);

  const handleLevelRemove = useCallback((levelId: string) => {
    if (!levelManagerRef.current) return;
    
    levelManagerRef.current.removeLevel(levelId);
    setLevels(levelManagerRef.current.getAllLevels());
    
    const newActive = levelManagerRef.current.getActiveLevel();
    setActiveLevelId(newActive?.id || null);
    if (newActive) {
      setElevation(newActive.elevation);
    }
  }, []);

  const handleLevelRename = useCallback((levelId: string, name: string) => {
    if (!levelManagerRef.current) return;
    levelManagerRef.current.updateLevel(levelId, { name });
    setLevels(levelManagerRef.current.getAllLevels());
  }, []);

  const handleLevelElevationChange = useCallback((levelId: string, elevation: number) => {
    if (!levelManagerRef.current) return;
    levelManagerRef.current.updateLevel(levelId, { elevation });
    setLevels(levelManagerRef.current.getAllLevels());
    
    // Update current elevation if this is the active level
    if (levelId === activeLevelId) {
      setElevation(elevation);
    }
  }, [activeLevelId]);

  const handleToggleVisibility = useCallback((levelId: string, visible: boolean) => {
    if (!levelManagerRef.current) return;
    levelManagerRef.current.updateLevel(levelId, { visible });
  }, []);

  const handleToggleAllVisibility = useCallback((visible: boolean) => {
    if (!levelManagerRef.current) return;
    levelManagerRef.current.toggleAllLevels(visible);
    setAllLevelsVisible(visible);
  }, []);

  // Handle tool change
  const handleToolChange = useCallback((tool: SketchToolType) => {
    setActiveTool(tool);
    setIsDrawing(true);
    sketchManagerRef.current?.startDrawing();
  }, []);

  // Handle mouse move for preview
  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isActive || !isDrawing || !sketchManagerRef.current) return;
      if (activeTool === 'column' || activeTool === 'equipment') return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      const drawMode =
        activeTool === 'slab' ? 'polyline' : activeTool === 'arcWall' ? 'arc' : 'line';
      
      sketchManagerRef.current.updatePreview(mouseRef.current, drawMode);
    },
    [isActive, isDrawing, activeTool, containerRef]
  );

  // Handle click for drawing
  const handleClick = useCallback(
    (event: MouseEvent) => {
      if (!isActive || !isDrawing || !sketchManagerRef.current) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      // Right click = finish drawing
      if (event.button === 2) {
        finishDrawing();
        return;
      }

      const point = sketchManagerRef.current.addPoint(mouseRef.current);
      if (!point) return;

      // Point-based tools (place immediately)
      if (activeTool === 'column' || activeTool === 'equipment') {
        createPrimitive([point]);
        sketchManagerRef.current?.cancelDrawing();
        setIsDrawing(false);
        return;
      }

      // Arc tool needs 3 points
      if (activeTool === 'arcWall' && sketchManagerRef.current.getPoints().length === 3) {
        createPrimitive(sketchManagerRef.current.finishDrawing());
        setIsDrawing(false);
        return;
      }
    },
    [isActive, isDrawing, activeTool, containerRef]
  );

  // Prevent context menu
  const handleContextMenu = useCallback((event: MouseEvent) => {
    event.preventDefault();
  }, []);

  // Create primitives from points
  const createPrimitive = useCallback(
    (points: SketchPoint[]) => {
      if (!sketchManagerRef.current || points.length === 0) return;

      let mesh: THREE.Mesh | null = null;

      switch (activeTool) {
        case 'wall':
          if (points.length >= 2) {
            mesh = createWall(points[0], points[1]);
          }
          break;

        case 'beam':
          if (points.length >= 2) {
            mesh = createBeam(points[0], points[1]);
          }
          break;

        case 'column':
          mesh = PrimitiveGenerator.createCylinder(
            COLUMN_SIZE / 2,
            WALL_HEIGHT,
            16
          );
          mesh.position.set(points[0].x, points[0].y + WALL_HEIGHT / 2, points[0].z);
          break;

        case 'slab':
          if (points.length >= 3) {
            mesh = createSlab(points);
          }
          break;

        case 'arcWall':
          if (points.length === 3) {
            mesh = createArcWall(points[0], points[1], points[2]);
          }
          break;

        case 'equipment':
          mesh = PrimitiveGenerator.createBox(1, 1, 1);
          mesh.position.set(points[0].x, points[0].y + 0.5, points[0].z);
          mesh.name = 'IfcFurniture';
          break;
      }

      if (mesh) {
        scene.add(mesh);
      }
    },
    [activeTool, scene]
  );

  // Create wall between two points
  const createWall = (p1: SketchPoint, p2: SketchPoint): THREE.Mesh => {
    const length = Math.sqrt(
      Math.pow(p2.x - p1.x, 2) + Math.pow(p2.z - p1.z, 2)
    );
    const angle = Math.atan2(p2.z - p1.z, p2.x - p1.x);

    const mesh = PrimitiveGenerator.createWall(
      length,
      WALL_HEIGHT,
      WALL_THICKNESS
    );
    mesh.position.set(
      (p1.x + p2.x) / 2,
      p1.y + WALL_HEIGHT / 2,
      (p1.z + p2.z) / 2
    );
    mesh.rotation.y = -angle;
    return mesh;
  };

  // Create beam between two points
  const createBeam = (p1: SketchPoint, p2: SketchPoint): THREE.Mesh => {
    const length = Math.sqrt(
      Math.pow(p2.x - p1.x, 2) + Math.pow(p2.z - p1.z, 2)
    );
    const angle = Math.atan2(p2.z - p1.z, p2.x - p1.x);

    const mesh = PrimitiveGenerator.createBeam(
      BEAM_WIDTH,
      BEAM_HEIGHT,
      length
    );
    mesh.position.set(
      (p1.x + p2.x) / 2,
      p1.y + WALL_HEIGHT, // At wall top
      (p1.z + p2.z) / 2
    );
    mesh.rotation.y = -angle;
    return mesh;
  };

  // Create slab from polygon points
  const createSlab = (points: SketchPoint[]): THREE.Mesh => {
    // Calculate center
    const center = points.reduce(
      (acc, p) => ({
        x: acc.x + p.x / points.length,
        y: acc.y + p.y / points.length,
        z: acc.z + p.z / points.length,
      }),
      { x: 0, y: 0, z: 0 }
    );

    // Create shape in XZ plane
    const shape = new THREE.Shape();
    points.forEach((p, i) => {
      const x = p.x - center.x;
      const z = p.z - center.z;
      if (i === 0) {
        shape.moveTo(x, z);
      } else {
        shape.lineTo(x, z);
      }
    });
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: SLAB_THICKNESS,
      bevelEnabled: false,
    });

    const material = new THREE.MeshStandardMaterial({ color: 0x808080 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(center.x, center.y, center.z);
    mesh.name = 'IfcSlab';
    mesh.rotation.x = Math.PI / 2;

    return mesh;
  };

  // Create arc wall from 3 points
  const createArcWall = (
    p1: SketchPoint,
    p2: SketchPoint,
    _p3: SketchPoint
  ): THREE.Mesh => {
    // Simple arc approximation
    const radius = Math.sqrt(
      Math.pow(p2.x - p1.x, 2) + Math.pow(p2.z - p1.z, 2)
    );
    const arc = new THREE.EllipseCurve(
      p1.x,
      p1.z,
      radius,
      radius,
      0,
      Math.PI / 2,
      false,
      0
    );
    const points = arc.getPoints(20);
    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, points[0].y);
    points.forEach((p) => shape.lineTo(p.x, p.y));

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: WALL_HEIGHT,
      bevelEnabled: false,
    });

    const material = new THREE.MeshStandardMaterial({ color: 0xd3d3d3 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, p1.y, 0);
    mesh.name = 'IfcWall';
    mesh.rotation.x = Math.PI / 2;

    return mesh;
  };

  // Finish drawing
  const finishDrawing = useCallback(() => {
    if (!sketchManagerRef.current) return;

    const points = sketchManagerRef.current.finishDrawing();
    if (points.length > 0) {
      createPrimitive(points);
    }
    setIsDrawing(false);
  }, [createPrimitive]);

  // Cancel drawing
  const handleCancel = useCallback(() => {
    sketchManagerRef.current?.cancelDrawing();
    setIsDrawing(false);
  }, []);

  // Confirm/Finish
  const handleConfirm = useCallback(() => {
    finishDrawing();
  }, [finishDrawing]);

  // Toggle snap
  const handleSnapToggle = useCallback(() => {
    setSnapToGrid((prev) => !prev);
    if (sketchManagerRef.current) {
      sketchManagerRef.current.snapToGrid = !snapToGrid;
    }
  }, [snapToGrid]);

  // Toggle ortho
  const handleOrthoToggle = useCallback(() => {
    setOrthoMode((prev) => !prev);
    if (sketchManagerRef.current) {
      sketchManagerRef.current.orthoMode = !orthoMode;
    }
  }, [orthoMode]);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('click', handleClick);
    container.addEventListener('contextmenu', handleContextMenu);

    return () => {
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('click', handleClick);
      container.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [isActive, handleMouseMove, handleClick, handleContextMenu]);

  if (!isActive) return null;

  return (
    <>
      <SketchToolbar
        activeTool={activeTool}
        onToolChange={handleToolChange}
        snapToGrid={snapToGrid}
        onSnapToggle={handleSnapToggle}
        orthoMode={orthoMode}
        onOrthoToggle={handleOrthoToggle}
        elevation={elevation}
        onElevationChange={setElevation}
        isDrawing={isDrawing}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
      />
      
      <LevelPanel
        levels={levels}
        activeLevelId={activeLevelId}
        onLevelSelect={handleLevelSelect}
        onLevelAdd={handleLevelAdd}
        onLevelRemove={handleLevelRemove}
        onLevelRename={handleLevelRename}
        onLevelElevationChange={handleLevelElevationChange}
        onToggleVisibility={handleToggleVisibility}
        allVisible={allLevelsVisible}
        onToggleAllVisibility={handleToggleAllVisibility}
      />
    </>
  );
};
