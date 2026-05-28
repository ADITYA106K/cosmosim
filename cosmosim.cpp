#include <vector>
#include <cmath>
#include <random>

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

const float G = 6.674e-2f;
const float EPSILON = 5.0f;  // Softening parameter: Prevents gravity from shooting to infinity if two particles overlap
const float WORLD = 1000.0f; // Simulation boundary limits

EXTERN void initializeEngine(int N)
{
    particles.clear();
    tree.clear();
    particles.reserve(N); // Pre allocate memory to prevent expensive vector resizing during the simulation
}

// Conserves orbital energy over time much better than standard explicit Euler
EXTERN void update(float dt)
{
    int n = particles.size();

    // Pass 1: Calculate forces
    for (int i = 0; i < n; i++)
    {
        float fx = 0.0f, fy = 0.0f;
        Particle &p = particles[i];

        // Naive O(N^2) brute force
        for (int j = 0; j < n; j++)
        {
            if (i == j)
                continue;

            float dx = particles[j].x - p.x;
            float dy = particles[j].y - p.y;
            float distSq = dx * dx + dy * dy + EPSILON * EPSILON;
            float dist = std::sqrt(distSq);
            float force = (G * p.mass * particles[j].mass) / distSq;

            fx += force * (dx / dist);
            fy += force * (dy / dist);
        }

        // Update velocity based on accumulated force
        p.vx += (fx / p.mass) * dt;
        p.vy += (fy / p.mass) * dt;
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
}

EXTERN void initUniformDust()
{
    initializeEngine(300);

    // Fixed seed (42) ensures the initial dust cloud looks exactly the same every time you refresh
    std::mt19937 rng(42);
    std::uniform_real_distribution<float> pos(-350.0f, 350.0f);
    std::uniform_real_distribution<float> mass(5.0f, 25.0f);
    std::uniform_real_distribution<float> vel(-8.0f, 8.0f);

    for (int i = 0; i < 300; i++)
    {
        particles.push_back({pos(rng), pos(rng),
                             vel(rng), vel(rng),
                             mass(rng)});
    }
}