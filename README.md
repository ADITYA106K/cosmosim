# CosmoSim 🌌

**A real-time gravitational N-body physics engine built in C++ and compiled to WebAssembly (WASM).**

## 🚀 The Concept

Simulating orbital mechanics for thousands of interacting bodies is a very heavy algorithmic problem. Doing it directly in a web browser usually fails for two reasons: standard JavaScript engines choke on the millions of $O(N^2)$ calculations required per frame, and standard numerical integrators (like explicit Euler) slowly leak orbital energy until the simulation tears itself apart.

**CosmoSim** solves this by escaping JavaScript entirely for the heavy lifting. The physics core is written in highly optimized C++17 and compiled to WebAssembly. By combining a zero-copy memory architecture with a physically accurate symplectic integrator, it brings stable, high-performance gravitational simulation natively to the browser.

## 🧠 Current Architecture (Day 1 Engine)

The foundation of the engine is live and heavily optimized:

* **Zero-Copy WASM Memory Bridge:** JavaScript never copies or serializes particle data. Instead, the frontend creates a `Float32Array` view that points *directly* into the C++ `std::vector` linear memory heap. The browser reads the exact bytes the C++ engine writes.
* **Symplectic Euler (Kick-Drift) Integration:** Standard integrators bleed energy over time. CosmoSim uses a time-symmetric integrator to naturally conserve the kinetic and potential energy of the system, keeping orbits mathematically bounded and stable.
* **Refresh-Rate Agnostic:** The engine calculates true delta-time (`dt`) on the frontend, ensuring the simulation runs at the exact same physical speed whether you are on a standard 60Hz monitor or a 144Hz display, with hard caps to prevent background-tab physics explosions.
* **Cache-Friendly Memory Layout:** The C++ `Particle` struct is strictly 5 floats wide (`x, y, vx, vy, mass`) with zero padding, ensuring sequential memory reads to maximize CPU L1 cache hits during the $O(N^2)$ force loop.

## 🗺️ Next steps

With the base engine and WebAssembly bridge stabilized, the next phases are focused on aggressive algorithmic scaling:

- [ ] **Barnes-Hut Spatial Subdivision:** Replacing the brute-force $O(N^2)$ gravity calculation with a flat-array Quadtree to drop complexity down to $O(N \log N)$.
- [ ] **Morton Code Pre-sorting:** Spatially sorting particles (Z-order curve) before tree construction to guarantee cache locality during recursive traversals.
- [ ] **WebGL Rendering Pipeline:** Migrating from the Canvas 2D API to custom WebGL shaders (`gl.POINTS`) to render tens of thousands of particles in a single GPU draw call.
- [ ] **Astrophysical Presets:** Implementing dynamic mass accretion (mergers) and galaxy collision scenarios.

## 🛠️ Build Instructions

To compile the engine locally, you will need the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).

**1. Compile the WASM Binary**
```bash
make wasm