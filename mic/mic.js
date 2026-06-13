const params = new URLSearchParams(window.location.search);
const API_URL = (params.get('api') || '').replace(/\/$/, '');
const UPLOAD_SECRET = params.get('secret') || '';
const MAX_SECONDS = 30;

const pageEl = document.querySelector('.mic-page');
const statusEl = document.getElementById('mic-status');
const timerEl = document.getElementById('mic-timer');
const hintEl = document.getElementById('mic-hint');
const recordBtn = document.getElementById('mic-record');
const stopBtn = document.getElementById('mic-stop');
const sendBtn = document.getElementById('mic-send');

let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let recordedBlob = null;
let timerInterval = null;
let startedAt = 0;

function setRecordingVisual(active) {
  pageEl.classList.toggle('is-recording', active);
}

function setStatus(text, className = '') {
  statusEl.textContent = text;
  statusEl.className = `mic-status ${className}`.trim();
}

function formatTime(seconds) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
}

function resetTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerEl.textContent = '00:00';
}

function startTimer() {
  startedAt = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    timerEl.textContent = formatTime(elapsed);

    if (elapsed >= MAX_SECONDS) {
      stopRecording();
    }
  }, 200);
}

async function ensureApiConfigured() {
  if (!API_URL) {
    setStatus('URL backend mancante', 'is-error');
    hintEl.textContent = 'Apri questa pagina scansionando il QR code dalla visualizzazione sul PC.';
    recordBtn.disabled = true;
    return false;
  }

  try {
    const response = await fetch(`${API_URL}/health`);
    if (!response.ok) throw new Error('Backend non raggiungibile');
    setStatus('Pronto', 'is-ready');
    hintEl.textContent = 'Premi Registra, parla o respira, poi Ferma e Invia.';
    return true;
  } catch {
    setStatus('Backend non raggiungibile', 'is-error');
    hintEl.textContent = `Verifica che il server sia attivo: ${API_URL}`;
    return false;
  }
}

async function startRecording() {
  if (!API_URL) return;

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
      sendBtn.disabled = false;
      setRecordingVisual(false);
      setStatus('Registrazione pronta per l\'invio', 'is-ready');
      hintEl.textContent = 'Premi Invia per mandare l\'audio alla visualizzazione.';
    });

    mediaRecorder.start(250);
    setRecordingVisual(true);
    setStatus('Registrazione in corso…', 'is-recording');
    recordBtn.disabled = true;
    stopBtn.disabled = false;
    sendBtn.disabled = true;
    startTimer();
  } catch (error) {
    console.error(error);
    setRecordingVisual(false);
    setStatus('Permesso microfono negato', 'is-error');
    hintEl.textContent = 'Consenti l\'accesso al microfono nelle impostazioni del browser.';
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  resetTimer();
  recordBtn.disabled = false;
  stopBtn.disabled = true;
}

async function sendRecording() {
  if (!recordedBlob || !API_URL) return;

  sendBtn.disabled = true;
  setStatus('Invio in corso…', '');

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

    setStatus('Inviato!', 'is-ready');
    hintEl.textContent = 'Puoi registrare un altro respiro.';
    recordedBlob = null;
    sendBtn.disabled = true;
  } catch (error) {
    console.error(error);
    setStatus('Errore di invio', 'is-error');
    hintEl.textContent = error.message;
    sendBtn.disabled = false;
  }
}

recordBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
sendBtn.addEventListener('click', sendRecording);

ensureApiConfigured();
