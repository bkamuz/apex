import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { SketchManager } from './SketchManager';
import { SketchToolbar } from './SketchToolbar';
import { PrimitiveGenerator } from '../PrimitiveGenerator';
import { LevelManager } from '../levels/LevelManager';
import { LevelPanel } from '../levels/LevelPanel';
import type { SketchToolType, SketchPoint } from './types';
import type { Level } from '../levels/types';
import { useBimFacade } from '../../api/useBimFacade';
import { useViewerStore } from '../../store/useViewerStore';
import {
  WALL_HEIGHT,
  COLUMN_SIZE,
  BEAM_WIDTH,
  BEAM_HEIGHT,
} from './types';
import {
  buildSketchArcWallMesh,
  buildSketchBeamMesh,
  buildSketchSlabMesh,
  buildSketchWallMesh,
} from './sketchGeometry';
import type { ApexBeamUserData } from '../beamTypes';

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
  const facade = useBimFacade();
  const [activeTool, setActiveTool] = useState<SketchToolType>('select');
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [orthoMode, setOrthoMode] = useState(false);
  const [elevation, setElevation] = useState(0);
  const [isDrawing, setIsDrawing] = useState(false);

  const [beamProfileWidth, setBeamProfileWidth] = useState(BEAM_WIDTH);
  const [beamProfileHeight, setBeamProfileHeight] = useState(BEAM_HEIGHT);
  /** Смещение по высоте от активного уровня (м), первая точка сегмента */
  const [beamOffsetStart, setBeamOffsetStart] = useState(0);
  /** Смещение по высоте от активного уровня (м), вторая точка сегмента */
  const [beamOffsetEnd, setBeamOffsetEnd] = useState(0);

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
      useViewerStore.getState().setActiveLevelId(firstLevel.id);
    }

    return () => {
      sketchManagerRef.current?.dispose();
      levelManagerRef.current?.dispose();
    };
  }, [isActive, scene, camera, containerRef]);

  useEffect(() => {
    if (sketchManagerRef.current) {
      sketchManagerRef.current.snapToGrid = snapToGrid;
      sketchManagerRef.current.orthoMode = orthoMode;
    }
  }, [snapToGrid, orthoMode, isActive]);

  useEffect(() => {
    if (!isActive) return;
    facade.applyLevelFilter(activeLevelId);
  }, [isActive, facade, activeLevelId]);

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
    useViewerStore.getState().setActiveLevelId(levelId);

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
    const nextId = newActive?.id || null;
    setActiveLevelId(nextId);
    useViewerStore.getState().setActiveLevelId(nextId);
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

  const createPrimitive = useCallback(
    (points: SketchPoint[]) => {
      if (!sketchManagerRef.current || points.length === 0) return;

      let mesh: THREE.Mesh | null = null;

      switch (activeTool) {
        case 'wall':
          if (points.length >= 2) {
            mesh = buildSketchWallMesh(points[0], points[1]);
          }
          break;

        case 'beam':
          if (points.length >= 2) {
            mesh = buildSketchBeamMesh(points[0], points[1], {
              width: beamProfileWidth,
              height: beamProfileHeight,
            });
            if (mesh) {
              const levelId = activeLevelId ?? 'level-1';
              const beamData: ApexBeamUserData = {
                start: { x: points[0].x, y: points[0].y, z: points[0].z },
                end: { x: points[1].x, y: points[1].y, z: points[1].z },
                profile: { width: beamProfileWidth, height: beamProfileHeight },
                levelId,
                levelBaseY: elevation,
              };
              mesh.userData.apexBeam = beamData;
            }
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
            mesh = buildSketchSlabMesh(points);
          }
          break;

        case 'arcWall':
          if (points.length === 3) {
            mesh = buildSketchArcWallMesh(points[0], points[1], points[2]);
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
        const levelId = activeLevelId ?? 'level-1';
        facade.registerNativeMesh(mesh, {
          category: mesh.name,
          name: mesh.name,
          levelId,
        });
      }
    },
    [activeTool, scene, facade, activeLevelId, beamProfileWidth, beamProfileHeight, elevation]
  );

  const finishDrawing = useCallback(() => {
    if (!sketchManagerRef.current) return;

    if (activeTool === 'wall' || activeTool === 'beam') {
      const pts = sketchManagerRef.current.getPoints();
      if (pts.length >= 2) {
        createPrimitive([pts[pts.length - 2], pts[pts.length - 1]]);
      }
      sketchManagerRef.current.finishDrawing();
      setIsDrawing(false);
      return;
    }

    const points = sketchManagerRef.current.finishDrawing();
    if (points.length > 0) {
      createPrimitive(points);
    }
    setIsDrawing(false);
  }, [createPrimitive, activeTool]);

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isActive || !isDrawing || !sketchManagerRef.current) return;
      if (activeTool === 'column' || activeTool === 'equipment') return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      if (activeTool === 'wall') {
        sketchManagerRef.current.updateWallBeamPreview(mouseRef.current, 'wall');
      } else if (activeTool === 'beam') {
        sketchManagerRef.current.updateWallBeamPreview(mouseRef.current, 'beam', {
          profile: { width: beamProfileWidth, height: beamProfileHeight },
          endY: elevation + beamOffsetEnd,
        });
      } else {
        const drawMode =
          activeTool === 'slab' ? 'polyline' : activeTool === 'arcWall' ? 'arc' : 'line';
        sketchManagerRef.current.updatePreview(mouseRef.current, drawMode);
      }
    },
    [
      isActive,
      isDrawing,
      activeTool,
      containerRef,
      elevation,
      beamProfileWidth,
      beamProfileHeight,
      beamOffsetEnd,
    ]
  );

  const handleClick = useCallback(
    (event: MouseEvent) => {
      if (!isActive || !isDrawing || !sketchManagerRef.current) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      if (event.button === 2) {
        finishDrawing();
        return;
      }

      if (activeTool === 'column' || activeTool === 'equipment') {
        const point = sketchManagerRef.current.addPoint(mouseRef.current);
        if (!point) return;
        createPrimitive([point]);
        sketchManagerRef.current?.cancelDrawing();
        setIsDrawing(false);
        return;
      }

      if (activeTool === 'wall') {
        const point = sketchManagerRef.current.addPoint(mouseRef.current);
        if (!point) return;
        const pts = sketchManagerRef.current.getPoints();
        if (pts.length >= 2) {
          createPrimitive([pts[pts.length - 2], pts[pts.length - 1]]);
          sketchManagerRef.current.trimPolylineToLastVertex();
        }
        return;
      }

      if (activeTool === 'beam') {
        const n = sketchManagerRef.current.getPoints().length;
        const yWorld = elevation + (n === 0 ? beamOffsetStart : beamOffsetEnd);
        const point = sketchManagerRef.current.addPoint(mouseRef.current, {
          overrideY: yWorld,
        });
        if (!point) return;
        const pts = sketchManagerRef.current.getPoints();
        if (pts.length >= 2) {
          createPrimitive([pts[pts.length - 2], pts[pts.length - 1]]);
          sketchManagerRef.current.trimPolylineToLastVertex();
        }
        return;
      }

      const point = sketchManagerRef.current.addPoint(mouseRef.current);
      if (!point) return;

      if (activeTool === 'arcWall' && sketchManagerRef.current.getPoints().length === 3) {
        createPrimitive(sketchManagerRef.current.finishDrawing());
        setIsDrawing(false);
        return;
      }
    },
    [
      isActive,
      isDrawing,
      activeTool,
      containerRef,
      createPrimitive,
      finishDrawing,
      elevation,
      beamOffsetStart,
      beamOffsetEnd,
    ]
  );

  const handleContextMenu = useCallback((event: MouseEvent) => {
    event.preventDefault();
  }, []);

  // Cancel drawing
  const handleCancel = useCallback(() => {
    sketchManagerRef.current?.cancelDrawing();
    setIsDrawing(false);
  }, []);

  /** Esc: отменить чертёж и выйти из инструмента в «выбор» */
  const resetToSelectTool = useCallback(() => {
    sketchManagerRef.current?.cancelDrawing();
    setIsDrawing(false);
    setActiveTool('select');
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

  useEffect(() => {
    if (!isActive) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      e.preventDefault();
      resetToSelectTool();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, resetToSelectTool]);

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
        beamProfileWidth={beamProfileWidth}
        beamProfileHeight={beamProfileHeight}
        beamOffsetStart={beamOffsetStart}
        beamOffsetEnd={beamOffsetEnd}
        onBeamProfileWidthChange={setBeamProfileWidth}
        onBeamProfileHeightChange={setBeamProfileHeight}
        onBeamOffsetStartChange={setBeamOffsetStart}
        onBeamOffsetEndChange={setBeamOffsetEnd}
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
