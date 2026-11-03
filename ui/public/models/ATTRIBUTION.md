# Third-party 3D model attribution

## RiggedFigure.glb

- File: `ui/public/models/RiggedFigure.glb`
- Source: Khronos Group glTF Sample Assets, `Models/RiggedFigure`
  (https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/RiggedFigure)
- Author: Cesium
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
  (https://creativecommons.org/licenses/by/4.0/legalcode)
- Changes: loaded at runtime, tinted/material-replaced to a cyan holographic
  material, scaled and animated in the YuppyCode scene. The model geometry
  itself is unmodified.

If the model fails to load, the UI falls back to a clearly procedural
wireframe humanoid; it does not present a 2D image as a 3D human.

## Hand tracking assets

- `ui/public/models/hand_landmarker.task` — MediaPipe Hand Landmarker
  (Apache-2.0), downloaded from Google's model storage.
- `ui/public/mediapipe/wasm/` — MediaPipe Tasks Vision WASM runtime
  (Apache-2.0), copied from `@mediapipe/tasks-vision@0.10.17`.

These assets run inference locally in the browser; camera frames are never
sent to the Rust bridge or any server.
