import { createMicTrailRenderer } from './mic-trail.js';

const params = new URLSearchParams(window.location.search);
const API_URL = (params.get('api') || '').replace(/\/$/, '');
const UPLOAD_SECRET = params.get('secret') || '';
const RECORD_SECONDS = 20;
const SENT_MESSAGE_DELAY_MS = 23000;

const LANDING_MS = 5200;
const LANDING_TAIL_MS = 1800;

const uiEl = document.getElementById('mic-ui');
const messageEl = document.getElementById('mic-message');
const progressEl = document.getElementById('mic-progress');
const actionBtn = document.getElementById('mic-action');
const canvasEl = document.getElementById('mic-canvas');
const landingTextEl = document.getElementById('mic-landing-text');

const aboutEl = document.getElementById('mic-about');
const aboutOpenBtn = document.getElementById('mic-about-open');
const aboutCloseBtn = document.getElementById('mic-about-close');

function lockPageScroll() {
  const blockScroll = (event) => {
    event.preventDefault();
  };

  document.addEventListener('touchmove', blockScroll, { passive: false });
  document.addEventListener('wheel', blockScroll, { passive: false });
}

lockPageScroll();

function openAbout() {
  aboutEl?.classList.add('is-open');
  aboutEl?.setAttribute('aria-hidden', 'false');
}

function closeAbout() {
  aboutEl?.classList.remove('is-open');
  aboutEl?.setAttribute('aria-hidden', 'true');
}

aboutOpenBtn?.addEventListener('click', openAbout);
aboutCloseBtn?.addEventListener('click', closeAbout);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeAbout();
  }
});

const COPY = {
  idle: {
    message:
      'Respira vicino al microfono del telefono',
    action: 'registra il tuo respiro',
  },
  recording: {
    message: '',
    action: 'respira…',
  },
  uploading: {
    message: 'Attendi che il tuo respiro prenda forma…',
    action: 'inviato',
  },
  sent: {
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
let currentUploadId = null;
let assignedPositionIndex = 0;
let sentMessageTimer = null;
let assignmentPollTimer = null;

function setState(nextState) {
  state = nextState;
  uiEl.classList.remove('is-recording', 'is-uploading', 'is-sent', 'is-error');

  if (nextState === 'recording') uiEl.classList.add('is-recording');
  if (nextState === 'uploading') uiEl.classList.add('is-uploading');
  if (nextState === 'sent') uiEl.classList.add('is-sent');
  if (nextState === 'error') uiEl.classList.add('is-error');

  const copy = COPY[nextState] || COPY.idle;
  messageEl.textContent = copy.message;
  actionBtn.textContent = copy.action;
  actionBtn.disabled = nextState === 'boot' || nextState === 'uploading';

  if (nextState !== 'recording') {
    progressEl.style.width = nextState === 'uploading' || nextState === 'sent' ? '100%' : '0%';
  }
}

let landingFadeTimer = null;

function showLandingText() {
  clearTimeout(landingFadeTimer);
  landingTextEl?.classList.remove('is-fading');
  landingTextEl?.classList.add('is-visible');

  landingFadeTimer = window.setTimeout(() => {
    landingTextEl?.classList.add('is-fading');
  }, LANDING_MS);
}

function hideLandingText() {
  clearTimeout(landingFadeTimer);
  landingFadeTimer = null;
  landingTextEl?.classList.remove('is-visible', 'is-fading');
}

function prepareHomeReveal() {
  canvasEl.classList.add('is-reveal-pending');
  canvasEl.classList.remove('is-revealing');
}

function showUi() {
  hideLandingText();
  uiEl.classList.remove('is-landing');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      uiEl.classList.add('is-visible');
      canvasEl.classList.add('is-revealing');
    });
  });
}

function setProgress(ratio) {
  progressEl.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

async function fetchNextPaletteIndex() {
  if (!API_URL) return 0;

  try {
    const response = await fetch(`${API_URL}/trail-preview`);
    if (!response.ok) return 0;
    const data = await response.json();
    if (Number.isFinite(data.nextPositionIndex)) return data.nextPositionIndex;
    if (data.nextTrailNumber === 0) return 0;
    if (Number.isFinite(data.lastPositionIndex)) {
      return (data.lastPositionIndex + 1) % 14;
    }
    return 0;
  } catch {
    return 0;
  }
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
    return true;
  } catch {
    setState('error');
    messageEl.textContent = `Backend non raggiungibile.\nVerifica: ${API_URL}`;
    return false;
  }
}

function stopMedia() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
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
  clearInterval(progressInterval);
  progressInterval = null;
}

function clearUploadTimers() {
  clearTimeout(sentMessageTimer);
  clearInterval(assignmentPollTimer);
  sentMessageTimer = null;
  assignmentPollTimer = null;
}

function vibrateDone() {
  if ('vibrate' in navigator) {
    navigator.vibrate([120, 60, 120]);
  }
}

async function pollTrailAssignment(uploadId) {
  if (!API_URL || !uploadId) return;

  const response = await fetch(`${API_URL}/upload/${uploadId}`);
  if (!response.ok) return;

  const data = await response.json();

  if (Number.isFinite(data.positionIndex)) {
    assignedPositionIndex = data.positionIndex;
    trailRenderer?.applyAssignedPalette(assignedPositionIndex);
  }
}

function startAssignmentPolling(uploadId) {
  clearInterval(assignmentPollTimer);
  assignmentPollTimer = setInterval(() => {
    pollTrailAssignment(uploadId).catch(() => {});
  }, 1500);
  pollTrailAssignment(uploadId).catch(() => {});
}

function scheduleSentMessage() {
  clearTimeout(sentMessageTimer);
  sentMessageTimer = setTimeout(() => {
    setState('sent');
    actionBtn.disabled = false;
  }, SENT_MESSAGE_DELAY_MS);
}

async function startRecording() {
  if (state === 'recording' || state === 'uploading' || !API_URL) return;

  clearUploadTimers();

  const nextPalette = await fetchNextPaletteIndex();
  trailRenderer?.applyAssignedPalette(nextPalette);

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
    analyser.smoothingTimeConstant = 0.68;
    source.connect(analyser);

    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    waveformData = new Uint8Array(analyser.fftSize);

    chunks = [];
    recordedBlob = null;

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
    stopMedia();
    setState('error');
    messageEl.textContent = 'Consenti l\'accesso al microfono nelle impostazioni del browser.';
    actionBtn.disabled = false;
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

  setState('uploading');
  trailRenderer?.enterUploadingState();
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
    currentUploadId = data.id;
    setState('uploading');
    scheduleSentMessage();
    startAssignmentPolling(currentUploadId);
  } catch (error) {
    console.error(error);
    clearUploadTimers();
    setState('error');
    messageEl.textContent = error.message;
    actionBtn.disabled = false;
  }
}

actionBtn.addEventListener('click', () => {
  if (state === 'idle' || state === 'sent') {
    startRecording();
    return;
  }

  if (state === 'error') {
    boot();
  }
});

async function boot() {
  setState('boot');
  uiEl.classList.add('is-landing');
  showLandingText();
  clearUploadTimers();

  trailRenderer = createMicTrailRenderer(canvasEl);
  const ready = await trailRenderer.init();

  if (ready) {
    await trailRenderer.runLanding();
    prepareHomeReveal();
    const homePalette = await fetchNextPaletteIndex();
    await trailRenderer.startHome(homePalette);
  }

  const apiOk = await ensureApiConfigured();
  if (apiOk) {
    setState('idle');
  }

  showUi();
}

boot();
