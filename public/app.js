// --- Icon Helper ---
function setIcon(el, iconName) {
  el.innerHTML = '<i data-lucide="' + iconName + '"></i>';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [el] });
}

// --- Remux session state ---
var currentRemuxSessionId = null;

// --- DOM Elements ---
var lobby = document.getElementById('lobby');
var roomScreen = document.getElementById('room');
var btnCreate = document.getElementById('btn-create');
var btnJoin = document.getElementById('btn-join');
var inputRoomCode = document.getElementById('input-room-code');
var roomCodeDisplay = document.getElementById('room-code-display');
var btnCopyLink = document.getElementById('btn-copy-link');
var userCountEl = document.getElementById('user-count');
var playerContainer = document.getElementById('player-container');
var video = document.getElementById('video-player');
var btnPlayPause = document.getElementById('btn-play-pause');
var progressBar = document.getElementById('progress-bar');
var progressFill = document.getElementById('progress-fill');
var progressThumb = document.getElementById('progress-thumb');
var videoSpinner = document.getElementById('video-spinner');
var timeDisplay = document.getElementById('time-display');
var btnFullscreen = document.getElementById('btn-fullscreen');
var syncStatus = document.getElementById('sync-status');
var toastEl = document.getElementById('toast');
var btnSubs = document.getElementById('btn-subs');
var subMenu = document.getElementById('sub-menu');
var subTracks = document.getElementById('sub-tracks');
var inputSubUrl = document.getElementById('input-sub-url');
var btnLoadSub = document.getElementById('btn-load-sub');
var btnSubFile = document.getElementById('btn-sub-file');
var inputSubFile = document.getElementById('input-sub-file');

// Audio track DOM
var btnAudio = document.getElementById('btn-audio');
var audioMenu = document.getElementById('audio-menu');
var audioTracks = document.getElementById('audio-tracks');

// Mode selector DOM
var modeBtns = document.querySelectorAll('.mode-btn');
var modeHint = document.getElementById('mode-hint');

// Remote control DOM
var remoteContainer = document.getElementById('remote-container');
var remotePlayPause = document.getElementById('remote-play-pause');
var remoteProgressBar = document.getElementById('remote-progress-bar');
var remoteProgressFill = document.getElementById('remote-progress-fill');
var remoteProgressThumb = document.getElementById('remote-progress-thumb');
var remoteTimeDisplay = document.getElementById('remote-time-display');
var remoteTitleEl = document.getElementById('remote-title');

// Remote track control DOM
var remoteTrackControls = document.getElementById('remote-track-controls');
var remoteBtnAudio = document.getElementById('remote-btn-audio');
var remoteBtnSubs = document.getElementById('remote-btn-subs');
var remoteAudioMenu = document.getElementById('remote-audio-menu');
var remoteAudioTracks = document.getElementById('remote-audio-tracks');
var remoteSubMenu = document.getElementById('remote-sub-menu');
var remoteSubTracks = document.getElementById('remote-sub-tracks');
var remoteInputSubUrl = document.getElementById('remote-input-sub-url');
var remoteBtnLoadSub = document.getElementById('remote-btn-load-sub');
var remoteBtnSubFile = document.getElementById('remote-btn-sub-file');
var remoteInputSubFile = document.getElementById('remote-input-sub-file');

// Search & Browse DOM
var inputSearch = document.getElementById('input-search');
var btnSearch = document.getElementById('btn-search');
var searchResults = document.getElementById('search-results');
var contentDetail = document.getElementById('content-detail');
var btnBack = document.getElementById('btn-back');
var detailPoster = document.getElementById('detail-poster');
var detailTitle = document.getElementById('detail-title');
var detailYear = document.getElementById('detail-year');
var detailTypeBadge = document.getElementById('detail-type-badge');
var detailDescription = document.getElementById('detail-description');
var episodePicker = document.getElementById('episode-picker');
var seasonSelect = document.getElementById('season-select');
var episodeList = document.getElementById('episode-list');
var streamSection = document.getElementById('stream-section');
var streamTitle = document.getElementById('stream-title');
var streamListEl = document.getElementById('stream-list');
var streamLoading = document.getElementById('stream-loading');
var streamEmpty = document.getElementById('stream-empty');

// Settings DOM
var btnSettings = document.getElementById('btn-settings');
var settingsOverlay = document.getElementById('settings-overlay');
var btnCloseSettings = document.getElementById('btn-close-settings');
var addonListEl = document.getElementById('addon-list');
var inputAddonUrl = document.getElementById('input-addon-url');
var btnAddAddon = document.getElementById('btn-add-addon');

// --- State ---
var socket = io();
var roomId = null;
var ignoreEvents = false; // Prevent echo loops
var hls = null; // HLS.js instance

// Server capabilities
var serverHasFFmpeg = false;
fetch('/api/capabilities').then(function(r) { return r.json(); }).then(function(d) {
  serverHasFFmpeg = !!d.ffmpeg;
}).catch(function() {});

// Search & browse state
var addons = []; // array of { url, name }
try { addons = JSON.parse(localStorage.getItem('streamAddons')) || []; } catch(e) { addons = []; }
// Migrate old torrentioConfig if present
(function() {
  var old = localStorage.getItem('torrentioConfig');
  if (old && addons.length === 0) {
    addons.push({ url: 'https://torrentio.strem.fun/' + old, name: 'Torrentio' });
    localStorage.setItem('streamAddons', JSON.stringify(addons));
    localStorage.removeItem('torrentioConfig');
  }
})();
var currentMeta = null; // currently viewed movie/series metadata

// --- Mode ---
var appMode = localStorage.getItem('watchTogetherMode') || 'both';

function isRemoteMode() { return appMode === 'remote'; }
function isPlayerMode() { return appMode === 'player'; }

var MODE_HINTS = {
  both: 'Full player with controls',
  player: 'Auto-fullscreen video player',
  remote: 'Control only \u2014 no video download'
};

function setMode(mode) {
  appMode = mode;
  localStorage.setItem('watchTogetherMode', mode);
  for (var i = 0; i < modeBtns.length; i++) {
    modeBtns[i].classList.toggle('active', modeBtns[i].getAttribute('data-mode') === mode);
  }
  modeHint.textContent = MODE_HINTS[mode] || '';
}

setMode(appMode); // initialize from localStorage

for (var mi = 0; mi < modeBtns.length; mi++) {
  (function(btn) {
    btn.addEventListener('click', function() {
      setMode(btn.getAttribute('data-mode'));
    });
  })(modeBtns[mi]);
}

// --- Remote state (used when appMode === 'remote') ---
var remoteTime = 0;
var remotePlaying = false;
var remoteDuration = 0;
var remoteTimer = null;

// --- Latency & Sync ---
var latency = 0; // one-way latency in ms (RTT / 2)
var serverOffset = 0; // local clock - server clock
var syncInterval = null;
var SYNC_HEARTBEAT_MS = 10000; // check every 10s
var DRIFT_THRESHOLD = 2.0; // only correct if >2s out of sync
var lastCorrectionTime = 0;

// --- Latency measurement ---
function measureLatency() {
  socket.emit('ping-sync', { clientSent: Date.now() });
}

socket.on('pong-sync', function(data) {
  var now = Date.now();
  var rtt = now - data.clientSent;
  latency = rtt / 2;
  serverOffset = now - data.serverTime - latency;
});

// Measure latency on connect and every 10s
socket.on('connect', function() {
  measureLatency();
  if (roomId) {
    socket.emit('join-room', roomId);
    syncStatus.textContent = 'Reconnected';
  }
});
setInterval(measureLatency, 10000);

