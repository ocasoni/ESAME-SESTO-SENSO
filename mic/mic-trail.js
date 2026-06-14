import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import {
  applyMixedPalette,
  applyPaletteToTrail,
  lerpPalettes,
} from '../src/trailPalettes.js';
import {
  createAmbientTrail,
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
  let colorFromIndex = 0;
  let colorToIndex = 0;
  let colorMix = 0;
  let liveAnalyser = null;
  let liveFrequencyData = null;
  let liveWaveformData = null;
  let landingStartedAt = 0;
  let recordStartedAt = 0;
  let recordDurationMs = 20000;
  let targetPositionIndex = 0;
  let ambientPhase = 0;
  let loopRunning = false;

  function applyTrailColors() {
    if (!trail) return;
    const mixed = lerpPalettes(colorFromIndex, colorToIndex, colorMix);
    applyMixedPalette(trail, mixed);
    engine?.applyTrailToGPU(trail);
  }

  function setColorProgress(fromIndex, toIndex, mix) {
    colorFromIndex = fromIndex;
    colorToIndex = toIndex;
    colorMix = THREE.MathUtils.clamp(mix, 0, 1);
    applyTrailColors();
  }

  function lockPalette(positionIndex) {
    applyPaletteToTrail(trail, positionIndex);
    colorFromIndex = positionIndex;
    colorToIndex = positionIndex;
    colorMix = 1;
    engine?.applyTrailToGPU(trail);
  }

  function tickFrame(delta, { spawn = true, fade = false } = {}) {
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
        tickFrame(delta, { spawn: true });
      } else {
        tickFrame(delta, { spawn: false, fade: true });
      }
      return;
    }

    if (mode === 'ambient') {
      ambientPhase += delta * 0.08;
      const mix = ((Math.sin(ambientPhase) + 1) * 0.5) * 0.35;
      setColorProgress(0, 2, mix);
      tickFrame(delta, { spawn: true });
      return;
    }

    if (mode === 'recording') {
      const elapsed = performance.now() - recordStartedAt;
      const progress = THREE.MathUtils.clamp(elapsed / recordDurationMs, 0, 1);
      setColorProgress(0, targetPositionIndex, progress);
      tickFrame(delta, { spawn: true });
      return;
    }

    if (mode === 'uploading' || mode === 'sent') {
      tickFrame(delta, { spawn: true });
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

  function startAmbient() {
    if (!engine) return;

    stopLoop();
    mode = 'ambient';
    engine.clearSlot(0);
    trail = createAmbientTrail();
    setColorProgress(0, 1, 0);
    engine.applyTrailToGPU(trail);
    ambientPhase = 0;
    startLoop();
  }

  function startRecording(analyser, frequencyData, waveformData, positionIndex) {
    if (!engine) return;

    stopLoop();
    mode = 'recording';
    targetPositionIndex = positionIndex;
    liveAnalyser = analyser;
    liveFrequencyData = frequencyData;
    liveWaveformData = waveformData;
    recordStartedAt = performance.now();

    engine.clearSlot(0);
    trail = createTrail(0, 0, 0);
    trail.mode = 'live';
    trail.position.set(0, -1.5, 0);
    trail.homePosition.copy(trail.position);
    trail.spawnPosition.copy(trail.position);
    trail.previousSpawnPosition.copy(trail.position);
    trail.audioDrivenPosition.copy(trail.position);
    trail.getLiveFrame = () =>
      getBreathFrameFromAnalyser(
        liveAnalyser,
        liveFrequencyData,
        liveWaveformData,
        MIC_SETTINGS
      );

    engine.applyTrailToGPU(trail);
    startLoop();
  }

  function startUploading(positionIndex) {
    if (!engine || !trail) return;
    targetPositionIndex = positionIndex;
    setColorProgress(colorToIndex, positionIndex, 0.65);
    mode = 'uploading';
  }

  function showSent(positionIndex) {
    if (!engine || !trail) return;
    mode = 'sent';
    lockPalette(positionIndex);
    if (!loopRunning) startLoop();
  }

  function dispose() {
    stopLoop();
    window.removeEventListener('resize', onResize);
    renderer?.dispose();
    container.innerHTML = '';
    renderer = null;
    engine = null;
    trail = null;
  }

  return {
    init,
    runLanding,
    startAmbient,
    startRecording,
    startUploading,
    showSent,
    dispose,
  };
}
