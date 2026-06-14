import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { applyPaletteToTrail } from '../src/trailPalettes.js';
import {
  buildSplashLoopFrames,
  createLandingTrail,
  createTrail,
  createTrailEngine,
  getBreathFrameFromAnalyser,
} from '../src/trailCore.js';

const CAMERA_FOV = 59;
const CAMERA_DISTANCE = 20;
const AUTO_ROTATE_SPEED = 2;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LANDING_MS = 5200;
const LANDING_TAIL_MS = 1800;

const MIC_SETTINGS = {
  inputGain: 4.0,
  breathSensitivity: 18.0,
  lowSensitivity: 4.0,
  midSensitivity: 4.5,
  highSensitivity: 7.0,
};

const MIC_RIBBONS = [
  {
    // basso: angolo destro → centro → giù → risale → esce a sinistra
    p0: { nx: 1.1, ny: 0.93 },
    p1: { nx: 0.72, ny: 0.58 },
    p2: { nx: 0.48, ny: 1.02 },
    p3: { nx: 0.28, ny: 0.78 },
    steps: 55,
    breathOffset: 0.8,
  },
  {
    p0: { nx: 0.28, ny: 0.78 },
    p1: { nx: 0.14, ny: 0.96 },
    p2: { nx: 0.02, ny: 0.62 },
    p3: { nx: -0.18, ny: 0.52 },
    steps: 55,
    breathOffset: 1.0,
  },
  {
    // angolo basso-sinistra → sale verso centro-basso
    p0: { nx: -0.1, ny: 1.06 },
    p1: { nx: 0.04, ny: 0.82 },
    p2: { nx: 0.2, ny: 0.66 },
    p3: { nx: 0.4, ny: 0.58 },
    steps: 75,
    breathOffset: 1.2,
  },
  {
    // alto-destra: entra nello schermo, curva, esce a destra
    p0: { nx: 0.82, ny: -0.02 },
    p1: { nx: 0.62, ny: 0.14 },
    p2: { nx: 0.78, ny: 0.34 },
    p3: { nx: 1.12, ny: 0.28 },
    steps: 70,
    breathOffset: 1.5,
  },
];

function cubicBezierNorm(t, p0, p1, p2, p3) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    nx: uuu * p0.nx + 3 * uu * t * p1.nx + 3 * u * tt * p2.nx + ttt * p3.nx,
    ny: uuu * p0.ny + 3 * uu * t * p1.ny + 3 * u * tt * p2.ny + ttt * p3.ny,
  };
}

function spawnRibbonAlongBezier(trail, ribbon, camera, engine) {
  const { p0, p1, p2, p3, steps, breathOffset } = ribbon;
  const anchor = trail.position.clone();

  for (let i = 0; i < steps; i += 1) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const a = cubicBezierNorm(t0, p0, p1, p2, p3);
    const b = cubicBezierNorm(t1, p0, p1, p2, p3);
    const prev = screenNormToWorld(a.nx, a.ny, camera);
    const curr = screenNormToWorld(b.nx, b.ny, camera);

    trail.loopElapsed = breathOffset + t1 * 1.6;
    engine.updateAudioDrivenPosition(trail, 0, true);
    trail.position.copy(anchor);

    trail.previousSpawnPosition.copy(prev);
    trail.spawnPosition.copy(curr);
    trail.audioDrivenPosition.copy(curr);
    engine.applyTrailToGPU(trail);
    engine.tickTrail(trail, 0.016, { spawn: true, audioStarted: false });
  }
}

function screenNormToWorld(nx, ny, camera) {
  const ndc = new THREE.Vector3(nx * 2 - 1, -(ny * 2 - 1), 0.5);
  ndc.unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const depth = -camera.position.z / dir.z;
  return camera.position.clone().add(dir.multiplyScalar(depth));
}

