#include <vector>
#include <cmath>
#include <random>
#include <algorithm>
#include <cstdint>

// Macro magic to expose these C++ functions to JavaScript via WebAssembly
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXTERN extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define EXTERN extern "C"
#endif

struct Particle
{
    float x, y;
    float vx, vy;
    float mass;
};

// We use integer indices instead of raw pointers to keep the CPU cache happy in WASM
struct QuadNode
{
    float cm_x, cm_y;
    float total_mass;
    float bx, by, bw;
    int first_child_idx;
    int particle_idx;
};

std::vector<Particle> particles;
std::vector<QuadNode> tree;

// Cache forces between frames to avoid rebuilding the tree twice for Leapfrog
std::vector<float> saved_fx;
std::vector<float> saved_fy;

const float G = 6.674e-2f;
const float EPSILON = 5.0f;  // Softening parameter: Prevents gravity from shooting to infinity if two particles overlap
const float WORLD = 1000.0f; // Simulation boundary limits
float THETA = 0.5f;          // Barnes-Hut threshold

// Bit-interleaves coordinates into a 64-bit Z-curve to keep spatially close particles close in memory
uint64_t mortonCode(float x, float y)
{
    // Using std::min/max prevents uint32 underflows if a particle bounces slightly out of bounds
    // This also bypasses the C++17 std::clamp Intellisense error in VS Code
    float nx = std::max(0.0f, std::min(1.0f, (x + WORLD) / (2.0f * WORLD)));
    float ny = std::max(0.0f, std::min(1.0f, (y + WORLD) / (2.0f * WORLD)));
    
    uint32_t ix = (uint32_t)(nx * ((1 << 21) - 1));
    uint32_t iy = (uint32_t)(ny * ((1 << 21) - 1));
    uint64_t code = 0;
    
    for (int i = 0; i < 21; i++)
    {
        code |= ((uint64_t)((ix >> i) & 1) << (2 * i));
        code |= ((uint64_t)((iy >> i) & 1) << (2 * i + 1));
    }
    return code;
}

void mortonSort()
{
    std::sort(particles.begin(), particles.end(),
        [](const Particle &a, const Particle &b) {
            return mortonCode(a.x, a.y) < mortonCode(b.x, b.y);
        });
}

int childQuadrant(int nodeIdx, int pIdx)
{
    float midX = tree[nodeIdx].bx + tree[nodeIdx].bw * 0.5f;
    float midY = tree[nodeIdx].by + tree[nodeIdx].bw * 0.5f;
    int qx = (particles[pIdx].x >= midX) ? 1 : 0;
    int qy = (particles[pIdx].y >= midY) ? 2 : 0;
    return qx + qy;
}

void subdivide(int nodeIdx)
{
    float hw = tree[nodeIdx].bw * 0.5f;
    tree[nodeIdx].first_child_idx = (int)tree.size();
    
    // Read bounds into local variables before push_back to prevent undefined behavior during vector reallocation
    float bx = tree[nodeIdx].bx;
    float by = tree[nodeIdx].by;
    
    tree.push_back({0, 0, 0, bx, by, hw, -1, -1});
    tree.push_back({0, 0, 0, bx + hw, by, hw, -1, -1});
    tree.push_back({0, 0, 0, bx, by + hw, hw, -1, -1});
    tree.push_back({0, 0, 0, bx + hw, by + hw, hw, -1, -1});
}

void insertParticle(int nodeIdx, int pIdx, int depth)
{
    if (depth > 64) return;

    if (tree[nodeIdx].particle_idx == -1 && tree[nodeIdx].first_child_idx == -1)
    {
        tree[nodeIdx].particle_idx = pIdx;
        return;
    }

    if (tree[nodeIdx].particle_idx != -1)
    {
        int existing = tree[nodeIdx].particle_idx;
        tree[nodeIdx].particle_idx = -1;
        subdivide(nodeIdx);
        insertParticle(tree[nodeIdx].first_child_idx + childQuadrant(nodeIdx, existing), existing, depth + 1);
    }

    insertParticle(tree[nodeIdx].first_child_idx + childQuadrant(nodeIdx, pIdx), pIdx, depth + 1);
}

void buildTree()
{
    tree.clear();
    mortonSort();
    tree.reserve(particles.size() * 4);
    tree.push_back({0, 0, 0, -WORLD, -WORLD, 2.0f * WORLD, -1, -1});
    
    for (int i = 0; i < (int)particles.size(); i++)
    {
        insertParticle(0, i, 0);
    }
}