// --- Drift correction ---
function startHeartbeat() {
  stopHeartbeat();
  syncInterval = setInterval(function() {
    if (isRemoteMode()) {
      if (remotePlaying && remoteDuration) {
        socket.emit('sync-heartbeat', {
          currentTime: remoteTime,
          sentAt: Date.now()
        });
      }
    } else {
      if (!video.paused && video.duration) {
        socket.emit('sync-heartbeat', {
          currentTime: video.currentTime,
          sentAt: Date.now()
        });
      }
    }
  }, SYNC_HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

socket.on('sync-heartbeat', function(data) {
  if (isRemoteMode()) {
    var now = Date.now();
    if (now - lastCorrectionTime < 15000) return;
    var networkDelay = (now - data.sentAt) / 1000;
    var partnerTime = data.currentTime + networkDelay;
    var drift = partnerTime - remoteTime;
    if (Math.abs(drift) > DRIFT_THRESHOLD) {
      lastCorrectionTime = now;
      remoteTime = partnerTime;
      updateRemoteDisplay();
      syncStatus.textContent = 'Resynced (' + (drift > 0 ? '+' : '') + drift.toFixed(1) + 's)';
    }
    return;
  }
  if (video.paused || !video.duration) return;
  // Don't correct more than once every 15s to avoid feedback loops
  var now = Date.now();
  if (now - lastCorrectionTime < 15000) return;

  var networkDelay = (now - data.sentAt) / 1000;
  var partnerTime = data.currentTime + networkDelay;
  var drift = partnerTime - video.currentTime;

  // Only correct if significantly out of sync (>2s)
  if (Math.abs(drift) > DRIFT_THRESHOLD) {
    lastCorrectionTime = now;
    video.currentTime = partnerTime;
    syncStatus.textContent = 'Resynced (' + (drift > 0 ? '+' : '') + drift.toFixed(1) + 's)';
  }
});

// Safe play that handles browsers where play() doesn't return a Promise
function safePlay() {
  try {
    var result = video.play();
    if (result && typeof result.catch === 'function') {
      result.catch(function() {});
    }
  } catch (e) {}
  return true;
}

// --- Utility ---
function generateCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (h > 0) {
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  setTimeout(function() { toastEl.classList.add('hidden'); }, 2500);
}

function joinRoom(code) {
  roomId = code.toUpperCase();
  socket.emit('join-room', roomId);
  lobby.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  roomScreen.style.display = 'flex';
  roomCodeDisplay.textContent = roomId;

  // Update URL without reload
  var newUrl = window.location.origin + window.location.pathname + '?room=' + roomId;
  window.history.replaceState(null, '', newUrl);
}

// --- Room Entry ---
btnCreate.addEventListener('click', function() {
  joinRoom(generateCode());
});

btnJoin.addEventListener('click', function() {
  var code = inputRoomCode.value.trim();
  if (code.length < 3) {
    showToast('Enter a valid room code');
    return;
  }
  joinRoom(code);
});

inputRoomCode.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') btnJoin.click();
});

// Auto-join from URL (compatible with old TV browsers without URLSearchParams)
(function() {
  var code = null;
  if (typeof URLSearchParams !== 'undefined') {
    code = new URLSearchParams(window.location.search).get('room');
  } else {
    var match = window.location.search.match(/[?&]room=([^&]+)/);
    if (match) code = decodeURIComponent(match[1]);
  }
  if (code) {
    joinRoom(code);
  }
})();

// --- Copy Link ---
btnCopyLink.addEventListener('click', function() {
  var link = window.location.origin + window.location.pathname + '?room=' + roomId;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(function() {
      showToast('Link copied!');
    });
  } else {
    // Fallback for TV browsers
    var ta = document.createElement('textarea');
    ta.value = link;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Link copied!');
  }
});

// --- Settings ---
btnSettings.addEventListener('click', function() {
  renderAddonList();
  settingsOverlay.classList.remove('hidden');
  settingsOverlay.style.display = 'flex';
});
btnCloseSettings.addEventListener('click', function() {
  settingsOverlay.classList.add('hidden');
});
settingsOverlay.addEventListener('click', function(e) {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

function saveAddons() {
  localStorage.setItem('streamAddons', JSON.stringify(addons));
}

function renderAddonList() {
  addonListEl.innerHTML = '';
  if (addons.length === 0) {
    addonListEl.innerHTML = '<div style="color:#666;font-size:0.85rem;padding:8px 0">No addons configured</div>';
    return;
  }
  addons.forEach(function(addon, index) {
    var entry = document.createElement('div');
    entry.className = 'addon-entry';
    entry.innerHTML =
      '<div style="flex:1;min-width:0">' +
        '<div class="addon-entry-name">' + (addon.name || 'Addon') + '</div>' +
        '<div class="addon-entry-url">' + addon.url + '</div>' +
      '</div>';
    var removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove-addon';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function() {
      addons.splice(index, 1);
      saveAddons();
      renderAddonList();
    });
    entry.appendChild(removeBtn);
    addonListEl.appendChild(entry);
  });
}

btnAddAddon.addEventListener('click', function() {
  var url = inputAddonUrl.value.trim();
  if (!url) return;
  // Clean up: remove /manifest.json suffix if present
  url = url.replace(/\/manifest\.json\/?$/, '').replace(/\/+$/, '');
  // Fetch manifest to get addon name
  inputAddonUrl.value = '';
  fetch('/api/addon-manifest?addon=' + encodeURIComponent(url))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var name = (data && data.name) ? data.name : url.split('/').pop() || 'Addon';
      addons.push({ url: url, name: name });
      saveAddons();
      renderAddonList();
      showToast('Added: ' + name);
    })
    .catch(function() {
      // Still add it even if manifest fetch fails
      addons.push({ url: url, name: url.split('//')[1] || 'Addon' });
      saveAddons();
      renderAddonList();
      showToast('Addon added');
    });
});

inputAddonUrl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') btnAddAddon.click();
});

// --- Search & Browse ---
btnSearch.addEventListener('click', function() {
  var query = inputSearch.value.trim();
  if (!query) return;
  searchContent(query);
});
inputSearch.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') btnSearch.click();
});

function searchContent(query) {
  // Search both movies and series in parallel
  searchResults.classList.remove('hidden');
  searchResults.style.display = 'grid';
  contentDetail.classList.add('hidden');
  playerContainer.classList.add('hidden');
  searchResults.innerHTML = '<div class="search-message">Searching...</div>';

  var moviesDone = false, seriesDone = false;
  var allResults = [];

  function renderWhenReady() {
    if (!moviesDone || !seriesDone) return;
    renderSearchResults(allResults);
  }

  fetch('/api/search?type=movie&query=' + encodeURIComponent(query))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.metas) {
        data.metas.forEach(function(m) { m._type = 'movie'; });
        allResults = allResults.concat(data.metas);
      }
    })
    .catch(function() {})
    .finally(function() { moviesDone = true; renderWhenReady(); });

  fetch('/api/search?type=series&query=' + encodeURIComponent(query))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.metas) {
        data.metas.forEach(function(m) { m._type = 'series'; });
        allResults = allResults.concat(data.metas);
      }
    })
    .catch(function() {})
    .finally(function() { seriesDone = true; renderWhenReady(); });
}

function renderSearchResults(results) {
  searchResults.innerHTML = '';
  if (results.length === 0) {
    searchResults.innerHTML = '<div class="search-message">No results found</div>';
    return;
  }
  results.forEach(function(item) {
    var card = document.createElement('div');
    card.className = 'result-card';
    card.tabIndex = 0;
    card.innerHTML =
      '<img src="' + (item.poster || '') + '" alt="' + (item.name || '').replace(/"/g, '&quot;') + '" loading="lazy">' +
      '<div class="result-card-type">' + (item._type || item.type) + '</div>' +
      '<div class="result-card-info">' +
        '<div class="result-card-title">' + (item.name || 'Unknown') + '</div>' +
        '<div class="result-card-year">' + (item.releaseInfo || item.year || '') + '</div>' +
      '</div>';
    card.addEventListener('click', function() {
      showContentDetail(item._type || item.type, item.id);
    });
    card.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') showContentDetail(item._type || item.type, item.id);
    });
    searchResults.appendChild(card);
  });
}

function showContentDetail(type, id) {
  searchResults.classList.add('hidden');
  contentDetail.classList.remove('hidden');
  contentDetail.style.display = 'block';
  streamSection.classList.add('hidden');
  episodePicker.classList.add('hidden');
  streamListEl.innerHTML = '';
  detailTitle.textContent = 'Loading...';
  detailDescription.textContent = '';
  detailYear.textContent = '';
  detailTypeBadge.textContent = '';
  detailPoster.src = '';

  fetch('/api/meta/' + encodeURIComponent(type) + '/' + encodeURIComponent(id))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.meta) {
        detailTitle.textContent = 'Not found';
        return;
      }
      currentMeta = data.meta;
      currentMeta._type = type;
      detailTitle.textContent = currentMeta.name || 'Unknown';
      detailYear.textContent = currentMeta.releaseInfo || currentMeta.year || '';
      detailTypeBadge.textContent = type;
      detailDescription.textContent = currentMeta.description || '';
      detailPoster.src = currentMeta.poster || '';

      if (type === 'series' && currentMeta.videos && currentMeta.videos.length > 0) {
        showEpisodePicker(currentMeta);
      } else {
        // Movie — fetch streams directly
        fetchStreams(type, id);
      }
    })
    .catch(function() {
      detailTitle.textContent = 'Error loading details';
    });
}

