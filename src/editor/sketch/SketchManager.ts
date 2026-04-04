import * as THREE from 'three';
import type { SketchPoint, SketchOptions, DrawMode } from './types';
import { DEFAULT_SKETCH_OPTIONS } from './types';

export class SketchManager {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private options: SketchOptions;
  public snapToGrid: boolean = true;
  public orthoMode: boolean = false;
  
  // Drawing state
  private currentPoints: SketchPoint[] = [];
  private previewObject: THREE.Mesh | THREE.Line | null = null;
  private ghostObject: THREE.Mesh | null = null;
  
  // Grid
  private gridHelper: THREE.GridHelper | null = null;

  constructor(scene: THREE.Scene, camera: THREE.Camera, options?: Partial<SketchOptions>) {
    this.scene = scene;
    this.camera = camera;
    this.options = { ...DEFAULT_SKETCH_OPTIONS, ...options };
    
    this.createGrid();
  }

  private createGrid(): void {
    const size = 100;
    const divisions = size / this.options.gridSize;
    this.gridHelper = new THREE.GridHelper(size, divisions, 0x444444, 0x333333);
    this.gridHelper.position.y = this.options.elevation;
    this.scene.add(this.gridHelper);
  }

  setElevation(y: number): void {
    this.options.elevation = y;
    if (this.gridHelper) {
      this.gridHelper.position.y = y;
    }
  }

  toggleGrid(): void {
    if (this.gridHelper) {
      this.gridHelper.visible = !this.gridHelper.visible;
    }
  }

  snapToPoint(point: THREE.Vector3): THREE.Vector3 {
    if (!this.options.snapToGrid) return point.clone();

    const grid = this.options.gridSize;
    return new THREE.Vector3(
      Math.round(point.x / grid) * grid,
      this.options.elevation,
      Math.round(point.z / grid) * grid
    );
  }

  getRaycastPoint(mouse: THREE.Vector2): THREE.Vector3 | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);

    // Create a horizontal plane at elevation (XZ plane at Y height)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.options.elevation);
    const target = new THREE.Vector3();

    raycaster.ray.intersectPlane(plane, target);
    return target;
  }

  startDrawing(): void {
    this.currentPoints = [];
  }

  addPoint(mouse: THREE.Vector2): SketchPoint | null {
    const point = this.getRaycastPoint(mouse);
    if (!point) return null;

    const snapped = this.snapToPoint(point);
    this.currentPoints.push({ x: snapped.x, y: snapped.y, z: snapped.z });
    
    return { x: snapped.x, y: snapped.y, z: snapped.z };
  }

  updatePreview(mouse: THREE.Vector2, mode: DrawMode): void {
    const point = this.getRaycastPoint(mouse);
    if (!point || this.currentPoints.length === 0) return;

    const snapped = this.snapToPoint(point);
    const lastPoint = this.currentPoints[this.currentPoints.length - 1];

    // Remove old preview
    if (this.previewObject) {
      this.scene.remove(this.previewObject);
    }

    if (mode === 'line' && this.currentPoints.length >= 1) {
      // Preview line
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(lastPoint.x, lastPoint.y, lastPoint.z),
        new THREE.Vector3(snapped.x, snapped.y, snapped.z),
      ]);
      this.previewObject = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x00ff00 })
      );
      this.scene.add(this.previewObject);
    }
  }

  clearPreview(): void {
    if (this.previewObject) {
      this.scene.remove(this.previewObject);
      this.previewObject = null;
    }
  }

  getPoints(): SketchPoint[] {
    return [...this.currentPoints];
  }

  finishDrawing(): SketchPoint[] {
    const points = [...this.currentPoints];
    this.currentPoints = [];
    this.clearPreview();
    return points;
  }

  cancelDrawing(): void {
    this.currentPoints = [];
    this.clearPreview();
  }

  showGhost(mesh: THREE.Mesh): void {
    this.ghostObject = mesh;
    this.scene.add(mesh);
  }

  hideGhost(): void {
    if (this.ghostObject) {
      this.scene.remove(this.ghostObject);
      this.ghostObject = null;
    }
  }

  dispose(): void {
    if (this.gridHelper) {
      this.scene.remove(this.gridHelper);
    }
    this.clearPreview();
    this.hideGhost();
  }
}
