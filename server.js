/**
 * CØDΞX Video Downloader — Backend Server
 * ----------------------------------------
 * Node.js + Express + yt-dlp
 */

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { spawn, execSync } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ─── AUTO-UPDATE YT-DLP ────────────────────────────────────────────────────
try {
  console.log('[yt-dlp] Checking for updates...');
  const out = execSync('pip install -U yt-dlp --quiet 2>&1', { timeout: 60000 }).toString().trim();
  console.log('[yt-dlp] Done:', out || 'already up to date');
} catch (e) {
  console.warn('[yt-dlp] Auto-update failed (non-fatal):', e.message);
}

// ─── COOKIES FILE ──────────────────────────────────────────────────────────
const COOKIES_FILE  = process.env.COOKIES_PATH || path.join(__dirname, 'cookies.txt');
const COOKIES_EXIST = fs.existsSync(COOKIES_FILE);
console.log(COOKIES_EXIST ? `[cookies] Loaded: ${COOKIES_FILE}` : '[cookies] No cookies.txt found');

// ─── PROXY ─────────────────────────────────────────────────────────────────
const PROXY = process.env.YTDLP_PROXY || null;
console.log(PROXY ? `[proxy] Configured` : '[proxy] None');

// ─── ALLOWED ORIGINS ───────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

app.use(cors({
  origin: ALLOWED_ORIGINS[0] === '*' ? '*' : (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET'],
}));

app.use(express.json());

// ─── RATE LIMITING ─────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes.' },
});
app.use('/api/', limiter);

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  let ytdlpVersion = 'unknown';
  try { ytdlpVersion = execSync('yt-dlp --version 2>&1').toString().trim(); } catch {}
  res.json({
    status:  'ok',
    service: 'CØDΞX Backend',
    time:    new Date().toISOString(),
    cookies: COOKIES_EXIST ? 'loaded' : 'missing',
    proxy:   PROXY ? 'configured' : 'none',
    ytdlp:   ytdlpVersion,
  });
});

// ─── SERVE FRONTEND ────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

// ─── HELPERS ───────────────────────────────────────────────────────────────
function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function sanitizeFilename(name) {
  return name.replace(/[^\w\s\-.()\[\]]/g, '').replace(/\s+/g, '_').slice(0, 180);
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return null;
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function bytesToMB(bytes) {
  if (!bytes || bytes < 0) return null;
  return Math.round(bytes / 1e6);
}

// ─── NORMALIZE URL ─────────────────────────────────────────────────────────
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.pathname.startsWith('/shorts/')) {
      return `https://www.youtube.com/watch?v=${u.pathname.replace('/shorts/', '')}`;
    }
    if (u.hostname === 'youtu.be') {
      return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
    }
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
    return url;
  } catch { return url; }
}

// ─── COOKIES ARGS ──────────────────────────────────────────────────────────
function cookiesArgs() {
  return COOKIES_EXIST ? ['--cookies', COOKIES_FILE] : [];
}

// ─── BASE ARGS (no proxy) — used for actual download ───────────────────────
// Proxy is intentionally excluded here because free proxies can't handle
// streaming large video files — only used for info fetching
function baseArgs() {
  return [
    '--no-warnings',
    '--no-playlist',
    '--retries', '5',
    '--fragment-retries', '5',
    '--no-part',
    '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    ...cookiesArgs(),
  ];
}

// ─── INFO ARGS (with proxy) — used only for fetching video metadata ─────────
function infoArgs() {
  const args = [...baseArgs()];
  if (PROXY) args.push('--proxy', PROXY);
  return args;
}

// ─── RUN YT-DLP ────────────────────────────────────────────────────────────
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const bin  = process.env.YTDLP_PATH || 'yt-dlp';
    const proc = spawn(bin, args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });

    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error('yt-dlp is not installed.'));
      else reject(err);
    });
  });
}

