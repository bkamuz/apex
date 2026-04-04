export interface Level {
  id: string;
  name: string;
  elevation: number; // Z coordinate in meters (stored internally as meters)
  color?: string;
  visible?: boolean;
}

export const DEFAULT_LEVELS: Level[] = [
  { id: 'level-1', name: 'Level 1', elevation: 0, color: '#3a7bd5', visible: true },
  { id: 'level-2', name: 'Level 2', elevation: 3.0, color: '#28a745', visible: true },
  { id: 'level-3', name: 'Level 3', elevation: 6.0, color: '#dc3545', visible: true },
  { id: 'roof', name: 'Roof', elevation: 9.0, color: '#ffc107', visible: true },
];

export const LEVEL_SPACING_MM = 3000; // Default floor height in mm
export const LEVEL_SPACING = LEVEL_SPACING_MM / 1000; // 3.0 meters

// Conversion utilities
export const mmToMeters = (mm: number): number => mm / 1000;
export const metersToMm = (meters: number): number => meters * 1000;
