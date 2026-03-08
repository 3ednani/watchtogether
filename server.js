const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Server } = require('socket.io');
const path = require('path');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Prevent server crashes from unhandled stream/network errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (non-fatal):', err.message);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- FFmpeg detection ---
let ffmpegAvailable = false;
let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';
// Check common install locations as fallback
const ffmpegCandidates = ['ffmpeg'];
if (process.platform === 'win32') {
  const fs2 = require('fs');
  const base = 'C:\\ffmpeg';
  try {
    const entries = fs2.readdirSync(base);
    for (const e of entries) {
      const p = path.join(base, e, 'bin', 'ffmpeg.exe');
      if (fs2.existsSync(p)) ffmpegCandidates.push(p);
    }
  } catch (_) {}
}
for (const candidate of ffmpegCandidates) {
  try {
    execSync(`"${candidate}" -version`, { stdio: 'ignore' });
    ffmpegAvailable = true;
    ffmpegPath = candidate;
    // Derive ffprobe path from ffmpeg path
    if (candidate !== 'ffmpeg') {
      ffprobePath = candidate.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    }
    console.log('FFmpeg detected:', candidate);
    console.log('FFprobe path:', ffprobePath);
    break;
  } catch (_) {}
}
if (!ffmpegAvailable) {
  console.warn('FFmpeg not found — remuxing disabled, falling back to direct proxy');
}

// --- Hardware encoder detection ---
let hwEncoder = null; // { name, type, hwaccel }
if (ffmpegAvailable) {
  const encodersToTry = [];
  if (process.platform === 'win32') {
    encodersToTry.push({ name: 'h264_nvenc', type: 'NVENC', hwaccel: 'cuda' });
    encodersToTry.push({ name: 'h264_qsv', type: 'QuickSync', hwaccel: 'qsv' });
    encodersToTry.push({ name: 'h264_amf', type: 'AMF', hwaccel: 'auto' });
  } else if (process.platform === 'darwin') {
    encodersToTry.push({ name: 'h264_videotoolbox', type: 'VideoToolbox', hwaccel: 'videotoolbox' });
  } else {
    encodersToTry.push({ name: 'h264_nvenc', type: 'NVENC', hwaccel: 'cuda' });
    encodersToTry.push({ name: 'h264_vaapi', type: 'VAAPI', hwaccel: 'vaapi' });
    encodersToTry.push({ name: 'h264_qsv', type: 'QuickSync', hwaccel: 'qsv' });
  }
  for (const enc of encodersToTry) {
    try {
      execSync(`"${ffmpegPath}" -hide_banner -f lavfi -i nullsrc=s=256x256:d=1 -c:v ${enc.name} -frames:v 1 -f null -`, { stdio: 'ignore', timeout: 10000 });
      hwEncoder = enc;
      console.log(`Hardware encoder detected: ${enc.name} (${enc.type})`);
      break;
    } catch (_) {}
  }
  if (!hwEncoder) {
    console.log('No hardware encoder found, using libx264 (CPU)');
  }
}

// --- MediaFlow Proxy integration ---
const MEDIAFLOW_URL = (process.env.MEDIAFLOW_URL || '').replace(/\/+$/, '');
const MEDIAFLOW_API_PASSWORD = process.env.MEDIAFLOW_API_PASSWORD || '';
if (MEDIAFLOW_URL) {
  console.log('MediaFlow Proxy configured:', MEDIAFLOW_URL);
}

// --- Transcode stream management ---
const transcodeStreams = new Map(); // streamKey -> { process, url, startTime }

function probeInput(url, referer) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format'];
    const headerStr = referer
      ? `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`
      : `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`;
    args.push('-headers', headerStr, '-i', url);

    const proc = spawn(ffprobePath, args, { timeout: 30000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed: ' + stderr.slice(0, 200)));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('Failed to parse ffprobe output')); }
    });
    proc.on('error', reject);
  });
}


// Metadata cache for probed streams
const metadataCache = new Map(); // url -> metadata
const subtitleCache = new Map(); // "url|track" -> { status: 'extracting'|'done', data: '' }

// Helper: get stream key from URL
function getStreamKey(url) {
  return crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
}

