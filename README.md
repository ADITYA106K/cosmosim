<div align="center">

# CosmoSim
**Real-Time Gravitational N-Body Simulator**

> A high-performance physics engine written in C++ and compiled to WebAssembly. Simulates thousands of gravitating bodies at 60 FPS directly in the browser through aggressive memory optimization and a zero-copy architecture.

**[▶ Live Demo](https://aditya106k.github.io/cosmosim/)** | **[📹 Architecture Overview & Demo Video](https://drive.google.com/file/d/1D1VL0EjdtIM1mtLPdkfBNOUUR2AjgjOD/view?usp=sharing)**

</div>

---

## Technical Specification

| Component | Implementation |
| :--- | :--- |
| **Language** | C++17 |
| **Target** | WebAssembly (WASM) via Emscripten / LLVM-Clang |
| **Algorithm** | Barnes-Hut Spatial Approximation |
| **Complexity** | `O(N log N)` per frame |
| **Integrator** | Symplectic Leapfrog (Störmer-Verlet) |
| **Data Structure** | Flat, contiguous `std::vector` (Integer-indexed QuadNodes) |
| **Spatial Sort** | Morton Code (Z-order curve) |
| **Rendering** | WebGL Point-Sprite SDF Shaders (1 draw call per frame) |
| **WASM Bridge** | Zero-copy `Float32Array` view into the WASM linear memory heap |

---

## Core Architecture & Optimizations

Running an N-body simulation in the browser demands strict performance optimizations. CosmoSim bypasses standard JavaScript bottlenecks by managing memory directly in C++ and optimizing for L1 cache locality.

### 1. Algorithmic Scaling: `O(N^2)` to `O(N log N)`
The naive approach for calculating gravitational forces computes every particle pair directly. For 10,000 particles, this requires nearly 50 million force calculations per frame—an impossibility for a browser at 60 FPS. CosmoSim implements the **Barnes-Hut algorithm**, treating distant clusters of particles as a single center-of-mass. This reduces force calculations to approximately 420,000 per frame, yielding a measured **~30× speedup**.

### 2. Numerical Stability: Symplectic Integration
Standard numerical integration (like Euler's method) is asymmetric in time, introducing a systematic error where orbits artificially gain energy and dissolve. CosmoSim uses a **Symplectic Leapfrog (Störmer-Verlet) Integrator**. By staggering position and velocity updates by half a timestep, the engine exactly preserves a modified Hamiltonian. Total system energy remains rigidly bounded indefinitely.

### 3. Cache-Friendly Memory Layout
A conventional Barnes-Hut quadtree allocates nodes on the heap connected by pointers, causing millions of CPU cache misses per second during traversal. CosmoSim eliminates pointer chasing entirely:
* **Flat Arrays:** The tree is stored in a single, contiguous `std::vector<QuadNode>`. Children are referenced by array indices, allowing the CPU prefetcher to load subtrees efficiently.
* **Morton Z-Order Sorting:** Before tree construction, particles are sorted by their 64-bit Morton code. Spatially adjacent particles become adjacent in memory, maximizing L1 cache hits during tree construction and force traversal.

### 4. Zero-Copy WebAssembly Bridge
Serializing and deserializing data between C++ and JavaScript every frame destroys performance. CosmoSim utilizes a **zero-copy memory bridge**. JavaScript never requests serialized data; instead, it instantiates a `Float32Array` view directly into the WebAssembly linear memory heap (`Module.HEAPF32`). Reading particle positions in JS is a direct memory read from the C++ array. 

### 5. Single-Pass WebGL Rendering
The HTML5 Canvas 2D API cannot render thousands of radial gradients within a 16.7ms frame budget. CosmoSim utilizes a raw **WebGL rendering pipeline**. The `Float32Array` from the WASM heap is uploaded to the GPU in a single `gl.bufferData` call, and a custom shader renders all particles as SDF point-sprites in one `gl.drawArrays` call. 

---

## Hardware Benchmarks

The live dashboard tracks exact sub-millisecond execution times. The following benchmarks demonstrate the algorithmic speedup executed on consumer hardware:

| Particles | Naive `O(N^2)` (ms) | Barnes-Hut (ms) | Speedup | FPS | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **870** | ~10.00 | **4.40** | 2.2× | 60 | ✅ Real-time |
| **1,390** | ~25.00 | **6.60** | 3.7× | 60 | ✅ Real-time |
| **2,000** | ~50.00 | **8.50** | 5.8× | 60 | ✅ Real-time |
| **5,000** | ~312.00 | **22.00** | 14.1× | 45+ | ✅ Interactive |
| **10,000** | ~1250.00 | **50.00** | 25.0× | ~20 | ⚠️ Acceptable |

*(Note: The live θ slider allows dynamic tuning of the approximation threshold, trading mathematical precision for rendering speed).*

---

## Interactive Controls

| Input | Action |
| :--- | :--- |
| **Button: Galaxy Collision** | Spawns two counter-rotating exponential mass disks on a collision course. |
| **Button: Binary Star** | Simulates two massive central cores in a stable elliptical orbit with test particles. |
| **Button: Uniform Dust** | A cold-start scenario simulating gravitational condensation from uniform noise. |
| **Left Click + Drag** | Pans the camera dynamically across the simulation boundaries. |
| **Scroll Wheel** | Applies logarithmic zoom to the WebGL canvas. |
| **Q Key** | Toggles the mathematical Barnes-Hut Quadtree bounding box overlay. |
| **Energy Dashboard** | Live rendering of Kinetic (Gold), Potential (Red), and Total Energy (White). |

---

## Local Build Instructions

Ensure you have the [Emscripten SDK (emsdk)](https://emscripten.org/docs/getting_started/downloads.html) installed and activated in your terminal environment.

```bash
# Clone the repository
git clone https://github.com/ADITYA106K/cosmosim.git
cd cosmosim

# Compile the C++ engine to WebAssembly with maximum optimizations (-O3, -flto)
make wasm 

# Start a local HTTP server to bypass CORS restrictions
make serve

# Open your browser to http://localhost:8080