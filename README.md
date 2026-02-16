# Apex BIM Tool

An open-source, cloud-native BIM tool architecture.

## Architecture Highlights
*   **Engine:** Three.js + WebGPU
*   **BIM Stack:** [That Open Company (formerly IFC.js)](https://thatopen.com/)
*   **Geometry Kernels:** [OpenCASCADE.js](https://ocjs.org/) (High-precision) & [Manifold](https://github.com/elalish/manifold) (Robust Mesh Ops)
*   **Data Hub:** [Speckle](https://speckle.systems/) (Git-like versioning)

## Directory Structure
*   `src/core`: Geometry kernel wrappers and core modeling logic.
*   `src/viewer`: 3D rendering engine, cameras, and BIM-specific visualization tools.
*   `src/data`: Connectors for Speckle, IFC parsers, and data synchronization.
*   `src/ui`: User interface components (React).
*   `src/api`: Cloud service integrations.

---
*Created with ❤️ for open-source BIM.*