// ─── ERROR CLASSIFIER ──────────────────────────────────────────────────────
function classifyError(msg) {
  if (msg.includes('yt-dlp is not installed'))
    return { status: 500, error: 'yt-dlp is not installed on the server.' };
  if (msg.includes('Unsupported URL'))
    return { status: 400, error: 'This URL is not supported.' };
  if (msg.includes('Private video') || msg.includes('Sign in'))
    return { status: 403, error: 'This video is private or requires login.' };
  if (msg.includes('not available') || msg.includes('unavailable'))
    return { status: 404, error: 'Video not found or unavailable in your region.' };
  if (msg.includes('reload') || msg.includes('reloaded'))
    return { status: 503, error: 'YouTube is temporarily blocking this request. Try again in a moment.' };
  if (msg.includes('HTTP Error 404'))
    return { status: 404, error: 'Video not found (404). Check the URL.' };
  if (msg.includes('HTTP Error 403'))
    return { status: 403, error: 'Access denied by platform. Try again later.' };
  if (msg.includes('proxy'))
    return { status: 502, error: 'Proxy error. Try again.' };
  return { status: 500, error: 'Could not process video. ' + msg.split('\n').slice(-2).join(' ') };
}

// ─── GET VIDEO INFO ────────────────────────────────────────────────────────
// Uses proxy to bypass IP blocks when fetching metadata
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: 'Invalid or missing URL.' });

  const cleanUrl = normalizeUrl(url);
  console.log(`[/api/info] ${url} → ${cleanUrl} | proxy: ${PROXY ? 'yes' : 'no'}`);

  try {
    const raw  = await ytdlp(['--dump-json', ...infoArgs(), cleanUrl]);
    const info = JSON.parse(raw);

    const seenLabels = new Set();
    const formats    = [];
    const sorted     = (info.formats || []).slice().sort((a, b) => (b.height || 0) - (a.height || 0));

    for (const f of sorted) {
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';
      if (!hasVideo && !hasAudio) continue;

      let label, resolution;
      if (hasVideo) {
        const h = f.height || 0;
        if      (h >= 2160) { label = '4K';    resolution = '2160p'; }
        else if (h >= 1440) { label = '1440p'; resolution = '1440p'; }
        else if (h >= 1080) { label = '1080p'; resolution = '1080p'; }
        else if (h >= 720)  { label = '720p';  resolution = '720p';  }
        else if (h >= 480)  { label = '480p';  resolution = '480p';  }
        else if (h >= 360)  { label = '360p';  resolution = '360p';  }
        else if (h >= 240)  { label = '240p';  resolution = '240p';  }
        else if (h > 0)     { label = h + 'p'; resolution = h + 'p'; }
        else continue;
      } else {
        label = 'Audio'; resolution = 'audio';
      }

      if (seenLabels.has(label)) continue;
      seenLabels.add(label);

      const filesize = f.filesize || f.filesize_approx || null;
      formats.push({
        format_id:    f.format_id,
        label,
        resolution,
        ext:          f.ext || 'mp4',
        filesize,
        filesize_mb:  bytesToMB(filesize),
        filesize_str: formatBytes(filesize),
        has_video:    hasVideo,
        has_audio:    hasAudio,
        note:         f.format_note || '',
        vcodec:       f.vcodec,
        acodec:       f.acodec,
      });
    }

    if (!seenLabels.has('Best')) {
      formats.unshift({
        format_id: 'bestvideo+bestaudio/best',
        label: 'Best', resolution: 'best', ext: 'mp4',
        filesize: null, filesize_mb: null, filesize_str: 'Auto',
        has_video: true, has_audio: true, note: 'Best available quality',
      });
    }

    return res.json({
      title:        info.title,
      duration:     info.duration,
      duration_str: info.duration_string,
      thumbnail:    info.thumbnail,
      uploader:     info.uploader || info.channel,
      view_count:   info.view_count,
      upload_date:  info.upload_date,
      webpage_url:  info.webpage_url,
      extractor:    info.extractor_key,
      formats,
    });

  } catch (err) {
    console.error('[/api/info] Error:', err.message);
    const { status, error } = classifyError(err.message);
    return res.status(status).json({ error });
  }
});

