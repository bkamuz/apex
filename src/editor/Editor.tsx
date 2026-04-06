import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { SelectionManager } from './SelectionManager';
import { BooleanOperations } from './BooleanOperations';
import { PrimitiveGenerator } from './PrimitiveGenerator';
import { EditorToolbar } from './EditorToolbar';
import type { ToolType, BooleanOperationType, SelectedObject } from './types';
import { useBimFacade } from '../api/useBimFacade';
import { useViewerStore } from '../store/useViewerStore';
import { isApexBeamMesh } from './beamTypes';
import {
  createBeamGizmoGroup,
  syncBeamGizmoGroup,
  disposeBeamGizmoGroup,
  getBeamGizmoPickMeshes,
} from './beamGizmo';
import { applyBeamGeometryToMesh } from './sketch/sketchGeometry';

interface EditorProps {
  containerRef: React.RefObject<HTMLDivElement>;
  scene: THREE.Scene;
  camera: THREE.Camera;
}

export const Editor: React.FC<EditorProps> = ({
  containerRef,
  scene,
  camera,
}) => {
  const facade = useBimFacade();
  const activeLevelId = useViewerStore((s) => s.activeLevelId);
  const [activeTool, setActiveTool] = useState<ToolType>('select');
  const [selectedObject, setSelectedObject] = useState<SelectedObject | null>(null);
  const [isTransforming, setIsTransforming] = useState(false);
  const [beamEditEndpoint, setBeamEditEndpoint] = useState<'start' | 'end' | null>(null);

  const selectionManagerRef = useRef<SelectionManager | null>(null);
  const transformControlRef = useRef<TransformControls | null>(null);
  const mouseRef = useRef(new THREE.Vector2());
  const beamGizmoGroupRef = useRef<THREE.Group | null>(null);

  // Initialize selection and transform managers
  useEffect(() => {
    if (!containerRef.current) return;

    selectionManagerRef.current = new SelectionManager(scene);

    const transformControl = new TransformControls(camera, containerRef.current);
    transformControlRef.current = transformControl;

    transformControl.addEventListener('dragging-changed', (event) => {
      setIsTransforming(event.value as boolean);
    });

    transformControl.addEventListener('change', () => {
      // Update selection box when object is transformed
      if (selectionManagerRef.current) {
        selectionManagerRef.current.select(selectionManagerRef.current.getFirstSelected());
      }
    });

    return () => {
      transformControl.dispose();
      selectionManagerRef.current?.dispose();
    };
  }, [scene, camera, containerRef]);

  useEffect(() => {
    facade.applyLevelFilter(activeLevelId);
  }, [facade, activeLevelId]);

  // Handle tool changes
  useEffect(() => {
    if (!transformControlRef.current || !selectedObject) return;

    const control = transformControlRef.current;

    if (isApexBeamMesh(selectedObject.object)) {
      control.detach();
      return;
    }

    switch (activeTool) {
      case 'move':
        control.setMode('translate');
        control.attach(selectedObject.object);
        break;
      case 'rotate':
        control.setMode('rotate');
        control.attach(selectedObject.object);
        break;
      case 'scale':
        control.setMode('scale');
        control.attach(selectedObject.object);
        break;
      default:
        control.detach();
    }
  }, [activeTool, selectedObject]);

  // Балка: линия и точки в режиме «Выбор»
  useEffect(() => {
    const prev = beamGizmoGroupRef.current;
    if (prev) {
      scene.remove(prev);
      disposeBeamGizmoGroup(prev);
      beamGizmoGroupRef.current = null;
    }

    const mesh = selectedObject?.object;
    if (
      !mesh ||
      !isApexBeamMesh(mesh) ||
      activeTool !== 'select'
    ) {
      return;
    }

    const beam = mesh.userData.apexBeam;
    const group = createBeamGizmoGroup(beam);
    scene.add(group);
    beamGizmoGroupRef.current = group;

    return () => {
      if (beamGizmoGroupRef.current) {
        scene.remove(beamGizmoGroupRef.current);
        disposeBeamGizmoGroup(beamGizmoGroupRef.current);
        beamGizmoGroupRef.current = null;
      }
    };
  }, [scene, selectedObject, activeTool]);

  useEffect(() => {
    const g = beamGizmoGroupRef.current;
    const mesh = selectedObject?.object;
    if (!g || !mesh || !isApexBeamMesh(mesh) || activeTool !== 'select') return;
    syncBeamGizmoGroup(g, mesh.userData.apexBeam, beamEditEndpoint);
  }, [selectedObject, beamEditEndpoint, activeTool]);

  // Handle mouse clicks for selection
  const handleClick = useCallback((event: MouseEvent) => {
    if (!containerRef.current || !selectionManagerRef.current || activeTool !== 'select') return;

    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouseRef.current, camera);

    const gizmoGroup = beamGizmoGroupRef.current;
    if (gizmoGroup) {
      const pickMeshes = getBeamGizmoPickMeshes(gizmoGroup);
      if (pickMeshes.length > 0) {
        const gizmoHits = raycaster.intersectObjects(pickMeshes, false);
        if (gizmoHits.length > 0) {
          const end = gizmoHits[0].object.userData.apexBeamEnd as 'start' | 'end';
          setBeamEditEndpoint(end);
          return;
        }
      }
    }

    setBeamEditEndpoint(null);

    const selected = selectionManagerRef.current.raycast(
      mouseRef.current,
      camera,
      transformControlRef.current ? [transformControlRef.current.getHelper()] : undefined
    );

    selectionManagerRef.current.select(selected);
    setSelectedObject(selected);
  }, [camera, activeTool]);

  // Handle mouse move for hover
  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (!containerRef.current || !selectionManagerRef.current || activeTool !== 'select' || isTransforming) return;

    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const hovered = selectionManagerRef.current.raycast(
      mouseRef.current,
      camera,
      transformControlRef.current ? [transformControlRef.current.getHelper()] : undefined
    );

    selectionManagerRef.current.hover(hovered);
  }, [camera, activeTool, isTransforming]);

  useEffect(() => {
    if (!containerRef.current) return;

    containerRef.current.addEventListener('click', handleClick);
    containerRef.current.addEventListener('mousemove', handleMouseMove);

    return () => {
      containerRef.current?.removeEventListener('click', handleClick);
      containerRef.current?.removeEventListener('mousemove', handleMouseMove);
    };
  }, [handleClick, handleMouseMove]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      setActiveTool('select');
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Handle boolean operations
  const handleBooleanOperation = useCallback(async (operation: BooleanOperationType) => {
    if (!selectionManagerRef.current) return;

    const selected = selectionManagerRef.current.getSelectedObjects();
    if (selected.length < 2) return;

    const mesh1 = selected[0].object as THREE.Mesh;
    const mesh2 = selected[1].object as THREE.Mesh;

    let result: THREE.Mesh;

    switch (operation) {
      case 'union':
        result = await BooleanOperations.union(mesh1, mesh2);
        break;
      case 'subtract':
        result = await BooleanOperations.subtract(mesh1, mesh2);
        break;
      case 'intersect':
        result = await BooleanOperations.intersect(mesh1, mesh2);
        break;
    }

    facade.unregisterNativeMesh(mesh1);
    facade.unregisterNativeMesh(mesh2);
    scene.remove(mesh1);
    scene.remove(mesh2);

    scene.add(result);

    const firstId = selected[0].elementId;
    const rec = firstId ? facade.getElement(firstId) : undefined;
    const levelId =
      rec?.levelId ?? useViewerStore.getState().activeLevelId ?? 'level-1';

    const newElementId = facade.registerNativeMesh(result, {
      category: 'IfcBuildingElementProxy',
      name: 'Boolean result',
      levelId,
    });

    selectionManagerRef.current.select({
      id: newElementId,
      object: result,
      ifcType: 'IfcBuildingElementProxy',
      elementId: newElementId,
    });
    setSelectedObject({
      id: newElementId,
      object: result,
      ifcType: 'IfcBuildingElementProxy',
      elementId: newElementId,
    });
  }, [scene, facade]);

  // Handle primitive creation
  const handleCreatePrimitive = useCallback((type: string) => {
    if (!selectionManagerRef.current) return;

    let primitive: THREE.Mesh;

    switch (type) {
      case 'box':
        primitive = PrimitiveGenerator.createBox();
        break;
      case 'cylinder':
        primitive = PrimitiveGenerator.createCylinder();
        break;
      case 'sphere':
        primitive = PrimitiveGenerator.createSphere();
        break;
      case 'beam':
        primitive = PrimitiveGenerator.createBeam();
        break;
      case 'slab':
        primitive = PrimitiveGenerator.createSlab();
        break;
      case 'wall':
        primitive = PrimitiveGenerator.createWall();
        break;
      default:
        return;
    }

    // Position at camera view
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    primitive.position.copy(direction).multiplyScalar(5);

    scene.add(primitive);

    const levelId = useViewerStore.getState().activeLevelId ?? 'level-1';
    const elementId = facade.registerNativeMesh(primitive, {
      category: primitive.name,
      name: primitive.name,
      levelId,
    });

    selectionManagerRef.current.select({
      id: elementId,
      object: primitive,
      ifcType: primitive.name,
      elementId,
    });
    setSelectedObject({
      id: elementId,
      object: primitive,
      ifcType: primitive.name,
      elementId,
    });
  }, [camera, scene, facade]);

  // Handle property changes (позиция примитива в сцене Three.js)
  const handlePropertyChange = useCallback((key: string, value: number) => {
    if (!selectedObject || !Number.isFinite(value)) return;

    const mesh = selectedObject.object;
    /* eslint-disable react-hooks/immutability -- изменение THREE.Object3D в сцене, не клон React */
    if (key === 'position.x') mesh.position.x = value;
    else if (key === 'position.y') mesh.position.y = value;
    else if (key === 'position.z') mesh.position.z = value;
    else return;
    /* eslint-enable react-hooks/immutability */

    mesh.updateMatrixWorld(true);

    if (selectionManagerRef.current) {
      selectionManagerRef.current.select(selectedObject);
    }
  }, [selectedObject]);

  const handleBeamApexUpdate = useCallback(
    (u: {
      startOffsetFromLevel?: number;
      endOffsetFromLevel?: number;
      startX?: number;
      startZ?: number;
      endX?: number;
      endZ?: number;
      profileWidth?: number;
      profileHeight?: number;
    }) => {
      if (!selectedObject || !isApexBeamMesh(selectedObject.object)) return;

      const mesh = selectedObject.object;
      const prev = mesh.userData.apexBeam;
      let start = { ...prev.start };
      let end = { ...prev.end };
      let profile = { ...prev.profile };

      if (u.startOffsetFromLevel !== undefined && Number.isFinite(u.startOffsetFromLevel)) {
        start = { ...start, y: prev.levelBaseY + u.startOffsetFromLevel };
      }
      if (u.endOffsetFromLevel !== undefined && Number.isFinite(u.endOffsetFromLevel)) {
        end = { ...end, y: prev.levelBaseY + u.endOffsetFromLevel };
      }
      if (u.startX !== undefined && Number.isFinite(u.startX)) {
        start = { ...start, x: u.startX };
      }
      if (u.startZ !== undefined && Number.isFinite(u.startZ)) {
        start = { ...start, z: u.startZ };
      }
      if (u.endX !== undefined && Number.isFinite(u.endX)) {
        end = { ...end, x: u.endX };
      }
      if (u.endZ !== undefined && Number.isFinite(u.endZ)) {
        end = { ...end, z: u.endZ };
      }
      if (u.profileWidth !== undefined && Number.isFinite(u.profileWidth) && u.profileWidth > 0) {
        profile = { ...profile, width: u.profileWidth };
      }
      if (u.profileHeight !== undefined && Number.isFinite(u.profileHeight) && u.profileHeight > 0) {
        profile = { ...profile, height: u.profileHeight };
      }

      const beam = { ...prev, start, end, profile };
      // userData — часть сцены Three.js, не состояние React
      // eslint-disable-next-line react-hooks/immutability -- mesh привязан к выбору по ссылке
      mesh.userData.apexBeam = beam;

      applyBeamGeometryToMesh(mesh, beam);

      if (selectionManagerRef.current) {
        selectionManagerRef.current.select(selectedObject);
      }
      setSelectedObject((prev) => (prev ? { ...prev } : null));
    },
    [selectedObject]
  );

  const canBoolean = selectedObject !== null;

  return (
    <div className="editor-container">
      <EditorToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        onBooleanOperation={handleBooleanOperation}
        onCreatePrimitive={handleCreatePrimitive}
        selectedObject={selectedObject}
        onPropertyChange={handlePropertyChange}
        canBoolean={canBoolean}
        beamEditEndpoint={beamEditEndpoint}
        onBeamApexUpdate={handleBeamApexUpdate}
      />
    </div>
  );
};
