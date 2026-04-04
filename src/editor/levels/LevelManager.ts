import * as THREE from 'three';
import type { Level } from './types';
import { DEFAULT_LEVELS, LEVEL_SPACING } from './types';

export class LevelManager {
  private scene: THREE.Scene;
  private levels: Map<string, Level> = new Map();
  private activeLevelId: string | null = null;
  private gridHelpers: Map<string, THREE.GridHelper> = new Map();
  private labels: Map<string, THREE.Sprite> = new Map();

  constructor(scene: THREE.Scene, initialLevels?: Level[]) {
    this.scene = scene;
    
    const levels = initialLevels || DEFAULT_LEVELS;
    levels.forEach((level) => this.addLevel(level));
    
    if (levels.length > 0) {
      this.activeLevelId = levels[0].id;
    }
  }

  addLevel(level: Level): void {
    if (this.levels.has(level.id)) {
      console.warn(`Level ${level.id} already exists`);
      return;
    }

    this.levels.set(level.id, level);
    this.createLevelGrid(level);
    this.createLevelLabel(level);

    if (!this.activeLevelId) {
      this.activeLevelId = level.id;
    }
  }

  removeLevel(levelId: string): void {
    const level = this.levels.get(levelId);
    if (!level) return;

    // Remove grid
    const grid = this.gridHelpers.get(levelId);
    if (grid) {
      this.scene.remove(grid);
      this.gridHelpers.delete(levelId);
    }

    // Remove label
    const label = this.labels.get(levelId);
    if (label) {
      this.scene.remove(label);
      this.labels.delete(levelId);
    }

    this.levels.delete(levelId);

    if (this.activeLevelId === levelId) {
      this.activeLevelId = this.levels.keys().next().value || null;
    }
  }

  updateLevel(levelId: string, updates: Partial<Level>): void {
    const level = this.levels.get(levelId);
    if (!level) return;

    Object.assign(level, updates);

    // Update grid if elevation changed
    if (updates.elevation !== undefined) {
      const grid = this.gridHelpers.get(levelId);
      if (grid) {
        grid.position.z = updates.elevation;
      }
      const label = this.labels.get(levelId);
      if (label) {
        label.position.z = updates.elevation + 0.5;
      }
    }

    // Update visibility
    if (updates.visible !== undefined) {
      const grid = this.gridHelpers.get(levelId);
      if (grid) {
        grid.visible = updates.visible;
      }
      const label = this.labels.get(levelId);
      if (label) {
        label.visible = updates.visible;
      }
    }

    this.levels.set(levelId, level);
  }

  setActiveLevel(levelId: string): void {
    if (!this.levels.has(levelId)) {
      console.warn(`Level ${levelId} does not exist`);
      return;
    }
    this.activeLevelId = levelId;
  }

  getActiveLevel(): Level | null {
    if (!this.activeLevelId) return null;
    return this.levels.get(this.activeLevelId) || null;
  }

  getActiveElevation(): number {
    const level = this.getActiveLevel();
    return level?.elevation || 0;
  }

  getLevel(levelId: string): Level | undefined {
    return this.levels.get(levelId);
  }

  getAllLevels(): Level[] {
    return Array.from(this.levels.values());
  }

  getNextLevelElevation(): number {
    const levels = this.getAllLevels();
    if (levels.length === 0) return 0;
    
    const maxElevation = Math.max(...levels.map((l) => l.elevation));
    return maxElevation + LEVEL_SPACING; // Default 3m spacing
  }

  private createLevelGrid(level: Level): void {
    const size = 100;
    const divisions = 20;
    
    // Create horizontal grid (floor plane)
    const grid = new THREE.GridHelper(size, divisions, level.color || 0x444444, 0x333333);
    grid.position.y = level.elevation; // Y is up in Three.js
    grid.name = `Level-${level.name}`;
    
    this.scene.add(grid);
    this.gridHelpers.set(level.id, grid);
  }

  private createLevelLabel(level: Level): void {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    canvas.width = 256;
    canvas.height = 64;

    // Background
    context.fillStyle = 'rgba(0, 0, 0, 0.7)';
    context.fillRect(0, 0, 256, 64);

    // Text
    context.font = 'Bold 28px Arial';
    context.fillStyle = level.color || '#ffffff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(`${level.name} (${level.elevation.toFixed(1)}m)`, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(material);
    
    // Position label at edge of level, facing camera
    sprite.position.set(40, level.elevation + 0.5, 0);
    sprite.scale.set(20, 5, 1);
    sprite.name = `Level-Label-${level.name}`;

    this.scene.add(sprite);
    this.labels.set(level.id, sprite);
  }

  toggleAllLevels(visible: boolean): void {
    this.levels.forEach((level) => {
      this.updateLevel(level.id, { visible });
    });
  }

  dispose(): void {
    this.levels.forEach((_, id) => {
      this.removeLevel(id);
    });
    this.levels.clear();
    this.gridHelpers.clear();
    this.labels.clear();
  }
}
