import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { SelectionManager } from './SelectionManager';
import { BooleanOperations } from './BooleanOperations';
import { PrimitiveGenerator } from './PrimitiveGenerator';
import { EditorToolbar } from './EditorToolbar';
import type { ToolType, BooleanOperationType, SelectedObject } from './types';

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
  const [activeTool, setActiveTool] = useState<ToolType>('select');
  const [selectedObject, setSelectedObject] = useState<SelectedObject | null>(null);
  const [isTransforming, setIsTransforming] = useState(false);

  const selectionManagerRef = useRef<SelectionManager | null>(null);
  const transformControlRef = useRef<TransformControls | null>(null);
  const mouseRef = useRef(new THREE.Vector2());

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

  // Handle tool changes
  useEffect(() => {
    if (!transformControlRef.current || !selectedObject) return;

    const control = transformControlRef.current;

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

  // Handle mouse clicks for selection
  const handleClick = useCallback((event: MouseEvent) => {
    if (!containerRef.current || !selectionManagerRef.current || activeTool !== 'select') return;

    const rect = containerRef.current.getBoundingClientRect();
    mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

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

    // Remove original objects
    scene.remove(mesh1);
    scene.remove(mesh2);

    // Add result
    scene.add(result);

    // Select result
    selectionManagerRef.current.select({
      id: result.uuid,
      object: result,
      ifcType: 'IfcBuildingElementProxy',
    });
    setSelectedObject({
      id: result.uuid,
      object: result,
      ifcType: 'IfcBuildingElementProxy',
    });
  }, [scene]);

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

    // Select new primitive
    selectionManagerRef.current.select({
      id: primitive.uuid,
      object: primitive,
      ifcType: primitive.name,
    });
    setSelectedObject({
      id: primitive.uuid,
      object: primitive,
      ifcType: primitive.name,
    });
  }, [camera, scene]);

  // Handle property changes
  const handlePropertyChange = useCallback((key: string, value: any) => {
    if (!selectedObject) return;

    const keys = key.split('.');
    let obj: any = selectedObject.object;

    for (let i = 0; i < keys.length - 1; i++) {
      obj = obj[keys[i]];
    }

    obj[keys[keys.length - 1]] = value;
    selectedObject.object.updateMatrixWorld(true);

    // Update selection box
    if (selectionManagerRef.current) {
      selectionManagerRef.current.select(selectedObject);
    }
  }, [selectedObject]);

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
      />
    </div>
  );
};
