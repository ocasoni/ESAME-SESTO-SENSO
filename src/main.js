import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import GUI from 'lil-gui';
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

let camera, scene, renderer, controls, clock, light;
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

const maxTrailSlots = 6;

// Ogni scia mantiene la stessa quantità di particelle che aveva prima.
// Così il comportamento visivo della scia rimane uguale.
const particlesPerTrail = Math.pow(2, 14);
const nbParticles = particlesPerTrail * maxTrailSlots;

const currentTrailParticleStart = uniform(0);

const timeScale = uniform(0.8);
const particleLifetime = uniform(0.65);
const particleSize = uniform(0.45);

const colorOffset = uniform(0.0);
const colorBrightness = uniform(1.25);
const colorRotationSpeed = uniform(0.4);
const trailHue = uniform(0.58);
const currentTrailHue = uniform(0.58);

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

init();

async function init() {
  if (WebGPU.isAvailable() === false) {
    document.body.appendChild(WebGPU.getErrorMessage());
    throw new Error('No WebGPU support');
  }

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0, 10);

  scene = new THREE.Scene();

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
    const base = hue(color(0x0066ff), currentTrailHue.add(colorOffset));

    return base.mul(colorBrightness);
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
  scene.add(particleMesh);

  const sourceDotGeom = new THREE.SphereGeometry(0.035, 24, 24);
  const sourceDotMaterial = new THREE.MeshBasicMaterial({
    color: 0xff66ff,
    transparent: true,
    opacity: 1.0
  });

  sourceDot = new THREE.Mesh(sourceDotGeom, sourceDotMaterial);
  sourceDot.frustumCulled = false;
  scene.add(sourceDot);

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
  scene.add(backgroundMesh);

  light = new THREE.PointLight(0xffffff, 3000);
  scene.add(light);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = false;
  controls.maxDistance = 75;

  window.addEventListener('resize', onWindowResize);

  createAudioStartButton();

  const gui = new GUI({ title: 'Parameters' });

  gui.add(controls, 'autoRotate').name('Auto Rotate');
  gui.add(controls, 'autoRotateSpeed', -10.0, 10.0, 0.01).name('Auto Rotate Speed');

  const partFolder = gui.addFolder('Particles');
  partFolder.add(timeScale, 'value', 0.0, 4.0, 0.01).name('timeScale');
  partFolder.add(nbToSpawn, 'value', 1, 100, 1).name('Spawn rate');
  partFolder.add(particleSize, 'value', 0.01, 3.0, 0.01).name('Size');
  partFolder.add(particleLifetime, 'value', 0.01, 2.0, 0.01).name('Lifetime');
  partFolder.add(colorRotationSpeed, 'value', 0.0, 5.0, 0.01).name('Color rotation speed');

  const trajectoryFolder = gui.addFolder('Trajectory');
  trajectoryFolder.add(trajectoryParams, 'speed', 0.1, 3.0, 0.01).name('Audio speed');
  trajectoryFolder.add(trajectoryParams, 'smoothness', 0.02, 0.5, 0.01).name('Smoothness');
  trajectoryFolder.add(trajectoryParams, 'range', 1.0, 8.0, 0.1).name('Range');
  trajectoryFolder.add(trajectoryParams, 'directionChange', 0.05, 1.5, 0.01).name('Direction change');
  trajectoryFolder.add(trajectoryParams, 'forwardPush', 0.1, 2.5, 0.01).name('Forward push');

  const cymaticFolder = gui.addFolder('Cymatics');
  cymaticFolder.add(cymaticScale, 'value', 0.05, 2.0, 0.01).name('Section scale');
  cymaticFolder.add(cymaticDepth, 'value', 0.0, 1.0, 0.01).name('Section depth');


  const turbFolder = gui.addFolder('Turbulence');
  turbFolder.add(turbFriction, 'value', 0.0, 0.3, 0.01).name('Friction');
  turbFolder.add(turbFrequency, 'value', 0.0, 1.0, 0.01).name('Frequency');
  turbFolder.add(turbOctaves, 'value', 1, 9, 1).name('Octaves');
  turbFolder.add(turbLacunarity, 'value', 1.0, 5.0, 0.01).name('Lacunarity');
  turbFolder.add(turbGain, 'value', 0.0, 1.0, 0.01).name('Gain');

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
      currentTrailHue.value = trail.hue;
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
      const dotColor = new THREE.Color().setHSL(displayTrail.hue, 1.0, 0.65);

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

  controls.update();
  renderer.render(scene, camera);
}

