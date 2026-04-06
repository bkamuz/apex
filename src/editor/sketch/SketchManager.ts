import * as THREE from 'three';
import type { SketchPoint, SketchOptions, DrawMode } from './types';
import { buildSketchBeamMesh, type BeamProfile } from './sketchGeometry';
import { DEFAULT_SKETCH_OPTIONS, WALL_HEIGHT, WALL_THICKNESS } from './types';

export type WallBeamPreviewTool = 'wall' | 'beam';

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
    let p = point.clone();
    p.y = this.options.elevation;

    if (this.snapToGrid) {
      const grid = this.options.gridSize;
      p.x = Math.round(p.x / grid) * grid;
      p.z = Math.round(p.z / grid) * grid;
    }

    return p;
  }

  /** Орто в плоскости XZ относительно последней точки (как Shift в CAD). */
  private applyOrthoXZ(last: SketchPoint, p: THREE.Vector3): THREE.Vector3 {
    const dx = p.x - last.x;
    const dz = p.z - last.z;
    if (Math.abs(dx) >= Math.abs(dz)) {
      return new THREE.Vector3(p.x, last.y, last.z);
    }
    return new THREE.Vector3(last.x, last.y, p.z);
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

  addPoint(
    mouse: THREE.Vector2,
    opts?: { overrideY?: number }
  ): SketchPoint | null {
    const point = this.getRaycastPoint(mouse);
    if (!point) return null;

    if (opts?.overrideY !== undefined) {
      let v = new THREE.Vector3(point.x, opts.overrideY, point.z);
      const g = this.options.gridSize;
      if (this.snapToGrid) {
        v.x = Math.round(v.x / g) * g;
        v.z = Math.round(v.z / g) * g;
      }
      if (this.orthoMode && this.currentPoints.length > 0) {
        const last = this.currentPoints[this.currentPoints.length - 1];
        v = this.applyOrthoXZ(last, v);
        v.y = opts.overrideY;
        if (this.snapToGrid) {
          v.x = Math.round(v.x / g) * g;
          v.z = Math.round(v.z / g) * g;
        }
      }
      this.currentPoints.push({ x: v.x, y: v.y, z: v.z });
      return { x: v.x, y: v.y, z: v.z };
    }

    let snapped = this.snapToPoint(point);
    if (this.orthoMode && this.currentPoints.length > 0) {
      const last = this.currentPoints[this.currentPoints.length - 1];
      snapped = this.applyOrthoXZ(last, snapped);
      if (this.snapToGrid) {
        snapped = this.snapToPoint(snapped);
      }
    }

    this.currentPoints.push({ x: snapped.x, y: snapped.y, z: snapped.z });

    return { x: snapped.x, y: snapped.y, z: snapped.z };
  }

  /**
   * После построения сегмента стены/балки оставляем только последнюю вершину —
   * следующий клик продолжает цепочку.
   */
  trimPolylineToLastVertex(): void {
    if (this.currentPoints.length >= 1) {
      const last = this.currentPoints[this.currentPoints.length - 1];
      this.currentPoints = [last];
    }
  }

  private disposePreviewObject(): void {
    if (!this.previewObject) return;
    this.scene.remove(this.previewObject);
    if (this.previewObject instanceof THREE.Line) {
      this.previewObject.geometry.dispose();
      (this.previewObject.material as THREE.Material).dispose();
    } else if (this.previewObject instanceof THREE.Mesh) {
      this.previewObject.geometry.dispose();
      const mats = Array.isArray(this.previewObject.material)
        ? this.previewObject.material
        : [this.previewObject.material];
      mats.forEach((m) => m.dispose());
    }
    this.previewObject = null;
  }

  /**
   * Резинка стены/балки от последней точки до курсора.
   * Для балки: beamPreview задаёт профиль и мировую Y конца сегмента (от уровня + смещение).
   */
  updateWallBeamPreview(
    mouse: THREE.Vector2,
    tool: WallBeamPreviewTool,
    beamPreview?: { profile: BeamProfile; endY: number }
  ): void {
    this.disposePreviewObject();
    if (this.currentPoints.length === 0) return;

    const point = this.getRaycastPoint(mouse);
    if (!point) return;

    const lastPoint = this.currentPoints[this.currentPoints.length - 1];

    let snapped = this.snapToPoint(point);
    if (tool === 'beam' && beamPreview !== undefined) {
      snapped = new THREE.Vector3(point.x, beamPreview.endY, point.z);
      const g = this.options.gridSize;
      if (this.snapToGrid) {
        snapped.x = Math.round(snapped.x / g) * g;
        snapped.z = Math.round(snapped.z / g) * g;
      }
      if (this.orthoMode) {
        snapped = this.applyOrthoXZ(lastPoint, snapped);
        snapped.y = beamPreview.endY;
        if (this.snapToGrid) {
          snapped.x = Math.round(snapped.x / g) * g;
          snapped.z = Math.round(snapped.z / g) * g;
        }
      }
    } else if (this.orthoMode) {
      snapped = this.applyOrthoXZ(lastPoint, snapped);
      if (this.snapToGrid) {
        snapped = this.snapToPoint(snapped);
      }
    }

    const p1 = lastPoint;
    const p2 = { x: snapped.x, y: snapped.y, z: snapped.z };

    let mesh: THREE.Mesh;
    if (tool === 'wall') {
      mesh = this.buildWallMesh(p1, p2, 0xd3d3d3, true);
    } else {
      const profile = beamPreview?.profile ?? { width: 0.3, height: 0.6 };
      const previewMesh = buildSketchBeamMesh(p1, p2, profile, { isPreview: true });
      if (!previewMesh) {
        return;
      }
      mesh = previewMesh;
    }
    this.previewObject = mesh;
    this.scene.add(mesh);
  }

  private buildWallMesh(
    p1: SketchPoint,
    p2: SketchPoint,
    color: number,
    isPreview: boolean
  ): THREE.Mesh {
    const length = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    if (length < 1e-6) {
      const g = new THREE.BoxGeometry(0.01, WALL_HEIGHT, WALL_THICKNESS);
      const mat = this.previewMaterial(color, isPreview);
      return new THREE.Mesh(g, mat);
    }
    const angle = Math.atan2(p2.z - p1.z, p2.x - p1.x);
    const geometry = new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS);
    const mat = this.previewMaterial(color, isPreview);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(
      (p1.x + p2.x) / 2,
      p1.y + WALL_HEIGHT / 2,
      (p1.z + p2.z) / 2
    );
    mesh.rotation.y = -angle;
    return mesh;
  }

  private previewMaterial(color: number, isPreview: boolean): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      opacity: isPreview ? 0.42 : 1,
      transparent: isPreview,
      depthWrite: !isPreview,
    });
  }

  updatePreview(mouse: THREE.Vector2, mode: DrawMode): void {
    const point = this.getRaycastPoint(mouse);
    if (!point || this.currentPoints.length === 0) return;

    let snapped = this.snapToPoint(point);
    const lastPoint = this.currentPoints[this.currentPoints.length - 1];
    if (this.orthoMode) {
      snapped = this.applyOrthoXZ(lastPoint, snapped);
      if (this.snapToGrid) {
        snapped = this.snapToPoint(snapped);
      }
    }

    this.disposePreviewObject();

    if (mode === 'line' && this.currentPoints.length >= 1) {
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
    this.disposePreviewObject();
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
