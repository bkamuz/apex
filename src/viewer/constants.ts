// BIM Viewer Constants
export const VIEWER_CONSTANTS = {
  // Fragment geometry creation timeout settings
  FRAGMENT_CHECK_INTERVAL_MS: 250,
  MAX_FRAGMENT_RETRIES: 20,
  
  // File upload limits
  MAX_FILE_SIZE_BYTES: 500 * 1024 * 1024, // 500MB
  MAX_FILE_SIZE_MB: 500,
  
  // Loading timeout
  LOADING_TIMEOUT_MS: 300000, // 5 minutes
  
  // Camera settings
  INITIAL_CAMERA_POSITION: { x: 10, y: 10, z: 10 },
  INITIAL_CAMERA_TARGET: { x: 0, y: 0, z: 0 },
  
  // Scene settings
  BACKGROUND_COLOR: 0x202124,
  AMBIENT_LIGHT_COLOR: 0xffffff,
  AMBIENT_LIGHT_INTENSITY: 0.5,
  DIRECTIONAL_LIGHT_COLOR: 0xffffff,
  DIRECTIONAL_LIGHT_INTENSITY: 1.5,
  DIRECTIONAL_LIGHT_POSITION: { x: 10, y: 10, z: 10 },
} as const;