function showEpisodePicker(meta) {
  episodePicker.classList.remove('hidden');
  episodePicker.style.display = 'block';
  seasonSelect.innerHTML = '';
  episodeList.innerHTML = '';

  // Group episodes by season
  var seasons = {};
  meta.videos.forEach(function(v) {
    var s = v.season || 0;
    if (!seasons[s]) seasons[s] = [];
    seasons[s].push(v);
  });

  var seasonNums = Object.keys(seasons).map(Number).filter(function(n) { return n > 0; }).sort(function(a, b) { return a - b; });

  seasonNums.forEach(function(num) {
    var opt = document.createElement('option');
    opt.value = num;
    opt.textContent = 'Season ' + num;
    seasonSelect.appendChild(opt);
  });

  function renderEpisodes(seasonNum) {
    episodeList.innerHTML = '';
    var eps = seasons[seasonNum] || [];
    eps.sort(function(a, b) { return (a.episode || 0) - (b.episode || 0); });
    eps.forEach(function(ep) {
      var item = document.createElement('div');
      item.className = 'episode-item';
      item.tabIndex = 0;
      item.innerHTML =
        '<span class="episode-num">E' + (ep.episode || '?') + '</span>' +
        '<span class="episode-title">' + (ep.title || ep.name || 'Episode ' + (ep.episode || '?')) + '</span>';
      var epClickHandler = (function(epObj) {
        return function() {
          var streamId = meta.id + ':' + seasonNum + ':' + (epObj.episode || epObj.number);
          fetchStreams('series', streamId);
        };
      })(ep);
      item.addEventListener('click', epClickHandler);
      item.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') epClickHandler();
      });
      episodeList.appendChild(item);
    });
  }

  seasonSelect.addEventListener('change', function() {
    renderEpisodes(Number(seasonSelect.value));
  });

  if (seasonNums.length > 0) {
    renderEpisodes(seasonNums[0]);
  }
}

function fetchStreams(type, id) {
  streamSection.classList.remove('hidden');
  streamSection.style.display = 'block';
  streamListEl.innerHTML = '';
  streamLoading.classList.remove('hidden');
  streamLoading.style.display = 'block';
  streamEmpty.classList.add('hidden');

  if (addons.length === 0) {
    streamLoading.classList.add('hidden');
    streamEmpty.textContent = 'No addons configured. Add stream addons in Settings.';
    streamEmpty.classList.remove('hidden');
    streamEmpty.style.display = 'block';
    return;
  }

  var pending = addons.length;
  var allStreams = [];

  addons.forEach(function(addon) {
    var url = '/api/streams/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) +
      '?addon=' + encodeURIComponent(addon.url);
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.streams) {
          data.streams.forEach(function(s) { s._addonName = addon.name; });
          allStreams = allStreams.concat(data.streams);
        }
      })
      .catch(function() {})
      .finally(function() {
        pending--;
        if (pending <= 0) {
          streamLoading.classList.add('hidden');
          if (allStreams.length === 0) {
            streamEmpty.classList.remove('hidden');
            streamEmpty.style.display = 'block';
            return;
          }
          renderStreams(allStreams);
        }
      });
  });
}

function renderStreams(streams) {
  streamListEl.innerHTML = '';
  streams.forEach(function(s) {
    var hasUrl = s.url || s.externalUrl;

    var item = document.createElement('div');
    item.className = 'stream-item';
    item.tabIndex = 0;
    if (!hasUrl) item.classList.add('stream-no-url');

    // Parse quality from name/title
    var quality = '';
    var nameStr = (s.name || '') + ' ' + (s.title || '');
    if (/2160p|4k/i.test(nameStr)) quality = '4K';
    else if (/1080p/i.test(nameStr)) quality = '1080p';
    else if (/720p/i.test(nameStr)) quality = '720p';
    else if (/480p/i.test(nameStr)) quality = '480p';

    var qualityHTML = quality ? '<span class="stream-quality">' + quality + '</span>' : '';
    var nameDisplay = (s._addonName || s.name || 'Stream').replace(/\n/g, ' | ');
    var titleDisplay = ((s.name ? s.name + '\n' : '') + (s.title || '')).replace(/\n/g, ' | ');

    item.innerHTML =
      '<div style="flex:1;min-width:0">' +
        '<div class="stream-name">' + nameDisplay + '</div>' +
        '<div class="stream-detail">' + titleDisplay + '</div>' +
      '</div>' +
      qualityHTML;

    var streamClickHandler;
    if (hasUrl) {
      streamClickHandler = (function(stream) {
        return function() { selectStream(stream); };
      })(s);
    } else {
      streamClickHandler = function() {
        showToast('This stream requires a debrid service configured in the addon');
      };
    }
    item.addEventListener('click', streamClickHandler);
    item.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') streamClickHandler();
    });
    streamListEl.appendChild(item);
  });
}

function selectStream(stream) {
  // Hide browse UI, show player
  searchResults.classList.add('hidden');
  contentDetail.classList.add('hidden');

  // Broadcast content info to partner
  if (currentMeta) {
    socket.emit('set-content', {
      name: currentMeta.name,
      poster: currentMeta.poster,
      type: currentMeta._type || currentMeta.type
    });
    if (isRemoteMode()) {
      remoteTitleEl.textContent = currentMeta.name || 'Playing';
    }
  }

  var url = stream.url || stream.externalUrl;
  var hints = stream.behaviorHints || {};
  var referer = '';
  if (hints.proxyHeaders && hints.proxyHeaders.request && hints.proxyHeaders.request.Referer) {
    referer = hints.proxyHeaders.request.Referer;
  }

  var isHlsStream = url.includes('.m3u8');

  // For non-HLS streams with FFmpeg: full HLS remux (video + audio + subs)
  if (!isHlsStream && serverHasFFmpeg) {
    startRemuxSession(url, referer);
  } else {
    // HLS or no FFmpeg: proxy and play directly
    var proxyVideoUrl = '/proxy?url=' + encodeURIComponent(url);
    if (referer) proxyVideoUrl += '&referer=' + encodeURIComponent(referer);
    if (isHlsStream || hints.notWebReady) {
      loadVideo(proxyVideoUrl, true);
    } else {
      loadVideo(url, true);
    }
  }
}

var loadRemuxRetries = 0;
function loadRemuxTracks(sessionId) {
  loadRemuxRetries++;
  if (loadRemuxRetries > 20) return; // stop after ~60s
  fetch('/remux/' + sessionId + '/info')
    .then(function(r) { return r.json(); })
    .then(function(info) {
      if (info.subtitles && info.subtitles.length > 0) {
        var readySubs = info.subtitles.filter(function(s) { return s.ready; });
        if (readySubs.length > 0) {
          clearSubtitleUI();
          var engSubBtn = null;
          var engSubIdx = -1;
          readySubs.forEach(function(sub) {
            var track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = sub.title + ' (' + sub.lang + ')';
            track.srclang = sub.lang;
            track.src = sub.url;
            track.setAttribute('data-external', 'true');
            video.appendChild(track);
            var idx = video.textTracks.length - 1;
            addSubtitleButton(track.label, idx);
            if (engSubBtn === null && (isEnglish(sub.lang) || isEnglish(sub.title))) {
              engSubBtn = subTracks.lastChild;
              engSubIdx = idx;
            }
          });
          // Auto-select English subtitle
          if (engSubBtn && engSubIdx !== -1) {
            disableAllSubs();
            video.textTracks[engSubIdx].mode = 'showing';
            setActiveSubBtn(engSubBtn);
          }
          broadcastSubtitleTrackList();
          console.log('Loaded ' + readySubs.length + ' subtitle tracks from remux');
        } else {
          setTimeout(function() { loadRemuxTracks(sessionId); }, 3000);
        }
      }
    })
    .catch(function(err) {
      console.warn('Failed to load remux track info:', err);
    });
}