void computeCOM(int nodeIdx)
{
    QuadNode &node = tree[nodeIdx];

    if (node.particle_idx != -1)
    {
        Particle &p = particles[node.particle_idx];
        node.cm_x = p.x;
        node.cm_y = p.y;
        node.total_mass = p.mass;
        return;
    }

    if (node.first_child_idx == -1) return;

    node.cm_x = 0;
    node.cm_y = 0;
    node.total_mass = 0;
    
    for (int i = 0; i < 4; i++)
    {
        int c = node.first_child_idx + i;
        if (c < (int)tree.size())
        {
            computeCOM(c);
            node.total_mass += tree[c].total_mass;
            node.cm_x += tree[c].cm_x * tree[c].total_mass;
            node.cm_y += tree[c].cm_y * tree[c].total_mass;
        }
    }
    
    if (node.total_mass > 0)
    {
        node.cm_x /= node.total_mass;
        node.cm_y /= node.total_mass;
    }
}

// Barnes-Hut O(N log N) optimization: Approximates distant clusters as a single mass
void computeForce(int pIdx, int nodeIdx, float &fx, float &fy)
{
    if (nodeIdx >= (int)tree.size()) return;
    QuadNode &node = tree[nodeIdx];
    if (node.total_mass == 0) return;

    Particle &p = particles[pIdx];
    float dx = node.cm_x - p.x;
    float dy = node.cm_y - p.y;
    
    // Use pure geometric distance for the approximation test, but apply softening for actual gravity
    float geomDist = std::sqrt(dx * dx + dy * dy);

    bool isLeaf = (node.first_child_idx == -1);
    bool isSelf = (node.particle_idx == pIdx);

    if (!isSelf && (isLeaf || (node.bw / geomDist) < THETA))
    {
        float softDistSq = (dx * dx + dy * dy) + (EPSILON * EPSILON);
        float softDist = std::sqrt(softDistSq);
        
        float force = (G * p.mass * node.total_mass) / softDistSq;
        fx += force * (dx / softDist);
        fy += force * (dy / softDist);
        return;
    }

    if (!isLeaf)
    {
        for (int i = 0; i < 4; i++)
        {
            computeForce(pIdx, node.first_child_idx + i, fx, fy);
        }
    }
}

EXTERN void initializeEngine(int N)
{
    particles.clear();
    tree.clear();
    saved_fx.assign(N, 0.0f);
    saved_fy.assign(N, 0.0f);
    particles.reserve(N); // Pre allocate memory to prevent expensive vector resizing during the simulation
    tree.reserve(N * 4);
}

// Conserves orbital energy over time much better than standard explicit Euler
EXTERN void update(float dt)
{
    int n = particles.size();

    // Pass 1: Half-kick using forces cached at the end of the last frame
    for (int i = 0; i < n; i++)
    {
        particles[i].vx += (saved_fx[i] / particles[i].mass) * (dt * 0.5f);
        particles[i].vy += (saved_fy[i] / particles[i].mass) * (dt * 0.5f);
    }

    // Pass 2: Update positions and enforce boundaries
    for (auto &p : particles)
    {
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // Elastic collisions with the map edges
        if (std::abs(p.x) > WORLD)
        {
            p.x = std::copysign(WORLD, p.x);
            p.vx *= -0.8f; // Reverse direction but lose 20% speed to dampen runaway systems
        }
        if (std::abs(p.y) > WORLD)
        {
            p.y = std::copysign(WORLD, p.y);
            p.vy *= -0.8f;
        }
    }

    // Pass 3: Rebuild tree once with updated positions
    buildTree();
    computeCOM(0);

    // Pass 4: Second half-kick and cache forces for next frame
    for (int i = 0; i < n; i++)
    {
        float fx = 0.0f, fy = 0.0f;
        computeForce(i, 0, fx, fy);
        
        saved_fx[i] = fx;
        saved_fy[i] = fy;
        
        particles[i].vx += (fx / particles[i].mass) * (dt * 0.5f);
        particles[i].vy += (fy / particles[i].mass) * (dt * 0.5f);
    }
}

// Zero-copy memory bridge: Hands the raw C++ memory address directly to JavaScript
EXTERN float *getParticleBuffer()
{
    return reinterpret_cast<float *>(particles.data());
}

EXTERN int getParticleCount()
{
    return particles.size();
}

EXTERN void addParticle(float x, float y, float vx, float vy, float mass)
{
    particles.push_back({x, y, vx, vy, mass});
    saved_fx.push_back(0.0f); // Keep parallel arrays in sync to prevent WASM out-of-bounds crashes
    saved_fy.push_back(0.0f);
}

EXTERN void setTheta(float t)
{
    THETA = t;
}

EXTERN void initUniformDust()
{
    initializeEngine(2000);

    // Fixed seed (42) ensures the initial dust cloud looks exactly the same every time you refresh
    std::mt19937 rng(42);
    std::uniform_real_distribution<float> pos(-350.0f, 350.0f);
    std::uniform_real_distribution<float> mass(5.0f, 25.0f);
    std::uniform_real_distribution<float> vel(-8.0f, 8.0f);

    for (int i = 0; i < 2000; i++)
    {
        particles.push_back({pos(rng), pos(rng),
                             vel(rng), vel(rng),
                             mass(rng)});
    }
}