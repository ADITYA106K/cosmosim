const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const stats = document.getElementById('stats');

let frameCount = 0;
let fps = 0;
let fpsTimer = 0;
let lastTime = performance.now();
let initialized = false;

// The Emscripten Module object acting as the JS/C++ bridge
var Module = {
  // Fires when the cosmosim.wasm binary is fully loaded
  onRuntimeInitialized: function () {
    console.log('WASM loaded successfully');
    Module._initUniformDust();
    initialized = true;
    requestAnimationFrame(gameLoop);
  }
};

function gameLoop(timestamp) {
  if (!initialized) return;

  // Calculate dt in seconds to decouple physics speed from monitor refresh rates 
  const now = performance.now();
  let dt = (now - lastTime) / 1000.0;
  lastTime = now;

  // Cap dt to prevent physics explosions if the browser tab is backgrounded
  if (dt > 0.1) dt = 0.016;

  frameCount++;
  fpsTimer += dt;
  if (fpsTimer >= 1.0) {
    fps = frameCount;
    frameCount = 0;
    fpsTimer = 0;
  }

  const t0 = performance.now();
  Module._update(dt);
  const physTime = (performance.now() - t0).toFixed(2);

  const count = Module._getParticleCount();
  render(count);

  stats.textContent =
    `Particles: ${count}  |  FPS: ${fps}  |  Physics: ${physTime}ms  |  WASM bridge active`;

  requestAnimationFrame(gameLoop);
}

function render(count) {
  ctx.fillStyle = 'rgba(5, 10, 18, 0.3)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ZERO-COPY MEMORY BRIDGE
  // Fetching a fresh pointer every frame protects against C++ vector reallocations
  const ptr = Module._getParticleBuffer();

  // C++ Particle struct is exactly 5 floats wide: [x, y, vx, vy, mass]
  const heapView = new Float32Array(HEAPF32.buffer, ptr, count * 5);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const scale = 0.8;

  for (let i = 0; i < count; i++) {
    const x = heapView[i * 5 + 0];
    const y = heapView[i * 5 + 1];
    const mass = heapView[i * 5 + 4];

    const sx = cx + x * scale;
    const sy = cy + y * scale;

    // Logarithmic scaling prevents supermassive particles from engulfing the screen
    const r = Math.min(Math.log(mass + 1) * 0.8, 4);

    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(100, 180, 255, ${Math.min(mass / 25, 1)})`;
    ctx.fill();
  }
}