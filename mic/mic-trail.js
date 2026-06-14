import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, shapeCircle } from 'three/tsl';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { getParticleColor, getTrailPalette } from '../src/trailPalettes.js';
import { getBreathFrameFromAnalyser } from '../src/trailCore.js';
import {
  DECOR_LAYOUTS,
  DECOR_PARTICLE_COUNT,
} from './mic-decor-layouts.js';

const CAMERA_FOV = 59;
const CAMERA_DISTANCE = 20;

const MIC_SETTINGS = {
  inputGain: 4.0,
  breathSensitivity: 18.0,
  lowSensitivity: 4.0,
  midSensitivity: 4.5,
  highSensitivity: 7.0,
};

const STATIC_COLOR_SCALE = 1.1;
const DOT_SIZE_MIN_PX = 18;
const DOT_SIZE_MAX_PX = 40;

function rnd(seed) {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function particlePixelSize(seed, nx) {
  const mix = rnd(seed * 3.17);
  let size = THREE.MathUtils.lerp(DOT_SIZE_MIN_PX, DOT_SIZE_MAX_PX, mix);
  const edgeDistance = Math.min(nx, 1 - nx);
  if (edgeDistance < 0.14) {
    size = Math.max(size, THREE.MathUtils.lerp(28, DOT_SIZE_MAX_PX, 1 - edgeDistance / 0.14));
  }
  return size;
}

function screenToWorld(nx, ny, aspect) {
  const height = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) * CAMERA_DISTANCE;
  const width = height * aspect;
  const x = (nx - 0.5) * 2 * width * 0.94;
  const y = (0.5 - ny) * 2 * height * 0.94;
  return new THREE.Vector3(x, y, 0);
}

function clampChannel(value) {
  return Math.min(1, Math.max(0, value));
}

export function createMicTrailRenderer(container) {
  let renderer = null;
  let scene = null;
  let decorGroup = null;
  let camera = null;
  let clock = null;
  let rafId = 0;
  let loopRunning = false;
  let mode = 'static';

  let staticSprites = null;
  let staticMaterial = null;
  let staticPositionAttr = null;
  let staticColorAttr = null;
  let staticSizeAttr = null;
  let staticAlphaAttr = null;
  let positionIndex = 0;
  let brightness = 1;
  let liveAnalyser = null;
  let liveFrequencyData = null;
  let liveWaveformData = null;

  let particleStates = [];

  function paletteColor(seed) {
    const palette = getTrailPalette(positionIndex);
    return getParticleColor(palette, seed).multiplyScalar(STATIC_COLOR_SCALE);
  }

  function initParticleStates() {
    const layout = DECOR_LAYOUTS.home;
    particleStates = layout.map((point, index) => ({
      nx: point.nx,
      ny: point.ny,
      seed: point.seed,
      index,
    }));
  }

  function writeStaticGeometry() {
    if (!staticSprites) return;

    const aspect = window.innerWidth / window.innerHeight;

    particleStates.forEach((particle, i) => {
      const world = screenToWorld(particle.nx, particle.ny, aspect);
      const color = paletteColor(particle.seed);
      const pixelSize = particlePixelSize(particle.seed, particle.nx);

      staticPositionAttr.setXYZ(i, world.x, world.y, world.z);
      staticSizeAttr.setX(i, pixelSize);
      staticAlphaAttr.setX(i, 1);
      staticColorAttr.setXYZ(
        i,
        clampChannel(color.x * brightness),
        clampChannel(color.y * brightness),
        clampChannel(color.z * brightness)
      );
    });

    staticPositionAttr.needsUpdate = true;
    staticColorAttr.needsUpdate = true;
    staticSizeAttr.needsUpdate = true;
    staticAlphaAttr.needsUpdate = true;
  }

  function createStaticSprites() {
    staticPositionAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(DECOR_PARTICLE_COUNT * 3),
      3
    );
    staticColorAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(DECOR_PARTICLE_COUNT * 3),
      3
    );
    staticSizeAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(DECOR_PARTICLE_COUNT),
      1
    );
    staticAlphaAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(DECOR_PARTICLE_COUNT),
      1
    );

    staticMaterial = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      sizeAttenuation: false,
      alphaTest: 0.02,
    });
    staticMaterial.positionNode = instancedBufferAttribute(staticPositionAttr);
    staticMaterial.colorNode = instancedBufferAttribute(staticColorAttr);
    staticMaterial.sizeNode = instancedBufferAttribute(staticSizeAttr, 'float');
    staticMaterial.opacityNode = instancedBufferAttribute(staticAlphaAttr, 'float').mul(shapeCircle());

    staticSprites = new THREE.Sprite(staticMaterial);
    staticSprites.count = DECOR_PARTICLE_COUNT;
    staticSprites.frustumCulled = false;
    decorGroup.add(staticSprites);
  }

  function applyStaticBrightness(level) {
    brightness = THREE.MathUtils.clamp(level, 0.55, 1.35);
    writeStaticGeometry();
  }

  function frameUpdate(delta) {
    if (mode === 'recording' && liveAnalyser) {
      const frame = getBreathFrameFromAnalyser(
        liveAnalyser,
        liveFrequencyData,
        liveWaveformData,
        MIC_SETTINGS
      );
      applyStaticBrightness(0.62 + frame.level * 0.72);
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
    decorGroup = new THREE.Group();
    scene.add(decorGroup);

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

    initParticleStates();
    createStaticSprites();
    writeStaticGeometry();

    window.addEventListener('resize', onResize);
    return true;
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    writeStaticGeometry();
  }

  function showStaticDecor(nextPositionIndex) {
    positionIndex = nextPositionIndex;
    mode = 'static';
    staticSprites.visible = true;
    applyStaticBrightness(1);
    if (!loopRunning) startLoop();
  }

  function setScreenLayout() {
    // Posizioni fisse: nessun cambio layout tra stati.
  }

  function setPalette(nextPositionIndex) {
    positionIndex = nextPositionIndex;
    writeStaticGeometry();
  }

  function startRecording(analyser, frequencyData, waveformData) {
    liveAnalyser = analyser;
    liveFrequencyData = frequencyData;
    liveWaveformData = waveformData;
    mode = 'recording';
    staticSprites.visible = true;
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
    showStaticDecor,
    setScreenLayout,
    setPalette,
    startRecording,
    stopRecordingVisual,
    dispose,
  };
}
