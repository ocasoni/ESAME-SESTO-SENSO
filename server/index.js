import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import FormData from 'form-data';
import fs from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3001;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const META_FILE = path.join(UPLOAD_DIR, 'meta.json');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function loadMeta() {
  if (!fs.existsSync(META_FILE)) {
    return { lastId: 0, uploads: [], lastTrailAssignment: null };
  }

  try {
    const data = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    if (!data.lastTrailAssignment) {
      data.lastTrailAssignment = null;
    }
    return data;
  } catch {
    return { lastId: 0, uploads: [], lastTrailAssignment: null };
  }
}

function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

let meta = loadMeta();

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'video/webm') {
      cb(null, true);
      return;
    }

    cb(new Error('Solo file audio'));
  },
});

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'esame-sesto-senso-upload',
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/network-info', (_req, res) => {
  res.json({
    lanIp: getLanIp(),
    port: Number(PORT),
  });
});

app.get('/latest', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const uploads = meta.uploads.filter((entry) => entry.id > since);

  res.json({
    latestId: meta.lastId,
    uploads,
  });
});

app.get('/audio/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const entry = meta.uploads.find((item) => item.id === id);

  if (!entry) {
    res.status(404).json({ error: 'Audio non trovato' });
    return;
  }

  const filePath = path.join(UPLOAD_DIR, entry.filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File non trovato' });
    return;
  }

  res.sendFile(filePath);
});

app.get('/upload/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const entry = meta.uploads.find((item) => item.id === id);

  if (!entry) {
    res.status(404).json({ error: 'Upload non trovato' });
    return;
  }

  res.json(entry);
});

app.get('/trail-preview', (_req, res) => {
  const last = meta.lastTrailAssignment || null;
  const nextTrailNumber = last ? last.trailNumber + 1 : 0;
  const nextPositionIndex = last ? (last.positionIndex + 1) % 14 : 0;

  res.json({
    nextTrailNumber,
    nextPositionIndex,
    lastPositionIndex: last?.positionIndex ?? null,
  });
});

app.post('/upload/:id/trail-assignment', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const entry = meta.uploads.find((item) => item.id === id);

  if (!entry) {
    res.status(404).json({ error: 'Upload non trovato' });
    return;
  }

  const positionIndex = Number(req.body?.positionIndex);
  const trailNumber = Number(req.body?.trailNumber);

  if (!Number.isFinite(positionIndex) || !Number.isFinite(trailNumber)) {
    res.status(400).json({ error: 'positionIndex e trailNumber richiesti' });
    return;
  }

  entry.positionIndex = positionIndex;
  entry.trailNumber = trailNumber;
  entry.assignedAt = new Date().toISOString();
  meta.lastTrailAssignment = { positionIndex, trailNumber };
  saveMeta(meta);

  res.json({ ok: true, positionIndex, trailNumber });
});

app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (UPLOAD_SECRET && req.headers['x-upload-secret'] !== UPLOAD_SECRET) {
      res.status(401).json({ error: 'Secret non valido' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'Nessun file audio' });
      return;
    }

    meta.lastId += 1;

    const entry = {
      id: meta.lastId,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      createdAt: new Date().toISOString(),
      positionIndex: null,
      trailNumber: null,
      assignedAt: null,
    };

    meta.uploads.push(entry);
    saveMeta(meta);

    let telegramSent = false;

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      telegramSent = await sendToTelegram(req.file.path, entry.originalName);
    }

    res.json({
      ok: true,
      id: entry.id,
      telegramSent,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Errore durante l\'upload' });
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message || 'Errore' });
});

async function sendToTelegram(filePath, caption) {
  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('document', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
  });
  formData.append('caption', caption || 'Nuovo respiro dal telefono');

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
    {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    console.error('Telegram error:', body);
    return false;
  }

  return true;
}

function getLanIp() {
  const nets = os.networkInterfaces();

  for (const interfaces of Object.values(nets)) {
    for (const net of interfaces) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }

  return null;
}

app.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`Server in ascolto su http://localhost:${PORT}`);
  if (lanIp) {
    console.log(`Rete locale (telefono): http://${lanIp}:${PORT}`);
  }
  console.log(`Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'configurato' : 'NON configurato (imposta TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)'}`);
});
