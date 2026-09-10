# CØDΞX Video Downloader — Backend

A Node.js + Express backend that powers the CØDΞX Video Downloader frontend using **yt-dlp** and **ffmpeg**.

---

## Project structure

```
codex-backend/
├── server.js          ← Express API server
├── package.json
├── nixpacks.toml      ← Railway build config (installs yt-dlp + ffmpeg)
├── railway.json       ← Railway deploy config
├── .gitignore
├── README.md
└── public/
    └── index.html     ← The CØDΞX frontend (served automatically)
```

---

## API routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Health check |
| GET | `/api/info?url=<video_url>` | Returns title, duration, thumbnail, formats |
| GET | `/api/download?url=<video_url>&format_id=<id>&title=<title>` | Streams the video file |

---

## Run locally

### 1. Install Node.js dependencies

```bash
npm install
```

### 2. Install yt-dlp

```bash
# macOS
brew install yt-dlp

# Linux / Ubuntu
sudo pip install yt-dlp

# Windows
winget install yt-dlp
# or: pip install yt-dlp
```

### 3. Install ffmpeg (required for merging video+audio)

```bash
# macOS
brew install ffmpeg

# Linux / Ubuntu
sudo apt install ffmpeg

# Windows
winget install ffmpeg
```

### 4. Start the server

```bash
node server.js
```

Open http://localhost:3000 — the frontend is served automatically from `/public/index.html`.

---

## Deploy to Railway (free hosting)

Railway gives you a free hosted server. This is the recommended way to host CØDΞX.

### Step 1 — Create a GitHub repository

```bash
# In the codex-backend folder:
git init
git add .
git commit -m "Initial CØDΞX backend"
```

Create a new repo on GitHub (https://github.com/new), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/codex-backend.git
git branch -M main
git push -u origin main
```

### Step 2 — Deploy on Railway

1. Go to https://railway.app and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `codex-backend` repository
4. Railway detects `nixpacks.toml` automatically and installs Node.js, yt-dlp, and ffmpeg
5. Click **Deploy**
6. Wait ~2 minutes for the build

### Step 3 — Get your public URL

1. In Railway, go to your project → **Settings → Networking**
2. Click **Generate Domain**
3. Copy the URL — it looks like: `https://codex-backend-production-xxxx.up.railway.app`

### Step 4 — Update the frontend

Open `public/index.html` and find this line near the top of the `<script>` tag:

```javascript
const API_BASE = '';
```

Change it to your Railway URL:

```javascript
const API_BASE = 'https://codex-backend-production-xxxx.up.railway.app';
```

Save, commit, and push — Railway redeploys automatically.

```bash
git add public/index.html
git commit -m "Set API_BASE to Railway URL"
git push
```

---

## Deploy to Render (alternative free option)

1. Go to https://render.com → **New → Web Service**
2. Connect your GitHub repo
3. Set **Build command**: `pip install yt-dlp && npm install`
4. Set **Start command**: `node server.js`
5. Add environment variables (optional — see below)
6. Click **Create Web Service**

**Note:** Render's free tier spins down after 15 minutes of inactivity. Railway is recommended for always-on usage.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (Railway sets this automatically) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed frontend origins. Set this to your frontend URL in production, e.g. `https://codex.yourdomain.com` |
| `YTDLP_PATH` | `yt-dlp` | Full path to yt-dlp binary if not in PATH |

### Setting on Railway

1. Project → **Variables**
2. Add: `ALLOWED_ORIGINS` = `https://your-frontend-domain.com`

---

## Deploy frontend separately (optional)

If you want the frontend on a different host (Netlify, Vercel, GitHub Pages):

1. Copy `public/index.html` to your frontend hosting
2. Set `API_BASE` in the HTML to your Railway backend URL
3. Set `ALLOWED_ORIGINS` on Railway to your frontend's domain

---

## Keep yt-dlp updated

YouTube and other platforms frequently update their systems. If downloads stop working, update yt-dlp:

```bash
# Locally
pip install -U yt-dlp

# On Railway — just push any commit and it rebuilds with the latest yt-dlp
git commit --allow-empty -m "Rebuild to update yt-dlp"
git push
```

---

## Convert to a desktop app later (Electron)

When you're ready to turn CØDΞX into a desktop app:

1. Install Electron: `npm install electron --save-dev`
2. The backend runs as a local server
3. The frontend (`public/index.html`) is loaded in the Electron window
4. Bundle with `electron-builder` for Windows, macOS, Linux

---

## Legal

CØDΞX is a tool for downloading content you own or have permission to download.  
Respect copyright law and each platform's terms of service.  
Built by SecureStack Labs, Lagos, Nigeria.