function createAudioStartButton() {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'absolute';
  wrapper.style.left = '50%';
  wrapper.style.bottom = '32px';
  wrapper.style.transform = 'translateX(-50%)';
  wrapper.style.zIndex = '20';
  wrapper.style.display = 'flex';
  wrapper.style.gap = '10px';
  wrapper.style.alignItems = 'center';

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.style.display = 'none';

  const button = document.createElement('button');
  button.textContent = 'Load audio';
  button.style.padding = '12px 18px';
  button.style.border = '1px solid rgba(255,255,255,0.25)';
  button.style.borderRadius = '8px';
  button.style.background = 'rgba(255,255,255,0.1)';
  button.style.color = '#fff';
  button.style.font = '14px Arial, sans-serif';
  button.style.cursor = 'pointer';

  const label = document.createElement('span');
  label.textContent = 'No file selected';
  label.style.color = 'rgba(255,255,255,0.75)';
  label.style.font = '13px Arial, sans-serif';

  button.addEventListener('click', () => {
    input.click();
  });

  const stopButton = document.createElement('button');
  stopButton.textContent = 'Stop';
  stopButton.style.padding = '12px 18px';
  stopButton.style.border = '1px solid rgba(255,255,255,0.25)';
  stopButton.style.borderRadius = '8px';
  stopButton.style.background = 'rgba(255,255,255,0.1)';
  stopButton.style.color = '#fff';
  stopButton.style.font = '14px Arial, sans-serif';
  stopButton.style.cursor = 'pointer';

  stopButton.addEventListener('click', stopAllTrails);

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;

    label.textContent = file.name;
    await startAudioFile(file);
  });

  wrapper.appendChild(input);
  wrapper.appendChild(button);
  wrapper.appendChild(stopButton);
  wrapper.appendChild(label);

  document.body.appendChild(wrapper);
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
}

function stopAllTrails() {
  stopCurrentAudioSource();

  audioIsPlaying = false;
  audioStarted = false;
  simulationPaused = true;
  recordingTrail = null;

  smoothedLevel = 0;
}

function getTrailStartPosition(index) {
  const slot = index % maxTrailSlots;

  const positions = [
    new THREE.Vector3(-3.4,  2.1,  1.4),
    new THREE.Vector3( 3.4, -2.0, -1.5),
    new THREE.Vector3(-3.2, -2.2, -1.6),
    new THREE.Vector3( 3.2,  2.0,  1.7),
    new THREE.Vector3( 0.0,  3.2, -2.0),
    new THREE.Vector3( 0.0, -3.2,  2.0)
  ];

  return positions[slot].clone();
}

function createTrail(index) {
  const slot = index % maxTrailSlots;
  const startPosition = getTrailStartPosition(index);
  const trailHues = [
    0.58, // blu / ciano
    0.82, // viola / magenta
    0.08, // arancio
    0.33, // verde
    0.95, // rosa / rosso
    0.48  // turchese
  ];

  const trailHueValue = trailHues[slot];

  return {
    slot,
    particleStart: slot * particlesPerTrail,
    spawnIndex: 0,

    hue: trailHueValue,

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

async function startAudioFile(file) {
  stopCurrentAudioSource();

  if (audioContext) {
    await audioContext.close();
  }

  simulationPaused = false;

  const trail = createTrail(activeTrailNumber);
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

  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  audioSource = audioContext.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.loop = true;

  audioGain = audioContext.createGain();
  audioGain.gain.value = 0.8;

  audioSource.connect(audioGain);
  audioGain.connect(analyser);
  analyser.connect(audioContext.destination);

  audioSource.start();

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
  const level = THREE.MathUtils.clamp(rms * 8.0, 0, 1);

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

  lowBand = THREE.MathUtils.clamp(lowBand * 2.2, 0, 1);
  midBand = THREE.MathUtils.clamp(midBand * 2.8, 0, 1);
  highBand = THREE.MathUtils.clamp(highBand * 5.5, 0, 1);

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
    trail.loopElapsed += delta;

    const loopProgress = (trail.loopElapsed % breathLearnDuration) / breathLearnDuration;
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

  if (trail.position.length() > maxDistance) {
    const inwardDirection = trail.position.clone().normalize().multiplyScalar(-1);

    trail.position.setLength(maxDistance * 0.96);
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

