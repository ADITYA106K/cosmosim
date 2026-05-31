const canvas = document.getElementById('canvas');
// WebGL context to draw everything in one go instead of 2000 loop iterations
const gl = canvas.getContext('webgl');
if (!gl) alert('WebGL not supported — please use Chrome or Firefox');

const stats = document.getElementById('stats');

let frameCount = 0;
let fps = 0;
let fpsTimer = 0;
let lastTime = performance.now();
let initialized = false;

// Vertex shader: sets particle positions and sizes them by mass
const vertSrc = `
  attribute vec2 a_position;
  attribute float a_mass;
  uniform vec2 u_resolution;
  varying float v_mass;

  void main() {
    // MINIMAL FIX: Removed "* 2.0 - 1.0" so the C++ (0,0) origin stays perfectly centered
    vec2 clip = a_position / u_resolution;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    // Logarithmic scaling prevents supermassive particles from engulfing the screen
    gl_PointSize = clamp(log(a_mass + 1.0) * 1.8, 2.0, 14.0);
    v_mass = a_mass;
  }
`;

// Fragment shader: procedural glow effect (no images needed)
const fragSrc = `
  precision mediump float;
  varying float v_mass;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float brightness = 1.0 - dist * 2.0;
    float blue = 0.6 + clamp(log(v_mass + 1.0) / 25.0, 0.0, 0.4);
    gl_FragColor = vec4(brightness * 0.4, brightness * 0.7, brightness * blue, brightness);
  }
`;

// Compile and wire up shaders
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertSrc));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
gl.linkProgram(prog);
gl.useProgram(prog);

const posLoc = gl.getAttribLocation(prog, 'a_position');
const massLoc = gl.getAttribLocation(prog, 'a_mass');
const resLoc = gl.getUniformLocation(prog, 'u_resolution');

const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.uniform2f(resLoc, canvas.width / 2, canvas.height / 2);

// Additive blending so dense clusters glow bright
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

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
  const t1 = performance.now();
  render(count);
  const renderTime = (performance.now() - t1).toFixed(2);

  // Live dashboard update
  const totalTime = (parseFloat(physTime) + parseFloat(renderTime)).toFixed(2);
  document.getElementById('d-particles').textContent = count;
  document.getElementById('d-fps').textContent = fps;
  document.getElementById('d-physics').textContent = physTime;
  document.getElementById('d-render').textContent = renderTime;
  document.getElementById('d-total').textContent = totalTime;

  stats.textContent = `Particles: ${count}  |  FPS: ${fps}  |  Physics: ${physTime}ms  |  Render: ${renderTime}ms`;

  requestAnimationFrame(gameLoop);
}

function render(count) {
  gl.clearColor(0.02, 0.04, 0.07, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  if (count === 0) return;

  // ZERO-COPY MEMORY BRIDGE
  // Fetching a fresh pointer every frame protects against C++ vector reallocations
  const ptr = Module._getParticleBuffer();

  // C++ Particle struct is exactly 5 floats wide: [x, y, vx, vy, mass]
  // CRITICAL FIX: Removed "Module." because HEAPF32 is in the global scope
  const heapView = new Float32Array(HEAPF32.buffer, ptr, count * 5);

  // Blast the entire array to the GPU in a single call
  gl.bufferData(gl.ARRAY_BUFFER, heapView, gl.DYNAMIC_DRAW);

  // Tell WebGL how to read our 20-byte struct (offset 0 for pos, offset 16 for mass)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 20, 0);
  gl.vertexAttribPointer(massLoc, 1, gl.FLOAT, false, 20, 16);
  gl.enableVertexAttribArray(posLoc);
  gl.enableVertexAttribArray(massLoc);

  // Draw everything instantly
  gl.drawArrays(gl.POINTS, 0, count);
}

// Click canvas to spawn a massive particle at cursor position
canvas.addEventListener('click', function(e) {
  if (!initialized) return;
  const rect = canvas.getBoundingClientRect();
  const scale = 1.0; // WebGL uses raw coords, removed the 0.8 scale offset
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  
  // Convert screen coords back to world coords
  const wx = (e.clientX - rect.left - cx) / scale;
  const wy = (e.clientY - rect.top - cy) / scale;
  
  Module._addParticle(wx, wy, 0.0, 0.0, 500.0);
});