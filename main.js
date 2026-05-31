const canvas = document.getElementById('canvas');
// WebGL context to draw everything in one go instead of 2000 loop iterations
const gl = canvas.getContext('webgl');
if (!gl) alert('WebGL not supported — please use Chrome or Firefox');

const stats = document.getElementById('stats');

// ENERGY GRAPH SETUP
const eCanvas = document.getElementById('energyCanvas');
const ctx = eCanvas.getContext('2d');
ctx.font = "11px monospace";
let energyHistory = []; 
const MAX_HISTORY = 900; // Store exactly enough data points to fill the 900px wide canvas

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
  
  // --- SURGICAL INSERTION: FETCH DIAGNOSTICS FROM C++ ---
  const ke = Module._getKineticEnergy();
  const pe = Module._getPotentialEnergy();
  const te = Module._getTotalEnergy();
  
  // Push to history array and shift if it gets too long
  energyHistory.push({ke, pe, te});
  if (energyHistory.length > MAX_HISTORY) energyHistory.shift();
  // ------------------------------------------------------

  const physTime = (performance.now() - t0).toFixed(2);

  const count = Module._getParticleCount();
  const t1 = performance.now();
  render(count);
  drawEnergyGraph(); // <-- SURGICAL INSERTION: Draw the graph every frame
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
  const ptr = Module._getParticleBuffer();
  const heapView = new Float32Array(HEAPF32.buffer, ptr, count * 5);

  gl.bufferData(gl.ARRAY_BUFFER, heapView, gl.DYNAMIC_DRAW);

  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 20, 0);
  gl.vertexAttribPointer(massLoc, 1, gl.FLOAT, false, 20, 16);
  gl.enableVertexAttribArray(posLoc);
  gl.enableVertexAttribArray(massLoc);

  gl.drawArrays(gl.POINTS, 0, count);
}

// --- SURGICAL INSERTION: THE MATH RENDERER ---
function drawEnergyGraph() {
  ctx.clearRect(0, 0, eCanvas.width, eCanvas.height);
  if (energyHistory.length === 0) return;

  // 1. Find min/max boundaries to dynamically auto-scale the graph's Y-axis
  let maxE = -Infinity, minE = Infinity;
  for (let d of energyHistory) {
      if (d.ke > maxE) maxE = d.ke;
      if (d.pe < minE) minE = d.pe;
  }
  
  let range = maxE - minE;
  if (range === 0) range = 1;
  let scale = eCanvas.height / (range * 1.2);
  let baseline = maxE + range * 0.1; // Push the graph down slightly

  function getY(val) { return (baseline - val) * scale; }

  // 2. Draw 0-Axis Baseline (Ghostly white line)
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.beginPath(); ctx.moveTo(0, getY(0)); ctx.lineTo(eCanvas.width, getY(0)); ctx.stroke();

  // 3. Draw Potential Energy (Deep Cyan)
  ctx.strokeStyle = "#0A7E8C"; 
  ctx.beginPath();
  for(let i=0; i<energyHistory.length; i++) {
      if(i===0) ctx.moveTo(i, getY(energyHistory[i].pe));
      else ctx.lineTo(i, getY(energyHistory[i].pe));
  }
  ctx.stroke();

  // 4. Draw Kinetic Energy (Gold)
  ctx.strokeStyle = "#DDAA00"; 
  ctx.beginPath();
  for(let i=0; i<energyHistory.length; i++) {
      if(i===0) ctx.moveTo(i, getY(energyHistory[i].ke));
      else ctx.lineTo(i, getY(energyHistory[i].ke));
  }
  ctx.stroke();

  // 5. Draw Total Energy (Thick White Line)
  ctx.strokeStyle = "#FFFFFF"; 
  ctx.lineWidth = 2;
  ctx.beginPath();
  for(let i=0; i<energyHistory.length; i++) {
      if(i===0) ctx.moveTo(i, getY(energyHistory[i].te));
      else ctx.lineTo(i, getY(energyHistory[i].te));
  }
  ctx.stroke();
  ctx.lineWidth = 1;

  // 6. Print live metric numbers
  let last = energyHistory[energyHistory.length-1];
  ctx.fillStyle = "#DDAA00"; ctx.fillText("Kinetic:   " + Math.round(last.ke), 10, 16);
  ctx.fillStyle = "#0A7E8C"; ctx.fillText("Potential: " + Math.round(last.pe), 10, 32);
  ctx.fillStyle = "#FFFFFF"; ctx.fillText("TOTAL (E): " + Math.round(last.te), 10, 48);
}
// ----------------------------------------------

// Click canvas to spawn a massive particle at cursor position
canvas.addEventListener('click', function(e) {
  if (!initialized) return;
  const rect = canvas.getBoundingClientRect();
  const scale = 1.0; 
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  
  const wx = (e.clientX - rect.left - cx) / scale;
  const wy = (e.clientY - rect.top - cy) / scale;
  
  Module._addParticle(wx, wy, 0.0, 0.0, 500.0);
});