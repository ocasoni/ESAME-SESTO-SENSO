import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import {
  abs,
  atan,
  color,
  floor,
  deltaTime,
  float,
  Fn,
  hash,
  hue,
  instanceIndex,
  If,
  Loop,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
  PI,
  storage,
  step,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  sin,
  cos,
} from 'three/tsl';
import './style.css';
import QRCode from 'qrcode';
import { buildMicPageUrl, resolveNetworkUrls } from './networkUrls.js';
import { extractBreathFramesFromArrayBuffer } from './audioFromUpload.js';
import { fetchUploadAudio, startUploadPolling } from './telegramPoll.js';

let resolvedApiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS || 1500);
const AUTO_ROTATE_SPEED = 2;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

let worldSpinAngle = 0;

let stopPolling = null;
let phoneUiElements = null;

let camera, scene, renderer, controls, clock, light, worldGroup;
let clearTrailParticlesCompute = null;
let fadeTrailParticlesCompute = null;
let sourceDot;
let updateParticles, spawnParticles;
let getInstanceColor;

let audioContext;
let analyser;
let frequencyData;
let waveformData;
let audioStarted = false;

const audioDrivenPosition = new THREE.Vector3();
let audioPhase = 0;
let smoothedLevel = 0;

const activeTrails = [];
const fadingTrails = [];
let activeTrailNumber = 0;
let recordingTrail = null;
let displayTrail = null;

let smoothedLowBand = 0;
let smoothedMidBand = 0;
let smoothedHighBand = 0;
let previousFrequencyBalance = 0;

let audioSource = null;
let audioGain = null;
let audioIsPlaying = false;

let microphoneStream = null;
let microphoneSource = null;
let selectedMicDeviceId = null;

const breathLearnDuration = 30.0;
let simulationPaused = false;

const spawnSpread = uniform(0.08);
const spawnLinksWidth = uniform(0.005);

const cymaticLevel = uniform(0.0);
const cymaticLow = uniform(0.0);
const cymaticMid = uniform(0.0);
const cymaticHigh = uniform(0.0);
const cymaticPhase = uniform(0.0);
const cymaticScale = uniform(1.1);
const cymaticDepth = uniform(0.12);

const TWO_PI = PI.mul(2.0);

const screenPointer = new THREE.Vector2();
const scenePointer = new THREE.Vector3();
const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const raycaster = new THREE.Raycaster();

const maxActiveTrails = 10;
const maxParticleSlots = 14;
const TRAIL_FADE_DURATION = 2.8;
const TRAIL_SPREAD_DISTANCE = 13.5;
const INITIAL_CAMERA_FOV = 59;
const INITIAL_CAMERA_DISTANCE = 20;

const TRAIL_POSITION_DIRECTIONS = [
  new THREE.Vector3(0.0, 0.0, 0.0),
  new THREE.Vector3(1.0, -0.55, -0.85),
  new THREE.Vector3(-0.92, -0.85, 1.05),
  new THREE.Vector3(0.88, 1.08, -1.18),
  new THREE.Vector3(0.18, 1.48, 1.08),
  new THREE.Vector3(-0.38, -1.58, -1.08),
  new THREE.Vector3(1.28, 0.38, 0.88),
  new THREE.Vector3(-1.18, 0.58, -0.78),
  new THREE.Vector3(0.48, -1.28, 0.98),
  new THREE.Vector3(-0.98, 0.98, 1.38),
  new THREE.Vector3(0.72, -0.32, 1.45),
  new THREE.Vector3(-1.32, -0.22, -0.55),
  new THREE.Vector3(0.58, 1.05, 1.28),
  new THREE.Vector3(-0.62, 1.35, -1.05),
];

// Ogni scia mantiene la stessa quantità di particelle che aveva prima.
// Così il comportamento visivo della scia rimane uguale.
const particlesPerTrail = Math.pow(2, 14);
const nbParticles = particlesPerTrail * maxParticleSlots;

const currentTrailParticleStart = uniform(0);
const clearTrailParticleStart = uniform(0);
const fadeTrailParticleStart = uniform(0);
const fadeTrailRate = uniform(1.0);

const timeScale = uniform(0.8);
const particleLifetime = uniform(0.65);
const particleSize = uniform(0.45);

const colorOffset = uniform(0.0);
const colorBrightness = uniform(1.25);
const colorRotationSpeed = uniform(0.4);
const currentTrailColorA = uniform(vec3(0.0, 0.35, 1.0));
const currentTrailColorB = uniform(vec3(0.0, 1.0, 1.0));
const currentTrailColorC = uniform(vec3(0.7, 0.0, 1.0));

const spawnIndex = uniform(0);
const nbToSpawn = uniform(50);
const spawnPosition = uniform(vec3(0.0));
const previousSpawnPosition = uniform(vec3(0.0));

const turbFrequency = uniform(0.35);
const turbAmplitude = uniform(1.2);
const turbOctaves = uniform(2);
const turbLacunarity = uniform(2.0);
const turbGain = uniform(0.35);
const turbFriction = uniform(0.08);

const freezeLifeThreshold = uniform(0.90);

const trajectoryParams = {
  speed: 1.35,
  smoothness: 0.12,
  range: 4.2,
  directionChange: 0.72,
  forwardPush: 1.0
};

const microphoneSettings = {
  inputGain: 4.0,
  breathSensitivity: 18.0,
  lowSensitivity: 4.0,
  midSensitivity: 4.5,
  highSensitivity: 7.0
};

init();