function startRemuxSession(url, referer) {
  syncStatus.textContent = 'Preparing stream...';

  var remuxUrl = '/remux?url=' + encodeURIComponent(url);
  if (referer) remuxUrl += '&referer=' + encodeURIComponent(referer);
  if (roomId) remuxUrl += '&room=' + encodeURIComponent(roomId);

  fetch(remuxUrl)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        console.warn('Remux error:', data.error);
        // Fallback: try direct URL first (uses client's IP, avoids datacenter blocking),
        // HLS.js will fall back to proxy automatically if CORS fails
        loadVideo(url, true);
        return;
      }
      currentRemuxSessionId = data.sessionId;
      if (data.ready) {
        loadRemuxedVideo(data.sessionId);
      } else {
        pollRemuxReady(data.sessionId, url);
      }
    })
    .catch(function(err) {
      console.warn('Remux request failed:', err);
      loadVideo(url, true);
    });
}

function pollRemuxReady(sessionId, url) {
  var attempts = 0;
  var pollTimer = setInterval(function() {
    attempts++;
    if (attempts > 120) { // 60 seconds
      clearInterval(pollTimer);
      syncStatus.textContent = 'Remux timeout, trying direct...';
      loadVideo(url, true);
      return;
    }
    fetch('/remux/' + sessionId + '/status')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ready) {
          clearInterval(pollTimer);
          loadRemuxedVideo(sessionId);
        } else if (data.state === 'error') {
          clearInterval(pollTimer);
          syncStatus.textContent = 'Remux failed, trying direct...';
          loadVideo(url, true);
        } else {
          syncStatus.textContent = 'Preparing stream...';
        }
      })
      .catch(function() {});
  }, 500);
}

function loadRemuxedVideo(sessionId) {
  var masterUrl = '/remux/' + sessionId + '/master.m3u8';
  loadVideo(masterUrl, true);
  // Load subtitle tracks after a delay (they extract in background)
  loadRemuxRetries = 0;
  setTimeout(function() { loadRemuxTracks(sessionId); }, 2000);
}

// Back button — from detail to search results
btnBack.addEventListener('click', function() {
  contentDetail.classList.add('hidden');
  currentMeta = null;
  searchResults.classList.remove('hidden');
  searchResults.style.display = 'grid';
});

// --- Video Loading ---
function isHLS(url) {
  return url.includes('.m3u8');
}

function proxyUrl(url) {
  // Route through our server proxy to bypass CORS
  if (url.indexOf('/proxy?') !== -1) return url; // already proxied
  return '/proxy?url=' + encodeURIComponent(url);
}

function loadVideo(url, broadcast) {
  if (!url) return;

  // Remote mode: don't load any video, just track state
  if (isRemoteMode()) {
    remoteTime = 0;
    remotePlaying = false;
    remoteDuration = 0;
    stopRemoteTimer();
    playerContainer.classList.add('hidden');
    // Clear track menus from previous video
    remoteAudioTracks.innerHTML = '';
    remoteSubTracks.innerHTML = '';
    remoteAudioMenu.classList.add('hidden');
    remoteSubMenu.classList.add('hidden');
    remoteBtnAudio.classList.add('hidden');
    remoteTrackControls.classList.add('hidden');
    remoteContainer.classList.remove('hidden');
    remoteContainer.style.display = 'block';
    setIcon(remotePlayPause, 'play');
    updateRemoteDisplay();
    syncStatus.textContent = 'Remote ready. Press Play to start.';
    if (broadcast) {
      socket.emit('set-video', { url: url });
    }
    return;
  }

  // Show spinner while loading
  showSpinner();

  // Destroy previous HLS instance
  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (isHLS(url)) {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      // Try direct URL first with HLS.js, fall back to proxy on error
      var alreadyProxied = url.indexOf('/proxy?') !== -1;
      var isLocalRemux = url.indexOf('/remux/') === 0;
      var hlsConfig = {
        enableWebVTT: true,
        enableCEA708Captions: true,
        renderTextTracksNatively: true
      };
      // Extend timeouts for proxied/remux streams — the proxy chain
      // (Render -> MediaFlow -> CDN) needs more time than direct loading
      if (isLocalRemux || alreadyProxied) {
        hlsConfig.manifestLoadingTimeOut = 30000;
        hlsConfig.manifestLoadingMaxRetry = 6;
        hlsConfig.levelLoadingTimeOut = 30000;
        hlsConfig.levelLoadingMaxRetry = 6;
        hlsConfig.fragLoadingTimeOut = 45000;
        hlsConfig.fragLoadingMaxRetry = 8;
        hlsConfig.fragLoadingMaxRetryTimeout = 15000;
      }
      hls = new Hls(hlsConfig);
      hls.loadSource(url);
      hls.attachMedia(video);
      // Detect tracks when HLS manifest is fully parsed
      hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
        console.log('HLS MANIFEST_PARSED — audio:', (hls.audioTracks || []).length, 'subs:', (hls.subtitleTracks || []).length);
        setTimeout(function() {
          detectHLSSubtitles();
          detectHLSAudioTracks();
          broadcastSubtitleTrackList();
          broadcastAudioTrackList();
        }, 300);
      });
      // Skip proxy retry if already proxied OR if it's a local remux URL (no CORS needed)
      var triedProxy = alreadyProxied || isLocalRemux;
      var mediaRecoveryAttempts = 0;
      hls.on(Hls.Events.ERROR, function(event, data) {
        console.warn('HLS error:', data.type, data.details, data.fatal ? '(FATAL)' : '', data.response ? ('status=' + data.response.code) : '', 'url:', (data.frag && data.frag.url) || (data.context && data.context.url) || '');

        // Handle media errors with HLS.js built-in recovery
        if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          mediaRecoveryAttempts++;
          if (mediaRecoveryAttempts <= 2) {
            console.log('HLS media error recovery attempt #' + mediaRecoveryAttempts);
            if (mediaRecoveryAttempts === 1) {
              hls.recoverMediaError();
            } else {
              // Second attempt: swap audio codec and recover
              hls.swapAudioCodec();
              hls.recoverMediaError();
            }
            return;
          }
          // Exhausted recovery attempts
          console.error('HLS media error: recovery failed after ' + mediaRecoveryAttempts + ' attempts');
          syncStatus.textContent = 'Media error: playback failed';
          hideSpinner();
          return;
        }

        // Handle network errors
        if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR && !triedProxy) {
          triedProxy = true;
          syncStatus.textContent = 'Retrying through proxy...';
          hls.destroy();
          hls = new Hls(hlsConfig);
          hls.loadSource(proxyUrl(url));
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
            console.log('HLS (proxy) MANIFEST_PARSED — audio:', (hls.audioTracks || []).length, 'subs:', (hls.subtitleTracks || []).length);
            setTimeout(function() {
              detectHLSSubtitles();
              detectHLSAudioTracks();
              broadcastSubtitleTrackList();
              broadcastAudioTrackList();
            }, 300);
          });
          hls.on(Hls.Events.ERROR, function(event, data2) {
            if (data2.fatal) {
              console.error('HLS proxy error:', data2.type, data2.details);
              syncStatus.textContent = 'HLS error: ' + data2.type;
              hideSpinner();
            }
          });
        } else if (data.fatal) {
          console.error('HLS fatal error:', data.type, data.details);
          syncStatus.textContent = 'HLS error: ' + data.type;
          hideSpinner();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Fallback: Safari / Tizen / some TVs support HLS natively
      video.src = url;
      video.load();
    } else {
      syncStatus.textContent = 'HLS not supported on this browser';
      hideSpinner();
      return;
    }
  } else {
    video.src = url;
    video.load();
  }

  playerContainer.classList.remove('hidden');
  playerContainer.style.display = 'flex';
  syncStatus.textContent = 'Video loaded. Press Play to start.';
  setIcon(btnPlayPause, 'play');
  subMenu.classList.add('hidden');
  audioMenu.classList.add('hidden');
  btnAudio.classList.add('hidden');
  clearSubtitleUI();

  if (broadcast) {
    socket.emit('set-video', { url: url });
  }

  // Player (TV) mode: auto-fullscreen
  if (isPlayerMode()) {
    setTimeout(function() {
      var el = playerContainer;
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    }, 500);
  }
}

