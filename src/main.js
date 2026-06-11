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

  const micFolder = gui.addFolder('Microphone');
  micFolder.add(microphoneSettings, 'inputGain', 1.0, 20.0, 0.1).name('Input gain').onChange((value) => {
    if (audioGain) {
      audioGain.gain.value = value;
    }
  });

  micFolder.add(microphoneSettings, 'breathSensitivity', 4.0, 60.0, 0.5).name('Breath sensitivity');
  micFolder.add(microphoneSettings, 'lowSensitivity', 1.0, 20.0, 0.1).name('Low sensitivity');
  micFolder.add(microphoneSettings, 'midSensitivity', 1.0, 20.0, 0.1).name('Mid sensitivity');
  micFolder.add(microphoneSettings, 'highSensitivity', 1.0, 25.0, 0.1).name('High sensitivity');

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
  wrapper.style.flexWrap = 'wrap';
  wrapper.style.justifyContent = 'center';

  const micSelect = document.createElement('select');
  micSelect.style.padding = '12px 14px';
  micSelect.style.border = '1px solid rgba(255,255,255,0.25)';
  micSelect.style.borderRadius = '8px';
  micSelect.style.background = 'rgba(20,23,26,0.95)';
  micSelect.style.color = '#fff';
  micSelect.style.font = '14px Arial, sans-serif';
  micSelect.style.cursor = 'pointer';
  micSelect.style.maxWidth = '280px';

  const button = document.createElement('button');
  button.textContent = 'Start microphone';
  button.style.padding = '12px 18px';
  button.style.border = '1px solid rgba(255,255,255,0.25)';
  button.style.borderRadius = '8px';
  button.style.background = 'rgba(255,255,255,0.1)';
  button.style.color = '#fff';
  button.style.font = '14px Arial, sans-serif';
  button.style.cursor = 'pointer';

  const stopButton = document.createElement('button');
  stopButton.textContent = 'Stop';
  stopButton.style.padding = '12px 18px';
  stopButton.style.border = '1px solid rgba(255,255,255,0.25)';
  stopButton.style.borderRadius = '8px';
  stopButton.style.background = 'rgba(255,255,255,0.1)';
  stopButton.style.color = '#fff';
  stopButton.style.font = '14px Arial, sans-serif';
  stopButton.style.cursor = 'pointer';

  const label = document.createElement('span');
  label.textContent = 'Select the headphones microphone, then start';
  label.style.color = 'rgba(255,255,255,0.75)';
  label.style.font = '13px Arial, sans-serif';

  async function refreshMicrophones() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices.filter((device) => device.kind === 'audioinput');

      micSelect.innerHTML = '';

      if (microphones.length === 0) {
        const option = document.createElement('option');
        option.textContent = 'No microphone found';
        option.value = '';
        micSelect.appendChild(option);
        return;
      }

      microphones.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${index + 1}`;
        micSelect.appendChild(option);
      });

      selectedMicDeviceId = micSelect.value;
    } catch (error) {
      label.textContent = 'Microphone list unavailable';
      console.error(error);
    }
  }

  micSelect.addEventListener('change', () => {
    selectedMicDeviceId = micSelect.value;
  });

  button.addEventListener('click', async () => {
    await startMicrophoneRecording(selectedMicDeviceId);
    await refreshMicrophones();

    const selectedOption = micSelect.options[micSelect.selectedIndex];
    label.textContent = selectedOption
      ? `Recording from: ${selectedOption.textContent}`
      : 'Recording from microphone';
  });

  stopButton.addEventListener('click', stopAllTrails);

  wrapper.appendChild(micSelect);
  wrapper.appendChild(button);
  wrapper.appendChild(stopButton);
  wrapper.appendChild(label);

  document.body.appendChild(wrapper);

  refreshMicrophones();

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshMicrophones);
  }
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

function getTrailStartPosition(index) {
  const slot = index % maxTrailSlots;

  // La prima traccia parte sempre dal centro dello schermo/scena.
  if (index === 0) {
    return new THREE.Vector3(0.0, 0.0, 0.0);
  }

  // Distanza grande tra le altre scie.
  const trailDistance = 8.0;

  const positions = [
    // slot 0 non viene usato per la prima traccia,
    // ma resta qui per sicurezza quando i trail fanno il giro dopo maxTrailSlots.
    new THREE.Vector3(0.0, 0.0, 0.0),

    new THREE.Vector3( 1.0, -0.7, -0.9),
    new THREE.Vector3(-0.8, -1.0,  1.1),
    new THREE.Vector3( 0.9,  1.0, -1.2),
    new THREE.Vector3( 0.2,  1.4,  1.0),
    new THREE.Vector3(-0.3, -1.5, -1.1)
  ];

  return positions[slot]
    .clone()
    .normalize()
    .multiplyScalar(trailDistance);
}

function createTrail(index) {
  const slot = index % maxTrailSlots;
  const startPosition = getTrailStartPosition(index);
  const homePosition = startPosition.clone();
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
      colorA: new THREE.Vector3(1.0, 0.0, 0.35), // fucsia/rosso
      colorB: new THREE.Vector3(1.0, 0.0, 0.75), // pink
      colorC: new THREE.Vector3(0.9, 0.0, 0.15), // cremisi
      saturation: 1.0
    }
  ];

  const trailPalette = trailPalettes[slot];

  return {
    slot,
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