async function init() {
  if (WebGPU.isAvailable() === false) {
    document.body.appendChild(WebGPU.getErrorMessage());
    throw new Error('No WebGPU support');
  }

  camera = new THREE.PerspectiveCamera(INITIAL_CAMERA_FOV, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0, INITIAL_CAMERA_DISTANCE);

  scene = new THREE.Scene();
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  clock = new THREE.Clock();

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setClearColor(0x14171a);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setAnimationLoop(animate);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  await renderer.init();

 getInstanceColor = Fn(([i]) => {
    const seedA = hash(i);
    const seedB = hash(i.add(31));

    const colorMixA = mix(
      currentTrailColorA,
      currentTrailColorB,
      seedA
    );

    const colorMixB = mix(
      colorMixA,
      currentTrailColorC,
      seedB.mul(0.45)
    );

    return colorMixB.mul(colorBrightness);
  });

  const particlePositions = storage(new THREE.StorageInstancedBufferAttribute(nbParticles, 4), 'vec4', nbParticles);
  const particleVelocities = storage(new THREE.StorageInstancedBufferAttribute(nbParticles, 4), 'vec4', nbParticles);

  const particleColors = storage(new THREE.StorageInstancedBufferAttribute(nbParticles, 4), 'vec4', nbParticles);
  const particleProperties = storage(new THREE.StorageInstancedBufferAttribute(nbParticles, 4), 'vec4', nbParticles);

  renderer.compute(
    Fn(() => {
      particlePositions.element(instanceIndex).xyz.assign(vec3(10000.0));
      particlePositions.element(instanceIndex).w.assign(-1.0);

      particleColors.element(instanceIndex).xyz.assign(vec3(1.0));
      particleColors.element(instanceIndex).w.assign(1.0);

      particleProperties.element(instanceIndex).x.assign(1.0);
      particleProperties.element(instanceIndex).y.assign(0.005);
      particleProperties.element(instanceIndex).z.assign(1.0);
      particleProperties.element(instanceIndex).w.assign(0.0);
    })().compute(nbParticles)
  );

  clearTrailParticlesCompute = Fn(() => {
    const particleIndex = clearTrailParticleStart.add(instanceIndex).toInt();

    particlePositions.element(particleIndex).xyz.assign(vec3(10000.0));
    particlePositions.element(particleIndex).w.assign(-1.0);
    particleProperties.element(particleIndex).w.assign(0.0);
    particleProperties.element(particleIndex).z.assign(1.0);
  })().compute(particlesPerTrail);

  fadeTrailParticlesCompute = Fn(() => {
    const particleIndex = fadeTrailParticleStart.add(instanceIndex).toInt();
    const position = particlePositions.element(particleIndex).xyz;
    const life = particlePositions.element(particleIndex).w;
    const reveal = particleProperties.element(particleIndex).w;
    const fadeStep = deltaTime.mul(fadeTrailRate);

    If(life.greaterThan(0.0), () => {
      life.subAssign(fadeStep);
      reveal.subAssign(fadeStep.mul(1.35));

      If(life.lessThanEqual(0.0), () => {
        life.assign(-1.0);
        reveal.assign(0.0);
        position.assign(vec3(10000.0));
      });
    });
  })().compute(particlesPerTrail);

  const particleQuadSize = 0.12;
  const particleGeom = new THREE.PlaneGeometry(particleQuadSize, particleQuadSize);

  const particleMaterial = new THREE.SpriteNodeMaterial();
  particleMaterial.blending = THREE.AdditiveBlending;
  particleMaterial.depthWrite = false;
  particleMaterial.positionNode = particlePositions.toAttribute();
  particleMaterial.scaleNode = vec2(particleProperties.toAttribute().x);
  particleMaterial.rotationNode = atan(particleVelocities.toAttribute().y, particleVelocities.toAttribute().x);

  particleMaterial.colorNode = Fn(() => {
    const life = particlePositions.toAttribute().w;
    const reveal = particleProperties.toAttribute().w;
    const liveBrightness = colorBrightness.mul(0.65).add(0.35);

    return particleColors.toAttribute().xyz
      .mul(life)
      .mul(reveal)
      .mul(liveBrightness);
  })();

  particleMaterial.opacityNode = Fn(() => {
    const circle = step(uv().xy.sub(0.5).length(), 0.5);
    const life = particlePositions.toAttribute().w;
    const reveal = particleProperties.toAttribute().w;

    return circle.mul(life).mul(reveal);
  })();

  const particleMesh = new THREE.InstancedMesh(particleGeom, particleMaterial, nbParticles);
  particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  particleMesh.frustumCulled = false;
  worldGroup.add(particleMesh);

  const sourceDotGeom = new THREE.SphereGeometry(0.035, 24, 24);
  const sourceDotMaterial = new THREE.MeshBasicMaterial({
    color: 0xff66ff,
    transparent: true,
    opacity: 1.0
  });

  sourceDot = new THREE.Mesh(sourceDotGeom, sourceDotMaterial);
  sourceDot.frustumCulled = false;
  worldGroup.add(sourceDot);

  updateParticles = Fn(() => {
    const position = particlePositions.element(instanceIndex).xyz;
    const life = particlePositions.element(instanceIndex).w;
    const targetPosition = particleVelocities.element(instanceIndex).xyz;
    const reveal = particleProperties.element(instanceIndex).w;

    const dt = deltaTime.mul(0.1).mul(timeScale);

    If(life.greaterThan(0.0), () => {
      const frozen = particleProperties.element(instanceIndex).z;

      If(frozen.lessThan(0.5), () => {
        const settleSpeed = float(0.18)
          .add(cymaticLevel.mul(0.12))
          .add(cymaticHigh.mul(0.05));

        position.assign(
          mix(position, targetPosition, settleSpeed)
        );

        const localVel = mx_fractal_noise_vec3(
          position.mul(turbFrequency),
          turbOctaves,
          turbLacunarity,
          turbGain,
          turbAmplitude
        ).mul(life.add(0.01)).mul(0.018);

        position.addAssign(localVel);

        reveal.addAssign(dt.mul(10.0));

        If(reveal.greaterThan(1.0), () => {
          reveal.assign(1.0);
        });

        life.subAssign(dt.mul(particleLifetime.reciprocal()));

        If(life.lessThan(freezeLifeThreshold), () => {
          life.assign(freezeLifeThreshold);
          frozen.assign(1.0);
          reveal.assign(1.0);
        });
      });
    });
  })().compute(nbParticles).label('Update Particles');

  spawnParticles = Fn(() => {
    const particleIndex = currentTrailParticleStart
      .add(spawnIndex.add(instanceIndex).mod(particlesPerTrail).toInt())
      .toInt();
    const position = particlePositions.element(particleIndex).xyz;
    const life = particlePositions.element(particleIndex).w;
    const velocity = particleVelocities.element(particleIndex).xyz;
    const particleColor = particleColors.element(particleIndex);
    const particleProperty = particleProperties.element(particleIndex);

    life.assign(1.0);

    particleColor.xyz.assign(getInstanceColor(particleIndex));
    particleColor.w.assign(1.0);

    particleProperty.x.assign(particleSize);
    particleProperty.y.assign(spawnLinksWidth);
    particleProperty.z.assign(0.0);

    const pos = mix(
      previousSpawnPosition,
      spawnPosition,
      instanceIndex.toFloat().div(nbToSpawn.sub(1).toFloat()).clamp()
    );

    const seedA = hash(particleIndex);
    const seedB = hash(particleIndex.add(17));
    const seedC = hash(particleIndex.add(43));
    const seedD = hash(particleIndex.add(91));

    const theta = seedA.mul(TWO_PI);

    const modeLow = float(2.0).add(cymaticLow.mul(9.0));
    const modeMid = float(3.0).add(cymaticMid.mul(13.0));
    const modeHigh = float(5.0).add(cymaticHigh.mul(22.0));

    const radialWave = abs(
      sin(theta.mul(modeLow).add(cymaticPhase))
    );

    const angularWave = abs(
      cos(theta.mul(modeMid).sub(cymaticPhase.mul(0.65)))
    );

    const detailWave = abs(
      sin(theta.mul(modeHigh).add(seedC.mul(TWO_PI)))
    );

    const cymaticField = radialWave
      .mul(0.45)
      .add(angularWave.mul(0.4))
      .add(detailWave.mul(0.35));

    const bandCount = float(3.0)
      .add(cymaticLow.mul(4.0))
      .add(cymaticMid.mul(5.0))
      .add(cymaticHigh.mul(3.0));

    const bandId = floor(seedB.mul(bandCount));

    const bandRadius = bandId
      .add(0.5)
      .div(bandCount);

    const bandVibration = abs(
      sin(
        bandRadius
          .mul(modeLow)
          .mul(PI)
          .add(cymaticPhase)
      )
    );

    const nodeAttraction = bandVibration
      .mul(0.55)
      .add(cymaticField.mul(0.45));

    const microSpread = seedD
      .sub(0.5)
      .mul(0.08)
      .mul(float(1.0).add(cymaticHigh));

    const audioRadius = float(0.18).add(cymaticLevel);

    const radius = cymaticScale
      .mul(audioRadius)
      .mul(
        bandRadius
          .add(nodeAttraction.mul(0.38))
          .add(microSpread)
      );

    const xDeform = float(0.75)
      .add(radialWave.mul(0.65))
      .add(cymaticMid.mul(0.45));

    const yDeform = float(0.75)
      .add(angularWave.mul(0.65))
      .add(cymaticHigh.mul(0.45));

    const x = cos(theta).mul(radius).mul(xDeform);
    const y = sin(theta).mul(radius).mul(yDeform);

    const z = detailWave
      .sub(0.5)
      .mul(cymaticDepth)
      .mul(float(0.5).add(cymaticLevel));

    const cymaticOffset = vec3(x, y, z);

    // Tutte le particelle nascono dal punto unico della scia.
    position.assign(pos);

    // Però la loro posizione finale è quella della sezione cimatico-sonora,
    // esattamente come prima.
    velocity.assign(
      pos.add(cymaticOffset)
    );

    // Nascono quasi invisibili, così non disegnano righe mentre si aprono.
    particleProperty.w.assign(0.80);
  })().compute(nbToSpawn.value).label('Spawn Particles');

  const backgroundGeom = new THREE.IcosahedronGeometry(100, 5).applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  const backgroundMaterial = new THREE.MeshStandardNodeMaterial();
  backgroundMaterial.roughness = 0.4;
  backgroundMaterial.metalness = 0.9;
  backgroundMaterial.flatShading = true;
  backgroundMaterial.colorNode = color(0x0);

  const backgroundMesh = new THREE.Mesh(backgroundGeom, backgroundMaterial);
  worldGroup.add(backgroundMesh);

  light = new THREE.PointLight(0xffffff, 3000);
  worldGroup.add(light);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.autoRotate = false;
  controls.maxDistance = 75;

  window.addEventListener('resize', onWindowResize);

  createPhoneUploadUI();
  unlockAudioPlayback();
  publishTrailState();
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onPointerMove(e) {
  screenPointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  screenPointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

function updatePointer() {
  raycaster.setFromCamera(screenPointer, camera);
  raycaster.ray.intersectPlane(raycastPlane, scenePointer);
}

function animate() {
  const delta = clock.getDelta();
  const elapsedTime = clock.getElapsedTime();

  if (!simulationPaused) {
    renderer.compute(updateParticles);
    updateFadingTrails(delta);
  }

  if (!simulationPaused && activeTrails.length > 0) {
    for (const trail of activeTrails) {
      trail.previousSpawnPosition.copy(trail.spawnPosition);

      updateAudioDrivenPosition(trail, delta);

      trail.spawnPosition.lerp(
        trail.audioDrivenPosition,
        trajectoryParams.smoothness
      );

      currentTrailParticleStart.value = trail.particleStart;
      currentTrailColorA.value.copy(trail.colorA);
      currentTrailColorB.value.copy(trail.colorB);
      currentTrailColorC.value.copy(trail.colorC);
      spawnIndex.value = trail.spawnIndex;

      previousSpawnPosition.value.copy(trail.previousSpawnPosition);
      spawnPosition.value.copy(trail.spawnPosition);

      renderer.compute(spawnParticles);

      trail.spawnIndex = (trail.spawnIndex + nbToSpawn.value) % particlesPerTrail;
    }

    audioIsPlaying = true;
  }


  if (sourceDot) {
    if (displayTrail) {
      sourceDot.position.copy(displayTrail.spawnPosition);
    }

    const sourcePulse = 1.0 + smoothedLevel * 1.8;
    sourceDot.scale.setScalar(sourcePulse);

    const brightness = THREE.MathUtils.clamp(colorBrightness.value, 0.6, 2.4);
      if (displayTrail) {
      const dotColor = new THREE.Color().setHSL(
        displayTrail.hue,
        displayTrail.saturation,
        0.65
      );

      sourceDot.material.color.setRGB(
        dotColor.r * brightness,
        dotColor.g * brightness,
        dotColor.b * brightness
      );
    }
  }

  if (audioIsPlaying) {
    colorOffset.value += delta * colorRotationSpeed.value * timeScale.value * 0.03;
  }

  light.position.set(
    Math.sin(elapsedTime * 0.5) * 30,
    Math.cos(elapsedTime * 0.3) * 30,
    Math.sin(elapsedTime * 0.2) * 30
  );

  worldSpinAngle += (Math.PI * 2 / 60) * AUTO_ROTATE_SPEED * delta;
  worldGroup.quaternion.setFromAxisAngle(WORLD_UP, -worldSpinAngle);

  controls.update();
  renderer.render(scene, camera);
}

function getMicPageUrl(micBase) {
  return buildMicPageUrl(
    micBase,
    resolvedApiUrl,
    import.meta.env.VITE_UPLOAD_SECRET
  );
}

function updatePhoneStatus(text, type = '') {
  if (type === 'is-error') {
    console.warn(text);
  }
}

async function createPhoneUploadUI() {
  const network = await resolveNetworkUrls();
  resolvedApiUrl = network.apiUrl;

  const panel = document.createElement('div');
  panel.id = 'phone-upload-panel';

  const slot = document.createElement('div');
  slot.className = 'phone-qr-slot';

  const qrWrap = document.createElement('div');
  qrWrap.className = 'phone-qr-wrap';
  qrWrap.title = 'Nascondi QR code';
  const qrCanvas = document.createElement('canvas');
  qrWrap.appendChild(qrCanvas);
  slot.appendChild(qrWrap);

  const recall = document.createElement('button');
  recall.type = 'button';
  recall.className = 'phone-qr-recall';
  recall.textContent = 'QR code';
  recall.setAttribute('aria-label', 'QR code');
  slot.appendChild(recall);

  panel.appendChild(slot);

  qrWrap.addEventListener('click', () => {
    panel.classList.add('is-hidden');
  });

  recall.addEventListener('click', () => {
    panel.classList.remove('is-hidden');
  });

  document.body.appendChild(panel);

  phoneUiElements = { qrCanvas, panel };

  const micUrl = getMicPageUrl(network.micBase);

  if (!network.isPhoneReady) {
    updatePhoneStatus('QR con localhost: il telefono non può aprirlo', 'is-error');
  }

  try {
    await QRCode.toCanvas(qrCanvas, micUrl, {
      width: 96,
      margin: 1,
      color: {
        dark: '#ffffff',
        light: '#00000000',
      },
    });
  } catch (error) {
    console.error(error);
    updatePhoneStatus('QR code non disponibile', 'is-error');
  }

  startPhoneUploadPolling();
}

function startPhoneUploadPolling() {
  if (stopPolling) stopPolling();

  stopPolling = startUploadPolling({
    apiUrl: resolvedApiUrl,
    intervalMs: POLL_INTERVAL_MS,
    onStatusChange: (state, lastId, error) => {
      if (state === 'connected') {
        updatePhoneStatus(
          lastId > 0
            ? `In ascolto… (${lastId} registrazioni ricevute)`
            : 'In ascolto… in attesa di registrazioni',
          'is-ready'
        );
        return;
      }

      updatePhoneStatus(`Backend non raggiungibile (${resolvedApiUrl})`, 'is-error');
      if (error) console.warn(error);
    },
    onNewUpload: handleNewPhoneUpload,
  });
}

async function playTrailRecording(audioBuffer) {
  stopCurrentAudioSource();

  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  audioSource = audioContext.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.connect(audioContext.destination);

  const source = audioSource;
  source.addEventListener('ended', () => {
    if (audioSource === source) {
      audioSource = null;
    }
  });

  source.start(0);
}

function unlockAudioPlayback() {
  const unlock = async () => {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext();
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
  };

  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
}

function peekNextPositionIndex() {
  let excludePosition = null;

  if (activeTrails.length >= maxActiveTrails) {
    excludePosition = activeTrails[0]?.positionIndex ?? null;
  }

  return allocatePositionIndex(excludePosition);
}

async function publishTrailState(overrides = {}) {
  if (!resolvedApiUrl) return;

  try {
    await fetch(`${resolvedApiUrl}/trail-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nextPositionIndex: peekNextPositionIndex(),
        ...overrides,
      }),
    });
  } catch (error) {
    console.warn('Impossibile pubblicare trail-state:', error);
  }
}

async function handleNewPhoneUpload(upload) {
  updatePhoneStatus(`Nuova registrazione #${upload.id}…`, '');

  await publishTrailState({ processingUploadId: upload.id, drawingUploadId: null });

  try {
    const arrayBuffer = await fetchUploadAudio(resolvedApiUrl, upload.id);
    const { frames, audioBuffer } = await extractBreathFramesFromArrayBuffer(
      arrayBuffer,
      microphoneSettings,
      breathLearnDuration
    );

    if (frames.length === 0) {
      throw new Error('Nessun frame audio estratto');
    }

    simulationPaused = false;

    const { slot, positionIndex } = prepareSlotForNewTrail();

    const trail = createTrail(activeTrailNumber, slot, positionIndex);
    activeTrailNumber += 1;

    trail.mode = 'loop';
    trail.loopFrames = frames;
    trail.loopDuration = frames.length / 60;
    trail.loopElapsed = 0;

    activeTrails.push(trail);
    displayTrail = trail;
    audioStarted = true;
    audioIsPlaying = true;

    await publishTrailState({
      processingUploadId: upload.id,
      drawingUploadId: upload.id,
      lastTrailPositionIndex: positionIndex,
    });

    await playTrailRecording(audioBuffer);

    await publishTrailState({
      processingUploadId: null,
      drawingUploadId: null,
      lastCompletedUploadId: upload.id,
      lastTrailPositionIndex: positionIndex,
    });

    updatePhoneStatus(`Scia #${upload.id} creata (${upload.originalName || 'audio'})`, 'is-ready');
  } catch (error) {
    console.error(error);
    await publishTrailState({ processingUploadId: null, drawingUploadId: null });
    updatePhoneStatus(`Errore scia #${upload.id}: ${error.message}`, 'is-error');
  }
}

function getTrailPosition(positionIndex) {
  const direction = TRAIL_POSITION_DIRECTIONS[positionIndex % TRAIL_POSITION_DIRECTIONS.length];

  if (positionIndex === 0 && direction.lengthSq() === 0) {
    return new THREE.Vector3(0.0, 0.0, 0.0);
  }

  return direction.clone().normalize().multiplyScalar(TRAIL_SPREAD_DISTANCE);
}

function getOccupiedPositionIndices(excludePosition = null) {
  const occupied = new Set();

  for (const trail of activeTrails) {
    occupied.add(trail.positionIndex);
  }

  for (const entry of fadingTrails) {
    occupied.add(entry.trail.positionIndex);
  }

  if (excludePosition !== null) {
    occupied.add(excludePosition);
  }

  return occupied;
}

function getUsedParticleSlots() {
  const used = new Set();

  for (const trail of activeTrails) {
    used.add(trail.slot);
  }

  for (const entry of fadingTrails) {
    used.add(entry.trail.slot);
  }

  return used;
}

function finishTrailFade(entry) {
  clearTrailParticleSlot(entry.trail.particleStart);

  const fadeIndex = fadingTrails.indexOf(entry);
  if (fadeIndex !== -1) {
    fadingTrails.splice(fadeIndex, 1);
  }

  if (displayTrail === entry.trail) {
    displayTrail = activeTrails[activeTrails.length - 1] || null;
  }
}

function updateFadingTrails(delta) {
  if (!fadeTrailParticlesCompute || fadingTrails.length === 0) return;

  fadeTrailRate.value = 1.0 / TRAIL_FADE_DURATION;

  for (let i = fadingTrails.length - 1; i >= 0; i--) {
    const entry = fadingTrails[i];
    entry.elapsed += delta;

    fadeTrailParticleStart.value = entry.trail.particleStart;
    renderer.compute(fadeTrailParticlesCompute);

    if (entry.elapsed >= TRAIL_FADE_DURATION) {
      finishTrailFade(entry);
    }
  }
}

function startTrailFadeOut(trail) {
  fadingTrails.push({ trail, elapsed: 0 });
}

function allocateParticleSlot() {
  const used = getUsedParticleSlots();

  for (let slot = 0; slot < maxParticleSlots; slot++) {
    if (!used.has(slot)) return slot;
  }

  if (fadingTrails.length > 0) {
    finishTrailFade(fadingTrails[0]);
    return allocateParticleSlot();
  }

  return 0;
}

function allocatePositionIndex(excludePosition = null) {
  const occupied = getOccupiedPositionIndices(excludePosition);

  for (let i = 0; i < TRAIL_POSITION_DIRECTIONS.length; i++) {
    if (!occupied.has(i)) return i;
  }

  for (let i = 1; i < TRAIL_POSITION_DIRECTIONS.length; i++) {
    if (i !== excludePosition) return i;
  }

  return 0;
}

function prepareSlotForNewTrail() {
  let excludePosition = null;

  if (activeTrails.length >= maxActiveTrails) {
    const oldestTrail = activeTrails.shift();
    excludePosition = oldestTrail.positionIndex;
    startTrailFadeOut(oldestTrail);

    if (recordingTrail === oldestTrail) {
      recordingTrail = null;
    }
  }

  return {
    slot: allocateParticleSlot(),
    positionIndex: allocatePositionIndex(excludePosition),
  };
}

function clearTrailParticleSlot(particleStart) {
  if (!clearTrailParticlesCompute) return;

  clearTrailParticleStart.value = particleStart;
  renderer.compute(clearTrailParticlesCompute);
}

function stopCurrentAudioSource() {
  if (audioSource) {
    try {
      audioSource.stop();
    } catch (error) {
      // Source already stopped.
    }

    audioSource.disconnect();
    audioSource = null;
  }

  if (microphoneSource) {
    microphoneSource.disconnect();
    microphoneSource = null;
  }

  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => {
      track.stop();
    });

    microphoneStream = null;
  }

  if (audioGain) {
    audioGain.disconnect();
    audioGain = null;
  }
}

function stopAllTrails() {
  stopCurrentAudioSource();

  audioIsPlaying = false;
  audioStarted = false;
  simulationPaused = true;
  recordingTrail = null;

  smoothedLevel = 0;
}

function createTrail(index, slot, positionIndex) {
  const startPosition = getTrailPosition(positionIndex);
  const homePosition = startPosition.clone();
  const paletteIndex = positionIndex % 10;
  const trailPalettes = [
    {
      hue: 0.58,
      colorA: new THREE.Vector3(0.0, 0.35, 1.0), // blu elettrico
      colorB: new THREE.Vector3(0.0, 1.0, 1.0),  // ciano
      colorC: new THREE.Vector3(0.4, 0.0, 1.0),  // violetto
      saturation: 1.0
    },
    {
      hue: 0.08,
      colorA: new THREE.Vector3(1.0, 0.18, 0.0), // rosso/arancio
      colorB: new THREE.Vector3(1.0, 0.75, 0.0), // oro
      colorC: new THREE.Vector3(1.0, 0.02, 0.25), // rosa caldo
      saturation: 1.0
    },
    {
      hue: 0.33,
      colorA: new THREE.Vector3(0.0, 1.0, 0.15), // verde acido
      colorB: new THREE.Vector3(0.55, 1.0, 0.0), // lime
      colorC: new THREE.Vector3(0.0, 0.75, 0.35), // smeraldo
      saturation: 1.0
    },
    {
      hue: 0.78,
      colorA: new THREE.Vector3(0.65, 0.0, 1.0), // viola
      colorB: new THREE.Vector3(1.0, 0.0, 0.95), // magenta
      colorC: new THREE.Vector3(0.25, 0.0, 1.0), // indaco
      saturation: 1.0
    },
    {
      hue: 0.55,
      colorA: new THREE.Vector3(0.0, 0.9, 1.0), // acqua
      colorB: new THREE.Vector3(0.0, 0.45, 1.0), // azzurro
      colorC: new THREE.Vector3(0.0, 1.0, 0.65), // menta
      saturation: 1.0
    },
    {
      hue: 0.95,
      colorA: new THREE.Vector3(1.0, 0.0, 0.35),
      colorB: new THREE.Vector3(1.0, 0.0, 0.75),
      colorC: new THREE.Vector3(0.9, 0.0, 0.15),
      saturation: 1.0
    },
    {
      hue: 0.15,
      colorA: new THREE.Vector3(1.0, 0.55, 0.0),
      colorB: new THREE.Vector3(1.0, 0.85, 0.2),
      colorC: new THREE.Vector3(0.85, 0.25, 0.0),
      saturation: 1.0
    },
    {
      hue: 0.48,
      colorA: new THREE.Vector3(0.0, 0.75, 0.95),
      colorB: new THREE.Vector3(0.15, 0.55, 1.0),
      colorC: new THREE.Vector3(0.0, 0.95, 0.75),
      saturation: 1.0
    },
    {
      hue: 0.68,
      colorA: new THREE.Vector3(0.55, 0.0, 0.95),
      colorB: new THREE.Vector3(0.85, 0.15, 1.0),
      colorC: new THREE.Vector3(0.35, 0.0, 0.85),
      saturation: 1.0
    },
    {
      hue: 0.02,
      colorA: new THREE.Vector3(1.0, 0.25, 0.05),
      colorB: new THREE.Vector3(1.0, 0.55, 0.15),
      colorC: new THREE.Vector3(0.95, 0.05, 0.2),
      saturation: 1.0
    }
  ];

  const trailPalette = trailPalettes[paletteIndex];

  return {
    slot,
    positionIndex,
    particleStart: slot * particlesPerTrail,
    spawnIndex: 0,

    hue: trailPalette.hue,
    colorA: trailPalette.colorA,
    colorB: trailPalette.colorB,
    colorC: trailPalette.colorC,
    saturation: trailPalette.saturation,
    homePosition,

    position: startPosition.clone(),
    velocity: new THREE.Vector3(),

    direction: new THREE.Vector3(
      1.0,
      0.28 + slot * 0.07,
      0.16 - slot * 0.05
    ).normalize(),

    targetDirection: new THREE.Vector3(),
    wanderPhase: slot * 2.17,

    spawnPosition: startPosition.clone(),
    previousSpawnPosition: startPosition.clone(),
    audioDrivenPosition: startPosition.clone(),

    smoothedLevel: 0,
    smoothedLowBand: 0,
    smoothedMidBand: 0,
    smoothedHighBand: 0,
    previousFrequencyBalance: 0,

    recordElapsed: 0,
    loopElapsed: 0,
    recordedFrames: [],
    loopFrames: [],

    mode: 'recording'
  };
}

async function startMicrophoneRecording(deviceId = null) {
  stopCurrentAudioSource();

  if (audioContext) {
    await audioContext.close();
  }

  simulationPaused = false;

  const { slot, positionIndex } = prepareSlotForNewTrail();

  const trail = createTrail(activeTrailNumber, slot, positionIndex);
  activeTrailNumber++;

  activeTrails.push(trail);
  recordingTrail = trail;
  displayTrail = trail;

  audioContext = new AudioContext();

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.86;

  frequencyData = new Uint8Array(analyser.frequencyBinCount);
  waveformData = new Uint8Array(analyser.fftSize);

  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1
  };

  if (deviceId) {
    audioConstraints.deviceId = {
      exact: deviceId
    };
  }

  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: false
  });

  microphoneSource = audioContext.createMediaStreamSource(microphoneStream);

  audioGain = audioContext.createGain();
  audioGain.gain.value = microphoneSettings.inputGain;

  microphoneSource.connect(audioGain);
  audioGain.connect(analyser);

  // Non colleghiamo analyser a audioContext.destination,
  // così non senti il microfono rientrare nelle casse/cuffie.
  // analyser.connect(audioContext.destination);

  audioStarted = true;
  audioIsPlaying = true;
}

