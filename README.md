# ESAME-SESTO-SENSO

Three.js WebGPU — scie audio da registrazioni telefono via Telegram.

## Perché il telefono non apre il link?

| URL nel QR | Funziona dal telefono? |
|------------|----------------------|
| `http://localhost:...` | **No** — localhost è il telefono stesso |
| `http://192.168.x.x:5173/...` | Solo stessa **Wi‑Fi** del PC |
| `https://TUO-USER.github.io/NOME-REPO/mic/...` | **Sì** — da qualsiasi rete (4G/Wi‑Fi) |

**Soluzione consigliata:** pubblicare la pagina mic su **GitHub Pages** e il backend su **Render**.

---

## Setup completo (3 passi)

### Passo 1 — Backend su Render

1. Vai su [render.com](https://render.com) → **New Web Service**
2. Collega il repo GitHub, **Root Directory:** `server`
3. **Environment:**
   - `TELEGRAM_BOT_TOKEN` = token da @BotFather
   - `TELEGRAM_CHAT_ID` = il tuo chat id
4. Deploy → copia l’URL (es. `https://esame-sesto-senso.onrender.com`)

### Passo 2 — GitHub Pages

1. Push del codice su GitHub (branch `main`)
2. Repo → **Settings** → **Pages** → Source: **GitHub Actions**
3. Repo → **Settings** → **Secrets and variables** → **Actions** → **Variables**
4. Aggiungi: `VITE_API_URL` = URL Render del passo 1
5. Ogni push su `main` pubblica il sito su:
   `https://ocasoni.github.io/ESAME-SESTO-SENSO/`

### Passo 3 — File `.env` sul PC (per il QR in locale)

Repo: [github.com/ocasoni/ESAME-SESTO-SENSO](https://github.com/ocasoni/ESAME-SESTO-SENSO)

```env
VITE_API_URL=https://esame-sesto-senso.onrender.com
VITE_MIC_PAGE_URL=https://ocasoni.github.io/ESAME-SESTO-SENSO/mic/index.html
```

Riavvia `npm run dev`. Il QR punterà a **GitHub** (apribile dal telefono) e l’audio andrà a **Render**.

---

## Sviluppo locale (senza GitHub)

Telefono e PC sulla **stessa Wi‑Fi**:

```env
VITE_API_URL=http://localhost:3001
VITE_LAN_HOST=192.168.1.105
```

```bash
npm run server   # terminale 1
npm run dev      # terminale 2
```

Trova l’IP del PC con `ipconfig` (Indirizzo IPv4).

---

## Token Telegram

Solo in `server/.env` (locale) o variabili Render (online):

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

**Mai** nel frontend.

---

## Script

| Comando | Descrizione |
|---------|-------------|
| `npm run dev` | Visualizzazione 3D |
| `npm run server` | Backend upload/Telegram |
| `npm run build:pages` | Build per GitHub Pages |
