import { useEffect, useRef, useState, useCallback } from 'react';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';
import styles from './BIMViewer.module.css';
import type { IfcFragmentModelHandle, LoadedModel, IfcLoaderConfig } from '../types/bim';
import { BimApplicationProvider } from '../api/BimApplicationProvider';
import { useBimFacade } from '../api/useBimFacade';
import { useDocumentServerSync } from '../api/useDocumentServerSync';
import { Editor } from '../editor/Editor';
import { SketchMode } from '../editor/sketch/SketchMode';
import { SpatialTree } from '../ui/SpatialTree';
import { VIEWER_CONSTANTS as VC } from './constants';
import { useViewerStore } from '../store/useViewerStore';

const getAssetPath = (path: string): string => {
  const base = import.meta.env.BASE_URL;
  return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`;
};

const sanitizeFilename = (name: string): string => name.replace(/[<>:"/\\|?*]/g, '_');

export const BIMViewer: React.FC = () => (
  <BimApplicationProvider>
    <BIMViewerInner />
  </BimApplicationProvider>
);

const DEFAULT_PROJECT_ID = 'default';

const BIMViewerInner: React.FC = () => {
  const facade = useBimFacade();
  useDocumentServerSync(facade, DEFAULT_PROJECT_ID);
  const containerRef = useRef<HTMLDivElement>(null);
  const componentsRef = useRef<OBC.Components | null>(null);
  const loadedModelRef = useRef<LoadedModel | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isLoaderReady, setIsLoaderReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const { mode, setMode, isTreeVisible, setTreeVisible } = useViewerStore();
  const [viewerComponents, setViewerComponents] = useState<{
    components: OBC.Components | null;
    scene: THREE.Scene | null;
    camera: THREE.Camera | null;
  }>({ components: null, scene: null, camera: null });

  // Comprehensive Three.js resource disposal
  const disposeModel = useCallback(() => {
    if (loadedModelRef.current) {
      const { object } = loadedModelRef.current;

      // Traverse and dispose all meshes
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }
        if (mesh.material) {
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((mat) => {
            // Dispose textures
            Object.values(mat).forEach((val) => {
              if (val?.isTexture) {
                val.dispose();
              }
            });
            mat.dispose();
          });
        }
      });

      // Remove from parent
      if (object.parent) {
        object.parent.remove(object);
      }

      loadedModelRef.current = null;
      facade.removeIfcElements();
    }

    // Dispose lights if they exist
    if (componentsRef.current) {
      try {
        const worlds = componentsRef.current.get(OBC.Worlds);
        if (worlds.list.size > 0) {
          const world = worlds.list.values().next().value;
          if (world?.scene?.three) {
            world.scene.three.traverse((obj: THREE.Object3D) => {
              const light = obj as THREE.Light;
              if (light.isLight) {
                light.dispose?.();
              }
            });
          }
        }
      } catch (e) {
        console.warn('Error disposing lights:', e);
      }
    }
  }, [facade]);

  // Complete cleanup function
  const cleanup = useCallback(() => {
    // Clear timeouts
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }

    // Abort any in-progress loading
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Dispose 3D resources
    disposeModel();
    facade.clearDocument();
    facade.clearRuntime();

    // Dispose components
    if (componentsRef.current) {
      componentsRef.current.dispose();
      componentsRef.current = null;
    }
  }, [disposeModel, facade]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let onModelSetCallback: (() => Promise<void>) | null = null;
    let onMaterialSetCallback: (() => void) | null = null;

    const initViewer = async () => {
      try {
        const components = new OBC.Components();
        componentsRef.current = components;

        const worlds = components.get(OBC.Worlds);
        const world = worlds.create();

        // Setup scene
        const scene = new OBC.SimpleScene(components);
        world.scene = scene;
        scene.setup();
        scene.three.background = new THREE.Color(VC.BACKGROUND_COLOR);

        // Setup renderer
        const renderer = new OBC.SimpleRenderer(components, containerRef.current!);
        world.renderer = renderer;

        // Setup camera
        const camera = new OBC.SimpleCamera(components);
        world.camera = camera;

        components.init();

        // Setup camera controls with error handling
        try {
          await camera.controls.setLookAt(
            VC.INITIAL_CAMERA_POSITION.x,
            VC.INITIAL_CAMERA_POSITION.y,
            VC.INITIAL_CAMERA_POSITION.z,
            VC.INITIAL_CAMERA_TARGET.x,
            VC.INITIAL_CAMERA_TARGET.y,
            VC.INITIAL_CAMERA_TARGET.z,
            true
          );
        } catch (err) {
          console.error('Failed to set camera position:', err);
        }

        // Add lights
        const ambientLight = new THREE.AmbientLight(
          VC.AMBIENT_LIGHT_COLOR,
          VC.AMBIENT_LIGHT_INTENSITY
        );
        scene.three.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(
          VC.DIRECTIONAL_LIGHT_COLOR,
          VC.DIRECTIONAL_LIGHT_INTENSITY
        );
        directionalLight.position.set(
          VC.DIRECTIONAL_LIGHT_POSITION.x,
          VC.DIRECTIONAL_LIGHT_POSITION.y,
          VC.DIRECTIONAL_LIGHT_POSITION.z
        );
        scene.three.add(directionalLight);

        // Grid
        const grids = components.get(OBC.Grids);
        grids.create(world);

        // Initialize FragmentsManager with error handling
        const fragments = components.get(OBC.FragmentsManager);
        try {
          await fragments.init(getAssetPath('fragments/worker.mjs'));
        } catch {
          throw new Error('Failed to initialize geometry engine. Check WASM files.');
        }

        // Create callback for model loading - store reference for cleanup
        onModelSetCallback = async () => {
          if (disposed) return;

          const model = fragments.list.values().next().value;
          if (!model) return;

          try {
            model.useCamera(camera.three);
            world.scene.three.add(model.object);
            fragments.core.update(true);

            // Wait for geometry with timeout
            let retries = 0;
            while (model.tiles?.size === 0 && retries < VC.MAX_FRAGMENT_RETRIES) {
              await new Promise((resolve) =>
                setTimeout(resolve, VC.FRAGMENT_CHECK_INTERVAL_MS)
              );
              retries++;
            }

            // Fit camera to model
            if (
              model.tiles?.size > 0 &&
              model.box &&
              camera.hasCameraControls()
            ) {
              const bbox = components.get(OBC.BoundingBoxer);
              bbox.list.add(model.box);
              const box3 = bbox.get();

              if (box3 && !box3.isEmpty()) {
                camera.controls.fitToBox(box3, true);
              }
              bbox.list.clear();
            }
          } catch (err) {
            console.error('Error processing loaded model:', err);
          }
        };

        // Create callback for materials - store reference for cleanup
        onMaterialSetCallback = () => {
          if (disposed) return;

          const material = fragments.core.models.materials.list.values().next().value;
          if (!material) return;

          if (
            !('isLodMaterial' in material && material.isLodMaterial)
          ) {
            material.polygonOffset = true;
            material.polygonOffsetUnits = 1;
            material.polygonOffsetFactor = 1; // Consistent value instead of random
          }
        };

        // Add callbacks with stored references
        fragments.list.onItemSet.add(onModelSetCallback);
        fragments.core.models.materials.list.onItemSet.add(onMaterialSetCallback);

        // Setup IfcLoader with error handling
        const ifcLoader = components.get(OBC.IfcLoader);

        const config: IfcLoaderConfig = {
          wasm: {
            path: getAssetPath('wasm/'),
            absolute: false,
          },
          autoSetWasm: false,
        };

        try {
          await ifcLoader.setup(config);
        } catch {
          throw new Error('Failed to setup IFC loader. Check WASM configuration.');
        }

        if (!disposed) {
          setIsLoaderReady(true);
          // Store references for editor
          setViewerComponents({
            components,
            scene: world.scene?.three as unknown as THREE.Scene || null,
            camera: world.camera?.three || null,
          });
        }
      } catch (err) {
        if (disposed) return;
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to initialize viewer';
        console.error('Viewer initialization error:', err);
        setError(errorMessage);
      }
    };

    initViewer();

    // Window resize handler
    const handleResize = () => {
      if (componentsRef.current) {
        try {
          const worlds = componentsRef.current.get(OBC.Worlds);
          if (worlds.list.size > 0) {
            const world = worlds.list.values().next().value;
            if (world?.renderer?.three) {
              world.renderer.three.setSize(
                containerRef.current!.clientWidth,
                containerRef.current!.clientHeight
              );
            }
          }
        } catch (e) {
          console.warn('Error handling resize:', e);
        }
      }
    };

    window.addEventListener('resize', handleResize);

    // Cleanup function - removes event listeners and disposes resources
    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);

      // Remove event callbacks
      if (onModelSetCallback && componentsRef.current) {
        try {
          const fragments = componentsRef.current.get(OBC.FragmentsManager);
          fragments.list.onItemSet.remove(onModelSetCallback);
        } catch (e) {
          console.warn('Error removing model callback:', e);
        }
      }

      if (onMaterialSetCallback && componentsRef.current) {
        try {
          const fragments = componentsRef.current.get(OBC.FragmentsManager);
          fragments.core.models.materials.list.onItemSet.remove(onMaterialSetCallback);
        } catch (e) {
          console.warn('Error removing material callback:', e);
        }
      }

      cleanup();
    };
  }, [cleanup]);

  useEffect(() => {
    facade.setRuntime({
      scene: viewerComponents.scene,
      camera: viewerComponents.camera,
      components: viewerComponents.components,
    });
  }, [
    facade,
    viewerComponents.scene,
    viewerComponents.camera,
    viewerComponents.components,
  ]);

  // File validation
  const validateFile = (file: File): string | null => {
    if (file.size === 0) {
      return 'File is empty';
    }

    if (file.size > VC.MAX_FILE_SIZE_BYTES) {
      return `File too large. Maximum size: ${VC.MAX_FILE_SIZE_MB}MB`;
    }

    if (!file.name.toLowerCase().endsWith('.ifc')) {
      return 'Only .ifc files are supported';
    }

    return null;
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file || !componentsRef.current) return;

    // Validate file
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Abort any previous loading
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsLoading(true);
    setError(null);
    setLoadingProgress(0);

    // Setup loading timeout
    loadingTimeoutRef.current = setTimeout(() => {
      setError('Loading timeout. The file may be too large.');
      setIsLoading(false);
      setLoadingProgress(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }, VC.LOADING_TIMEOUT_MS);

    const ifcLoader = componentsRef.current.get(OBC.IfcLoader);

    try {
      disposeModel();

      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);

      const model = await ifcLoader.load(data, true, sanitizeFilename(file.name), {
        processData: {
          progressCallback: (progress) => {
            setLoadingProgress(Math.round(progress * 100));
            // Reset timeout on progress
            if (loadingTimeoutRef.current) {
              clearTimeout(loadingTimeoutRef.current);
              loadingTimeoutRef.current = setTimeout(() => {
                setError('Loading timeout. The file may be too large.');
                setIsLoading(false);
                setLoadingProgress(0);
              }, VC.LOADING_TIMEOUT_MS);
            }
          },
        },
      });

      // Clear timeout on success
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = null;
      }

      // Wait for fragments
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Store model reference + sync IFC metadata into Document
      if (model.box) {
        const fm = model as unknown as Partial<IfcFragmentModelHandle> & {
          object: THREE.Object3D;
          box: THREE.Box3;
          modelId?: string;
        };
        const fragmentModel: IfcFragmentModelHandle | undefined =
          typeof fm.getFragmentMap === 'function'
            ? (fm as IfcFragmentModelHandle)
            : undefined;

        if (fragmentModel?.properties) {
          facade.replaceIfcFromProperties(fragmentModel.properties);
        }

        loadedModelRef.current = {
          id: fm.modelId || file.name,
          name: file.name,
          object: fm.object,
          box: fm.box,
          fragmentModel,
        };
      }
    } catch (err) {
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = null;
      }

      if ((err as { name?: string }).name === 'AbortError') {
        setError('Loading was cancelled');
      } else {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to load IFC file';
        setError(errorMessage);
        console.error('IFC load error:', err);
      }
    } finally {
      setIsLoading(false);
      setLoadingProgress(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      abortControllerRef.current = null;
    }
  };

  const handleRetry = () => {
    setError(null);
    window.location.reload();
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
    setIsLoading(false);
    setLoadingProgress(0);
  };

  if (error) {
    return (
      <div className={styles.viewerContainer}>
        <div className={styles.errorOverlay}>
          <div className={styles.errorIcon}>⚠️</div>
          <div className={styles.errorTitle}>Viewer Initialization Failed</div>
          <div className={styles.errorMessage}>{error}</div>
          <button className={styles.retryButton} onClick={handleRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.viewerContainer}>
      <div ref={containerRef} className={styles.canvas} />

      {isLoading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.spinner} />
          <div className={styles.loadingText}>
            Loading IFC file... {loadingProgress > 0 && `${loadingProgress}%`}
          </div>
          <button className={styles.retryButton} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {/* Mode Toggle Buttons */}
      {isLoaderReady && (
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '20px',
          zIndex: 1000,
          display: 'flex',
          gap: '8px',
        }}>
          <button
            onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
            style={{
              background: mode === 'edit' ? '#3a7bd5' : '#2a2a2a',
              color: 'white',
              border: '1px solid #444',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            {mode === 'edit' ? '👁️ View Mode' : '✏️ Edit Mode'}
          </button>

          <button
            onClick={() => setMode(mode === 'sketch' ? 'view' : 'sketch')}
            style={{
              background: mode === 'sketch' ? '#3a7bd5' : '#2a2a2a',
              color: 'white',
              border: '1px solid #444',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            {mode === 'sketch' ? '👁️ View Mode' : '📐 Sketch Mode'}
          </button>
          <button
            onClick={() => setTreeVisible(!isTreeVisible)}
            style={{
              background: isTreeVisible ? '#3a7bd5' : '#2a2a2a',
              color: 'white',
              border: '1px solid #444',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
              marginLeft: '16px',
            }}
          >
            {isTreeVisible ? '🌳 Hide Tree' : '🌳 Show Tree'}
          </button>
        </div>
      )}

      {/* Spatial Tree */}
      {isTreeVisible && viewerComponents.components && loadedModelRef.current?.fragmentModel && (
        <SpatialTree
          components={viewerComponents.components}
          fragmentModel={loadedModelRef.current.fragmentModel}
          rootName={loadedModelRef.current.name}
          onClose={() => setTreeVisible(false)}
        />
      )}

      {/* Editor Toolbar */}
      {mode === 'edit' && viewerComponents.components && viewerComponents.scene && viewerComponents.camera && (
        <Editor
          containerRef={containerRef as React.RefObject<HTMLDivElement>}
          scene={viewerComponents.scene}
          camera={viewerComponents.camera}
        />
      )}

      {/* Sketch Mode */}
      {mode === 'sketch' && viewerComponents.scene && viewerComponents.camera && (
        <SketchMode
          containerRef={containerRef as React.RefObject<HTMLDivElement>}
          scene={viewerComponents.scene}
          camera={viewerComponents.camera}
          isActive={true}
        />
      )}

      {/* Upload Button */}
      <div className={styles.overlay}>
        <label className={styles.uploadButton}>
          {isLoaderReady ? '📁 Загрузить IFC' : '⏳ Загрузка ядра...'}
          <input
            ref={fileInputRef}
            type="file"
            accept=".ifc"
            onChange={handleFileChange}
            disabled={!isLoaderReady || isLoading}
            className={styles.fileInput}
          />
        </label>
        <div className={styles.statusText}>
          Поддерживаются .ifc файлы
        </div>
      </div>
    </div>
  );
};

export default BIMViewer;