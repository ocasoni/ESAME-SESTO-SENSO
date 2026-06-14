import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { applyPaletteToTrail } from '../src/trailPalettes.js';
import {
  buildSplashLoopFrames,
  createLandingTrail,
  createTrail,
  createTrailEngine,
  getBreathFrameFromAnalyser,
  particlesPerTrail,
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
    steps: 60,
    breathOffset: 0.8,
    zoom: 1.22,
    focal: { nx: 0.46, ny: 0.86 },
  },
  {
    p0: { nx: 0.28, ny: 0.78 },
    p1: { nx: 0.14, ny: 0.96 },
    p2: { nx: 0.02, ny: 0.62 },
    p3: { nx: -0.18, ny: 0.52 },
    steps: 60,
    breathOffset: 1.0,
    zoom: 1.22,
    focal: { nx: 0.46, ny: 0.86 },
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

function applyRibbonZoom(point, ribbon) {
  if (!ribbon.zoom) return point;

  const focal = ribbon.focal ?? { nx: 0.5, ny: 0.85 };
  return {
    nx: focal.nx + (point.nx - focal.nx) * ribbon.zoom,
    ny: focal.ny + (point.ny - focal.ny) * ribbon.zoom,
  };
}

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

function spawnRibbonAlongBezier(trail, ribbon, camera, engine, homeParticles) {
  const { p0, p1, p2, p3, steps, breathOffset } = ribbon;
  const anchor = trail.position.clone();

  for (let i = 0; i < steps; i += 1) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const a = applyRibbonZoom(cubicBezierNorm(t0, p0, p1, p2, p3), ribbon);
    const b = applyRibbonZoom(cubicBezierNorm(t1, p0, p1, p2, p3), ribbon);
    const prev = screenNormToWorld(a.nx, a.ny, camera);
    const curr = screenNormToWorld(b.nx, b.ny, camera);

    trail.loopElapsed = breathOffset + t1 * 1.6;
    engine.updateAudioDrivenPosition(trail, 0, true);
    trail.position.copy(anchor);

    trail.previousSpawnPosition.copy(prev);
    trail.spawnPosition.copy(curr);
    trail.audioDrivenPosition.copy(curr);

    const spawnBefore = trail.spawnIndex;
    engine.applyTrailToGPU(trail);
    engine.tickTrail(trail, 0.016, { spawn: true, audioStarted: false });

    const spawnCount = Math.round(engine.uniforms.nbToSpawn.value);
    for (let p = 0; p < spawnCount; p += 1) {
      const idx = (spawnBefore + p) % particlesPerTrail;
      engine.setStaticParticleMeta(
        idx,
        Math.random() * Math.PI * 2,
        0.35 + Math.random() * 0.95,
        0.035 + Math.random() * 0.14,
        t1
      );
      homeParticles.push({ index: idx });
    }
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
  let homeTime = 0;
  let homeParticles = [];
  let activeSparkles = [];
  let lastSparkleRoll = 0;
  let smoothedAudioLow = 0;
  let smoothedAudioMid = 0;
  let smoothedAudioHigh = 0;
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
    const eased = t * t * (3 - 2 * t);
    return THREE.MathUtils.lerp(homeFade, homeFadeTarget, eased);
  }

  function sparkleEnvelope(sparkle, now) {
    const duration = sparkle.end - sparkle.start;
    const t = (now - sparkle.start) / duration;
    if (t >= 1) return 0;

    const attack = 0.1;
    if (t < attack) return (t / attack) * sparkle.peak;

    const decay = 1 - (t - attack) / (1 - attack);
    return sparkle.peak * decay * decay;
  }

  function updateHomeSparkles(now) {
    activeSparkles = activeSparkles.filter((sparkle) => now < sparkle.end);

    if (
      homeParticles.length > 0 &&
      activeSparkles.length < 10 &&
      now - lastSparkleRoll > 280 + Math.random() * 520
    ) {
      lastSparkleRoll = now;
      const picks = 1 + Math.floor(Math.random() * 2);

      for (let i = 0; i < picks; i += 1) {
        const particle = homeParticles[Math.floor(Math.random() * homeParticles.length)];
        activeSparkles.push({
          index: particle.index,
          start: now,
          end: now + 480 + Math.random() * 720,
          peak: 0.1 + Math.random() * 0.32,
        });
      }
    }

    engine.clearSparkleIntensities();
    for (const sparkle of activeSparkles) {
      const intensity = sparkleEnvelope(sparkle, now);
      if (intensity > 0.001) {
        engine.addSparkleIntensity(sparkle.index, intensity);
      }
    }
  }

  function renderStaticFrame(delta, { pulse = false } = {}) {
    homeTime += delta;

    let audioLow = 0;
    let audioMid = 0;
    let audioHigh = 0;
    let recording = 0;

    if (pulse && liveAnalyser) {
      const frame = getBreathFrameFromAnalyser(
        liveAnalyser,
        liveFrequencyData,
        liveWaveformData,
        MIC_SETTINGS
      );
      smoothedAudioLow = THREE.MathUtils.lerp(smoothedAudioLow, frame.lowBand, 0.12);
      smoothedAudioMid = THREE.MathUtils.lerp(smoothedAudioMid, frame.midBand, 0.12);
      smoothedAudioHigh = THREE.MathUtils.lerp(smoothedAudioHigh, frame.highBand, 0.12);
      audioLow = smoothedAudioLow;
      audioMid = smoothedAudioMid;
      audioHigh = smoothedAudioHigh;
      recording = 1;
    } else {
      smoothedAudioLow = THREE.MathUtils.lerp(smoothedAudioLow, 0, 0.05);
      smoothedAudioMid = THREE.MathUtils.lerp(smoothedAudioMid, 0, 0.05);
      smoothedAudioHigh = THREE.MathUtils.lerp(smoothedAudioHigh, 0, 0.05);
    }

    if (mode === 'home' || mode === 'uploading' || mode === 'sent') {
      updateHomeSparkles(performance.now());
    }

    engine.uniforms.colorBrightness.value = baseBrightness;
    engine.applyStaticAppearance(trail, homeTime, {
      low: audioLow,
      mid: audioMid,
      high: audioHigh,
      recording,
    });

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
    engine = await createTrailEngine(renderer, worldGroup, 1, { staticTwinkle: true });
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
    homeParticles = [];
    activeSparkles = [];
    lastSparkleRoll = performance.now();
    homeTime = 0;
    smoothedAudioLow = 0;
    smoothedAudioMid = 0;
    smoothedAudioHigh = 0;

    trail = createTrail(0, 0, positionIndex);
    trail.mode = 'loop';
    trail.loopDuration = 4;
    trail.loopElapsed = 1.6;
    trail.loopFrames = buildSplashLoopFrames(4, 60);
    applyPaletteToTrail(trail, positionIndex);
    paletteIndex = positionIndex;
    targetPaletteIndex = positionIndex;

    for (const ribbon of MIC_RIBBONS) {
      spawnRibbonAlongBezier(trail, ribbon, camera, engine, homeParticles);
    }

    engine.commitStaticParticleMeta();
    engine.freezeStaticParticles(trail);

    staticReady = true;
    homeFade = 1;
    homeFadeTarget = 1;
    homeFadeDuration = 0;
    engine.uniforms.colorBrightness.value = baseBrightness;
    engine.applyStaticAppearance(trail, homeTime, { recording: 0 });
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
    smoothedAudioLow = 0;
    smoothedAudioMid = 0;
    smoothedAudioHigh = 0;

    if (!loopRunning) startLoop();
  }

  function enterUploadingState() {
    mode = 'uploading';
    liveAnalyser = null;
    smoothedAudioLow = 0;
    smoothedAudioMid = 0;
    smoothedAudioHigh = 0;
    if (engine) {
      engine.uniforms.colorBrightness.value = baseBrightness;
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