// Helper: probe and cache metadata
async function getOrProbeMetadata(url, referer) {
  if (metadataCache.has(url)) return metadataCache.get(url);
  const probeInfo = await probeInput(url, referer);
  const streams = probeInfo.streams || [];
  const videoStreams = streams.filter(s => s.codec_type === 'video');
  const audioStreams = streams.filter(s => s.codec_type === 'audio');
  const textSubCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
  const subtitleStreams = streams.filter(s =>
    s.codec_type === 'subtitle' && textSubCodecs.includes(s.codec_name)
  );

  let duration = parseFloat(probeInfo.format?.duration) || 0;
  if (!duration && videoStreams.length > 0) {
    duration = parseFloat(videoStreams[0].duration) || 0;
  }

  const videoCodec = videoStreams[0]?.codec_name || 'unknown';
  const needsTranscode = videoCodec !== 'h264';
  const webAudioCodecs = ['aac', 'mp3', 'opus'];

  const metadata = {
    duration,
    videoCodec,
    needsTranscode,
    width: videoStreams[0]?.width || 0,
    height: videoStreams[0]?.height || 0,
    audioTracks: audioStreams.map((a, i) => ({
      index: i,
      codec: a.codec_name,
      lang: a.tags?.language || 'und',
      title: a.tags?.title || a.tags?.language || `Track ${i + 1}`,
      needsTranscode: !webAudioCodecs.includes(a.codec_name?.toLowerCase())
    })),
    subtitleTracks: subtitleStreams.map((s, i) => ({
      index: i,
      streamIndex: s.index,
      lang: s.tags?.language || 'und',
      title: s.tags?.title || s.tags?.language || `Sub ${i + 1}`
    }))
  };

  console.log(`[Transcode] Probe: duration=${duration.toFixed(1)}s, video=${videoCodec}${needsTranscode ? '->transcode' : '->copy'}, ${audioStreams.length} audio, ${subtitleStreams.length} subs`);
  metadataCache.set(url, metadata);

  // Pre-extract all subtitle tracks in background so they're cached for seeking
  if (subtitleStreams.length > 0) {
    preExtractSubtitles(url, referer, subtitleStreams.length);
  }

  return metadata;
}

function preExtractSubtitles(url, referer, trackCount) {
  const headerStr = referer
    ? `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`
    : `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`;

  for (let track = 0; track < trackCount; track++) {
    const cacheKey = `${url}|${track}`;
    if (subtitleCache.has(cacheKey)) continue;

    subtitleCache.set(cacheKey, { status: 'extracting', data: '' });
    console.log(`[Subtitles] Pre-extracting track ${track} for ${url.substring(0, 60)}...`);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-headers', headerStr,
      '-i', url,
      '-map', `0:s:${track}`,
      '-c:s', 'webvtt',
      '-f', 'webvtt',
      'pipe:1'
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let vttData = '';

    proc.stdout.on('data', (chunk) => {
      vttData += chunk.toString();
      // Update cache progressively so client gets partial data while extracting
      const entry = subtitleCache.get(cacheKey);
      if (entry) entry.data = vttData;
    });

    proc.on('close', (code) => {
      const entry = subtitleCache.get(cacheKey);
      if (entry) {
        entry.status = 'done';
        entry.data = vttData;
      }
      console.log(`[Subtitles] Track ${track} extraction ${code === 0 ? 'complete' : 'failed'} (${vttData.length} bytes)`);
    });

    proc.on('error', () => {
      subtitleCache.delete(cacheKey);
    });
  }
}

// Helper: build FFmpeg args for fragmented MP4 streaming
function buildTranscodeArgs(url, referer, startTime, audioTrack, metadata) {
  const headerStr = referer
    ? `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`
    : `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`;

  const args = ['-hide_banner', '-loglevel', 'error'];

  // Hardware decoding
  if (metadata.needsTranscode && hwEncoder) {
    if (hwEncoder.hwaccel === 'cuda') args.push('-hwaccel', 'cuda');
    else if (hwEncoder.hwaccel === 'qsv') args.push('-hwaccel', 'qsv');
    else if (hwEncoder.hwaccel === 'd3d11va') args.push('-hwaccel', 'd3d11va');
  }

  // Fast seek before input
  if (startTime > 0) args.push('-ss', String(startTime));

  args.push('-headers', headerStr);
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push('-i', url);

  // Map video + selected audio
  args.push('-map', '0:v:0', '-map', `0:a:${audioTrack}?`);

  // Video encoding
  if (metadata.needsTranscode) {
    args.push('-pix_fmt', 'yuv420p');
    if (hwEncoder) {
      args.push('-c:v', hwEncoder.name);
      if (hwEncoder.type === 'NVENC') {
        args.push('-preset', 'p4', '-cq', '23', '-bf', '0');
      } else if (hwEncoder.type === 'QuickSync') {
        args.push('-preset', 'veryfast', '-global_quality', '23', '-bf', '0');
      } else if (hwEncoder.type === 'AMF') {
        args.push('-quality', 'speed', '-bf', '0');
      } else if (hwEncoder.type === 'VideoToolbox') {
        args.push('-q:v', '65', '-bf', '0');
      }
    } else {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency');
      args.push('-crf', '23', '-profile:v', 'high', '-level', '4.1', '-bf', '0');
    }
  } else {
    args.push('-c:v', 'copy');
  }

  // Audio encoding
  const audioInfo = metadata.audioTracks[audioTrack];
  if (audioInfo && !audioInfo.needsTranscode) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  // Fragmented MP4 output piped to stdout
  args.push(
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    '-f', 'mp4',
    'pipe:1'
  );

  return args;
}

