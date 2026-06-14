import { createMicTrailRenderer } from './mic-trail.js';

const params = new URLSearchParams(window.location.search);
const API_URL = (params.get('api') || '').replace(/\/$/, '');
const UPLOAD_SECRET = params.get('secret') || '';
const RECORD_SECONDS = 20;
const TRAIL_POLL_MS = 1200;
const POST_UPLOAD_COMPLETE_MS = 20000;

const uiEl = document.getElementById('mic-ui');
const landingEl = document.getElementById('mic-landing');
const messageEl = document.getElementById('mic-message');
const progressEl = document.getElementById('mic-progress');
const actionBtn = document.getElementById('mic-action');
const canvasEl = document.getElementById('mic-canvas');

const COPY = {
  idle: {
    message:
      'Respira vicino al microfono del telefono.',
    action: 'registra il tuo respiro',
  },
  recording: {
    message: '',
    action: 'respira…',
  },
  waiting: {
    message: 'Il tuo respiro prende forma…',
    action: 'inviato',
  },
  generating: {
    message: "L'eco del tuo respiro è ora traccia visibile",
    action: 'inviato',
  },
  complete: {
    message: "L'eco del tuo respiro è ora traccia visibile",
    action: 'registra ancora',
  },
  error: {
    message: 'Impossibile connettersi al backend.',
    action: 'riprova',
  },
};

let state = 'boot';
let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let frequencyData = null;
let waveformData = null;
let chunks = [];
let recordedBlob = null;
let progressInterval = null;
let recordStartedAt = 0;
let trailRenderer = null;
let trailPollTimer = null;
let currentPositionIndex = 0;
let lastUploadId = null;
let lockedPositionIndex = null;
let uploadCompleteTimer = null;

function clearUploadCompleteTimer() {
  if (uploadCompleteTimer) {
    clearTimeout(uploadCompleteTimer);
    uploadCompleteTimer = null;
  }
}

function scheduleUploadComplete() {
  clearUploadCompleteTimer();
  uploadCompleteTimer = setTimeout(() => {
    if (lastUploadId == null || (state !== 'waiting' && state !== 'generating')) {
      return;
    }
    setState('complete');
    trailRenderer?.setPalette(lockedPositionIndex ?? currentPositionIndex);
  }, POST_UPLOAD_COMPLETE_MS);
}

function setState(nextState) {
  state = nextState;
  uiEl.classList.remove('is-recording', 'is-waiting', 'is-generating', 'is-complete', 'is-error');

  if (nextState === 'recording') uiEl.classList.add('is-recording');
  if (nextState === 'waiting') uiEl.classList.add('is-waiting');
  if (nextState === 'generating') uiEl.classList.add('is-generating');
  if (nextState === 'complete') uiEl.classList.add('is-complete');
  if (nextState === 'error') uiEl.classList.add('is-error');

  const copy = COPY[nextState] || COPY.idle;
  messageEl.textContent = copy.message;
  actionBtn.textContent = copy.action;
  actionBtn.disabled = nextState === 'boot' || nextState === 'waiting' || nextState === 'generating';

  if (nextState !== 'boot' && nextState !== 'recording') {
    trailRenderer?.setScreenLayout(nextState);
  }

  if (nextState === 'waiting' || nextState === 'generating') {
    progressEl.style.width = '100%';
  } else if (nextState !== 'recording') {
    progressEl.style.width = '0%';
  }
}

function showUi() {
  uiEl.classList.add('is-visible');
}

function hideLanding() {
  landingEl.classList.add('is-hidden');
  landingEl.setAttribute('aria-hidden', 'true');
}

function startLandingDissolve() {
  landingEl.classList.add('is-dissolving');
}

async function playLandingIntro() {
  if (!trailRenderer) {
    hideLanding();
    return;
  }

  await new Promise((resolve) => {
    const landing = trailRenderer.playLanding(resolve);

    const pollDissolve = () => {
      if (landing.dissolveStarted) {
        startLandingDissolve();
        return;
      }
      requestAnimationFrame(pollDissolve);
    };

    pollDissolve();
  });

  hideLanding();
}