function readBreathFrameFromAnalyser() {
  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(waveformData);

  let sum = 0;

  for (let i = 0; i < waveformData.length; i++) {
    const v = (waveformData[i] - 128) / 128;
    sum += v * v;
  }

  const rms = Math.sqrt(sum / waveformData.length);
  const noiseFloor = 0.006;
  const cleanedRms = Math.max(0, rms - noiseFloor);

  const level = THREE.MathUtils.clamp(
    cleanedRms * microphoneSettings.breathSensitivity,
    0,
    1
  );

  const breathStart = 1;
  const breathEnd = Math.floor(frequencyData.length * 0.035);

  const lowStart = breathEnd;
  const lowEnd = Math.floor(frequencyData.length * 0.12);

  const midStart = lowEnd;
  const midEnd = Math.floor(frequencyData.length * 0.34);

  const highStart = midEnd;
  const highEnd = Math.floor(frequencyData.length * 0.72);

  let lowBand = 0;
  let midBand = 0;
  let highBand = 0;

  for (let i = lowStart; i < lowEnd; i++) {
    const value = frequencyData[i] / 255;
    lowBand += value * value;
  }

  for (let i = midStart; i < midEnd; i++) {
    const value = frequencyData[i] / 255;
    midBand += value * value;
  }

  for (let i = highStart; i < highEnd; i++) {
    const value = frequencyData[i] / 255;
    highBand += value * value;
  }

  lowBand = Math.sqrt(lowBand / Math.max(1, lowEnd - lowStart));
  midBand = Math.sqrt(midBand / Math.max(1, midEnd - midStart));
  highBand = Math.sqrt(highBand / Math.max(1, highEnd - highStart));

  lowBand = THREE.MathUtils.clamp(lowBand * microphoneSettings.lowSensitivity, 0, 1);
  midBand = THREE.MathUtils.clamp(midBand * microphoneSettings.midSensitivity, 0, 1);
  highBand = THREE.MathUtils.clamp(highBand * microphoneSettings.highSensitivity, 0, 1);

  return {
    level,
    lowBand,
    midBand,
    highBand
  };
}

