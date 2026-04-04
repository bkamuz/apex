import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three';

export class TransformManager {
  private control: TransformControls;

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.control = new TransformControls(camera, domElement);
    
    // Hide control when dragging
    this.control.addEventListener('dragging-changed', (event) => {
      if (event.value) {
        // Disable camera controls while transforming
        domElement.style.cursor = 'move';
      } else {
        domElement.style.cursor = 'default';
      }
    });
  }

  attach(object: THREE.Object3D): void {
    this.control.attach(object);
  }

  detach(): void {
    this.control.detach();
  }

  setMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.control.setMode(mode);
  }

  getControl(): TransformControls {
    return this.control;
  }

  dispose(): void {
    this.control.dispose();
  }
}