// --- API endpoints ---

app.get('/api/capabilities', (req, res) => {
  res.json({ ffmpeg: ffmpegAvailable, hwEncoder: hwEncoder ? hwEncoder.type : null });
});

// --- Helper: fetch JSON from external API ---
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, (res) => {
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).setTimeout(15000, function() {
      this.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// --- Cinemeta / Torrentio API proxy ---
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

// Search movies/series via Cinemeta catalog
app.get('/api/search', async (req, res) => {
  const { type, query } = req.query;
  if (!query || !type) return res.status(400).json({ error: 'Missing type or query' });
  try {
    const url = `${CINEMETA_BASE}/catalog/${encodeURIComponent(type)}/top/search=${encodeURIComponent(query)}.json`;
    const data = await fetchJSON(url);
    res.json(data);
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(502).json({ error: 'Search failed' });
  }
});

// Get metadata (details, episodes) from Cinemeta
app.get('/api/meta/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  try {
    const url = `${CINEMETA_BASE}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const data = await fetchJSON(url);
    res.json(data);
  } catch (e) {
    console.error('Meta error:', e.message);
    res.status(502).json({ error: 'Meta fetch failed' });
  }
});

// Get manifest from any Stremio addon (to fetch addon name)
app.get('/api/addon-manifest', async (req, res) => {
  const addonUrl = req.query.addon;
  if (!addonUrl) return res.status(400).json({ error: 'Missing addon parameter' });
  try {
    const base = addonUrl.replace(/\/+$/, '');
    const data = await fetchJSON(`${base}/manifest.json`);
    res.json(data);
  } catch (e) {
    console.error('Manifest error:', e.message);
    res.status(502).json({ error: 'Manifest fetch failed' });
  }
});

// Get streams from any Stremio addon
app.get('/api/streams/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const addonUrl = req.query.addon; // full addon base URL
  if (!addonUrl) return res.status(400).json({ error: 'Missing addon parameter' });
  try {
    // Stremio addon protocol: {baseUrl}/stream/{type}/{id}.json
    const base = addonUrl.replace(/\/+$/, '');
    const url = `${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const data = await fetchJSON(url);
    res.json(data);
  } catch (e) {
    console.error('Streams error:', e.message);
    res.status(502).json({ error: 'Stream fetch failed' });
  }
});

// --- Transcode endpoints ---

// Probe stream metadata
app.get('/transcode/metadata', async (req, res) => {
  if (!ffmpegAvailable) return res.status(503).json({ error: 'FFmpeg not available' });
  const url = req.query.url;
  const referer = req.query.referer || '';
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    const metadata = await getOrProbeMetadata(url, referer);
    res.json(metadata);
  } catch (e) {
    console.error('[Transcode] Probe failed:', e.message);
    res.status(500).json({ error: 'Probe failed: ' + e.message });
  }
});