function getLoopedBreathFrame(trail, delta) {
  if (trail.mode === 'recording') {
    const frame = readBreathFrameFromAnalyser();

    trail.recordedFrames.push(frame);
    trail.recordElapsed += delta;

    if (trail.recordElapsed >= breathLearnDuration) {
      trail.loopFrames = trail.recordedFrames.slice();
      trail.mode = 'loop';
      trail.loopElapsed = 0;

      if (recordingTrail === trail) {
        stopCurrentAudioSource();
        recordingTrail = null;
      }
    }

    return frame;
  }

  if (trail.mode === 'loop' && trail.loopFrames.length > 0) {
    const loopDuration = trail.loopDuration || breathLearnDuration;
    trail.loopElapsed += delta;

    const loopProgress = (trail.loopElapsed % loopDuration) / loopDuration;
    const exactIndex = loopProgress * trail.loopFrames.length;

    const indexA = Math.floor(exactIndex) % trail.loopFrames.length;
    const indexB = (indexA + 1) % trail.loopFrames.length;
    const mixAmount = exactIndex - Math.floor(exactIndex);

    const a = trail.loopFrames[indexA];
    const b = trail.loopFrames[indexB];

    return {
      level: THREE.MathUtils.lerp(a.level, b.level, mixAmount),
      lowBand: THREE.MathUtils.lerp(a.lowBand, b.lowBand, mixAmount),
      midBand: THREE.MathUtils.lerp(a.midBand, b.midBand, mixAmount),
      highBand: THREE.MathUtils.lerp(a.highBand, b.highBand, mixAmount)
    };
  }

  return {
    level: 0,
    lowBand: 0,
    midBand: 0,
    highBand: 0
  };
}

