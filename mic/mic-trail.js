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

const MIC_CLUSTERS = [
  { nx: 0.78, ny: 0.1, spawns: 8 },
  { nx: 0.9, ny: 0.38, spawns: 9 },
  { nx: 0.86, ny: 0.55, spawns: 7 },
  { nx: 0.1, ny: 0.86, spawns: 14 },
  { nx: 0.32, ny: 0.72, spawns: 11 },
  { nx: 0.52, ny: 0.9, spawns: 9 },
];

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

  function setPalette(index) {
    paletteIndex = index;
    targetPaletteIndex = index;
    paletteMix = 1;
    applyPaletteToTrail(trail, index);
    engine?.applyTrailToGPU(trail);
  }

  function renderStaticFrame(delta, { pulse = false } = {}) {
    if (pulse && liveAnalyser) {
      const frame = getBreathFrameFromAnalyser(
        liveAnalyser,
        liveFrequencyData,
        liveWaveformData,
        MIC_SETTINGS
      );
      smoothedLevel = THREE.MathUtils.lerp(smoothedLevel, frame.level, 0.18);
      engine.uniforms.colorBrightness.value = baseBrightness + smoothedLevel * 1.4;
    } else {
      engine.uniforms.colorBrightness.value = THREE.MathUtils.lerp(
        engine.uniforms.colorBrightness.value,
        baseBrightness,
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

    for (const cluster of MIC_CLUSTERS) {
      const center = screenNormToWorld(cluster.nx, cluster.ny, camera);
      trail.spawnPosition.copy(center);
      trail.previousSpawnPosition.copy(center);
      trail.audioDrivenPosition.copy(center);
      trail.position.copy(center);
      engine.applyTrailToGPU(trail);

      for (let i = 0; i < cluster.spawns; i += 1) {
        engine.tickTrail(trail, 0.016, { spawn: true, audioStarted: false });
      }
    }

    staticReady = true;
    engine.uniforms.colorBrightness.value = baseBrightness;
  }

  async function startHome(positionIndex) {
    if (!engine) return;

    stopLoop();
    mode = 'home';
    worldGroup.quaternion.identity();
    await spawnStaticField(positionIndex);
    startLoop();
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
      engine.uniforms.colorBrightness.value = baseBrightness;
    }
  }

  function applyAssignedPalette(positionIndex) {
    setPalette(positionIndex);
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
    startRecording,
    enterUploadingState,
    applyAssignedPalette,
    dispose,
  };
}