function setProgress(ratio) {
  progressEl.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

async function fetchTrailState() {
  if (!API_URL) {
    return {
      nextPositionIndex: 0,
      processingUploadId: null,
      drawingUploadId: null,
      lastCompletedUploadId: null,
      lastTrailPositionIndex: null,
    };
  }

  try {
    const response = await fetch(`${API_URL}/trail-state`);
    if (!response.ok) throw new Error('trail-state unavailable');
    return response.json();
  } catch {
    return {
      nextPositionIndex: currentPositionIndex,
      processingUploadId: null,
      drawingUploadId: null,
      lastCompletedUploadId: null,
      lastTrailPositionIndex: null,
    };
  }
}

async function refreshHomePalette() {
  const trailState = await fetchTrailState();
  currentPositionIndex = trailState.nextPositionIndex ?? 0;
  trailRenderer?.setPalette(currentPositionIndex);
}

function startTrailPolling() {
  stopTrailPolling();
  trailPollTimer = setInterval(async () => {
    const trailState = await fetchTrailState();

    if (state === 'idle') {
      currentPositionIndex = trailState.nextPositionIndex ?? currentPositionIndex;
      trailRenderer?.setPalette(currentPositionIndex);
    }

    if (state === 'waiting' && lastUploadId != null) {
      if (trailState.drawingUploadId === lastUploadId) {
        if (Number.isFinite(trailState.lastTrailPositionIndex)) {
          lockedPositionIndex = trailState.lastTrailPositionIndex;
          trailRenderer?.setPalette(trailState.lastTrailPositionIndex);
        }
      }
    }
  }, TRAIL_POLL_MS);
}

function stopTrailPolling() {
  clearInterval(trailPollTimer);
  trailPollTimer = null;
}

async function ensureApiConfigured() {
  if (!API_URL) {
    setState('error');
    messageEl.textContent = 'Apri questa pagina scansionando il QR code dal PC.';
    actionBtn.disabled = true;
    return false;
  }

  try {
    const response = await fetch(`${API_URL}/health`);
    if (!response.ok) throw new Error('Backend non raggiungibile');
    await refreshHomePalette();
    startTrailPolling();
    return true;
  } catch {
    setState('error');
    messageEl.textContent = `Backend non raggiungibile.\nVerifica: ${API_URL}`;
    return false;
  }
}

function vibrateDone() {
  if ('vibrate' in navigator) {
    navigator.vibrate([120, 60, 120]);
  }
}

async function startRecording() {
  if (state === 'recording' || state === 'waiting' || state === 'generating' || !API_URL) {
    return;
  }

  await refreshHomePalette();

  clearUploadCompleteTimer();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });

    audioContext = new AudioContext();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.86;
    source.connect(analyser);

    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    waveformData = new Uint8Array(analyser.fftSize);

    chunks = [];
    recordedBlob = null;
    lastUploadId = null;
    lockedPositionIndex = null;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    mediaRecorder.addEventListener('stop', () => {
      recordedBlob = new Blob(chunks, { type: mimeType });
    });

    mediaRecorder.start(250);
    recordStartedAt = Date.now();
    setState('recording');
    setProgress(0);

    trailRenderer?.startRecording(analyser, frequencyData, waveformData);

    progressInterval = setInterval(() => {
      const elapsed = (Date.now() - recordStartedAt) / 1000;
      setProgress(elapsed / RECORD_SECONDS);

      if (elapsed >= RECORD_SECONDS) {
        finishRecording();
      }
    }, 100);
  } catch (error) {
    console.error(error);
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
    audioContext = null;
    analyser = null;
    setState('error');
    messageEl.textContent = 'Consenti l\'accesso al microfono nelle impostazioni del browser.';
  }
}

async function finishRecording() {
  if (state !== 'recording') return;

  clearInterval(progressInterval);
  progressInterval = null;
  setProgress(1);
  vibrateDone();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      mediaRecorder.addEventListener('stop', resolve, { once: true });
      mediaRecorder.stop();
    });
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
  }

  audioContext = null;
  analyser = null;
  trailRenderer?.stopRecordingVisual();

  setState('waiting');
  await sendRecording();
}

async function sendRecording() {
  if (!recordedBlob || !API_URL) {
    setState('error');
    return;
  }

  const formData = new FormData();
  formData.append('audio', recordedBlob, `respiro-${Date.now()}.webm`);

  try {
    const headers = {};
    if (UPLOAD_SECRET) {
      headers['X-Upload-Secret'] = UPLOAD_SECRET;
    }

    const response = await fetch(`${API_URL}/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Upload fallito');
    }

    recordedBlob = null;
    lastUploadId = data.id;
    scheduleUploadComplete();
  } catch (error) {
    console.error(error);
    setState('error');
    messageEl.textContent = error.message;
    actionBtn.disabled = false;
  }
}

actionBtn.addEventListener('click', () => {
  if (state === 'idle' || state === 'complete') {
    startRecording();
    return;
  }

  if (state === 'error') {
    boot();
  }
});

async function boot() {
  setState('boot');
  uiEl.classList.remove('is-visible');

  let rendererReady = false;
  const apiPromise = ensureApiConfigured();

  try {
    trailRenderer = createMicTrailRenderer(canvasEl);
    rendererReady = await trailRenderer.init();

    if (rendererReady) {
      await refreshHomePalette();
      await playLandingIntro();
    } else {
      hideLanding();
    }
  } catch (error) {
    console.error('Errore avvio mic:', error);
    hideLanding();
  } finally {
    const apiOk = await apiPromise;
    if (apiOk) {
      setState('idle');
      trailRenderer?.setScreenLayout();
    }

    if (rendererReady && trailRenderer) {
      trailRenderer.setHomeView();
    }

    showUi();
  }
}

boot();

window.addEventListener('beforeunload', () => {
  stopTrailPolling();
  clearUploadCompleteTimer();
});
