import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { applyPaletteToTrail, getParticleColor, getTrailPalette } from '../src/trailPalettes.js';
import {
  createLandingTrail,
  createTrailEngine,
  getBreathFrameFromAnalyser,
} from '../src/trailCore.js';

const CAMERA_FOV = 59;
const CAMERA_DISTANCE = 20;
const LANDING_MS = 5200;
const LANDING_TAIL_MS = 1800;

const MIC_SETTINGS = {
  inputGain: 4.0,
  breathSensitivity: 18.0,
  lowSensitivity: 4.0,
  midSensitivity: 4.5,
  highSensitivity: 7.0,
};

function addCluster(out, nx, ny, count, spread) {
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const radius = ((i * 0.618) % 1) * spread;
    out.push({
      nx: nx + Math.cos(angle) * radius,
      ny: ny + Math.sin(angle) * radius,
      seed: out.length + i * 17,
    });
  }
}

function buildDecorLayout() {
  const points = [];

  addCluster(points, 0.84, 0.1, 28, 0.06);
  addCluster(points, 0.76, 0.16, 18, 0.04);
  addCluster(points, 0.92, 0.36, 24, 0.05);
  addCluster(points, 0.86, 0.46, 16, 0.035);

  for (let i = 0; i <= 72; i += 1) {
    const t = i / 72;
    const nx = THREE.MathUtils.lerp(0.04, 0.58, t) + Math.sin(t * Math.PI * 5.5) * 0.028;
    const ny = THREE.MathUtils.lerp(0.96, 0.64, t) + Math.cos(t * Math.PI * 4.2) * 0.022;
    addCluster(points, nx, ny, 2, 0.012);
  }

  addCluster(points, 0.12, 0.88, 14, 0.04);
  addCluster(points, 0.28, 0.78, 12, 0.03);

  return points;
}

function screenToWorld(nx, ny, aspect) {
  const height = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) * CAMERA_DISTANCE;
  const width = height * aspect;
  const x = (nx - 0.5) * 2 * width * 0.94;
  const y = (0.5 - ny) * 2 * height * 0.94;
  return new THREE.Vector3(x, y, 0);
}

