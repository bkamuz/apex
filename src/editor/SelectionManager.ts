import * as THREE from 'three';
import type { SelectedObject } from './types';
import { SELECTION_COLOR, HOVER_COLOR } from './types';

export class SelectionManager {
  private selectedObjects: Map<string, SelectedObject> = new Map();
  private hoveredObject: SelectedObject | null = null;
  private selectionBox: THREE.BoxHelper | null = null;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  raycast(
    mouse: THREE.Vector2,
    camera: THREE.Camera,
    ignoreObjects?: THREE.Object3D[]
  ): SelectedObject | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersectableObjects: THREE.Object3D[] = [];
    this.scene.traverse((child) => {
      if (child.userData.apexSceneGizmo === true) {
        return;
      }
      if (
        child instanceof THREE.Mesh &&
        child.visible &&
        (!ignoreObjects || !ignoreObjects.includes(child))
      ) {
        // Skip objects without geometry or with empty position attributes
        try {
          const geometry = child.geometry;
          if (geometry) {
            const position = geometry.getAttribute('position');
            if (position && position.count > 0 && position.array) {
              intersectableObjects.push(child);
            }
          }
        } catch (e) {
          // Skip objects that cause errors (e.g., fragments without proper geometry)
          console.warn('Skipping object during raycast:', child.name, e);
        }
      }
    });

    if (intersectableObjects.length === 0) {
      return null;
    }

    const intersects = raycaster.intersectObjects(intersectableObjects);

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const elementId = hit.userData.elementId as string | undefined;
      return {
        id: elementId ?? hit.uuid,
        object: hit,
        ifcType: hit.name || 'Unknown',
        elementId: elementId ?? null,
      };
    }

    return null;
  }

  select(object: SelectedObject | null): void {
    // Deselect previous
    if (this.selectedObjects.size > 0) {
      this.selectedObjects.forEach((obj) => {
        if (obj.originalColor && obj.object instanceof THREE.Mesh) {
          obj.object.material.emissive?.setHex(0x000000);
        }
      });
      this.selectedObjects.clear();
    }

    // Remove selection box
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      this.selectionBox = null;
    }

    if (object) {
      this.selectedObjects.set(object.id, object);

      // Highlight selected
      if (object.object instanceof THREE.Mesh) {
        object.originalColor = (object.object.material as THREE.MeshStandardMaterial)
          .emissive?.clone();
        object.object.material.emissive?.setHex(SELECTION_COLOR);
      }

      // Add selection box
      this.selectionBox = new THREE.BoxHelper(object.object, SELECTION_COLOR);
      this.scene.add(this.selectionBox);
    }
  }

  hover(object: SelectedObject | null): void {
    if (this.hoveredObject && this.hoveredObject.object instanceof THREE.Mesh) {
      this.hoveredObject.object.material.emissive?.setHex(0x000000);
      this.hoveredObject = null;
    }

    if (object && !this.selectedObjects.has(object.id)) {
      this.hoveredObject = object;
      if (object.object instanceof THREE.Mesh) {
        object.object.material.emissive?.setHex(HOVER_COLOR);
      }
    }
  }

  getSelectedObjects(): SelectedObject[] {
    return Array.from(this.selectedObjects.values());
  }

  getFirstSelected(): SelectedObject | null {
    const first = this.selectedObjects.values().next().value;
    return first || null;
  }

  clearSelection(): void {
    this.select(null);
    this.hover(null);
  }

  dispose(): void {
    this.clearSelection();
    this.selectedObjects.clear();
  }
}