// ─── DOWNLOAD VIDEO ────────────────────────────────────────────────────────
// Does NOT use proxy — direct connection for fast reliable streaming
app.get('/api/download', async (req, res) => {
  const { url, format_id, title } = req.query;
  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: 'Invalid or missing URL.' });

  const cleanUrl  = normalizeUrl(url);
  const fmt       = format_id || 'bestvideo+bestaudio/best';
  const safeTitle = sanitizeFilename(title || 'video');
  const bin       = process.env.YTDLP_PATH || 'yt-dlp';

  // ── STRATEGY: use proxy to get the direct CDN video URL from YouTube,
  // then redirect the browser to that URL so the browser downloads directly
  // from YouTube's CDN — bypasses both the IP block AND proxy bandwidth limits
  try {
    const getUrlArgs = [
      '-f', fmt,
      '--get-url',
      ...infoArgs(),  // uses proxy to get past YouTube block
      cleanUrl,
    ];

    console.log(`[/api/download] Getting direct URL via proxy: ${cleanUrl}`);
    const directUrl = await ytdlp(getUrlArgs);
    const firstUrl  = directUrl.split('\n')[0].trim();

    if (!firstUrl || !firstUrl.startsWith('http')) {
      return res.status(500).json({ error: 'Could not get direct video URL.' });
    }

    // Redirect browser straight to YouTube CDN — browser downloads it natively
    console.log(`[/api/download] Redirecting to CDN URL`);
    return res.redirect(302, firstUrl);

  } catch (err) {
    console.error('[/api/download] get-url failed, falling back to stream:', err.message);
    // Fall through to old streaming method if get-url fails
  }

  const tmpDir    = os.tmpdir();
  const tmpFile   = path.join(tmpDir, `codex_${Date.now()}_${Math.random().toString(36).slice(2)}.%(ext)s`);

  const args = [
    '-f', fmt,
    '--merge-output-format', 'mp4',
    ...infoArgs(),
    '-o', tmpFile,
    cleanUrl,
  ];

  console.log(`[/api/download] Fallback streaming: ${cleanUrl} | format: ${fmt}`);

  const proc = spawn(bin, args);
  let stderr = '';

  proc.stderr.on('data', d => {
    stderr += d.toString();
    const line = d.toString().trim();
    if (line.includes('[download]')) process.stdout.write('\r' + line);
  });

  proc.on('error', err => {
    if (!res.headersSent)
      res.status(500).json({ error: 'yt-dlp not found: ' + err.message });
  });

  proc.on('close', code => {
    if (code !== 0) {
      console.error('[/api/download] Failed:', stderr);
      if (!res.headersSent) {
        const { status, error } = classifyError(stderr);
        res.status(status).json({ error });
      }
      return;
    }

    const dir     = path.dirname(tmpFile);
    const prefix  = path.basename(tmpFile).split('.')[0];
    let finalFile = null;

    try {
      const files = fs.readdirSync(dir);
      finalFile = files.map(f => path.join(dir, f)).find(f => path.basename(f).startsWith(prefix));
    } catch {}

    if (!finalFile || !fs.existsSync(finalFile)) {
      if (!res.headersSent)
        res.status(500).json({ error: 'Download finished but output file was not found.' });
      return;
    }

    const ext      = path.extname(finalFile).slice(1) || 'mp4';
    const mimeMap  = {
      mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
    };
    const mimeType = mimeMap[ext] || 'video/mp4';
    const stat     = fs.statSync(finalFile);

    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Codex-Filename', `${safeTitle}.${ext}`);

    console.log(`\n[/api/download] Streaming ${(stat.size / 1e6).toFixed(1)} MB → ${safeTitle}.${ext}`);

    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);

    stream.on('close', () => {
      fs.unlink(finalFile, () => {});
      console.log(`[/api/download] Done: ${path.basename(finalFile)}`);
    });

    stream.on('error', err => {
      console.error('[/api/download] Stream error:', err.message);
      fs.unlink(finalFile, () => {});
    });

    req.on('close', () => {
      stream.destroy();
      fs.unlink(finalFile, () => {});
    });
  });
});

// ─── START ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   CØDΞX Video Downloader — Backend   ║
  ║   Running on http://localhost:${PORT}    ║
  ╚═══════════════════════════════════════╝

  Cookies : ${COOKIES_EXIST ? '✅ loaded' : '⚠️  missing'}
  Proxy   : ${PROXY ? '✅ configured (info only)' : '⚠️  none'}

  Routes:
    GET /health
    GET /api/info?url=<video_url>
    GET /api/download?url=<video_url>&format_id=<id>&title=<title>
  `);
});
