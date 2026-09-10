/**
 * CØDΞX Video Downloader — Backend Server
 * ----------------------------------------
 * Node.js + Express + yt-dlp
 *
 * Routes:
 *   GET  /api/info?url=...        → returns video title, duration, formats
 *   GET  /api/download?url=...&format_id=...  → streams the video file
 *   GET  /health                  → health check for Railway/Render
 */

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── ALLOWED ORIGINS ───────────────────────────────────────────────────────
// Add your deployed frontend URL here, e.g. https://codex.yourdomain.com
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                   // max 30 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes.' },
});
app.use('/api/', limiter);

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'CØDΞX Backend', time: new Date().toISOString() });
});

// ─── SERVE FRONTEND (optional) ─────────────────────────────────────────────
// If you put index.html in a /public folder next to server.js,
// it will be served automatically at http://localhost:3000/
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

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

// Run yt-dlp and return stdout as a string
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    // yt-dlp may be installed as 'yt-dlp' or 'yt_dlp' depending on the system
    const bin = process.env.YTDLP_PATH || 'yt-dlp';
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
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp is not installed. Run: pip install yt-dlp'));
      } else {
        reject(err);
      }
    });
  });
}

// ─── GET VIDEO INFO ────────────────────────────────────────────────────────
// GET /api/info?url=<video_url>
//
// Returns:
// {
//   title, duration, thumbnail, uploader, view_count, upload_date,
//   formats: [ { format_id, label, resolution, ext, filesize, filesize_mb, note } ]
// }
app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid or missing URL.' });
  }

  try {
    const raw = await ytdlp([
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      url,
    ]);

    const info = JSON.parse(raw);

    // Build a clean list of formats the frontend can use
    const seenLabels = new Set();
    const formats = [];

    // Sort: best quality first
    const sorted = (info.formats || []).slice().sort((a, b) => (b.height || 0) - (a.height || 0));

    for (const f of sorted) {
      // Skip audio-only unless we want to expose it
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';

      if (!hasVideo && !hasAudio) continue;

      let label, resolution;

      if (hasVideo) {
        const h = f.height || 0;
        if      (h >= 2160) { label = '4K'; resolution = '2160p'; }
        else if (h >= 1440) { label = '1440p'; resolution = '1440p'; }
        else if (h >= 1080) { label = '1080p'; resolution = '1080p'; }
        else if (h >= 720)  { label = '720p';  resolution = '720p'; }
        else if (h >= 480)  { label = '480p';  resolution = '480p'; }
        else if (h >= 360)  { label = '360p';  resolution = '360p'; }
        else if (h >= 240)  { label = '240p';  resolution = '240p'; }
        else if (h > 0)     { label = h + 'p'; resolution = h + 'p'; }
        else continue;
      } else {
        label = 'Audio'; resolution = 'audio';
      }

      // Deduplicate by label — keep the best format for each resolution
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);

      const filesize = f.filesize || f.filesize_approx || null;

      formats.push({
        format_id:   f.format_id,
        label,
        resolution,
        ext:         f.ext || 'mp4',
        filesize:    filesize,
        filesize_mb: bytesToMB(filesize),
        filesize_str: formatBytes(filesize),
        has_video:   hasVideo,
        has_audio:   hasAudio,
        note:        f.format_note || '',
        vcodec:      f.vcodec,
        acodec:      f.acodec,
      });
    }

    // Always add a merged "best" option that yt-dlp handles automatically
    if (!seenLabels.has('Best')) {
      formats.unshift({
        format_id:    'bestvideo+bestaudio/best',
        label:        'Best',
        resolution:   'best',
        ext:          'mp4',
        filesize:     null,
        filesize_mb:  null,
        filesize_str: 'Auto',
        has_video:    true,
        has_audio:    true,
        note:         'Best available quality',
      });
    }

    return res.json({
      title:       info.title,
      duration:    info.duration,          // seconds
      duration_str: info.duration_string,
      thumbnail:   info.thumbnail,
      uploader:    info.uploader || info.channel,
      view_count:  info.view_count,
      upload_date: info.upload_date,
      webpage_url: info.webpage_url,
      extractor:   info.extractor_key,
      formats,
    });

  } catch (err) {
    console.error('[/api/info] Error:', err.message);

    if (err.message.includes('yt-dlp is not installed')) {
      return res.status(500).json({ error: 'yt-dlp is not installed on the server.' });
    }
    if (err.message.includes('Unsupported URL')) {
      return res.status(400).json({ error: 'This URL is not supported.' });
    }
    if (err.message.includes('Private video') || err.message.includes('Sign in')) {
      return res.status(403).json({ error: 'This video is private or requires login.' });
    }
    if (err.message.includes('not available')) {
      return res.status(404).json({ error: 'Video not found or unavailable in your region.' });
    }

    return res.status(500).json({ error: 'Could not fetch video info. ' + err.message });
  }
});

