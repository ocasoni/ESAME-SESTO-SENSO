import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { createSplashTrail, createTrailEngine } from '../src/trailCore.js';

const DRAW_MS = 4000;
const TAIL_FADE_MS = 2400;
const BG_FADE_MS = 900;
const INIT_TIMEOUT_MS = 15000;
const AUTO_ROTATE_SPEED = 2;
const INITIAL_CAMERA_FOV = 59;
const INITIAL_CAMERA_DISTANCE = 20;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timeout`));
    }, ms);

    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

export async function runMicSplash() {
  const splash = document.getElementById('mic-splash');
  const stage = document.getElementById('mic-splash-stage');

  if (!splash || !stage) {
    return;
  }

  if (WebGPU.isAvailable() === false) {
    splash.remove();
    return;
  }

  const scene = new THREE.Scene();
  const worldGroup = new THREE.Group();
  scene.add(worldGroup);

  const camera = new THREE.PerspectiveCamera(
    INITIAL_CAMERA_FOV,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(0, 0, INITIAL_CAMERA_DISTANCE);

  const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: false });
  renderer.setClearColor(0x000000);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  stage.innerHTML = '';
  stage.appendChild(renderer.domElement);

  let rafId = 0;

  try {
    await withTimeout(renderer.init(), INIT_TIMEOUT_MS, 'WebGPU init');

    const engine = await createTrailEngine(renderer, worldGroup, 1);
    const trail = createSplashTrail();
    const clock = new THREE.Clock();
    let worldSpinAngle = 0;
    const startedAt = performance.now();
    let spawning = true;
    let tailFading = false;
    let bgFadeStarted = false;

    await new Promise((resolve, reject) => {
      const onResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      };

      window.addEventListener('resize', onResize);

      const finish = () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(rafId);
        renderer.dispose();
        splash.classList.add('is-exiting', 'is-hidden');
        window.setTimeout(() => {
          splash.remove();
          resolve();
        }, BG_FADE_MS);
      };

      const tick = () => {
        try {
          const elapsed = performance.now() - startedAt;
          const delta = clock.getDelta();

          worldSpinAngle += (Math.PI * 2 / 60) * AUTO_ROTATE_SPEED * delta;
          worldGroup.quaternion.setFromAxisAngle(WORLD_UP, -worldSpinAngle);

          if (spawning && elapsed >= DRAW_MS) {
            spawning = false;
            tailFading = true;
          }

          if (spawning) {
            engine.tickTrail(trail, delta, { spawn: true, audioStarted: true });
          } else {
            renderer.compute(engine.updateParticles);

            if (tailFading) {
              engine.fadeSlot(trail.particleStart, 1.05);
            }
          }

          renderer.render(scene, camera);

          if (!bgFadeStarted && !spawning) {
            bgFadeStarted = true;
            splash.classList.add('is-exiting');
          }

          if (elapsed >= DRAW_MS + TAIL_FADE_MS) {
            finish();
            return;
          }

          rafId = requestAnimationFrame(tick);
        } catch (error) {
          window.removeEventListener('resize', onResize);
          cancelAnimationFrame(rafId);
          renderer.dispose();
          reject(error);
        }
      };

      rafId = requestAnimationFrame(tick);
    });
  } catch (error) {
    console.warn('Splash WebGPU non disponibile:', error);
    cancelAnimationFrame(rafId);
    renderer.dispose();
    stage.innerHTML = '';
    splash.remove();
  }
}