// --- Remote Control Functions ---
function startRemoteTimer() {
  stopRemoteTimer();
  var lastTick = Date.now();
  remoteTimer = setInterval(function() {
    var now = Date.now();
    var elapsed = (now - lastTick) / 1000;
    lastTick = now;
    remoteTime += elapsed;
    if (remoteDuration > 0 && remoteTime > remoteDuration) {
      remoteTime = remoteDuration;
    }
    updateRemoteDisplay();
  }, 250);
}

function stopRemoteTimer() {
  if (remoteTimer) {
    clearInterval(remoteTimer);
    remoteTimer = null;
  }
}

function updateRemoteDisplay() {
  if (remoteDuration > 0) {
    var pct = (remoteTime / remoteDuration) * 100;
    remoteProgressFill.style.width = pct + '%';
    remoteProgressThumb.style.left = pct + '%';
  } else {
    remoteProgressFill.style.width = '0%';
    remoteProgressThumb.style.left = '0%';
  }
  var durText = remoteDuration > 0 ? formatTime(remoteDuration) : '--:--';
  remoteTimeDisplay.textContent = formatTime(remoteTime) + ' / ' + durText;
}

remotePlayPause.addEventListener('click', function() {
  if (remotePlaying) {
    remotePlaying = false;
    stopRemoteTimer();
    setIcon(remotePlayPause, 'play');
    socket.emit('pause', { currentTime: remoteTime, sentAt: Date.now() });
    syncStatus.textContent = 'Paused (synced)';
    stopHeartbeat();
  } else {
    remotePlaying = true;
    startRemoteTimer();
    setIcon(remotePlayPause, 'pause');
    socket.emit('play', { currentTime: remoteTime, sentAt: Date.now() });
    syncStatus.textContent = 'Playing (synced)';
    startHeartbeat();
  }
});

