import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import GUI from 'lil-gui';
import {
  abs,
  atan,
  color,
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

const audioTargetPosition = new THREE.Vector3();
const audioRandomPosition = new THREE.Vector3();

const audioVelocity = new THREE.Vector3();
let previousLevel = 0;
let directionCooldown = 0;

let audioSource = null;
let audioGain = null;
let audioIsPlaying = false;

const spawnParticleSize = uniform(1.0);
const spawnSpread = uniform(0.08);
const spawnLinksWidth = uniform(0.005);

const cymaticLevel = uniform(0.0);
const cymaticLow = uniform(0.0);
const cymaticMid = uniform(0.0);
const cymaticHigh = uniform(0.0);
const cymaticPhase = uniform(0.0);
const cymaticScale = uniform(0.55);
const cymaticDepth = uniform(0.18);

const TWO_PI = PI.mul(2.0);

const screenPointer = new THREE.Vector2();
const scenePointer = new THREE.Vector3();
const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const raycaster = new THREE.Raycaster();

const nbParticles = Math.pow(2, 14);

const timeScale = uniform(1.0);
const particleLifetime = uniform(0.8);
const particleSize = uniform(2.5);
const linksWidth = uniform(0.025);

const colorOffset = uniform(0.0);
const colorVariance = uniform(2.0);
const colorRotationSpeed = uniform(1.0);

const spawnIndex = uniform(0);
const nbToSpawn = uniform(5);
const spawnPosition = uniform(vec3(0.0));
const previousSpawnPosition = uniform(vec3(0.0));

const turbFrequency = uniform(0.5);
const turbAmplitude = uniform(0.5);
const turbOctaves = uniform(2);
const turbLacunarity = uniform(2.0);
const turbGain = uniform(0.5);
const turbFriction = uniform(0.01);

const freezeLifeThreshold = uniform(0.90);

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
    return hue(color(0x0000ff), colorOffset.add(mx_fractal_noise_float(i.toFloat().mul(0.1), 2, 2.0, 0.5, colorVariance)));
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
    })().compute(nbParticles)
  );

  const particleQuadSize = 0.05;
  const particleGeom = new THREE.PlaneGeometry(particleQuadSize, particleQuadSize);

  const particleMaterial = new THREE.SpriteNodeMaterial();
  particleMaterial.blending = THREE.AdditiveBlending;
  particleMaterial.depthWrite = false;
  particleMaterial.positionNode = particlePositions.toAttribute();
  particleMaterial.scaleNode = vec2(particleProperties.toAttribute().x);
  particleMaterial.rotationNode = atan(particleVelocities.toAttribute().y, particleVelocities.toAttribute().x);

  particleMaterial.colorNode = Fn(() => {
    const life = particlePositions.toAttribute().w;
    return particleColors.toAttribute().xyz.mul(life);
  })();

  particleMaterial.opacityNode = Fn(() => {
    const circle = step(uv().xy.sub(0.5).length(), 0.5);
    const life = particlePositions.toAttribute().w;
    return circle.mul(life);
  })();

  const particleMesh = new THREE.InstancedMesh(particleGeom, particleMaterial, nbParticles);
  particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  particleMesh.frustumCulled = false;
  scene.add(particleMesh);

  updateParticles = Fn(() => {
    const position = particlePositions.element(instanceIndex).xyz;
    const life = particlePositions.element(instanceIndex).w;
    const velocity = particleVelocities.element(instanceIndex).xyz;
    const dt = deltaTime.mul(0.1).mul(timeScale);

    If(life.greaterThan(0.0), () => {
      const frozen = particleProperties.element(instanceIndex).z;

      If(frozen.lessThan(0.5), () => {
        const localVel = mx_fractal_noise_vec3(
          position.mul(turbFrequency),
          turbOctaves,
          turbLacunarity,
          turbGain,
          turbAmplitude
        ).mul(life.add(0.01));

        velocity.addAssign(localVel);
        velocity.mulAssign(turbFriction.oneMinus());
        position.addAssign(velocity.mul(dt));

        life.subAssign(dt.mul(particleLifetime.reciprocal()));

        If(life.lessThan(freezeLifeThreshold), () => {
          life.assign(freezeLifeThreshold);
          velocity.assign(vec3(0.0));
          frozen.assign(1.0);
        });
      });
    });
  })().compute(nbParticles).label('Update Particles');

  spawnParticles = Fn(() => {
    const particleIndex = spawnIndex.add(instanceIndex).mod(nbParticles).toInt();
    const position = particlePositions.element(particleIndex).xyz;
    const life = particlePositions.element(particleIndex).w;
    const velocity = particleVelocities.element(particleIndex).xyz;
    const particleColor = particleColors.element(particleIndex);
    const particleProperty = particleProperties.element(particleIndex);

    life.assign(1.0);

    particleColor.xyz.assign(getInstanceColor(particleIndex));
    particleColor.w.assign(1.0);

    particleProperty.x.assign(spawnParticleSize);
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

    const theta = seedA.mul(TWO_PI);

    const modeA = float(2.0).add(cymaticLow.mul(10.0));
    const modeB = float(3.0).add(cymaticMid.mul(14.0));
    const modeC = float(4.0).add(cymaticHigh.mul(18.0));

    const waveA = sin(theta.mul(modeA).add(cymaticPhase));
    const waveB = cos(theta.mul(modeB).sub(cymaticPhase.mul(0.7)));
    const waveC = sin(theta.mul(modeC).add(seedB.mul(PI)));

    const cymaticField = abs(waveA.mul(waveB).add(waveC.mul(0.45)));

    const baseRadius = cymaticScale.mul(0.25).add(cymaticLevel.mul(cymaticScale));
    const ring = seedB.mul(0.85).add(0.15);

    const radius = baseRadius.mul(ring).mul(
      float(0.35).add(cymaticField.mul(1.45))
    );

    const xStretch = float(0.55)
      .add(abs(sin(theta.mul(modeA))).mul(1.25))
      .add(cymaticMid.mul(0.8));

    const yStretch = float(0.55)
      .add(abs(cos(theta.mul(modeB))).mul(1.25))
      .add(cymaticHigh.mul(0.8));

    const x = cos(theta).mul(radius).mul(xStretch);
    const y = sin(theta).mul(radius).mul(yStretch);

    const z = sin(theta.mul(modeC).add(cymaticPhase))
      .mul(cymaticDepth)
      .mul(cymaticField)
      .mul(float(0.4).add(cymaticLevel));

    const cymaticOffset = vec3(x, y, z);

    position.assign(pos.add(cymaticOffset));

    velocity.assign(
      cymaticOffset
        .mul(0.35)
        .add(vec3(seedC.sub(0.5)).mul(0.04))
    );
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
  partFolder.add(colorVariance, 'value', 0.0, 10.0, 0.01).name('Color variance');
  partFolder.add(colorRotationSpeed, 'value', 0.0, 5.0, 0.01).name('Color rotation speed');


  const cymaticFolder = gui.addFolder('Cymatics');
  cymaticFolder.add(cymaticScale, 'value', 0.05, 2.0, 0.01).name('Section scale');
  cymaticFolder.add(cymaticDepth, 'value', 0.0, 1.0, 0.01).name('Section depth');


  const turbFolder = gui.addFolder('Turbulence');
  turbFolder.add(turbFriction, 'value', 0.0, 0.3, 0.01).name('Friction');
  turbFolder.add(turbFrequency, 'value', 0.0, 1.0, 0.01).name('Frequency');
  turbFolder.add(turbAmplitude, 'value', 0.0, 10.0, 0.01).name('Amplitude');
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
  renderer.compute(updateParticles);

  if (audioIsPlaying) {
    renderer.compute(spawnParticles);
    spawnIndex.value = (spawnIndex.value + nbToSpawn.value) % nbParticles;
  }
  const delta = clock.getDelta();
  const elapsedTime = clock.getElapsedTime();

  previousSpawnPosition.value.copy(spawnPosition.value);

  if (audioStarted) {
    updateAudioDrivenPosition(delta);
    spawnPosition.value.lerp(audioDrivenPosition, 0.38);
  } else {
    raycastPlane.normal.applyEuler(camera.rotation);
    updatePointer();
    spawnPosition.value.lerp(scenePointer, 0.1);
  }

  if (audioIsPlaying) {
    colorOffset.value += delta * colorRotationSpeed.value * timeScale.value;
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
  stopButton.textContent = 'Stop audio';
  stopButton.style.padding = '12px 18px';
  stopButton.style.border = '1px solid rgba(255,255,255,0.25)';
  stopButton.style.borderRadius = '8px';
  stopButton.style.background = 'rgba(255,255,255,0.1)';
  stopButton.style.color = '#fff';
  stopButton.style.font = '14px Arial, sans-serif';
  stopButton.style.cursor = 'pointer';

  stopButton.addEventListener('click', stopAudio);

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

function stopAudio() {
  if (audioSource) {
    try {
      audioSource.stop();
    } catch (error) {
      // Source already stopped.
    }

    audioSource.disconnect();
    audioSource = null;
  }

  audioIsPlaying = false;
  audioStarted = false;
  smoothedLevel = 0;
}

async function startAudioFile(file) {
  if (audioContext) {
    await audioContext.close();
  }

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


function updateAudioDrivenPosition(delta) {
  if (!audioStarted) return;

  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(waveformData);

  let sum = 0;
  for (let i = 0; i < waveformData.length; i++) {
    const v = (waveformData[i] - 128) / 128;
    sum += v * v;
  }

  const rms = Math.sqrt(sum / waveformData.length);
  const level = THREE.MathUtils.clamp(rms * 8.0, 0, 1);
  smoothedLevel = THREE.MathUtils.lerp(smoothedLevel, level, 0.12);

  const splitIndex = Math.floor(frequencyData.length * 0.18);

  let lowSum = 0;
  let highSum = 0;

  for (let i = 0; i < frequencyData.length; i++) {
    const value = frequencyData[i] / 255;

    if (i < splitIndex) {
      lowSum += value;
    } else {
      highSum += value;
    }
  }

  const lowEnergy = lowSum / splitIndex;
  const highEnergy = highSum / (frequencyData.length - splitIndex);

  const balance = highEnergy - lowEnergy;

  audioPhase += delta * (0.65 + smoothedLevel * 1.8);

  const waveformIndex = Math.floor((audioPhase * 180) % waveformData.length);
  const waveformValue = (waveformData[waveformIndex] - 128) / 128;

  const third = Math.floor(frequencyData.length / 3);

  let lowBand = 0;
  let midBand = 0;
  let highBand = 0;

  for (let i = 0; i < frequencyData.length; i++) {
    const value = frequencyData[i] / 255;

    if (i < third) {
      lowBand += value;
    } else if (i < third * 2) {
      midBand += value;
    } else {
      highBand += value;
    }
  }

  lowBand /= third;
  midBand /= third;
  highBand /= frequencyData.length - third * 2;

  const xFromMid = (midBand - 0.18) * 10.0;
  const yFromHighLow = (highBand - lowBand) * 12.0;
  const zFromLow = (lowBand - 0.18) * 10.0;

  const waveformKick = waveformValue * (1.0 + smoothedLevel * 4.0);

  const x =
    xFromMid +
    Math.sin(audioPhase * 0.7) * 1.2 +
    waveformKick * 0.8;

  const y =
    yFromHighLow +
    waveformKick * 1.6;

  const z =
    zFromLow +
    Math.sin(audioPhase * 0.53 + midBand * 4.0) * 1.8 -
    waveformKick * 0.6;

  audioDrivenPosition.set(x, y, z);

  turbAmplitude.value = THREE.MathUtils.lerp(
    turbAmplitude.value,
    0.7 + smoothedLevel * 8.0,
    0.08
  );

  spawnParticleSize.value = THREE.MathUtils.lerp(
    spawnParticleSize.value,
    0.35 + smoothedLevel * 1.25,
    0.08
  );

  nbToSpawn.value = THREE.MathUtils.lerp(
    nbToSpawn.value,
    8 + smoothedLevel * 70,
    0.08
  );
}

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