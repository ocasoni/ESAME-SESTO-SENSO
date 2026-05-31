import * as THREE from 'three/webgpu';
import GUI from 'lil-gui';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import {
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
  pass,
  pcurve,
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

const TWO_PI = PI.mul(2.0);

const screenPointer = new THREE.Vector2();
const scenePointer = new THREE.Vector3();
const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const raycaster = new THREE.Raycaster();

const nbParticles = Math.pow(2, 13);

const timeScale = uniform(1.0);
const particleLifetime = uniform(0.5);
const particleSize = uniform(1.0);
const linksWidth = uniform(0.005);

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

  renderer.compute(
    Fn(() => {
      particlePositions.element(instanceIndex).xyz.assign(vec3(10000.0));
      particlePositions.element(instanceIndex).w.assign(vec3(-1.0));
    })().compute(nbParticles)
  );

  const particleQuadSize = 0.05;
  const particleGeom = new THREE.PlaneGeometry(particleQuadSize, particleQuadSize);

  const particleMaterial = new THREE.SpriteNodeMaterial();
  particleMaterial.blending = THREE.AdditiveBlending;
  particleMaterial.depthWrite = false;
  particleMaterial.positionNode = particlePositions.toAttribute();
  particleMaterial.scaleNode = vec2(particleSize);
  particleMaterial.rotationNode = atan(particleVelocities.toAttribute().y, particleVelocities.toAttribute().x);

  particleMaterial.colorNode = Fn(() => {
    const life = particlePositions.toAttribute().w;
    const modLife = pcurve(life.oneMinus(), 8.0, 1.0);
    const pulse = pcurve(
      sin(hash(instanceIndex).mul(TWO_PI).add(time.mul(0.5).mul(TWO_PI))).mul(0.5).add(0.5),
      0.25,
      0.25
    ).mul(10.0).add(1.0);

    return getInstanceColor(instanceIndex).mul(pulse.mul(modLife));
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

  const linksIndices = [];
  for (let i = 0; i < nbParticles; i++) {
    const baseIndex = i * 8;
    for (let j = 0; j < 2; j++) {
      const offset = baseIndex + j * 4;
      linksIndices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    }
  }

  const nbVertices = nbParticles * 8;
  const linksVerticesSBA = new THREE.StorageBufferAttribute(nbVertices, 4);
  const linksColorsSBA = new THREE.StorageBufferAttribute(nbVertices, 4);

  const linksGeom = new THREE.BufferGeometry();
  linksGeom.setAttribute('position', linksVerticesSBA);
  linksGeom.setAttribute('color', linksColorsSBA);
  linksGeom.setIndex(linksIndices);

  const linksMaterial = new THREE.MeshBasicNodeMaterial();
  linksMaterial.vertexColors = true;
  linksMaterial.side = THREE.DoubleSide;
  linksMaterial.transparent = true;
  linksMaterial.depthWrite = false;
  linksMaterial.depthTest = false;
  linksMaterial.blending = THREE.AdditiveBlending;
  linksMaterial.opacityNode = storage(linksColorsSBA, 'vec4', linksColorsSBA.count).toAttribute().w;

  const linksMesh = new THREE.Mesh(linksGeom, linksMaterial);
  linksMesh.frustumCulled = false;
  scene.add(linksMesh);

  updateParticles = Fn(() => {
    const position = particlePositions.element(instanceIndex).xyz;
    const life = particlePositions.element(instanceIndex).w;
    const velocity = particleVelocities.element(instanceIndex).xyz;
    const dt = deltaTime.mul(0.1).mul(timeScale);

    If(life.greaterThan(0.0), () => {
      const localVel = mx_fractal_noise_vec3(position.mul(turbFrequency), turbOctaves, turbLacunarity, turbGain, turbAmplitude).mul(life.add(0.01));
      velocity.addAssign(localVel);
      velocity.mulAssign(turbFriction.oneMinus());
      position.addAssign(velocity.mul(dt));
      life.subAssign(dt.mul(particleLifetime.reciprocal()));

      const closestDist1 = float(10000.0).toVar();
      const closestPos1 = vec3(0.0).toVar();
      const closestLife1 = float(0.0).toVar();
      const closestDist2 = float(10000.0).toVar();
      const closestPos2 = vec3(0.0).toVar();
      const closestLife2 = float(0.0).toVar();

      Loop(nbParticles, ({ i }) => {
        const otherPart = particlePositions.element(i);

        If(i.notEqual(instanceIndex).and(otherPart.w.greaterThan(0.0)), () => {
          const otherPosition = otherPart.xyz;
          const dist = position.sub(otherPosition).lengthSq();
          const moreThanZero = dist.greaterThan(0.0);

          If(dist.lessThan(closestDist1).and(moreThanZero), () => {
            closestDist1.assign(dist);
            closestPos1.assign(otherPosition.xyz);
            closestLife1.assign(otherPart.w);
          }).ElseIf(dist.lessThan(closestDist2).and(moreThanZero), () => {
            closestDist2.assign(dist);
            closestPos2.assign(otherPosition.xyz);
            closestLife2.assign(otherPart.w);
          });
        });
      });

      const linksPositions = storage(linksVerticesSBA, 'vec4', linksVerticesSBA.count);
      const linksColors = storage(linksColorsSBA, 'vec4', linksColorsSBA.count);
      const firstLinkIndex = instanceIndex.mul(8);
      const secondLinkIndex = firstLinkIndex.add(4);

      linksPositions.element(firstLinkIndex).xyz.assign(position);
      linksPositions.element(firstLinkIndex).y.addAssign(linksWidth);
      linksPositions.element(firstLinkIndex.add(1)).xyz.assign(position);
      linksPositions.element(firstLinkIndex.add(1)).y.addAssign(linksWidth.negate());
      linksPositions.element(firstLinkIndex.add(2)).xyz.assign(closestPos1);
      linksPositions.element(firstLinkIndex.add(2)).y.addAssign(linksWidth.negate());
      linksPositions.element(firstLinkIndex.add(3)).xyz.assign(closestPos1);
      linksPositions.element(firstLinkIndex.add(3)).y.addAssign(linksWidth);

      linksPositions.element(secondLinkIndex).xyz.assign(position);
      linksPositions.element(secondLinkIndex).y.addAssign(linksWidth);
      linksPositions.element(secondLinkIndex.add(1)).xyz.assign(position);
      linksPositions.element(secondLinkIndex.add(1)).y.addAssign(linksWidth.negate());
      linksPositions.element(secondLinkIndex.add(2)).xyz.assign(closestPos2);
      linksPositions.element(secondLinkIndex.add(2)).y.addAssign(linksWidth.negate());
      linksPositions.element(secondLinkIndex.add(3)).xyz.assign(closestPos2);
      linksPositions.element(secondLinkIndex.add(3)).y.addAssign(linksWidth);

      const linkColor = getInstanceColor(instanceIndex);
      const l1 = max(0.0, min(closestLife1, life)).pow(0.8);
      const l2 = max(0.0, min(closestLife2, life)).pow(0.8);

      Loop(4, ({ i }) => {
        linksColors.element(firstLinkIndex.add(i)).xyz.assign(linkColor);
        linksColors.element(firstLinkIndex.add(i)).w.assign(l1);
        linksColors.element(secondLinkIndex.add(i)).xyz.assign(linkColor);
        linksColors.element(secondLinkIndex.add(i)).w.assign(l2);
      });
    });
  })().compute(nbParticles).label('Update Particles');

  spawnParticles = Fn(() => {
    const particleIndex = spawnIndex.add(instanceIndex).mod(nbParticles).toInt();
    const position = particlePositions.element(particleIndex).xyz;
    const life = particlePositions.element(particleIndex).w;
    const velocity = particleVelocities.element(particleIndex).xyz;

    life.assign(1.0);

    const rRange = float(0.01);
    const rTheta = hash(particleIndex).mul(TWO_PI);
    const rPhi = hash(particleIndex.add(1)).mul(PI);
    const rx = sin(rTheta).mul(cos(rPhi));
    const ry = sin(rTheta).mul(sin(rPhi));
    const rz = cos(rTheta);
    const rDir = vec3(rx, ry, rz);

    const pos = mix(previousSpawnPosition, spawnPosition, instanceIndex.toFloat().div(nbToSpawn.sub(1).toFloat()).clamp());
    position.assign(pos.add(rDir.mul(rRange)));
    velocity.assign(rDir.mul(5.0));
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
  controls.autoRotate = true;
  controls.maxDistance = 75;

  window.addEventListener('resize', onWindowResize);
  window.addEventListener('pointermove', onPointerMove);

  const gui = new GUI({ title: 'Parameters' });

  gui.add(controls, 'autoRotate').name('Auto Rotate');
  gui.add(controls, 'autoRotateSpeed', -10.0, 10.0, 0.01).name('Auto Rotate Speed');

  const partFolder = gui.addFolder('Particles');
  partFolder.add(timeScale, 'value', 0.0, 4.0, 0.01).name('timeScale');
  partFolder.add(nbToSpawn, 'value', 1, 100, 1).name('Spawn rate');
  partFolder.add(particleSize, 'value', 0.01, 3.0, 0.01).name('Size');
  partFolder.add(particleLifetime, 'value', 0.01, 2.0, 0.01).name('Lifetime');
  partFolder.add(linksWidth, 'value', 0.001, 0.1, 0.001).name('Links width');
  partFolder.add(colorVariance, 'value', 0.0, 10.0, 0.01).name('Color variance');
  partFolder.add(colorRotationSpeed, 'value', 0.0, 5.0, 0.01).name('Color rotation speed');

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
  renderer.compute(spawnParticles);
  spawnIndex.value = (spawnIndex.value + nbToSpawn.value) % nbParticles;
  raycastPlane.normal.applyEuler(camera.rotation);
  updatePointer();
  previousSpawnPosition.value.copy(spawnPosition.value);
  spawnPosition.value.lerp(scenePointer, 0.1);
  const delta = clock.getDelta();
  const elapsedTime = clock.getElapsedTime();

  colorOffset.value += delta * colorRotationSpeed.value * timeScale.value;

  light.position.set(
    Math.sin(elapsedTime * 0.5) * 30,
    Math.cos(elapsedTime * 0.3) * 30,
    Math.sin(elapsedTime * 0.2) * 30
  );

  controls.update();
  renderer.render(scene, camera);
}
