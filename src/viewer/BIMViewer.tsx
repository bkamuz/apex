import React, { useEffect, useRef, useState } from 'react';
import * as OBC from '@thatopen/components';
import * as THREE from 'three';

export const BIMViewer: React.FC = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const componentsRef = useRef<OBC.Components | null>(null);
    const [isLoaderReady, setIsLoaderReady] = useState(false);

    useEffect(() => {
        if (!containerRef.current) return;

        // 1. Initialize Components
        const components = new OBC.Components();
        componentsRef.current = components;

        // 2. Configure Worlds
        const worlds = components.get(OBC.Worlds);
        const world = worlds.create<
            OBC.SimpleScene,
            OBC.SimpleCamera,
            OBC.SimpleRenderer
        >();

        world.scene = new OBC.SimpleScene(components);
        world.renderer = new OBC.SimpleRenderer(components, containerRef.current);
        world.camera = new OBC.SimpleCamera(components);

        components.init();

        // 3. Setup Scene Content
        world.scene.setup();
        const scene = world.scene.three;
        scene.background = new THREE.Color(0x202124);

        // 4. Add Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight.position.set(10, 10, 10);
        scene.add(directionalLight);

        // 5. Grid
        const grids = components.get(OBC.Grids);
        grids.create(world);

        // 6. Setup Fragments Manager (Required for IFC Loader)
        const fragments = components.get(OBC.FragmentsManager);
        fragments.init("/fragments/worker.mjs");



        // 7. Setup IFC Loader
        const ifcLoader = components.get(OBC.IfcLoader);
        const setup = async () => {
            await ifcLoader.setup({
                wasm: {
                    path: "/wasm/",
                    absolute: false
                },
                autoSetWasm: false
            });
            setIsLoaderReady(true);
        };
        setup();

        // 8. Initial Camera
        world.camera.controls.setLookAt(10, 10, 10, 0, 0, 0, true);

        // Cleanup
        return () => {
            components.dispose();
            componentsRef.current = null;
        };
    }, []);

    const loadIfc = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !componentsRef.current) return;

        const ifcLoader = componentsRef.current.get(OBC.IfcLoader);
        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);

        try {
            const model = await ifcLoader.load(data, true, file.name);
            console.log("IFC Model loaded:", model);
            console.log("model.object:", model.object);

            if (model.object) {
                console.log("Is model.object THREE.Object3D?", model.object instanceof THREE.Object3D);
                console.log("model.object constructor:", model.object.constructor.name);
                console.log("model.object visible:", model.object.visible);
                console.log("model.object children count:", model.object.children.length);

                const box = new THREE.Box3().setFromObject(model.object);
                const size = new THREE.Vector3();
                box.getSize(size);
                console.log("Model BBox size:", size);
                console.log("Model BBox center:", box.getCenter(new THREE.Vector3()));
            }

            // Zoom to model
            const worlds = componentsRef.current.get(OBC.Worlds);
            const world = worlds.list.size > 0 ? worlds.list.values().next().value : null;

            if (world) {
                world.scene.three.add(model.object);
                console.log("Scene children count after add:", world.scene.three.children.length);
                console.log("Model parent in Three.js:", model.object.parent === world.scene.three ? "Correct" : "Incorrect");

                if (world.camera && world.camera.hasCameraControls()) {
                    const bbox = componentsRef.current.get(OBC.BoundingBoxer);
                    // element has a box property that is a THREE.Box3
                    // @ts-ignore
                    bbox.list.add(model.box);
                    const box3 = bbox.get();
                    console.log("BoundingBoxer result:", box3);
                    world.camera.controls.fitToBox(box3, true);
                    bbox.list.clear();
                }
            }
        } catch (error) {
            console.error("Error loading IFC:", error);
        }
    };

    return (
        <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
            <div
                ref={containerRef}
                style={{ width: '100%', height: '100%', overflow: 'hidden' }}
            />

            {/* Overlay UI */}
            <div style={{
                position: 'absolute',
                bottom: '30px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 100,
                background: 'rgba(30, 30, 30, 0.8)',
                padding: '15px 25px',
                borderRadius: '12px',
                display: 'flex',
                gap: '15px',
                alignItems: 'center',
                border: '1px solid #444',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(8px)'
            }}>
                <label style={{
                    color: 'white',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    cursor: isLoaderReady ? 'pointer' : 'wait',
                    background: '#3a7bd5',
                    padding: '8px 16px',
                    borderRadius: '6px',
                    transition: '0.3s'
                }}>
                    {isLoaderReady ? "📁 Загрузить IFC" : "⏳ Загрузка ядра..."}
                    <input
                        type="file"
                        accept=".ifc"
                        onChange={loadIfc}
                        disabled={!isLoaderReady}
                        style={{ display: 'none' }}
                    />
                </label>
                <div style={{ color: '#aaa', fontSize: '12px' }}>
                    Поддерживаются .ifc файлы
                </div>
            </div>
        </div>
    );
};
