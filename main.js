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

// --- NEW CAMERA STATE ---
let cameraX = 0, cameraY = 0;
let zoom = 1.0;
let isDragging = false;
let lastMouseX = 0, lastMouseY = 0;
let hasDragged = false;

// ─── ASTROPHYSICS VERTEX SHADER ─────────────────────────────
const vertSrc = `
  attribute vec2 a_position;
  attribute float a_mass;
  uniform vec2 u_resolution;
  uniform vec2 u_offset;
  uniform float u_zoom;
  varying float v_mass;

  void main() {
    // 1. Camera Math
    vec2 clip = (a_position - u_offset) / (u_resolution / u_zoom);
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    
    // 2. Physical Scaling: Multiply the base size by the camera zoom
    // CRANKED UP from 5.0 to 12.0 for much bolder, heavier stars
    float baseRadius = log(a_mass + 1.0) * 12.0; 
    float screenRadius = baseRadius * u_zoom;
    
    // INCREASED MINIMUM to 6.0 so even tiny dust particles are clearly visible
    // INCREASED MAXIMUM to 400.0 so giant cores look truly cinematic when zoomed in
    gl_PointSize = clamp(screenRadius, 6.0, 400.0);
    v_mass = a_mass;
  }
`;

// ─── ASTROPHYSICS FRAGMENT SHADER ───────────────────────────
const fragSrc = `
  precision mediump float;
  varying float v_mass;

  // Ultra-fast pseudo-random noise generator for solar surface texture
  float random(vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    float r = length(coord) * 2.0; 
    if (r > 1.0) discard;

    // 1. Base Stellar Colors
    vec3 color;
    if (v_mass < 20.0) {
        color = vec3(1.0, 0.35, 0.1);     // Red Dwarf
    } else if (v_mass < 500.0) {
        color = vec3(1.0, 0.8, 0.3);      // Yellow/Orange Sun
    } else {
        color = vec3(0.5, 0.8, 1.0);      // Blue Giant
    }

    // 2. Limb Darkening & 3D Sphere Illusion (r < 0.15 is the physical body)
    float coreRadius = 0.15;
    float isCore = 1.0 - smoothstep(coreRadius - 0.02, coreRadius + 0.02, r);
    
    // Calculate spherical depth (1.0 at center, 0.0 at edge) for a 3D look
    float z = sqrt(max(0.0, 1.0 - (r / coreRadius) * (r / coreRadius)));
    
    // Add solar granulation (texture) using the noise function
    float surfaceNoise = random(gl_PointCoord * 15.0) * 0.15;
    vec3 surfaceColor = color * (z - surfaceNoise) * 1.5;

    // 3. Diffraction Spikes (Lens Flare for bright stars)
    // Creates the '+' shape seen in telescopic photography
    float flareX = max(0.0, 1.0 - abs(coord.y) * 50.0) * exp(-abs(coord.x) * 3.0);
    float flareY = max(0.0, 1.0 - abs(coord.x) * 50.0) * exp(-abs(coord.y) * 3.0);
    
    // Only massive stars get strong flares (scales up to 1.0)
    float flareIntensity = clamp(v_mass / 500.0, 0.0, 1.0); 
    float flares = (flareX + flareY) * flareIntensity;

    // 4. Atmospheric Corona
    float corona = exp(-r * 4.5) * 0.8;

    // 5. Final Composition
    // Mix the deep space corona/flares with the solid 3D textured surface
    vec3 finalColor = mix(color * (corona + flares), surfaceColor, isCore);
    
    // Add a blinding white hotspot directly in the center
    finalColor += vec3(exp(-r * 25.0));

    // Output the final combined light elements
    gl_FragColor = vec4(finalColor, isCore + corona + flares);
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
const offsetLoc = gl.getUniformLocation(prog, 'u_offset'); 
const zoomLoc = gl.getUniformLocation(prog, 'u_zoom');     

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
  
  // --- FETCH DIAGNOSTICS FROM C++ ---
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
  drawEnergyGraph(); // Draw the graph every frame
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

  // Pass current camera state to the GPU
  gl.uniform2f(offsetLoc, cameraX, cameraY);
  gl.uniform1f(zoomLoc, zoom);

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

// --- THE MATH RENDERER ---
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

  // Define colors
  const peColor = "#FF5252"; // NEW: Bright Coral Red (distinct from UI borders)
  const keColor = "#DDAA00"; // Gold
  const teColor = "#FFFFFF"; // White

  // 2. Draw 0-Axis Baseline (Ghostly white line)
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, getY(0)); ctx.lineTo(eCanvas.width, getY(0)); ctx.stroke();

  // SET GLOBAL LINE WIDTH FOR ENERGY CURVES (Thicker!)
  ctx.lineWidth = 2.0;

  // 3. Draw Potential Energy
  ctx.strokeStyle = peColor; 
  ctx.beginPath();
  for(let i=0; i<energyHistory.length; i++) {
      if(i===0) ctx.moveTo(i, getY(energyHistory[i].pe));
      else ctx.lineTo(i, getY(energyHistory[i].pe));
  }
  ctx.stroke();

  // 4. Draw Kinetic Energy
  ctx.strokeStyle = keColor; 
  ctx.beginPath();
  for(let i=0; i<energyHistory.length; i++) {
      if(i===0) ctx.moveTo(i, getY(energyHistory[i].ke));
      else ctx.lineTo(i, getY(energyHistory[i].ke));
  }
  ctx.stroke();

  // 5. Draw Total Energy (Slightly thicker than the other two)
  ctx.strokeStyle = teColor; 
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for(let i=0; i<energyHistory.length; i++) {
      if(i===0) ctx.moveTo(i, getY(energyHistory[i].te));
      else ctx.lineTo(i, getY(energyHistory[i].te));
  }
  ctx.stroke();
  
  // Reset line width
  ctx.lineWidth = 1;

  // 6. FIX TEXT CUTOFF: Draw a dark mask box behind the text
  ctx.fillStyle = "rgba(5, 10, 18, 0.85)"; // Matches your app's background color
  ctx.fillRect(5, 4, 150, 52); 

  // 7. Print live metric numbers
  let last = energyHistory[energyHistory.length-1];
  ctx.fillStyle = keColor; ctx.fillText("Kinetic:   " + Math.round(last.ke), 10, 16);
  ctx.fillStyle = peColor; ctx.fillText("Potential: " + Math.round(last.pe), 10, 32);
  ctx.fillStyle = teColor; ctx.fillText("TOTAL (E): " + Math.round(last.te), 10, 48);
}
// ----------------------------------------------

// ─── CAMERA CONTROLS ──────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  isDragging = true;
  hasDragged = false;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  hasDragged = true;
  
  // Calculate how far the mouse moved, adjusted for zoom
  const dx = (e.clientX - lastMouseX) / zoom;
  const dy = (e.clientY - lastMouseY) / zoom;
  
  // Pan the camera inversely to the mouse movement
  cameraX -= dx;
  cameraY -= dy;
  
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});

canvas.addEventListener('mouseup', (e) => {
  isDragging = false;
  
  // If they just clicked without dragging, spawn a particle!
  if (!hasDragged && initialized) {
    const rect = canvas.getBoundingClientRect();
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    
    // Reverse-engineer the screen coordinates back into C++ world coordinates, factoring in zoom and pan
    const wx = ((e.clientX - rect.left - cx) / zoom) + cameraX;
    const wy = ((e.clientY - rect.top - cy) / zoom) + cameraY;
    
    Module._addParticle(wx, wy, 0.0, 0.0, 500.0);
  }
});

// Zoom in and out with the mouse wheel
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.deltaY < 0) {
    zoom *= 1.1; // Zoom in
  } else {
    zoom *= 0.9; // Zoom out
  }
  // Prevent zooming out so far the math breaks
  if (zoom < 0.1) zoom = 0.1; 
});