remoteProgressBar.addEventListener('click', function(e) {
  if (!remoteDuration || remoteSeekDragging) return;
  var rect = remoteProgressBar.getBoundingClientRect();
  var pct = (e.clientX - rect.left) / rect.width;
  remoteTime = pct * remoteDuration;
  updateRemoteDisplay();
  socket.emit('seek', { currentTime: remoteTime, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked (synced)';
});

// --- Remote Skip Buttons ---
var remoteSkipBack = document.getElementById('remote-skip-back');
var remoteSkipFwd = document.getElementById('remote-skip-fwd');

remoteSkipBack.addEventListener('click', function() {
  remoteTime = Math.max(0, remoteTime - 10);
  updateRemoteDisplay();
  socket.emit('seek', { currentTime: remoteTime, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked -10s (synced)';
});

remoteSkipFwd.addEventListener('click', function() {
  remoteTime = Math.min(remoteDuration || Infinity, remoteTime + 10);
  updateRemoteDisplay();
  socket.emit('seek', { currentTime: remoteTime, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked +10s (synced)';
});

// --- Remote Seekbar Drag ---
var remoteSeekDragging = false;

function remoteSeekFromEvent(e) {
  var rect = remoteProgressBar.getBoundingClientRect();
  var clientX = e.touches ? e.touches[0].clientX : e.clientX;
  var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  remoteTime = pct * (remoteDuration || 0);
  updateRemoteDisplay();
}

remoteProgressBar.addEventListener('mousedown', function(e) {
  if (!remoteDuration) return;
  remoteSeekDragging = true;
  remoteSeekFromEvent(e);
});
document.addEventListener('mousemove', function(e) {
  if (!remoteSeekDragging) return;
  remoteSeekFromEvent(e);
});
document.addEventListener('mouseup', function() {
  if (!remoteSeekDragging) return;
  remoteSeekDragging = false;
  socket.emit('seek', { currentTime: remoteTime, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked (synced)';
});

remoteProgressBar.addEventListener('touchstart', function(e) {
  if (!remoteDuration) return;
  remoteSeekDragging = true;
  remoteSeekFromEvent(e);
}, { passive: true });
document.addEventListener('touchmove', function(e) {
  if (!remoteSeekDragging) return;
  remoteSeekFromEvent(e);
}, { passive: true });
document.addEventListener('touchend', function() {
  if (!remoteSeekDragging) return;
  remoteSeekDragging = false;
  socket.emit('seek', { currentTime: remoteTime, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked (synced)';
});

// --- Playback Controls ---
btnPlayPause.addEventListener('click', function() {
  if (video.paused) {
    if (!safePlay()) return; // blocked — audio not ready yet
    socket.emit('play', { currentTime: video.currentTime, sentAt: Date.now() });
    syncStatus.textContent = 'Playing (synced)';
    startHeartbeat();
  } else {
    video.pause();
    socket.emit('pause', { currentTime: video.currentTime, sentAt: Date.now() });
    syncStatus.textContent = 'Paused (synced)';
    stopHeartbeat();
  }
});

video.addEventListener('play', function() {
  setIcon(btnPlayPause, 'pause');
});
video.addEventListener('pause', function() {
  setIcon(btnPlayPause, 'play');
});

// --- Loading Spinner ---
function showSpinner() {
  videoSpinner.classList.remove('hidden');
  videoSpinner.style.display = 'flex';
}
function hideSpinner() {
  videoSpinner.classList.add('hidden');
}
video.addEventListener('waiting', showSpinner);
video.addEventListener('seeking', showSpinner);
video.addEventListener('canplay', hideSpinner);
video.addEventListener('playing', hideSpinner);
video.addEventListener('seeked', hideSpinner);
video.addEventListener('error', hideSpinner);

// Notify remux server when user seeks so FFmpeg restarts at the right position
var _seekNotifyTimer = null;
video.addEventListener('seeking', function() {
  if (!currentRemuxSessionId) return;
  var targetSegment = Math.floor(video.currentTime / 4); // 4s segment duration
  if (_seekNotifyTimer) clearTimeout(_seekNotifyTimer);
  _seekNotifyTimer = setTimeout(function() {
    fetch('/remux/' + currentRemuxSessionId + '/seek?segment=' + targetSegment)
      .then(function(r) { return r.json(); })
      .then(function(d) { console.log('Seek notify:', d.status, 'seg', d.segment); })
      .catch(function() {});
  }, 150);
});

// --- Progress Bar ---
video.addEventListener('timeupdate', function() {
  if (video.duration) {
    var pct = (video.currentTime / video.duration) * 100;
    progressFill.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    timeDisplay.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
  }
});

progressBar.addEventListener('click', function(e) {
  if (!video.duration) return;
  var rect = progressBar.getBoundingClientRect();
  var pct = (e.clientX - rect.left) / rect.width;
  var newTime = pct * video.duration;
  video.currentTime = newTime;
  socket.emit('seek', { currentTime: newTime, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked (synced)';
});

// --- Player Skip Buttons ---
var btnSkipBack = document.getElementById('btn-skip-back');
var btnSkipFwd = document.getElementById('btn-skip-fwd');

btnSkipBack.addEventListener('click', function() {
  if (!video.duration) return;
  var t = Math.max(0, video.currentTime - 10);
  video.currentTime = t;
  socket.emit('seek', { currentTime: t, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked -10s (synced)';
});

btnSkipFwd.addEventListener('click', function() {
  if (!video.duration) return;
  var t = Math.min(video.duration, video.currentTime + 10);
  video.currentTime = t;
  socket.emit('seek', { currentTime: t, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked +10s (synced)';
});

// --- Controls Row Skip Buttons ---
var btnSkipBackCtrl = document.getElementById('btn-skip-back-ctrl');
var btnSkipFwdCtrl = document.getElementById('btn-skip-fwd-ctrl');

btnSkipBackCtrl.addEventListener('click', function() {
  if (!video.duration) return;
  var t = Math.max(0, video.currentTime - 10);
  video.currentTime = t;
  socket.emit('seek', { currentTime: t, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked -10s (synced)';
});

btnSkipFwdCtrl.addEventListener('click', function() {
  if (!video.duration) return;
  var t = Math.min(video.duration, video.currentTime + 10);
  video.currentTime = t;
  socket.emit('seek', { currentTime: t, sentAt: Date.now() });
  syncStatus.textContent = 'Seeked +10s (synced)';
});

// --- Fullscreen ---
btnFullscreen.addEventListener('click', function() {
  var el = playerContainer;
  var isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } else if (el.requestFullscreen) {
    el.requestFullscreen();
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  }
});

// --- Subtitles ---
btnSubs.addEventListener('click', function() {
  audioMenu.classList.add('hidden');
  subMenu.classList.toggle('hidden');
});

btnAudio.addEventListener('click', function() {
  subMenu.classList.add('hidden');
  audioMenu.classList.toggle('hidden');
});

btnLoadSub.addEventListener('click', function() {
  var url = inputSubUrl.value.trim();
  if (!url) return;
  addExternalSubtitle(url, 'External');
  socket.emit('set-subtitle', { url: url, label: 'External' });
  inputSubUrl.value = '';
});

// --- Local subtitle file picker ---
btnSubFile.addEventListener('click', function() {
  inputSubFile.click();
});

inputSubFile.addEventListener('change', function() {
  var file = inputSubFile.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var text = e.target.result;
    // Convert SRT to VTT if needed
    if (file.name.match(/\.srt$/i)) {
      text = srtToVtt(text);
    }
    var blob = new Blob([text], { type: 'text/vtt' });
    var blobUrl = URL.createObjectURL(blob);
    var label = file.name.replace(/\.[^.]+$/, '');
    addExternalSubtitle(blobUrl, label);
    // Send VTT text to partner (blob URLs are local-only)
    socket.emit('set-subtitle', { vttText: text, label: label });
  };
  reader.readAsText(file);
  inputSubFile.value = '';
});

function srtToVtt(srt) {
  var vtt = 'WEBVTT\n\n';
  // Normalize line endings and convert SRT timestamps (comma) to VTT (dot)
  vtt += srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}

function isEnglish(str) {
  if (!str) return false;
  var s = str.toLowerCase();
  return s === 'eng' || s === 'en' || s === 'english';
}

function clearSubtitleUI() {
  subTracks.innerHTML = '';
  // Add "Off" button
  var offBtn = document.createElement('button');
  offBtn.textContent = 'Off';
  offBtn.className = 'sub-track-btn active';
  offBtn.addEventListener('click', function() {
    disableAllSubs();
    setActiveSubBtn(offBtn);
    socket.emit('remove-subtitle');
  });
  subTracks.appendChild(offBtn);
}

function setActiveSubBtn(activeBtn) {
  var btns = subTracks.querySelectorAll('.sub-track-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }
  activeBtn.classList.add('active');
}

function disableAllSubs() {
  for (var i = 0; i < video.textTracks.length; i++) {
    video.textTracks[i].mode = 'disabled';
  }
}

function addSubtitleButton(label, trackIndex) {
  var btn = document.createElement('button');
  btn.textContent = label;
  btn.className = 'sub-track-btn';
  btn.addEventListener('click', function() {
    disableAllSubs();
    video.textTracks[trackIndex].mode = 'showing';
    setActiveSubBtn(btn);
  });
  subTracks.appendChild(btn);
}

function addExternalSubtitle(url, label) {
  // Remove existing external tracks
  var existing = video.querySelectorAll('track[data-external]');
  for (var i = 0; i < existing.length; i++) {
    existing[i].remove();
  }

  var track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = label || 'External';
  track.src = url;
  track.setAttribute('data-external', 'true');
  track.default = true;
  video.appendChild(track);

  // Add button and activate
  var idx = video.textTracks.length - 1;
  addSubtitleButton(track.label, idx);
  disableAllSubs();
  video.textTracks[idx].mode = 'showing';
  var btns = subTracks.querySelectorAll('.sub-track-btn');
  setActiveSubBtn(btns[btns.length - 1]);
  showToast('Subtitle loaded');
}

// Detect HLS embedded subtitles
function detectHLSSubtitles() {
  clearSubtitleUI();
  var engSubBtn = null;
  var engSubIndex = -1;
  if (hls && hls.subtitleTracks && hls.subtitleTracks.length > 0) {
    hls.subtitleDisplay = true;
    for (var i = 0; i < hls.subtitleTracks.length; i++) {
      var t = hls.subtitleTracks[i];
      var label = t.name || t.lang || ('Track ' + (i + 1));
      (function(index, lbl, track) {
        var btn = document.createElement('button');
        btn.textContent = lbl;
        btn.className = 'sub-track-btn';
        btn.addEventListener('click', function() {
          hls.subtitleTrack = index;
          disableAllSubs();
          if (video.textTracks[index]) {
            video.textTracks[index].mode = 'showing';
          }
          setActiveSubBtn(btn);
        });
        subTracks.appendChild(btn);
        // Track first English subtitle for auto-select
        if (engSubBtn === null && (isEnglish(track.lang) || isEnglish(track.name))) {
          engSubBtn = btn;
          engSubIndex = index;
        }
      })(i, label, t);
    }
  }
  // Also detect any <track> elements or native textTracks
  for (var j = 0; j < video.textTracks.length; j++) {
    var tt = video.textTracks[j];
    if (tt.label && !tt._listed) {
      tt._listed = true;
      addSubtitleButton(tt.label, j);
      if (engSubBtn === null && (isEnglish(tt.language) || isEnglish(tt.label))) {
        engSubBtn = subTracks.lastChild;
        engSubIndex = j;
      }
    }
  }
  // Auto-select English subtitle if found
  if (engSubBtn && engSubIndex !== -1) {
    disableAllSubs();
    if (hls && engSubIndex < (hls.subtitleTracks || []).length) {
      hls.subtitleTrack = engSubIndex;
    }
    if (video.textTracks[engSubIndex]) {
      video.textTracks[engSubIndex].mode = 'showing';
    }
    setActiveSubBtn(engSubBtn);
  }
}

// --- Audio Track Detection ---
function detectHLSAudioTracks() {
  audioTracks.innerHTML = '';
  btnAudio.classList.add('hidden');
  audioMenu.classList.add('hidden');

  // Try HLS.js audio tracks first
  if (hls && hls.audioTracks && hls.audioTracks.length >= 2) {
    btnAudio.classList.remove('hidden');
    // Auto-select English audio if available
    var engIdx = -1;
    for (var e = 0; e < hls.audioTracks.length; e++) {
      var at = hls.audioTracks[e];
      if (isEnglish(at.lang) || isEnglish(at.name)) { engIdx = e; break; }
    }
    if (engIdx !== -1 && hls.audioTrack !== engIdx) {
      hls.audioTrack = engIdx;
    }
    var currentTrack = hls.audioTrack;
    for (var i = 0; i < hls.audioTracks.length; i++) {
      var t = hls.audioTracks[i];
      var label = t.name || t.lang || ('Track ' + (i + 1));
      (function(index, lbl) {
        var btn = document.createElement('button');
        btn.textContent = lbl;
        btn.className = 'sub-track-btn' + (index === currentTrack ? ' active' : '');
        btn.addEventListener('click', function() {
          hls.audioTrack = index;
          var btns = audioTracks.querySelectorAll('.sub-track-btn');
          for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
          btn.classList.add('active');
        });
        audioTracks.appendChild(btn);
      })(i, label);
    }
    return;
  }

  // Fallback: native video.audioTracks (for direct video files)
  var nativeTracks = video.audioTracks;
  if (!nativeTracks || nativeTracks.length < 2) return;

  btnAudio.classList.remove('hidden');
  for (var n = 0; n < nativeTracks.length; n++) {
    var nt = nativeTracks[n];
    var nlabel = nt.label || nt.language || ('Track ' + (n + 1));
    (function(index, lbl, track) {
      var btn = document.createElement('button');
      btn.textContent = lbl;
      btn.className = 'sub-track-btn' + (track.enabled ? ' active' : '');
      btn.addEventListener('click', function() {
        // Disable all, enable selected
        for (var k = 0; k < nativeTracks.length; k++) {
          nativeTracks[k].enabled = (k === index);
        }
        var btns = audioTracks.querySelectorAll('.sub-track-btn');
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
        btn.classList.add('active');
      });
      audioTracks.appendChild(btn);
    })(n, nlabel, nt);
  }
}

// --- Track Broadcasting (Player/Both -> Remote) ---
function broadcastAudioTrackList() {
  var tracks = [];
  var selected = 0;
  if (hls && hls.audioTracks && hls.audioTracks.length >= 2) {
    selected = hls.audioTrack;
    for (var i = 0; i < hls.audioTracks.length; i++) {
      var t = hls.audioTracks[i];
      tracks.push({ index: i, label: t.name || t.lang || ('Track ' + (i + 1)) });
    }
  } else if (video.audioTracks && video.audioTracks.length >= 2) {
    for (var n = 0; n < video.audioTracks.length; n++) {
      var nt = video.audioTracks[n];
      tracks.push({ index: n, label: nt.label || nt.language || ('Track ' + (n + 1)) });
      if (nt.enabled) selected = n;
    }
  }
  if (tracks.length >= 2) {
    socket.emit('broadcast-audio-tracks', { tracks: tracks, selected: selected });
  }
}

function broadcastSubtitleTrackList() {
  var tracks = [];
  var selected = -1;
  if (hls && hls.subtitleTracks && hls.subtitleTracks.length > 0) {
    selected = hls.subtitleTrack;
    for (var i = 0; i < hls.subtitleTracks.length; i++) {
      var t = hls.subtitleTracks[i];
      tracks.push({ index: i, label: t.name || t.lang || ('Track ' + (i + 1)) });
    }
  }
  for (var j = 0; j < video.textTracks.length; j++) {
    var tt = video.textTracks[j];
    if (tt.label) {
      tracks.push({ index: j, label: tt.label });
      if (tt.mode === 'showing') selected = j;
    }
  }
  if (tracks.length > 0) {
    socket.emit('broadcast-subtitle-tracks', { tracks: tracks, selected: selected });
  }
}

// --- Remote Track Menu Population ---
function populateRemoteAudioMenu(tracks, selectedIndex) {
  remoteAudioTracks.innerHTML = '';
  if (!tracks || tracks.length < 2) {
    remoteBtnAudio.classList.add('hidden');
    remoteAudioMenu.classList.add('hidden');
    return;
  }
  remoteBtnAudio.classList.remove('hidden');
  remoteTrackControls.classList.remove('hidden');
  for (var i = 0; i < tracks.length; i++) {
    (function(track) {
      var btn = document.createElement('button');
      btn.textContent = track.label;
      btn.className = 'sub-track-btn' + (track.index === selectedIndex ? ' active' : '');
      btn.addEventListener('click', function() {
        socket.emit('select-audio-track', { index: track.index });
        var btns = remoteAudioTracks.querySelectorAll('.sub-track-btn');
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
        btn.classList.add('active');
        showToast('Audio: ' + track.label);
      });
      remoteAudioTracks.appendChild(btn);
    })(tracks[i]);
  }
}

function populateRemoteSubtitleMenu(tracks, selectedIndex) {
  remoteSubTracks.innerHTML = '';
  remoteTrackControls.classList.remove('hidden');

  // "Off" button always first
  var offBtn = document.createElement('button');
  offBtn.textContent = 'Off';
  offBtn.className = 'sub-track-btn' + (selectedIndex == null || selectedIndex === -1 ? ' active' : '');
  offBtn.addEventListener('click', function() {
    socket.emit('select-subtitle-track', { index: -1 });
    socket.emit('remove-subtitle');
    var btns = remoteSubTracks.querySelectorAll('.sub-track-btn');
    for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
    offBtn.classList.add('active');
    showToast('Subtitles off');
  });
  remoteSubTracks.appendChild(offBtn);

  if (tracks && tracks.length > 0) {
    for (var i = 0; i < tracks.length; i++) {
      (function(track) {
        var btn = document.createElement('button');
        btn.textContent = track.label;
        btn.className = 'sub-track-btn' + (track.index === selectedIndex ? ' active' : '');
        btn.addEventListener('click', function() {
          socket.emit('select-subtitle-track', { index: track.index });
          var btns = remoteSubTracks.querySelectorAll('.sub-track-btn');
          for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
          btn.classList.add('active');
          showToast('Subtitle: ' + track.label);
        });
        remoteSubTracks.appendChild(btn);
      })(tracks[i]);
    }
  }
}

// --- Remote Menu Toggle ---
remoteBtnSubs.addEventListener('click', function() {
  remoteAudioMenu.classList.add('hidden');
  remoteSubMenu.classList.toggle('hidden');
});
remoteBtnAudio.addEventListener('click', function() {
  remoteSubMenu.classList.add('hidden');
  remoteAudioMenu.classList.toggle('hidden');
});

// --- Remote External Subtitle Loading ---
remoteBtnLoadSub.addEventListener('click', function() {
  var url = remoteInputSubUrl.value.trim();
  if (!url) return;
  socket.emit('set-subtitle', { url: url, label: 'External' });
  remoteInputSubUrl.value = '';
  showToast('Subtitle URL sent');
});

remoteBtnSubFile.addEventListener('click', function() {
  remoteInputSubFile.click();
});

remoteInputSubFile.addEventListener('change', function() {
  var file = remoteInputSubFile.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var text = e.target.result;
    if (file.name.match(/\.srt$/i)) {
      text = srtToVtt(text);
    }
    var label = file.name.replace(/\.[^.]+$/, '');
    socket.emit('set-subtitle', { vttText: text, label: label });
    showToast('Subtitle file sent: ' + label);
  };
  reader.readAsText(file);
  remoteInputSubFile.value = '';
});

// Re-detect subs and audio when video loads
video.addEventListener('loadedmetadata', function() {
  // Broadcast duration to room (useful for remote mode clients)
  if (video.duration && isFinite(video.duration)) {
    socket.emit('set-duration', { duration: video.duration });
  }
  setTimeout(function() {
    detectHLSSubtitles();
    detectHLSAudioTracks();
    broadcastSubtitleTrackList();
    broadcastAudioTrackList();
  }, 500);
});

// --- Socket Events (receiving sync from partner) ---
socket.on('room-state', function(state) {
  if (isRemoteMode()) {
    if (state.videoUrl) {
      remoteContainer.classList.remove('hidden');
      remoteContainer.style.display = 'block';
      playerContainer.classList.add('hidden');
      remoteTime = state.currentTime || 0;
      remoteDuration = state.duration || 0;
      remotePlaying = !!state.playing;
      setIcon(remotePlayPause, remotePlaying ? 'pause' : 'play');
      if (remotePlaying) {
        startRemoteTimer();
        startHeartbeat();
      }
      updateRemoteDisplay();
      syncStatus.textContent = remotePlaying ? 'Playing (synced)' : 'Paused (synced)';
      if (state.contentMeta && state.contentMeta.name) {
        remoteTitleEl.textContent = state.contentMeta.name;
      }
      // Restore track lists for late-joining remotes
      if (state.audioTracks && state.audioTracks.length >= 2) {
        populateRemoteAudioMenu(state.audioTracks, state.selectedAudioTrack);
      }
      if (state.subtitleTracks && state.subtitleTracks.length > 0) {
        populateRemoteSubtitleMenu(state.subtitleTracks, state.selectedSubtitleTrack);
      }
    }
    return;
  }
  if (state.videoUrl) {
    loadVideo(state.videoUrl, false);
    video.currentTime = state.currentTime || 0;
    if (state.playing) {
      safePlay();
      syncStatus.textContent = 'Playing (synced)';
    }
  }
  // Restore subtitles for late joiners
  if (state.subtitle) {
    if (state.subtitle.vttText) {
      var blob = new Blob([state.subtitle.vttText], { type: 'text/vtt' });
      var blobUrl = URL.createObjectURL(blob);
      addExternalSubtitle(blobUrl, state.subtitle.label || 'Synced sub');
    } else if (state.subtitle.url) {
      addExternalSubtitle(state.subtitle.url, state.subtitle.label || 'Synced sub');
    }
  }
});

socket.on('set-video', function(data) {
  // Hide browse UI when partner loads a video
  searchResults.classList.add('hidden');
  contentDetail.classList.add('hidden');
  loadVideo(data.url, false);
  showToast('Partner loaded a video');
});

socket.on('set-content', function(data) {
  if (data && data.name) {
    showToast('Now playing: ' + data.name);
    if (isRemoteMode()) {
      remoteTitleEl.textContent = data.name;
    }
  }
});

socket.on('set-duration', function(data) {
  if (isRemoteMode() && data.duration) {
    remoteDuration = data.duration;
    updateRemoteDisplay();
  }
});

// Track list broadcasts from Player/Both -> Remote
socket.on('broadcast-audio-tracks', function(data) {
  if (!isRemoteMode()) return;
  populateRemoteAudioMenu(data.tracks, data.selected);
});

socket.on('broadcast-subtitle-tracks', function(data) {
  if (!isRemoteMode()) return;
  populateRemoteSubtitleMenu(data.tracks, data.selected);
});

// Track selection from Remote -> Player/Both
socket.on('select-audio-track', function(data) {
  if (isRemoteMode()) return;
  var index = data.index;
  if (hls && hls.audioTracks && hls.audioTracks.length > index) {
    hls.audioTrack = index;
  } else if (video.audioTracks && video.audioTracks.length > index) {
    for (var k = 0; k < video.audioTracks.length; k++) {
      video.audioTracks[k].enabled = (k === index);
    }
  }
  var btns = audioTracks.querySelectorAll('.track-btn, .sub-track-btn');
  for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
  if (btns[index]) btns[index].classList.add('active');
  showToast('Audio track changed');
});

socket.on('select-subtitle-track', function(data) {
  if (isRemoteMode()) return;
  var index = data.index;
  if (index === -1 || index == null) {
    disableAllSubs();
    clearSubtitleUI();
    detectHLSSubtitles();
  } else {
    disableAllSubs();
    if (hls && hls.subtitleTracks && hls.subtitleTracks.length > index) {
      hls.subtitleTrack = index;
    }
    if (video.textTracks[index]) {
      video.textTracks[index].mode = 'showing';
    }
    var btns = subTracks.querySelectorAll('.sub-track-btn');
    for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
    if (btns[index + 1]) btns[index + 1].classList.add('active');
  }
  showToast('Subtitle track changed');
});

socket.on('play', function(data) {
  if (isRemoteMode()) {
    var delay = data.sentAt ? (Date.now() - data.sentAt) / 1000 : 0;
    remoteTime = data.currentTime + delay;
    remotePlaying = true;
    setIcon(remotePlayPause, 'pause');
    startRemoteTimer();
    updateRemoteDisplay();
    syncStatus.textContent = 'Playing (synced)';
    showToast('Partner pressed play');
    startHeartbeat();
    return;
  }
  ignoreEvents = true;
  // Compensate for network delay — video kept playing on partner's side
  var delay = data.sentAt ? (Date.now() - data.sentAt) / 1000 : 0;
  video.currentTime = data.currentTime + delay;
  safePlay();
  ignoreEvents = false;
  syncStatus.textContent = 'Playing (synced)';
  showToast('Partner pressed play');
  startHeartbeat();
});

socket.on('pause', function(data) {
  if (isRemoteMode()) {
    remoteTime = data.currentTime;
    remotePlaying = false;
    setIcon(remotePlayPause, 'play');
    stopRemoteTimer();
    updateRemoteDisplay();
    syncStatus.textContent = 'Paused (synced)';
    showToast('Partner paused');
    stopHeartbeat();
    return;
  }
  ignoreEvents = true;
  video.pause();
  video.currentTime = data.currentTime;
  ignoreEvents = false;
  syncStatus.textContent = 'Paused (synced)';
  showToast('Partner paused');
  stopHeartbeat();
});

socket.on('seek', function(data) {
  if (isRemoteMode()) {
    remoteTime = data.currentTime;
    updateRemoteDisplay();
    syncStatus.textContent = 'Seeked (synced)';
    showToast('Partner seeked');
    return;
  }
  ignoreEvents = true;
  video.currentTime = data.currentTime;
  ignoreEvents = false;
  syncStatus.textContent = 'Seeked (synced)';
  showToast('Partner seeked');
});

socket.on('set-subtitle', function(data) {
  if (isRemoteMode()) {
    // Update remote subtitle UI to reflect external sub loaded
    var btns = remoteSubTracks.querySelectorAll('.sub-track-btn');
    for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
    showToast('Subtitle loaded: ' + (data.label || 'External'));
    return;
  }
  if (data.vttText) {
    // Partner sent raw VTT text (from a file) — create a blob URL
    var blob = new Blob([data.vttText], { type: 'text/vtt' });
    var blobUrl = URL.createObjectURL(blob);
    addExternalSubtitle(blobUrl, data.label || 'Partner sub');
  } else if (data.url) {
    addExternalSubtitle(data.url, data.label || 'Partner sub');
  }
  showToast('Partner loaded subtitles');
});

socket.on('remove-subtitle', function() {
  if (isRemoteMode()) {
    var btns = remoteSubTracks.querySelectorAll('.sub-track-btn');
    for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
    if (btns.length > 0) btns[0].classList.add('active'); // "Off" is first
    showToast('Subtitles turned off');
    return;
  }
  disableAllSubs();
  clearSubtitleUI();
  showToast('Partner turned off subtitles');
});

socket.on('user-count', function(count) {
  userCountEl.textContent = count + ' connected';
});

socket.on('disconnect', function() {
  syncStatus.textContent = 'Disconnected. Reconnecting...';
  stopHeartbeat();
});

// --- Fullscreen auto-hide controls ---
var hideTimer = null;

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function showControls() {
  playerContainer.classList.remove('controls-hidden');
  clearTimeout(hideTimer);
  if (isFullscreen() && !video.paused) {
    hideTimer = setTimeout(function() {
      playerContainer.classList.add('controls-hidden');
    }, 3000);
  }
}

function onFullscreenChange() {
  if (isFullscreen()) {
    setIcon(btnFullscreen, 'minimize');
    showControls();
  } else {
    setIcon(btnFullscreen, 'maximize');
    clearTimeout(hideTimer);
    playerContainer.classList.remove('controls-hidden');
  }
}

document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

playerContainer.addEventListener('mousemove', showControls);
playerContainer.addEventListener('touchstart', showControls);
playerContainer.addEventListener('click', function(e) {
  // Click on video area (not controls) toggles play/pause and shows controls
  if (e.target === video) {
    showControls();
  }
});

video.addEventListener('pause', function() {
  // Always show controls when paused
  clearTimeout(hideTimer);
  playerContainer.classList.remove('controls-hidden');
});
video.addEventListener('play', function() {
  if (isFullscreen()) {
    showControls(); // restart the hide timer
  }
});

// --- Keyboard shortcuts (TV remotes often send these) ---
document.addEventListener('keydown', function(e) {
  // Don't capture when typing in inputs
  if (e.target.tagName === 'INPUT') return;

  if (isRemoteMode()) {
    if (remoteContainer.classList.contains('hidden')) return;
    switch (e.key) {
      case ' ':
      case 'Enter':
      case 'MediaPlayPause':
        e.preventDefault();
        remotePlayPause.click();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        remoteTime = Math.max(0, remoteTime - 10);
        updateRemoteDisplay();
        socket.emit('seek', { currentTime: remoteTime, sentAt: Date.now() });
        syncStatus.textContent = 'Seeked -10s (synced)';
        break;
      case 'ArrowRight':
        e.preventDefault();
        remoteTime = Math.min(remoteDuration || Infinity, remoteTime + 10);
        updateRemoteDisplay();
        socket.emit('seek', { currentTime: remoteTime, sentAt: Date.now() });
        syncStatus.textContent = 'Seeked +10s (synced)';
        break;
    }
    return;
  }

  // Only when video is loaded
  if (playerContainer.classList.contains('hidden')) return;

  switch (e.key) {
    case ' ':
    case 'Enter':
    case 'MediaPlayPause':
      e.preventDefault();
      btnPlayPause.click();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      var back = Math.max(0, video.currentTime - 10);
      video.currentTime = back;
      socket.emit('seek', { currentTime: back, sentAt: Date.now() });
      syncStatus.textContent = 'Seeked -10s (synced)';
      break;
    case 'ArrowRight':
      e.preventDefault();
      var fwd = Math.min(video.duration || 0, video.currentTime + 10);
      video.currentTime = fwd;
      socket.emit('seek', { currentTime: fwd, sentAt: Date.now() });
      syncStatus.textContent = 'Seeked +10s (synced)';
      break;
    case 'f':
      btnFullscreen.click();
      break;
  }
});

// --- Initialize Lucide Icons ---
lucide.createIcons();
