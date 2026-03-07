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

// --- Remux session management ---
const remuxSessions = new Map();
const REMUX_DIR = path.join(os.tmpdir(), 'watch-together-remux');
const MAX_REMUX_SESSIONS = 3;
const SEGMENT_DURATION = 4; // seconds per HLS segment

if (ffmpegAvailable) {
  try { fs.mkdirSync(REMUX_DIR, { recursive: true }); } catch (e) {}
}

function sanitizeName(name) {
  return (name || 'track').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30) || 'track';
}

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

function extractSubtitles(sessionId, session, url, referer, subtitleStreams) {
  if (subtitleStreams.length === 0) return;
  session.subtitles = [];

  const headerStr = referer
    ? `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`
    : `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`;

  subtitleStreams.forEach((sub, i) => {
    const lang = sub.tags?.language || 'und';
    const title = sub.tags?.title || sub.tags?.language || `Sub_${i + 1}`;
    const vttFile = path.join(session.dir, `sub_${i}.vtt`);
    const subInfo = { index: i, lang, title, file: `sub_${i}.vtt`, ready: false };
    session.subtitles.push(subInfo);

    const args = [
      '-headers', headerStr,
      '-i', url,
      '-map', `0:${sub.index}`,
      '-c:s', 'webvtt',
      '-f', 'webvtt',
      vttFile
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(vttFile)) {
        subInfo.ready = true;
        console.log(`Remux ${sessionId}: subtitle ${i} (${title}) extracted`);
      } else {
        console.warn(`Remux ${sessionId}: subtitle ${i} extraction failed (code ${code})`);
      }
    });
    proc.on('error', () => {});
  });
}