export function createMicTrailRenderer(container) {
  let renderer = null;
  let engine = null;
  let trail = null;
  let scene = null;
  let worldGroup = null;
  let camera = null;
  let clock = null;
  let rafId = 0;
  let worldSpinAngle = 0;
  let mode = 'idle';
  let paletteIndex = 0;
  let targetPaletteIndex = 0;
  let paletteMix = 1;
  let liveAnalyser = null;
  let liveFrequencyData = null;
  let liveWaveformData = null;
  let landingStartedAt = 0;
  let loopRunning = false;
  let staticReady = false;
  let baseBrightness = 1.35;
  let smoothedLevel = 0;
  let homeFade = 0;
  let homeFadeTarget = 1;
  let homeFadeStart = 0;
  let homeFadeDuration = 900;

  function setPalette(index) {
    paletteIndex = index;
    targetPaletteIndex = index;
    paletteMix = 1;
    applyPaletteToTrail(trail, index);
    engine?.applyTrailToGPU(trail);
  }

  function currentHomeFade() {
    if (homeFadeDuration <= 0) return homeFadeTarget;
    const t = THREE.MathUtils.clamp((performance.now() - homeFadeStart) / homeFadeDuration, 0, 1);
    return THREE.MathUtils.lerp(homeFade, homeFadeTarget, t);
  }

  function renderStaticFrame(delta, { pulse = false } = {}) {
    const fade = mode === 'home' || mode === 'uploading' || mode === 'sent' ? currentHomeFade() : 1;

    if (pulse && liveAnalyser) {
      const frame = getBreathFrameFromAnalyser(
        liveAnalyser,
        liveFrequencyData,
        liveWaveformData,
        MIC_SETTINGS
      );
      const inputLevel = THREE.MathUtils.clamp(
        frame.level * 0.55 + frame.lowBand * 0.25 + frame.midBand * 0.12 + frame.highBand * 0.08,
        0,
        1
      );
      smoothedLevel = THREE.MathUtils.lerp(smoothedLevel, inputLevel, 0.32);
      const brightness = baseBrightness * (0.45 + smoothedLevel * 2.6);
      engine.uniforms.colorBrightness.value = brightness * fade;
    } else {
      engine.uniforms.colorBrightness.value = THREE.MathUtils.lerp(
        engine.uniforms.colorBrightness.value,
        baseBrightness * fade,
        0.08
      );
    }

    renderer.compute(engine.updateParticles);
    renderer.render(scene, camera);
  }

  function tickLandingFrame(delta, { spawn = true, fade = false } = {}) {
    worldSpinAngle += (Math.PI * 2 / 60) * AUTO_ROTATE_SPEED * delta;
    worldGroup.quaternion.setFromAxisAngle(WORLD_UP, -worldSpinAngle);

    if (fade) {
      renderer.compute(engine.updateParticles);
      engine.fadeSlot(trail.particleStart, 1.05);
    } else if (spawn) {
      engine.tickTrail(trail, delta, { spawn: true, audioStarted: true });
    } else {
      renderer.compute(engine.updateParticles);
    }

    renderer.render(scene, camera);
  }

  function frameUpdate(delta) {
    if (mode === 'landing') {
      const elapsed = performance.now() - landingStartedAt;

      if (elapsed < LANDING_MS) {
        tickLandingFrame(delta, { spawn: true });
      } else {
        tickLandingFrame(delta, { spawn: false, fade: true });
      }
      return;
    }

    if (!staticReady) return;

    if (mode === 'home' || mode === 'uploading' || mode === 'sent') {
      renderStaticFrame(delta);
      return;
    }

    if (mode === 'recording') {
      renderStaticFrame(delta, { pulse: true });
    }
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
    scene.add(worldGroup);

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
    engine = await createTrailEngine(renderer, worldGroup, 1);
    clock = new THREE.Clock();

    window.addEventListener('resize', onResize);
    return true;
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  async function runLanding() {
    if (!engine) return;

    stopLoop();
    mode = 'landing';
    staticReady = false;
    engine.clearSlot(0);
    trail = createLandingTrail();
    applyPaletteToTrail(trail, 0);
    engine.applyTrailToGPU(trail);
    landingStartedAt = performance.now();
    startLoop();

    await new Promise((resolve) => {
      const wait = () => {
        const elapsed = performance.now() - landingStartedAt;
        if (elapsed >= LANDING_MS + LANDING_TAIL_MS) {
          stopLoop();
          engine.clearSlot(0);
          resolve();
          return;
        }
        requestAnimationFrame(wait);
      };
      wait();
    });
  }

  async function spawnStaticField(positionIndex) {
    engine.clearSlot(0);
    staticReady = false;

    trail = createTrail(0, 0, positionIndex);
    trail.mode = 'loop';
    trail.loopDuration = 4;
    trail.loopElapsed = 1.6;
    trail.loopFrames = buildSplashLoopFrames(4, 60);
    applyPaletteToTrail(trail, positionIndex);
    paletteIndex = positionIndex;
    targetPaletteIndex = positionIndex;

    for (const ribbon of MIC_RIBBONS) {
      spawnRibbonAlongBezier(trail, ribbon, camera, engine);
    }

    staticReady = true;
    homeFade = 0;
    homeFadeTarget = 0;
    engine.uniforms.colorBrightness.value = 0;
  }

  async function startHome(positionIndex) {
    if (!engine) return;

    stopLoop();
    mode = 'home';
    worldGroup.quaternion.identity();
    await spawnStaticField(positionIndex);
    startLoop();
  }

  function fadeInHome(durationMs = 900) {
    homeFade = 0;
    homeFadeTarget = 1;
    homeFadeStart = performance.now();
    homeFadeDuration = durationMs;
  }

  async function applyAssignedPalette(positionIndex) {
    if (!engine || mode === 'landing') return;

    const keepFade = homeFadeTarget >= 1 ? currentHomeFade() : homeFade;
    await spawnStaticField(positionIndex);
    if (keepFade > 0) {
      homeFade = keepFade;
      homeFadeTarget = 1;
      homeFadeStart = performance.now();
      homeFadeDuration = 0;
    }
  }

  function startRecording(analyser, frequencyData, waveformData) {
    if (!engine || !staticReady) return;

    mode = 'recording';
    liveAnalyser = analyser;
    liveFrequencyData = frequencyData;
    liveWaveformData = waveformData;
    smoothedLevel = 0;

    if (!loopRunning) startLoop();
  }

  function enterUploadingState() {
    mode = 'uploading';
    liveAnalyser = null;
    smoothedLevel = 0;
    if (engine) {
      engine.uniforms.colorBrightness.value = baseBrightness * currentHomeFade();
    }
  }

  function dispose() {
    stopLoop();
    window.removeEventListener('resize', onResize);
    renderer?.dispose();
    container.innerHTML = '';
    renderer = null;
    engine = null;
    trail = null;
    staticReady = false;
  }

  return {
    init,
    runLanding,
    startHome,
    fadeInHome,
    startRecording,
    enterUploadingState,
    applyAssignedPalette,
    dispose,
  };
}