export function createMicTrailRenderer(container) {
  let renderer = null;
  let scene = null;
  let worldGroup = null;
  let landingGroup = null;
  let camera = null;
  let clock = null;
  let rafId = 0;
  let loopRunning = false;
  let mode = 'idle';

  let landingEngine = null;
  let landingTrail = null;
  let landingStartedAt = 0;

  let staticPoints = null;
  let staticMaterial = null;
  let staticBaseSizes = null;
  let staticBaseColors = null;
  let decorLayout = buildDecorLayout();
  let positionIndex = 0;
  let brightness = 1;
  let liveAnalyser = null;
  let liveFrequencyData = null;
  let liveWaveformData = null;

  function rebuildStaticPoints() {
    if (!worldGroup) return;

    if (staticPoints) {
      worldGroup.remove(staticPoints);
      staticPoints.geometry.dispose();
      staticMaterial.dispose();
    }

    const aspect = window.innerWidth / window.innerHeight;
    const palette = getTrailPalette(positionIndex);
    const positions = [];
    const colors = [];
    const sizes = [];

    decorLayout.forEach((point) => {
      const world = screenToWorld(
        THREE.MathUtils.clamp(point.nx, 0.02, 0.98),
        THREE.MathUtils.clamp(point.ny, 0.02, 0.98),
        aspect
      );
      const color = getParticleColor(palette, point.seed);
      const size = 0.11 + (point.seed % 1) * 0.08;

      positions.push(world.x, world.y, world.z);
      colors.push(color.x * 1.35, color.y * 1.35, color.z * 1.35);
      sizes.push(size);
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));

    staticMaterial = new THREE.PointsMaterial({
      size: 0.18,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    staticPoints = new THREE.Points(geometry, staticMaterial);
    staticPoints.frustumCulled = false;
    staticBaseSizes = sizes.slice();
    staticBaseColors = colors.slice();
    worldGroup.add(staticPoints);
  }

  function applyStaticBrightness(level) {
    if (!staticMaterial || !staticPoints) return;

    brightness = THREE.MathUtils.clamp(level, 0.35, 1.45);
    staticMaterial.opacity = 0.55 + brightness * 0.45;
    staticMaterial.size = 0.14 + brightness * 0.08;

    const colorAttr = staticPoints.geometry.getAttribute('color');
    for (let i = 0; i < staticBaseColors.length; i += 3) {
      colorAttr.array[i] = staticBaseColors[i] * brightness;
      colorAttr.array[i + 1] = staticBaseColors[i + 1] * brightness;
      colorAttr.array[i + 2] = staticBaseColors[i + 2] * brightness;
    }
    colorAttr.needsUpdate = true;
  }

  function renderFrame() {
    renderer.render(scene, camera);
  }

  function frameUpdate(delta) {
    if (mode === 'landing') {
      const elapsed = performance.now() - landingStartedAt;

      if (elapsed < LANDING_MS) {
        landingEngine.tickTrail(landingTrail, delta, { spawn: true, audioStarted: true });
      } else {
        landingEngine.fadeSlot(landingTrail.particleStart, 1.05);
        renderer.compute(landingEngine.updateParticles);
      }

      renderFrame();
      return;
    }

    if (mode === 'recording' && liveAnalyser) {
      const frame = getBreathFrameFromAnalyser(
        liveAnalyser,
        liveFrequencyData,
        liveWaveformData,
        MIC_SETTINGS
      );
      applyStaticBrightness(0.55 + frame.level * 0.9);
    }

    renderFrame();
  }

  function startLoop() {
    if (loopRunning) return;
    loopRunning = true;
    clock.start();

    const loop = () => {
      if (!loopRunning) return;
      frameUpdate(clock.getDelta());
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    loopRunning = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  async function init() {
    if (!container || WebGPU.isAvailable() === false) {
      return false;
    }

    scene = new THREE.Scene();
    worldGroup = new THREE.Group();
    landingGroup = new THREE.Group();
    scene.add(worldGroup);
    scene.add(landingGroup);

    camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      200
    );
    camera.position.set(0, 0, CAMERA_DISTANCE);

    renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false });
    renderer.setClearColor(0x000000);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    await renderer.init();
    clock = new THREE.Clock();
    rebuildStaticPoints();
    staticPoints.visible = false;

    window.addEventListener('resize', onResize);
    return true;
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    if (mode !== 'landing') {
      rebuildStaticPoints();
      applyStaticBrightness(brightness);
    }
  }

  async function runLanding() {
    landingEngine = await createTrailEngine(renderer, landingGroup, 1);
    landingTrail = createLandingTrail();
    applyPaletteToTrail(landingTrail, 0);
    landingEngine.applyTrailToGPU(landingTrail);

    staticPoints.visible = false;
    mode = 'landing';
    landingStartedAt = performance.now();
    startLoop();

    await new Promise((resolve) => {
      const wait = () => {
        const elapsed = performance.now() - landingStartedAt;
        if (elapsed >= LANDING_MS + LANDING_TAIL_MS) {
          stopLoop();
          landingEngine.clearSlot(0);
          landingGroup.clear();
          landingEngine = null;
          landingTrail = null;
          resolve();
          return;
        }
        requestAnimationFrame(wait);
      };
      wait();
    });
  }

  function showStaticDecor(nextPositionIndex) {
    positionIndex = nextPositionIndex;
    mode = 'static';
    rebuildStaticPoints();
    staticPoints.visible = true;
    applyStaticBrightness(1);
    startLoop();
  }

  function setPalette(nextPositionIndex) {
    positionIndex = nextPositionIndex;
    rebuildStaticPoints();
    applyStaticBrightness(brightness);
  }

  function startRecording(analyser, frequencyData, waveformData) {
    liveAnalyser = analyser;
    liveFrequencyData = frequencyData;
    liveWaveformData = waveformData;
    mode = 'recording';
    staticPoints.visible = true;
    if (!loopRunning) startLoop();
  }

  function stopRecordingVisual() {
    liveAnalyser = null;
    mode = 'static';
    applyStaticBrightness(1);
  }

  function dispose() {
    stopLoop();
    window.removeEventListener('resize', onResize);
    renderer?.dispose();
    container.innerHTML = '';
  }

  return {
    init,
    runLanding,
    showStaticDecor,
    setPalette,
    startRecording,
    stopRecordingVisual,
    dispose,
  };
}