function writeMasterPlaylist(session, audioStreams) {
  let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
  if (audioStreams.length > 0) {
    audioStreams.forEach((audio, i) => {
      const lang = (audio.tags?.language || 'und').replace(/"/g, '');
      const title = (audio.tags?.title || audio.tags?.language || `Track ${i + 1}`).replace(/"/g, '');
      const isDefault = i === 0 ? 'YES' : 'NO';
      playlist += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${title}",LANGUAGE="${lang}",DEFAULT=${isDefault},AUTOSELECT=YES,URI="a${i}.m3u8"\n`;
    });
    playlist += `\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="audio"\n`;
  } else {
    playlist += '#EXT-X-STREAM-INF:BANDWIDTH=5000000\n';
  }
  playlist += 'video.m3u8\n';
  fs.writeFileSync(path.join(session.dir, 'master.m3u8'), playlist);
}

function generateVodPlaylist(totalSegments, segmentDuration, duration, segmentPrefix) {
  let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';
  playlist += '#EXT-X-TARGETDURATION:' + Math.ceil(segmentDuration) + '\n';
  playlist += '#EXT-X-MEDIA-SEQUENCE:0\n';
  playlist += '#EXT-X-PLAYLIST-TYPE:VOD\n';
  for (let i = 0; i < totalSegments; i++) {
    const isLast = i === totalSegments - 1;
    const segDur = isLast ? Math.max(0.1, duration - i * segmentDuration) : segmentDuration;
    playlist += '#EXTINF:' + segDur.toFixed(6) + ',\n';
    playlist += segmentPrefix + String(i).padStart(4, '0') + '.ts\n';
  }
  playlist += '#EXT-X-ENDLIST\n';
  return playlist;
}

function startRemux(sessionId, session, url, referer) {
  probeInput(url, referer).then((probeInfo) => {
    session.probeData = probeInfo;
    const streams = probeInfo.streams || [];
    const videoStreams = streams.filter(s => s.codec_type === 'video');
    const audioStreams = streams.filter(s => s.codec_type === 'audio');
    const textSubCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
    const subtitleStreams = streams.filter(s =>
      s.codec_type === 'subtitle' && textSubCodecs.includes(s.codec_name)
    );

    // Get duration from format (most reliable) or video stream
    let duration = 0;
    if (probeInfo.format && probeInfo.format.duration) {
      duration = parseFloat(probeInfo.format.duration);
    }
    if (!duration && videoStreams.length > 0 && videoStreams[0].duration) {
      duration = parseFloat(videoStreams[0].duration);
    }
    if (!duration || !isFinite(duration) || duration <= 0) {
      session.state = 'error';
      session.error = 'Could not determine video duration';
      console.error(`Remux ${sessionId}: could not determine duration`);
      return;
    }

    const videoCodec = videoStreams.length > 0 ? videoStreams[0].codec_name : 'unknown';
    const needsVideoTranscode = videoCodec !== 'h264';

    // Store session metadata for on-demand seeking
    session.duration = duration;
    session.segmentDuration = SEGMENT_DURATION;
    session.totalSegments = Math.ceil(duration / SEGMENT_DURATION);
    session.needsVideoTranscode = needsVideoTranscode;
    session.audioStreamCount = audioStreams.length;
    session.audioStreamsData = audioStreams;
    session.currentStartSegment = 0;
    session.lastGeneratedSegment = -1;
    session.seekLock = false;

    console.log(`Probe ${sessionId}: duration=${duration.toFixed(1)}s, ${session.totalSegments} segments, video=${videoCodec}${needsVideoTranscode ? '->transcode' : '->copy'}, ${audioStreams.length} audio, ${subtitleStreams.length} subs`);
    audioStreams.forEach((a, i) => console.log(`  Audio #${i}: codec=${a.codec_name} lang=${a.tags?.language || 'und'} title="${a.tags?.title || ''}"`));

    // Store audio track info for the client
    session.audioInfo = audioStreams.map((a, i) => ({
      index: i,
      codec: a.codec_name,
      lang: a.tags?.language || 'und',
      title: a.tags?.title || a.tags?.language || `Track ${i + 1}`
    }));

    // Extract subtitles as separate VTT files (non-blocking)
    extractSubtitles(sessionId, session, url, referer, subtitleStreams);

    // Write master playlist with audio groups
    writeMasterPlaylist(session, audioStreams);

    // Start FFmpeg from the beginning (segment 0)
    spawnRemuxProcess(sessionId, session, 0);

    session.state = 'ready';
    session.masterReady = true;
  }).catch((err) => {
    session.state = 'error';
    session.error = 'Probe failed: ' + err.message;
    console.error(`Remux ${sessionId}: probe failed:`, err.message);
  });
}

// Spawn FFmpeg starting from a specific segment number (used for initial start and seek-restart)
function spawnRemuxProcess(sessionId, session, startSegment) {
  const seekTime = startSegment * session.segmentDuration;

  const args = [];
  const headerStr = session.referer
    ? `Referer: ${session.referer}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`
    : `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n`;

  // Fast input-level seek (before -i)
  if (seekTime > 0) {
    args.push('-ss', String(seekTime));
  }

  args.push('-headers', headerStr);
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push('-i', session.url);

  // Video output
  args.push('-map', '0:v:0');
  if (session.needsVideoTranscode) {
    // Force 8-bit 4:2:0 output — required for 10-bit HEVC/HDR input
    args.push('-pix_fmt', 'yuv420p');
    if (hwEncoder && !session.hwFailed) {
      // Hardware encoding — much faster than CPU
      args.push('-c:v', hwEncoder.name);
      if (hwEncoder.type === 'NVENC') {
        args.push('-preset', 'p2', '-tune', 'ull', '-cq', '25', '-bf', '0');
      } else if (hwEncoder.type === 'QuickSync') {
        args.push('-preset', 'veryfast', '-global_quality', '25', '-bf', '0');
      } else if (hwEncoder.type === 'AMF') {
        args.push('-quality', 'speed', '-bf', '0');
      } else if (hwEncoder.type === 'VideoToolbox') {
        args.push('-q:v', '65', '-bf', '0');
      }
    } else {
      // CPU fallback — TV-safe profile, zero latency for fast first segment
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency');
      args.push('-crf', '23', '-profile:v', 'high', '-level', '4.1');
      args.push('-bf', '0');
    }
    args.push('-force_key_frames', 'expr:gte(t,n_forced*' + session.segmentDuration + ')');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push('-an');
  args.push('-f', 'hls', '-hls_time', String(session.segmentDuration), '-hls_list_size', '0');
  args.push('-hls_flags', 'temp_file');
  args.push('-start_number', String(startSegment));
  args.push('-hls_segment_filename', path.join(session.dir, 'v_%04d.ts'));
  args.push(path.join(session.dir, '_int_v.m3u8'));

  // Audio outputs (one per track)
  (session.audioStreamsData || []).forEach((audio, i) => {
    args.push('-map', `0:a:${i}`);
    if (audio.codec_name === 'aac') {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
    }
    args.push('-vn');
    args.push('-f', 'hls', '-hls_time', String(session.segmentDuration), '-hls_list_size', '0');
    args.push('-hls_flags', 'temp_file');
    args.push('-start_number', String(startSegment));
    args.push('-hls_segment_filename', path.join(session.dir, `a${i}_%04d.ts`));
    args.push(path.join(session.dir, `_int_a${i}.m3u8`));
  });

  const useHw = session.needsVideoTranscode && hwEncoder && !session.hwFailed;
  const encLabel = session.needsVideoTranscode ? (useHw ? hwEncoder.name : 'libx264') : 'copy';
  console.log(`Remux ${sessionId}: FFmpeg start seg=${startSegment} (${seekTime}s), video=${encLabel}, ${session.audioStreamCount} audio`);
  console.log(`Remux ${sessionId}: FFmpeg cmd: "${ffmpegPath}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.remuxProc = proc;
  session.remuxComplete = false;
  session.ffmpegDead = false;
  session.currentStartSegment = startSegment;
  session.ffmpegStartTime = Date.now();
  session.lastGeneratedSegment = startSegment - 1;
  session.hasOutput = false;

  let stderrLog = '';

  proc.stderr.on('data', (data) => {
    const msg = data.toString();
    // Keep last 2KB of stderr for diagnostics
    stderrLog = (stderrLog + msg).slice(-2048);
    const timeMatch = msg.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
    if (timeMatch) {
      session.hasOutput = true;
      const h = parseInt(timeMatch[1]);
      const m = parseInt(timeMatch[2]);
      const s = parseInt(timeMatch[3]);
      const totalSeconds = h * 3600 + m * 60 + s + seekTime;
      const estSegment = Math.floor(totalSeconds / session.segmentDuration);
      if (estSegment > session.lastGeneratedSegment) {
        session.lastGeneratedSegment = estSegment;
      }
    }
  });

  proc.on('close', (code) => {
    // Only update if this is still the active process (not a killed old one)
    if (session.remuxProc === proc) {
      if (code === 0) {
        session.remuxComplete = true;
        session.lastGeneratedSegment = session.totalSegments - 1;
        console.log(`Remux ${sessionId}: FFmpeg complete`);
      } else if (code !== null && !session.hasOutput && useHw && !session.hwFailed) {
        // Hardware encoder failed before producing any output — fallback to libx264
        console.warn(`Remux ${sessionId}: hardware encoder failed (code ${code}), retrying with libx264`);
        console.warn(`  stderr: ${stderrLog.slice(-500)}`);
        session.hwFailed = true;
        spawnRemuxProcess(sessionId, session, startSegment);
      } else if (code !== null && code !== 255) {
        // FFmpeg crashed mid-stream — mark dead so segment requests can trigger restart
        // Do NOT set remuxComplete=true (that would permanently kill all segment requests)
        session.ffmpegDead = true;
        console.warn(`Remux ${sessionId}: FFmpeg crashed (code ${code}), will restart on next segment request`);
        console.warn(`  stderr: ${stderrLog.slice(-500)}`);
      } else {
        // Killed by us (SIGTERM = code null or 255) — normal during seek restart
        console.log(`Remux ${sessionId}: FFmpeg killed (seek restart)`);
      }
    }
  });

  proc.on('error', (err) => {
    if (session.remuxProc === proc) {
      console.warn(`Remux ${sessionId}: FFmpeg spawn error:`, err.message);
      session.ffmpegDead = true;
    }
  });
}

// Kill current FFmpeg and restart from a new segment position (Jellyfin-style seek)
function restartRemuxFromSegment(sessionId, session, targetSegment) {
  if (session.seekLock) return;
  session.seekLock = true;
  session.ffmpegDead = false;

  console.log(`Remux ${sessionId}: seek restart -> segment ${targetSegment} (${targetSegment * session.segmentDuration}s)`);

  if (session.remuxProc && !session.remuxProc.killed) {
    session.remuxProc.kill('SIGTERM');
  }

  // Small delay to let the process die cleanly before respawning
  setTimeout(() => {
    spawnRemuxProcess(sessionId, session, targetSegment);
    session.seekLock = false;
  }, 300);
}

function cleanupSession(sessionId) {
  const session = remuxSessions.get(sessionId);
  if (!session) return;
  if (session.remuxProc && !session.remuxProc.killed) {
    session.remuxProc.kill('SIGTERM');
    setTimeout(() => {
      if (session.remuxProc && !session.remuxProc.killed) session.remuxProc.kill('SIGKILL');
    }, 5000);
  }
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch (e) {}
  remuxSessions.delete(sessionId);
  console.log(`Remux ${sessionId}: cleaned up`);
}

function cleanupRoomSessions(roomId) {
  for (const [id, session] of remuxSessions) {
    if (session.roomId === roomId) cleanupSession(id);
  }
}

// Periodic cleanup: idle >30min or >6hr old
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of remuxSessions) {
    if (now - session.lastAccess > 30 * 60 * 1000 || now - session.createdAt > 6 * 60 * 60 * 1000) {
      console.log(`Remux GC: cleaning ${id}`);
      cleanupSession(id);
    }
  }
}, 60 * 1000);

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

// --- Remux endpoints ---
app.get('/remux', (req, res) => {
  if (!ffmpegAvailable) {
    return res.json({ error: 'FFmpeg not available', fallback: true });
  }
  const targetUrl = req.query.url;
  const customReferer = req.query.referer || '';
  const roomId = req.query.room || '';
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  // Reuse existing session for same URL+room
  for (const [id, session] of remuxSessions) {
    if (session.url === targetUrl && session.roomId === roomId && session.state !== 'error') {
      session.lastAccess = Date.now();
      return res.json({ sessionId: id, url: `/remux/${id}/master.m3u8`, state: session.state, ready: session.masterReady });
    }
  }

  if (remuxSessions.size >= MAX_REMUX_SESSIONS) {
    return res.json({ error: 'Too many active remux sessions', fallback: true });
  }

  const sessionId = crypto.randomBytes(8).toString('hex');
  const sessionDir = path.join(REMUX_DIR, sessionId);
  try { fs.mkdirSync(sessionDir, { recursive: true }); }
  catch (e) { return res.status(500).json({ error: 'Failed to create session directory' }); }

  const session = {
    process: null, dir: sessionDir, url: targetUrl, referer: customReferer,
    roomId, createdAt: Date.now(), lastAccess: Date.now(),
    state: 'starting', error: null, probeData: null, masterReady: false
  };
  remuxSessions.set(sessionId, session);
  startRemux(sessionId, session, targetUrl, customReferer);

  res.json({ sessionId, url: `/remux/${sessionId}/master.m3u8`, state: 'starting', ready: false });
});

app.get('/remux/:sessionId/status', (req, res) => {
  const session = remuxSessions.get(req.params.sessionId);
  if (!session) {
    console.log(`Status check: session ${req.params.sessionId} NOT FOUND`);
    return res.status(404).json({ error: 'Session not found' });
  }
  session.lastAccess = Date.now();
  res.json({ state: session.state, ready: session.masterReady, error: session.error });
});

app.get('/remux/:sessionId/info', (req, res) => {
  const session = remuxSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.lastAccess = Date.now();
  res.json({
    audio: (session.audioInfo || []),
    subtitles: (session.subtitles || []).map(s => ({
      index: s.index,
      lang: s.lang,
      title: s.title,
      url: `/remux/${req.params.sessionId}/${s.file}`,
      ready: s.ready
    })),
    duration: session.duration || 0,
    remuxComplete: session.remuxComplete || false
  });
});

// Client-initiated seek: tells the server to restart FFmpeg at a specific segment
app.get('/remux/:sessionId/seek', (req, res) => {
  const session = remuxSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.lastAccess = Date.now();

  const segment = parseInt(req.query.segment);
  if (isNaN(segment) || segment < 0) return res.status(400).json({ error: 'Invalid segment' });

  // Already on disk — no restart needed
  const segFile = path.join(session.dir, `v_${String(segment).padStart(4, '0')}.ts`);
  if (fs.existsSync(segFile)) {
    return res.json({ status: 'ready', segment });
  }

  // FFmpeg is already producing nearby — no restart needed
  if (!session.ffmpegDead && !session.seekLock &&
      segment >= session.currentStartSegment &&
      segment <= session.lastGeneratedSegment + 30) {
    return res.json({ status: 'pending', segment });
  }

  // Restart FFmpeg at the target position
  restartRemuxFromSegment(req.params.sessionId, session, segment);
  return res.json({ status: 'restarting', segment });
});

app.get('/remux/:sessionId/:file', (req, res) => {
  const session = remuxSessions.get(req.params.sessionId);
  if (!session) return res.status(404).send('Session not found');
  session.lastAccess = Date.now();

  const safeName = path.basename(req.params.file);

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-cache');

  // Master playlist — serve from disk (written once during probe)
  if (safeName === 'master.m3u8') {
    const filePath = path.join(session.dir, 'master.m3u8');
    if (!fs.existsSync(filePath)) return res.status(404).send('Not ready');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(fs.readFileSync(filePath, 'utf8'));
  }

  // VOD playlists — generated dynamically with full duration + ENDLIST
  if (safeName.endsWith('.m3u8')) {
    if (!session.duration) return res.status(404).send('Not ready');
    let content = null;
    if (safeName === 'video.m3u8') {
      content = generateVodPlaylist(session.totalSegments, session.segmentDuration, session.duration, 'v_');
    } else {
      const audioMatch = safeName.match(/^a(\d+)\.m3u8$/);
      if (audioMatch) {
        const idx = parseInt(audioMatch[1]);
        if (idx < session.audioStreamCount) {
          content = generateVodPlaylist(session.totalSegments, session.segmentDuration, session.duration, `a${idx}_`);
        }
      }
    }
    if (content) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Content-Length', Buffer.byteLength(content));
      return res.send(content);
    }
    return res.status(404).send('Playlist not found');
  }

  // Segment files (.ts) — serve from disk or trigger seek-restart
  if (safeName.endsWith('.ts')) {
    const filePath = path.join(session.dir, safeName);

    // If segment already exists on disk, serve it immediately
    if (fs.existsSync(filePath)) {
      return serveSegmentFile(filePath, res);
    }

    // Parse segment number from filename (v_0042.ts or a0_0042.ts)
    const segMatch = safeName.match(/^(?:v|a\d+)_(\d{4})\.ts$/);
    if (!segMatch) return res.status(404).send('Invalid segment');
    const segNum = parseInt(segMatch[1], 10);

    if (segNum >= (session.totalSegments || Infinity)) {
      return res.status(404).send('Out of range');
    }

    // Only restart FFmpeg from segment requests if it crashed (ffmpegDead).
    // Seek-based restarts are handled by the /seek endpoint called by the client.
    // This prevents HLS.js buffer-ahead requests from triggering unwanted restarts.
    const isVideoSegment = safeName.startsWith('v_');
    if (isVideoSegment && !session.seekLock && session.ffmpegDead) {
      restartRemuxFromSegment(req.params.sessionId, session, segNum);
    }

    // Wait for the segment to appear on disk (temp_file flag ensures it's complete)
    const startWait = Date.now();
    const waitForSeg = () => {
      if (fs.existsSync(filePath)) {
        return serveSegmentFile(filePath, res);
      }
      // If FFmpeg finished cleanly and segment still missing, it's never coming
      if (session.remuxComplete && !session.seekLock) {
        return res.status(404).send('Segment not available');
      }
      if (Date.now() - startWait > 45000) {
        return res.status(404).send('Timeout');
      }
      if (!remuxSessions.has(req.params.sessionId)) {
        return res.status(404).send('Session ended');
      }
      setTimeout(waitForSeg, 300);
    };
    waitForSeg();
    return;
  }

  // Other files (subtitles .vtt)
  const filePath = path.join(session.dir, safeName);
  if (fs.existsSync(filePath)) {
    if (safeName.endsWith('.vtt')) res.set('Content-Type', 'text/vtt');
    try {
      const stat = fs.statSync(filePath);
      res.set('Content-Length', stat.size);
      fs.createReadStream(filePath).pipe(res).on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
    } catch (e) {
      if (!res.headersSent) res.status(404).send('Read error');
    }
  } else if (safeName.endsWith('.vtt') && (session.state === 'starting' || session.state === 'ready')) {
    // Subtitle still being extracted — wait briefly
    let retries = 0;
    const waitForVtt = () => {
      if (fs.existsSync(filePath)) {
        res.set('Content-Type', 'text/vtt');
        try {
          const stat = fs.statSync(filePath);
          res.set('Content-Length', stat.size);
          fs.createReadStream(filePath).pipe(res);
        } catch (e) {
          if (!res.headersSent) res.status(404).send('Read error');
        }
        return;
      }
      retries++;
      if (retries < 10) setTimeout(waitForVtt, 300);
      else res.status(404).send('Not found');
    };
    waitForVtt();
  } else {
    res.status(404).send('Not found');
  }
});

function serveSegmentFile(filePath, res) {
  try {
    const stat = fs.statSync(filePath);
    if (!res.headersSent) {
      res.set('Content-Type', 'video/MP2T');
      res.set('Content-Length', stat.size);
      fs.createReadStream(filePath).pipe(res).on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
    }
  } catch (e) {
    if (!res.headersSent) res.status(404).send('Read error');
  }
}

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
  const isPlaylistUrl = targetUrl.includes('.m3u8');
  const rewritePlaylist = (body) => {
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
    const refParam = customReferer ? '&referer=' + encodeURIComponent(customReferer) : '';
    const origin = new URL(targetUrl).origin;
    const proxyLine = (url) => {
      let absolute;
      if (url.startsWith('http')) absolute = url;
      else if (url.startsWith('/')) absolute = origin + url;
      else absolute = baseUrl + url;
      return '/proxy?url=' + encodeURIComponent(absolute) + refParam;
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

  // For m3u8 playlists: fetch directly from CDN (skip MediaFlow).
  // MediaFlow's /proxy/stream never completes the response for small text files.
  // CDNs serve manifests fine even from datacenter IPs; they only block segments.
  if (isPlaylistUrl) {
    console.log('Fetching playlist directly:', targetUrl.substring(0, 100));
    const playlistClient = parsed.protocol === 'https:' ? https : http;
    const playlistReq = playlistClient.get(targetUrl, { headers: proxyHeaders }, (proxyRes) => {
      console.log('Playlist response:', proxyRes.statusCode, 'ct:', proxyRes.headers['content-type'] || 'none');

      // Follow redirects
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        const redirectUrl = new URL(proxyRes.headers.location, targetUrl).href;
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
        const rewritten = rewritePlaylist(body);
        console.log('Rewritten playlist first 300 chars:', JSON.stringify(rewritten.substring(0, 300)));
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
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
  let fetchUrl = targetUrl;
  let fetchClient = client;
  if (MEDIAFLOW_URL) {
    const mfUrl = new URL(MEDIAFLOW_URL + '/proxy/stream');
    mfUrl.searchParams.set('d', targetUrl);
    if (MEDIAFLOW_API_PASSWORD) mfUrl.searchParams.set('api_password', MEDIAFLOW_API_PASSWORD);
    fetchUrl = mfUrl.href;
    fetchClient = mfUrl.protocol === 'https:' ? https : http;
    console.log('Proxy via MediaFlow:', targetUrl.substring(0, 100));
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

    // Rewrite m3u8 playlists to route segments through proxy too
    const contentType = proxyRes.headers['content-type'] || '';
    const isPlaylist = targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('apple');

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
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('Proxy error');
  });

  proxyReq.setTimeout(MEDIAFLOW_URL ? 30000 : 15000, () => {
    proxyReq.destroy();
    console.error('Proxy timeout:', targetUrl.substring(0, 80));
    if (!res.headersSent) res.status(504).send('Proxy timeout');
  });

  // If the client disconnects, clean up the upstream request
  req.on('close', () => {
    proxyReq.destroy();
  });
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
      room.currentTime = 0;
      room.playing = false;
      room.audioTracks = null;
      room.subtitleTracks = null;
      room.selectedAudioTrack = null;
      room.selectedSubtitleTrack = null;
    }
    // Only cleanup remux sessions if the new URL is NOT from a remux in this room
    const isRemuxUrl = data.url && data.url.startsWith('/remux/');
    if (!isRemuxUrl) {
      cleanupRoomSessions(socket.roomId);
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
        cleanupRoomSessions(socket.roomId);
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