// ─── DOWNLOAD VIDEO ────────────────────────────────────────────────────────
// GET /api/download?url=<video_url>&format_id=<format_id>&title=<title>
//
// Streams the video file directly to the browser.
app.get('/api/download', async (req, res) => {
  const { url, format_id, title } = req.query;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid or missing URL.' });
  }

  const fmt    = format_id || 'bestvideo+bestaudio/best';
  const safeTitle = sanitizeFilename(title || 'video');
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `codex_${Date.now()}_${Math.random().toString(36).slice(2)}.%(ext)s`);

  const bin = process.env.YTDLP_PATH || 'yt-dlp';

  // yt-dlp args
  // -f: format selection
  // --merge-output-format mp4: merge video+audio into mp4
  // -o: output template
  // --no-playlist: don't download whole playlists
  // --no-warnings: cleaner stderr
  const args = [
    '-f', fmt,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '-o', tmpFile,
    url,
  ];

  console.log(`[/api/download] Starting: ${url} | format: ${fmt}`);

  const proc = spawn(bin, args);
  let stderr = '';

  proc.stderr.on('data', d => {
    stderr += d.toString();
    // Log progress lines for debugging
    const line = d.toString().trim();
    if (line.includes('[download]')) process.stdout.write('\r' + line);
  });

  proc.on('error', err => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'yt-dlp not found: ' + err.message });
    }
  });

  proc.on('close', async code => {
    if (code !== 0) {
      console.error('[/api/download] yt-dlp failed:', stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed. ' + (stderr.split('\n').slice(-2).join(' ')) });
      }
      return;
    }

    // Find the actual output file (extension may vary)
    const dir     = path.dirname(tmpFile);
    const prefix  = path.basename(tmpFile).split('.')[0];
    let finalFile = null;

    try {
      const files = fs.readdirSync(dir);
      finalFile = files.map(f => path.join(dir, f)).find(f => path.basename(f).startsWith(prefix));
    } catch {}

    if (!finalFile || !fs.existsSync(finalFile)) {
      console.error('[/api/download] Output file not found after yt-dlp finished.');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download finished but output file was not found.' });
      }
      return;
    }

    const ext      = path.extname(finalFile).slice(1) || 'mp4';
    const mimeMap  = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg' };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    const stat     = fs.statSync(finalFile);

    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Codex-Filename', `${safeTitle}.${ext}`);

    console.log(`\n[/api/download] Streaming ${(stat.size / 1e6).toFixed(1)} MB → ${safeTitle}.${ext}`);

    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);

    stream.on('close', () => {
      // Clean up temp file after streaming
      fs.unlink(finalFile, () => {});
      console.log(`[/api/download] Done & cleaned up: ${path.basename(finalFile)}`);
    });

    stream.on('error', err => {
      console.error('[/api/download] Stream error:', err.message);
      fs.unlink(finalFile, () => {});
    });

    req.on('close', () => {
      // Client disconnected early
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
  
  Routes:
    GET /health
    GET /api/info?url=<video_url>
    GET /api/download?url=<video_url>&format_id=<id>&title=<title>
  `);
});