function updateAudioDrivenPosition(trail, delta) {
  if (!audioStarted) return;

  const breathFrame = getLoopedBreathFrame(trail, delta);

  const level = breathFrame.level;
  const lowBand = breathFrame.lowBand;
  const midBand = breathFrame.midBand;
  const highBand = breathFrame.highBand;

  trail.smoothedLevel = THREE.MathUtils.lerp(trail.smoothedLevel, level, 0.12);

  smoothedLevel = trail.smoothedLevel;

  audioPhase += delta * (0.65 + trail.smoothedLevel * 1.8);

  trail.smoothedLowBand = THREE.MathUtils.lerp(trail.smoothedLowBand, lowBand, 0.08);
  trail.smoothedMidBand = THREE.MathUtils.lerp(trail.smoothedMidBand, midBand, 0.08);
  trail.smoothedHighBand = THREE.MathUtils.lerp(trail.smoothedHighBand, highBand, 0.08);

  smoothedLowBand = trail.smoothedLowBand;
  smoothedMidBand = trail.smoothedMidBand;
  smoothedHighBand = trail.smoothedHighBand;

  const totalFrequencyEnergy = THREE.MathUtils.clamp(
    smoothedLowBand + smoothedMidBand + smoothedHighBand,
    0,
    1
  );

  const frequencyBalance =
    smoothedHighBand * 1.2 +
    smoothedMidBand * 0.35 -
    smoothedLowBand * 0.9;

  const frequencyChange = frequencyBalance - trail.previousFrequencyBalance  ;
  trail.previousFrequencyBalance = THREE.MathUtils.lerp(
    trail.previousFrequencyBalance,
    frequencyBalance,
    0.06
  );

    // Movimento quasi fermo quando il suono è calmo.
  const motionAmount = THREE.MathUtils.smoothstep(totalFrequencyEnergy, 0.08, 0.55);

  // La direzione non viene ricavata direttamente da una posizione circolare.
  // Qui l'audio piega una direzione persistente, così la scia continua
  // ad avanzare nello spazio invece di orbitare sempre intorno allo stesso punto.
  trail.wanderPhase += delta * (
    0.45 +
    motionAmount * 1.35 +
    smoothedHighBand * 1.4
  ) * trajectoryParams.directionChange;

  trail.targetDirection.set(
    Math.sin(trail.wanderPhase * 0.73 + smoothedMidBand * 5.0),
    Math.sin(trail.wanderPhase * 1.11 + frequencyBalance * 3.0),
    Math.cos(trail.wanderPhase * 0.91 + smoothedLowBand * 4.0)
  );

  // I cambiamenti di spettro danno una sterzata, ma non resettano la traiettoria.
  trail.targetDirection.x += frequencyChange * 3.0;
  trail.targetDirection.y += (smoothedHighBand - smoothedLowBand) * 1.4;
  trail.targetDirection.z += (smoothedMidBand - 0.25) * 1.2;

  if (trail.targetDirection.lengthSq() > 0.0001) {
    trail.targetDirection.normalize();
  }

  // La direzione reale cambia lentamente: questo elimina l'effetto "giro in tondo"
  // e crea una scia che prende sempre nuove direzioni.
  trail.direction.lerp(
    trail.targetDirection,
    0.018 + motionAmount * 0.05 + Math.abs(frequencyChange) * 0.08
  );
  trail.direction.normalize();

  // Velocità della testa della scia.
  // Se il suono è tranquillo, questa velocità diventa molto bassa.
  const trajectorySpeed =
    (0.025 +
    motionAmount * 0.18 +
    smoothedHighBand * 0.045) * trajectoryParams.speed;

  // Accelerazione morbida nella direzione persistente.
  trail.velocity.lerp(
    trail.direction.clone().multiplyScalar(trajectorySpeed * trajectoryParams.forwardPush),
    0.04 + motionAmount * 0.09
  );

  // Freno: più il suono è calmo, più la testa si ferma.
  const calmBrake = THREE.MathUtils.lerp(0.88, 0.985, motionAmount);
  trail.velocity.multiplyScalar(calmBrake);

  trail.position.add(trail.velocity);

  // Limite spaziale morbido: invece di rimbalzare/orbitare sul bordo,
  // la scia viene reindirizzata verso una nuova direzione interna.
  const maxDistance = trajectoryParams.range;

  // Ora il limite non è più rispetto al centro globale della scena,
  // ma rispetto al centro personale della singola scia.
  const offsetFromHome = trail.position.clone().sub(trail.homePosition);

  if (offsetFromHome.length() > maxDistance) {
    const inwardDirection = offsetFromHome.clone().normalize().multiplyScalar(-1);

    trail.position.copy(
      trail.homePosition.clone().add(
        offsetFromHome.setLength(maxDistance * 0.96)
      )
    );

    trail.direction.lerp(inwardDirection, 0.32).normalize();
    trail.velocity.add(inwardDirection.multiplyScalar(trajectorySpeed * 0.65));
    trail.velocity.multiplyScalar(0.78);
  }

  trail.audioDrivenPosition.copy(trail.position);

  turbAmplitude.value = THREE.MathUtils.lerp(
    turbAmplitude.value,
    0.25 + smoothedLevel * 2.4 + highBand * 1.2,
    0.08
  );

  nbToSpawn.value = THREE.MathUtils.lerp(
    nbToSpawn.value,
    8 + smoothedLevel * 70,
    0.08
  );

  cymaticLevel.value = THREE.MathUtils.lerp(
    cymaticLevel.value,
    smoothedLevel,
    0.16
  );

  cymaticLow.value = THREE.MathUtils.lerp(
    cymaticLow.value,
    lowBand,
    0.14
  );

  cymaticMid.value = THREE.MathUtils.lerp(
    cymaticMid.value,
    midBand,
    0.14
  );

  cymaticHigh.value = THREE.MathUtils.lerp(
    cymaticHigh.value,
    highBand,
    0.14
  );

  cymaticPhase.value += delta * (1.2 + smoothedLevel * 5.0);

  const brightnessContrast = THREE.MathUtils.clamp(
    (highBand * 2.2) - (lowBand * 1.4) + midBand * 0.25,
    -1.2,
    1.2
  );

  const audioBrightness = THREE.MathUtils.clamp(
    0.95 + brightnessContrast * 1.6 + smoothedLevel * 0.55,
    0.08,
    4.0
  );

  colorBrightness.value = THREE.MathUtils.lerp(
    colorBrightness.value,
    audioBrightness,
    0.28
  );
}