// Stream transcoded/remuxed fragmented MP4
app.get('/transcode/stream', async (req, res) => {
  if (!ffmpegAvailable) return res.status(503).send('FFmpeg not available');
  const url = req.query.url;
  const referer = req.query.referer || '';
  const startTime = parseFloat(req.query.t) || 0;
  const audioTrack = parseInt(req.query.audio) || 0;
  if (!url) return res.status(400).send('Missing url parameter');

  const streamKey = getStreamKey(url);

  // Kill existing stream for this URL
  const existing = transcodeStreams.get(streamKey);
  if (existing && existing.process && !existing.process.killed) {
    existing.process.kill('SIGKILL');
    transcodeStreams.delete(streamKey);
  }

  let metadata;
  try {
    metadata = await getOrProbeMetadata(url, referer);
  } catch (e) {
    console.error('[Transcode] Probe failed:', e.message);
    return res.status(500).send('Probe failed');
  }

  if (!metadata.duration || metadata.duration <= 0) {
    return res.status(500).send('Could not determine duration');
  }

  const args = buildTranscodeArgs(url, referer, startTime, audioTrack, metadata);
  const encLabel = metadata.needsTranscode ? (hwEncoder ? hwEncoder.name : 'libx264') : 'copy';
  console.log(`[Transcode] Start: t=${startTime}s audio=${audioTrack} video=${encLabel}`);

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let hasOutput = false;
  let hwFailed = false;

  transcodeStreams.set(streamKey, { process: proc, url, startTime });

  res.set('Content-Type', 'video/mp4');
  res.set('Cache-Control', 'no-cache');
  res.set('Transfer-Encoding', 'chunked');
  res.set('X-Duration', String(metadata.duration));
  res.set('X-Start-Time', String(startTime));

  proc.stdout.on('data', (chunk) => {
    hasOutput = true;
    if (!res.writableEnded) res.write(chunk);
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('Invalid')) {
      console.error('[Transcode] FFmpeg:', msg.trim().substring(0, 200));
    }
  });

  proc.on('close', (code) => {
    transcodeStreams.delete(streamKey);
    // Retry with software encoder if hardware failed
    if (code !== 0 && !hasOutput && metadata.needsTranscode && hwEncoder && !hwFailed) {
      console.log('[Transcode] Hardware encoder failed, retrying with libx264...');
      hwFailed = true;
      const swArgs = buildTranscodeArgs(url, referer, startTime, audioTrack, { ...metadata, needsTranscode: true });
      // Replace hardware encoder args with libx264
      const nvIdx = swArgs.indexOf(hwEncoder.name);
      if (nvIdx !== -1) {
        // Remove hwaccel args
        const hwIdx = swArgs.indexOf('-hwaccel');
        if (hwIdx !== -1) swArgs.splice(hwIdx, 2);
        // Replace encoder
        swArgs[swArgs.indexOf(hwEncoder.name)] = 'libx264';
        // Add libx264 specific args
        const encIdx = swArgs.indexOf('libx264');
        swArgs.splice(encIdx + 1, 0, '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-bf', '0');
        // Remove hw-specific args after encoder (preset, cq, etc already in buildTranscodeArgs)
      }
      const swProc = spawn(ffmpegPath, swArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      transcodeStreams.set(streamKey, { process: swProc, url, startTime });
      swProc.stdout.on('data', (chunk) => { if (!res.writableEnded) res.write(chunk); });
      swProc.stderr.on('data', () => {});
      swProc.on('close', () => { transcodeStreams.delete(streamKey); if (!res.writableEnded) res.end(); });
      req.on('close', () => { swProc.kill('SIGKILL'); transcodeStreams.delete(streamKey); });
      return;
    }
    if (!res.writableEnded) res.end();
  });

  proc.on('error', (err) => {
    console.error('[Transcode] FFmpeg spawn error:', err.message);
    transcodeStreams.delete(streamKey);
    if (!res.headersSent) res.status(500).send('FFmpeg error');
  });

  req.on('close', () => {
    if (!proc.killed) proc.kill('SIGKILL');
    transcodeStreams.delete(streamKey);
  });
});

