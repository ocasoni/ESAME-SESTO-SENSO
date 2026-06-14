import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import {
  createTrail,
  createTrailEngine,
  getBreathFrameFromAnalyser,
} from '../src/trailCore.js';
import { applyPaletteToTrail } from '../src/trailPalettes.js';

const CAMERA_FOV = 59;
const CAMERA_DISTANCE = 20;

const MIC_SETTINGS = {
  inputGain: 4.0,
  breathSensitivity: 18.0,
  lowSensitivity: 4.0,
  midSensitivity: 4.5,
  highSensitivity: 7.0,
};

const LANDING_MOVE_DURATION = 5.4;
const TRAIL_FADE_DURATION = 2.8;

const LANDING_DRIFT_FROM = new THREE.Vector3(-3.8, -2.6, 0);
const LANDING_DRIFT_TO = new THREE.Vector3(4.6, 3.4, 0);

export function createMicTrailRenderer(container) {
  let renderer = null;
  let scene = null;
  let worldGroup = null;
  let camera = null;
  let clock = null;
  let rafId = 0;
  let loopRunning = false;
  let mode = 'idle';

  let trailEngine = null;
  let positionIndex = 0;
  let landingTrail = null;
  let recordingTrail = null;
  let landingElapsed = 0;
  let landingDissolveElapsed = 0;
  let landingDissolving = false;
  let landingCompleteCallback = null;

  let liveAnalyser = null;
  let liveFrequencyData = null;
  let liveWaveformData = null;

  function createFirstTrail(nextPositionIndex) {
    const trail = createTrail(0, 0, nextPositionIndex);
    trail.mode = 'auto';
    trail.loopElapsed = 0;
    return trail;
  }

  function updateLandingDrift() {
    const t = Math.min(1, landingElapsed / LANDING_MOVE_DURATION);
    worldGroup.position.lerpVectors(LANDING_DRIFT_FROM, LANDING_DRIFT_TO, t);
  }

  function resetWorldDrift() {
    worldGroup.position.set(0, 0, 0);
  }

  function finishLanding() {
    const callback = landingCompleteCallback;
    landingCompleteCallback = null;
    landingTrail = null;
    landingElapsed = 0;
    landingDissolveElapsed = 0;
    landingDissolving = false;
    mode = 'idle';
    resetWorldDrift();
    trailEngine?.clearSlot(0);
    trailEngine.particleMesh.visible = false;
    stopLoop();
    callback?.();
  }

  function frameUpdate(delta) {
    if (mode === 'landing' && landingTrail && trailEngine) {
      if (!landingDissolving) {
        trailEngine.tickTrail(landingTrail, delta, { spawn: true, audioStarted: true });
        updateLandingDrift();
        landingElapsed += delta;

        if (landingElapsed >= LANDING_MOVE_DURATION) {
          landingDissolving = true;
        }
      } else {
        trailEngine.tickTrail(landingTrail, delta, { spawn: false, audioStarted: false });
        trailEngine.fadeSlot(landingTrail.particleStart, 1.0 / TRAIL_FADE_DURATION);
        landingDissolveElapsed += delta;

        if (landingDissolveElapsed >= TRAIL_FADE_DURATION) {
          finishLanding();
        }
      }
    } else if (mode === 'recording' && recordingTrail && trailEngine) {
      trailEngine.tickTrail(recordingTrail, delta, { spawn: true, audioStarted: true });
    } else if (trailEngine) {
      renderer.compute(trailEngine.updateParticles);
    }

    renderer.render(scene, camera);
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
    clock = new THREE.Clock();

    trailEngine = await createTrailEngine(renderer, worldGroup, 1);
    trailEngine.particleMesh.visible = false;

    window.addEventListener('resize', onResize);
    return true;
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function playLanding(onComplete) {
    if (!trailEngine) {
      onComplete?.();
      return { get dissolveStarted() { return false; } };
    }

    trailEngine.clearSlot(0);
    resetWorldDrift();

    landingTrail = createFirstTrail(0);
    mode = 'landing';
    landingElapsed = 0;
    landingDissolveElapsed = 0;
    landingDissolving = false;
    landingCompleteCallback = onComplete ?? null;
    trailEngine.particleMesh.visible = true;

    if (!loopRunning) startLoop();

    return {
      get dissolveStarted() {
        return landingDissolving;
      },
    };
  }

  function setHomeView() {
    mode = 'idle';
    recordingTrail = null;
    landingTrail = null;
    resetWorldDrift();
    trailEngine?.clearSlot(0);
    if (trailEngine) {
      trailEngine.particleMesh.visible = false;
    }
    stopLoop();
  }

  function setScreenLayout() {
    // Nessun layout particellare in home.
  }

  function setPalette(nextPositionIndex) {
    positionIndex = nextPositionIndex;

    if (landingTrail) {
      applyPaletteToTrail(landingTrail, nextPositionIndex);
    }

    if (recordingTrail) {
      applyPaletteToTrail(recordingTrail, nextPositionIndex);
    }
  }

  function startRecording(analyser, frequencyData, waveformData) {
    if (!trailEngine) return;

    liveAnalyser = analyser;
    liveFrequencyData = frequencyData;
    liveWaveformData = waveformData;

    trailEngine.clearSlot(0);
    resetWorldDrift();

    recordingTrail = createTrail(0, 0, positionIndex);
    recordingTrail.mode = 'live';
    recordingTrail.getLiveFrame = () =>
      getBreathFrameFromAnalyser(
        liveAnalyser,
        liveFrequencyData,
        liveWaveformData,
        MIC_SETTINGS
      );

    mode = 'recording';
    trailEngine.particleMesh.visible = true;
    if (!loopRunning) startLoop();
  }

  function stopRecordingVisual() {
    liveAnalyser = null;
    liveFrequencyData = null;
    liveWaveformData = null;

    if (recordingTrail && trailEngine) {
      trailEngine.fadeSlot(recordingTrail.particleStart, 1.0 / TRAIL_FADE_DURATION);
    }

    recordingTrail = null;
    mode = 'idle';
    trailEngine.particleMesh.visible = false;
    stopLoop();
  }

  function dispose() {
    stopLoop();
    window.removeEventListener('resize', onResize);
    renderer?.dispose();
    container.innerHTML = '';
  }

  return {
    init,
    playLanding,
    setHomeView,
    setScreenLayout,
    setPalette,
    startRecording,
    stopRecordingVisual,
    dispose,
  };
}