// Extract single subtitle track as WebVTT
app.get('/transcode/subtitles', (req, res) => {
  if (!ffmpegAvailable) return res.status(503).send('FFmpeg not available');
  const url = req.query.url;
  const referer = req.query.referer || '';
  const track = parseInt(req.query.track) || 0;
  if (!url) return res.status(400).send('Missing url parameter');

  const cacheKey = `${url}|${track}`;
  const cached = subtitleCache.get(cacheKey);

  // Serve from cache — send whatever we have (complete or partial)
  if (cached && cached.data.length > 0) {
    res.set('Content-Type', 'text/vtt');
    res.set('Cache-Control', 'no-cache');
    res.send(cached.data);
    return;
  }

  // Fallback: extract on demand if cache miss
  const headerStr = referer
    ? `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`
    : `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-headers', headerStr,
    '-i', url,
    '-map', `0:s:${track}`,
    '-c:s', 'webvtt',
    '-f', 'webvtt',
    'pipe:1'
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  res.set('Content-Type', 'text/vtt');
  res.set('Cache-Control', 'no-cache');
  proc.stdout.pipe(res);
  proc.on('error', () => { if (!res.headersSent) res.status(500).send('Subtitle extraction failed'); });
  proc.on('close', (code) => { if (code !== 0 && !res.headersSent) res.status(500).send('Subtitle extraction failed'); });
  req.on('close', () => { if (!proc.killed) proc.kill('SIGKILL'); });
});

// Cleanup transcode streams on exit
process.on('SIGINT', () => {
  transcodeStreams.forEach(s => { if (s.process && !s.process.killed) s.process.kill('SIGKILL'); });
});

// CORS proxy for HLS streams
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  const customReferer = req.query.referer || null;
  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const referer = customReferer || parsed.origin;

  const proxyHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': referer,
    'Origin': referer.replace(/\/$/, ''),
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };

  // Forward Range header for seeking support
  if (req.headers.range) {
    proxyHeaders['Range'] = req.headers.range;
  }

  // Helper: rewrite m3u8 playlist body so all URLs route through our proxy
  const isPlaylistUrl = targetUrl.includes('.m3u8') || req.query.playlist === '1';
  const rewritePlaylist = (body) => {
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
    const refParam = customReferer ? '&referer=' + encodeURIComponent(customReferer) : '';
    const isMasterPl = body.includes('#EXT-X-STREAM-INF') || body.includes('#EXT-X-MEDIA');
    const plHint = isMasterPl ? '&playlist=1' : '';
    const origin = new URL(targetUrl).origin;
    const proxyLine = (url) => {
      let absolute;
      if (url.startsWith('http')) absolute = url;
      else if (url.startsWith('/')) absolute = origin + url;
      else absolute = baseUrl + url;
      return '/proxy?url=' + encodeURIComponent(absolute) + refParam + plHint;
    };
    let rewritten = body.replace(/^(?!#)(.+)$/gm, (match, line) => {
      line = line.trim();
      if (!line) return match;
      return proxyLine(line);
    });
    rewritten = rewritten.replace(/URI="([^"]+)"/g, (match, uri) => {
      return 'URI="' + proxyLine(uri) + '"';
    });
    return rewritten;
  };

  // For m3u8 playlists via MediaFlow: use the dedicated HLS manifest endpoint
  // (/proxy/hls/manifest.m3u8) instead of /proxy/stream which never completes for text.
  // Without MediaFlow: fetch directly from CDN.
  if (isPlaylistUrl) {
    let playlistFetchUrl, playlistFetchClient, playlistFetchHeaders;

    if (MEDIAFLOW_URL) {
      const mfUrl = new URL(MEDIAFLOW_URL + '/proxy/hls/manifest.m3u8');
      mfUrl.searchParams.set('d', targetUrl);
      if (MEDIAFLOW_API_PASSWORD) mfUrl.searchParams.set('api_password', MEDIAFLOW_API_PASSWORD);
      playlistFetchUrl = mfUrl.href;
      playlistFetchClient = mfUrl.protocol === 'https:' ? https : http;
      playlistFetchHeaders = { 'Accept-Encoding': 'identity' };
      console.log('Fetching playlist via MediaFlow HLS endpoint:', targetUrl.substring(0, 100));
    } else {
      playlistFetchUrl = targetUrl;
      playlistFetchClient = parsed.protocol === 'https:' ? https : http;
      playlistFetchHeaders = proxyHeaders;
      console.log('Fetching playlist directly:', targetUrl.substring(0, 100));
    }

    const playlistReq = playlistFetchClient.get(playlistFetchUrl, { headers: playlistFetchHeaders }, (proxyRes) => {
      console.log('Playlist response:', proxyRes.statusCode, 'ct:', proxyRes.headers['content-type'] || 'none');

      // Follow redirects
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        const redirectUrl = new URL(proxyRes.headers.location, playlistFetchUrl).href;
        proxyRes.resume();
        const refParam = customReferer ? '&referer=' + encodeURIComponent(customReferer) : '';
        res.redirect('/proxy?url=' + encodeURIComponent(redirectUrl) + refParam);
        return;
      }

      if (proxyRes.statusCode >= 400) {
        console.error('Playlist upstream error:', proxyRes.statusCode);
        proxyRes.resume();
        if (!res.headersSent) res.status(proxyRes.statusCode).send('Playlist fetch failed');
        return;
      }

      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', (chunk) => { body += chunk; });
      proxyRes.on('end', () => {
        console.log('Playlist body length:', body.length, 'first 200 chars:', JSON.stringify(body.substring(0, 200)));
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', '*');
        if (!body.trim().startsWith('#EXTM3U')) {
          if (proxyRes.headers['content-type']) res.set('Content-Type', proxyRes.headers['content-type']);
          res.send(body);
          return;
        }

        // Master playlists reference sub-playlists; media playlists reference segments
        const isMaster = body.includes('#EXT-X-STREAM-INF') || body.includes('#EXT-X-MEDIA');
        const playlistHint = isMaster ? '&playlist=1' : '';

        let rewritten;
        if (MEDIAFLOW_URL) {
          // MediaFlow rewrites URLs to point through itself. Re-rewrite through our proxy.
          const mfOrigin = new URL(MEDIAFLOW_URL).origin;
          const mfEscaped = mfOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const refParam = customReferer ? '&referer=' + encodeURIComponent(customReferer) : '';
          rewritten = body.replace(new RegExp(mfEscaped + '/proxy/[^\\s"\\n]*', 'g'), (mfLink) => {
            try {
              const u = new URL(mfLink);
              let originalUrl = u.searchParams.get('d');
              if (originalUrl) {
                // Resolve relative URLs (like /storage/enc.key) against the target
                if (!originalUrl.startsWith('http')) {
                  originalUrl = new URL(originalUrl, targetUrl).href;
                }
                return '/proxy?url=' + encodeURIComponent(originalUrl) + refParam + playlistHint;
              }
            } catch (e) {}
            return mfLink;
          });
        } else {
          rewritten = rewritePlaylist(body);
        }
        console.log('Rewritten playlist first 300 chars:', JSON.stringify(rewritten.substring(0, 300)));
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
      });
      proxyRes.on('error', (err) => {
        console.error('Playlist response error:', err.message);
        if (!res.headersSent) res.status(502).send('Playlist read error');
      });
    });
    playlistReq.on('error', (err) => {
      console.error('Playlist fetch error:', err.message);
      if (!res.headersSent) res.status(502).send('Playlist fetch failed');
    });
    playlistReq.setTimeout(15000, () => {
      playlistReq.destroy();
      if (!res.headersSent) res.status(504).send('Playlist fetch timeout');
    });
    return;
  }

  // Route through MediaFlow Proxy if configured (for non-playlist requests)
  // Includes retry logic for transient errors (socket hang up, etc.)
  const doProxyRequest = (attempt) => {
    let fetchUrl = targetUrl;
    let fetchClient = client;
    if (MEDIAFLOW_URL) {
      const mfUrl = new URL(MEDIAFLOW_URL + '/proxy/stream');
      mfUrl.searchParams.set('d', targetUrl);
      if (MEDIAFLOW_API_PASSWORD) mfUrl.searchParams.set('api_password', MEDIAFLOW_API_PASSWORD);
      fetchUrl = mfUrl.href;
      fetchClient = mfUrl.protocol === 'https:' ? https : http;
      if (attempt === 1) console.log('Proxy via MediaFlow:', targetUrl.substring(0, 100));
      else console.log('Proxy via MediaFlow (retry #' + attempt + '):', targetUrl.substring(0, 100));
    }

    const fetchHeaders = MEDIAFLOW_URL ? { 'Accept-Encoding': 'identity' } : proxyHeaders;
    const proxyReq = fetchClient.get(fetchUrl, { headers: fetchHeaders }, (proxyRes) => {
      if (MEDIAFLOW_URL) {
        console.log('MediaFlow response:', proxyRes.statusCode, 'ct:', proxyRes.headers['content-type'] || 'none', targetUrl.substring(0, 100));
      }
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Headers', '*');

      // Follow redirects (3xx)
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        const redirectUrl = new URL(proxyRes.headers.location, targetUrl).href;
        proxyRes.resume();
        const refParam = customReferer ? '&referer=' + encodeURIComponent(customReferer) : '';
        res.redirect('/proxy?url=' + encodeURIComponent(redirectUrl) + refParam);
        return;
      }

      // Forward upstream errors
      if (proxyRes.statusCode >= 400) {
        console.error('Proxy upstream error:', proxyRes.statusCode, targetUrl.substring(0, 80));
        res.status(proxyRes.statusCode);
        proxyRes.pipe(res).on('error', () => {});
        return;
      }

      // If MediaFlow returned a playlist content-type, /proxy/stream won't deliver
      // the body. Abort and re-fetch through the HLS manifest endpoint.
      const contentType = proxyRes.headers['content-type'] || '';
      const isPlaylist = contentType.includes('mpegurl') || contentType.includes('apple');

      if (MEDIAFLOW_URL && isPlaylist) {
        proxyRes.destroy();
        proxyReq.destroy();
        console.log('Playlist detected from /proxy/stream, re-fetching via HLS endpoint:', targetUrl.substring(0, 100));
        const mfHlsUrl = new URL(MEDIAFLOW_URL + '/proxy/hls/manifest.m3u8');
        mfHlsUrl.searchParams.set('d', targetUrl);
        if (MEDIAFLOW_API_PASSWORD) mfHlsUrl.searchParams.set('api_password', MEDIAFLOW_API_PASSWORD);
        const hlsClient = mfHlsUrl.protocol === 'https:' ? https : http;
        const hlsReq = hlsClient.get(mfHlsUrl.href, { headers: { 'Accept-Encoding': 'identity' } }, (hlsRes) => {
          if (hlsRes.statusCode >= 400) {
            hlsRes.resume();
            if (!res.headersSent) res.status(hlsRes.statusCode).send('Playlist fetch failed');
            return;
          }
          let body = '';
          hlsRes.setEncoding('utf8');
          hlsRes.on('data', (chunk) => { body += chunk; });
          hlsRes.on('end', () => {
            console.log('HLS re-fetch body length:', body.length);
            if (res.headersSent) return;
            if (!body.trim().startsWith('#EXTM3U')) {
              res.set('Content-Type', contentType);
              res.send(body);
              return;
            }
            const isMaster2 = body.includes('#EXT-X-STREAM-INF') || body.includes('#EXT-X-MEDIA');
            const playlistHint2 = isMaster2 ? '&playlist=1' : '';
            const mfOrigin = new URL(MEDIAFLOW_URL).origin;
            const mfEscaped = mfOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const refParam = customReferer ? '&referer=' + encodeURIComponent(customReferer) : '';
            const rewritten = body.replace(new RegExp(mfEscaped + '/proxy/[^\\s"\\n]*', 'g'), (mfLink) => {
              try {
                const u = new URL(mfLink);
                let originalUrl = u.searchParams.get('d');
                if (originalUrl) {
                  if (!originalUrl.startsWith('http')) {
                    originalUrl = new URL(originalUrl, targetUrl).href;
                  }
                  return '/proxy?url=' + encodeURIComponent(originalUrl) + refParam + playlistHint2;
                }
              } catch (e) {}
              return mfLink;
            });
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(rewritten);
          });
          hlsRes.on('error', (err) => {
            console.error('HLS re-fetch error:', err.message);
            if (!res.headersSent) res.status(502).send('Playlist read error');
          });
        });
        hlsReq.on('error', (err) => {
          console.error('HLS re-fetch request error:', err.message);
          if (!res.headersSent) res.status(502).send('Playlist fetch failed');
        });
        hlsReq.setTimeout(15000, () => {
          hlsReq.destroy();
          if (!res.headersSent) res.status(504).send('Playlist fetch timeout');
        });
        return;
      }

      if (isPlaylist) {
        let body = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', (chunk) => { body += chunk; });
        proxyRes.on('end', () => {
          console.log('Playlist body length:', body.length);
          if (res.headersSent) return;
          if (!body.trim().startsWith('#EXTM3U')) {
            if (proxyRes.headers['content-type']) res.set('Content-Type', proxyRes.headers['content-type']);
            res.send(body);
            return;
          }
          const rewritten = rewritePlaylist(body);
          res.set('Content-Type', 'application/vnd.apple.mpegurl');
          res.send(rewritten);
        });
      } else {
        // Stream binary data (video segments, keys, etc.)
        console.log('Proxy binary:', proxyRes.statusCode, targetUrl.substring(0, 100));
      // Forward status code (206 for partial content / range requests)
      res.status(proxyRes.statusCode);
      if (proxyRes.headers['content-type']) {
        res.set('Content-Type', proxyRes.headers['content-type']);
      }
      if (proxyRes.headers['content-length']) {
        res.set('Content-Length', proxyRes.headers['content-length']);
      }
      if (proxyRes.headers['content-range']) {
        res.set('Content-Range', proxyRes.headers['content-range']);
      }
      if (proxyRes.headers['accept-ranges']) {
        res.set('Accept-Ranges', proxyRes.headers['accept-ranges']);
      }
      proxyRes.pipe(res).on('error', () => {});
    }
  });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message, 'attempt:', attempt);
      if (MEDIAFLOW_URL && attempt < 3 && !res.headersSent) {
        console.log('Retrying MediaFlow request...');
        setTimeout(() => doProxyRequest(attempt + 1), 500 * attempt);
      } else if (!res.headersSent) {
        res.status(502).send('Proxy error');
      }
    });

    proxyReq.setTimeout(MEDIAFLOW_URL ? 60000 : 15000, () => {
      proxyReq.destroy();
      console.error('Proxy timeout:', targetUrl.substring(0, 80));
      if (!res.headersSent) res.status(504).send('Proxy timeout');
    });

    req.on('close', () => {
      proxyReq.destroy();
    });
  };

  doProxyRequest(1);
});

// Store room state
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    socket.roomId = roomId;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { videoUrl: '', currentTime: 0, playing: false, duration: 0, subtitle: null, contentMeta: null, audioTracks: null, subtitleTracks: null, selectedAudioTrack: null, selectedSubtitleTrack: null });
    }

    const state = rooms.get(roomId);
    // Send current room state to the new user
    socket.emit('room-state', state);

    const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    io.to(roomId).emit('user-count', count);
    console.log(`User ${socket.id} joined room ${roomId} (${count} users)`);
  });

  // Latency measurement — echo back client timestamp + server time
  socket.on('ping-sync', (data) => {
    socket.emit('pong-sync', { clientSent: data.clientSent, serverTime: Date.now() });
  });

  // Heartbeat relay — forward playback position to partner with server timestamp
  socket.on('sync-heartbeat', (data) => {
    data.serverRelayTime = Date.now();
    socket.to(socket.roomId).emit('sync-heartbeat', data);
  });

  socket.on('set-video', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.videoUrl = data.url;
      room.videoReferer = data.referer || '';
      room.isTranscode = !!data.transcode;
      room.currentTime = 0;
      room.playing = false;
      room.audioTracks = null;
      room.subtitleTracks = null;
      room.selectedAudioTrack = null;
      room.selectedSubtitleTrack = null;
    }
    socket.to(socket.roomId).emit('set-video', data);
  });

  // Sync selected content metadata (title, poster) to room
  socket.on('set-content', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.contentMeta = data;
    }
    socket.to(socket.roomId).emit('set-content', data);
  });

  socket.on('play', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.playing = true;
      room.currentTime = data.currentTime;
    }
    socket.to(socket.roomId).emit('play', data);
  });

  socket.on('pause', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.playing = false;
      room.currentTime = data.currentTime;
    }
    socket.to(socket.roomId).emit('pause', data);
  });

  socket.on('seek', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.currentTime = data.currentTime;
    }
    socket.to(socket.roomId).emit('seek', data);
  });

  socket.on('set-duration', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && data.duration) {
      room.duration = data.duration;
    }
    socket.to(socket.roomId).emit('set-duration', data);
  });

  // Subtitle sync: { url, label } for URL-based, { vttText, label } for file-based
  socket.on('set-subtitle', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.subtitle = data;
    }
    socket.to(socket.roomId).emit('set-subtitle', data);
  });

  socket.on('remove-subtitle', () => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.subtitle = null;
    }
    socket.to(socket.roomId).emit('remove-subtitle');
  });

  // Track list broadcasting (Player/Both -> Remote)
  socket.on('broadcast-audio-tracks', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.audioTracks = data.tracks;
      room.selectedAudioTrack = data.selected != null ? data.selected : 0;
    }
    socket.to(socket.roomId).emit('broadcast-audio-tracks', data);
  });

  socket.on('broadcast-subtitle-tracks', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.subtitleTracks = data.tracks;
      room.selectedSubtitleTrack = data.selected;
    }
    socket.to(socket.roomId).emit('broadcast-subtitle-tracks', data);
  });

  // Track selection (Remote -> Player/Both)
  socket.on('select-audio-track', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.selectedAudioTrack = data.index;
    }
    socket.to(socket.roomId).emit('select-audio-track', data);
  });

  socket.on('select-subtitle-track', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.selectedSubtitleTrack = data.index;
    }
    socket.to(socket.roomId).emit('select-subtitle-track', data);
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const count = io.sockets.adapter.rooms.get(socket.roomId)?.size || 0;
      io.to(socket.roomId).emit('user-count', count);

      // Clean up empty rooms
      if (count === 0) {
        rooms.delete(socket.roomId);
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
