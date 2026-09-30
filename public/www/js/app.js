// ── AUDIO ENGINE ──────────────────────────────────────────
const AC = new (window.AudioContext || window.webkitAudioContext)();
let gainNode = AC.createGain();
let analyserNode = AC.createAnalyser();
analyserNode.fftSize = 256;

let eqFilters = [];
let sourceNode = null;
let audioBuffer = null;
let startedAt = 0;
let pausedAt = 0;
let isPlaying = false;
let eqEnabled = true;

const EQ_BANDS = [
  { f: 60, type: 'lowshelf' },
  { f: 170, type: 'peaking' },
  { f: 350, type: 'peaking' },
  { f: 1000, type: 'peaking' },
  { f: 3500, type: 'peaking' },
  { f: 10000, type: 'peaking' },
  { f: 16000, type: 'highshelf' }
];

const PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0],
  bass: [8, 5, 3, 0, -1, -1, -2],
  vocal: [-2, -1, 0, 5, 5, 3, 1],
  treble: [-2, -1, 0, 1, 3, 6, 7],
  classical: [4, 3, 0, 0, 0, 3, 4],
  lounge: [3, 2, 0, -1, 0, 2, 3]
};

function buildEQChain() {
  eqFilters.forEach(f => f.disconnect());
  eqFilters = EQ_BANDS.map(b => {
    const f = AC.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.f;
    f.gain.value = 0;
    return f;
  });
  for (let i = 0; i < eqFilters.length - 1; i++) {
    eqFilters[i].connect(eqFilters[i + 1]);
  }
  eqFilters[eqFilters.length - 1].connect(gainNode);
  gainNode.connect(analyserNode);
  analyserNode.connect(AC.destination);
}
buildEQChain();

function connectSource(buf) {
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch (e) {}
    sourceNode.disconnect();
  }
  sourceNode = AC.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.connect(eqEnabled ? eqFilters[0] : gainNode);
  sourceNode.onended = () => { if (isPlaying) nextTrack(); };
}

function playFrom(offset) {
  if (!audioBuffer) return;
  connectSource(audioBuffer);
  startedAt = AC.currentTime - offset;
  sourceNode.start(0, offset);
  isPlaying = true;
  document.getElementById('playBtn').textContent = '⏸';
  document.getElementById('playBtn').classList.remove('loading');
  updateMediaSessionState(true);
  resumeViz();
  if (typeof startLRCSync === 'function' && lyricsMode === 'lrc') startLRCSync();
}

function pausePlayback() {
  if (!isPlaying) return;
  if (videoMode) {
    document.getElementById('videoEl').pause();
    isPlaying = false;
    document.getElementById('playBtn').textContent = '▶';
    updateMediaSessionState(false);
    return;
  }
  pausedAt = Math.max(0, AC.currentTime - startedAt);
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch (e) {}
  }
  isPlaying = false;
  document.getElementById('playBtn').textContent = '▶';
  updateMediaSessionState(false);
  stopViz();
  if (typeof stopLRCSync === 'function') stopLRCSync();
}

gainNode.gain.value = 0.8;

// ── ESTADO Y DATOS ────────────────────────────────────────
let library = [];
let queue = [];
let folderMap = [];
let curIdx = 0;
let shuffle = false;
let repeatMode = 0;
let liked = false;
let activeTab = 'queue';
let folders = [];

// ── SISTEMA DE ARCHIVOS LOCALES ───────────────────────────
async function openFolder() {
  if (AC.state === 'suspended') AC.resume();
  try {
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    toast('Cargando archivos…');
    const files = await collectAudio(dir);
    if (!files.length) { toast('No se encontraron archivos multimedia'); return; }
    const newTracks = await parseFiles(files);
    const folderIdx = folders.length;

    const startOffset = library.length;
    library = [...library, ...newTracks];
    newTracks.forEach((_, i) => folderMap[startOffset + i] = folderIdx);
    queue = library.map((_, i) => i);
    folders.push(dir.name);
    renderPanel();
    toast(`${newTracks.length} pistas cargadas`);
    if (library.length === newTracks.length) loadTrack(0);
  } catch (e) {
    if (e.name !== 'AbortError') toast('Error al abrir la carpeta');
  }
}

async function collectAudio(dir) {
  const exts = ['mp3', 'flac', 'aac', 'm4a', 'ogg', 'wav', 'opus', 'wma',
    'mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', '3gp'];
  const files = [];

  async function scanDirectory(directory) {
    for await (const entry of directory.values()) {
      if (entry.kind === 'file') {
        const ext = entry.name.split('.').pop().toLowerCase();
        if (exts.includes(ext)) {
          try { files.push(await entry.getFile()); } catch (e) {}
        }
      } else if (entry.kind === 'directory') {
        try { await scanDirectory(entry); } catch (e) {}
      }
    }
  }

  await scanDirectory(dir);
  return files;
}

const VIDEO_EXTS = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', '3gp'];
function isVideoExt(ext) { return VIDEO_EXTS.includes(ext.toLowerCase()); }

async function parseFiles(files) {
  return files.map(f => {
    const name = f.name.replace(/\.[^.]+$/, '');
    const parts = name.split(' - ');
    const ext = f.name.split('.').pop().toUpperCase();
    return {
      name: parts.length > 1 ? parts.slice(1).join(' - ') : name,
      artist: parts.length > 1 ? parts[0] : 'Desconocido',
      album: '—', duration: 0, durationStr: '—',
      file: f, format: ext,
      isVideo: isVideoExt(ext)
    };
  });
}

// ── REPRODUCCIÓN Y DECODIFICACIÓN ─────────────────────────
let videoMode = false;
let videoObjectURL = null;

function setVideoMode(on) {
  videoMode = on;
  document.getElementById('videoWrap').style.display = on ? 'block' : 'none';
  document.getElementById('artworkWrap').classList.toggle('hidden', on);
  document.querySelector('.viz-wrap').style.display = on ? 'none' : 'block';
}

async function loadTrack(idx) {
  if (!library.length) return;
  if (isPlaying) pausePlayback();
  catalogSource = null;
  curIdx = idx;
  pausedAt = 0;
  const t = library[queue[curIdx]];
  if (!t) return;

  updateNPDisplay(t);
  if (!t.isVideo) drawArt(queue[curIdx]);
  document.getElementById('playBtn').classList.add('loading');
  document.getElementById('playBtn').textContent = '…';

  if (videoObjectURL) { URL.revokeObjectURL(videoObjectURL); videoObjectURL = null; }

  if (t.isVideo) {
    setVideoMode(true);
    document.getElementById('videoBadge').textContent = t.format;
    const url = URL.createObjectURL(t.file);
    videoObjectURL = url;
    const vid = document.getElementById('videoEl');
    vid.src = url;
    vid.load();
    if (!vid._connected) {
      const src = AC.createMediaElementSource(vid);
      src.connect(eqEnabled ? eqFilters[0] : gainNode);
      vid._connected = true;
    }
    vid.play().then(() => {
      isPlaying = true;
      audioBuffer = { duration: vid.duration || 0 };
      document.getElementById('playBtn').classList.remove('loading');
      document.getElementById('playBtn').textContent = '⏸';
      updateMediaSessionState(true);
    }).catch(() => {
      toast('No se pudo reproducir el video');
      document.getElementById('playBtn').classList.remove('loading');
      document.getElementById('playBtn').textContent = '▶';
    });
  } else {
    setVideoMode(false);
    try {
      const ab = await t.file.arrayBuffer();
      audioBuffer = await AC.decodeAudioData(ab);
      t.duration = audioBuffer.duration;
      t.durationStr = fmtTime(audioBuffer.duration);
      document.getElementById('timeDur').textContent = t.durationStr;
      renderPanel();
      playFrom(0);
      if (lyricsVisible) fetchLyrics(t.artist, t.name);
    } catch (e) {
      toast('No se pudo decodificar el archivo');
      document.getElementById('playBtn').classList.remove('loading');
      document.getElementById('playBtn').textContent = '▶';
    }
  }
}

function updateNPDisplay(t) {
  document.getElementById('npTitle').textContent = t.name;
  document.getElementById('npArtist').textContent = t.artist;
  document.getElementById('npFormat').textContent = t.format + (t.durationStr !== '—' ? ' · ' + t.durationStr : '');
  document.getElementById('timeDur').textContent = t.durationStr;
  document.getElementById('timeCur').textContent = '0:00';
  document.getElementById('progFill').style.width = '0%';
  document.getElementById('progThumb').style.left = '0%';
  document.getElementById('heartBtn').textContent = '♡';
  document.getElementById('heartBtn').classList.remove('on');
  liked = false;
  updateMediaSession(t.name, t.artist, t.album || '—', null);
}

// ── MEDIA SESSION ─────────────────────────────────────────
function updateMediaSession(title, artist, album, artworkUrl) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist,
    album,
    artwork: artworkUrl
      ? [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }]
      : [{ src: 'https://industriasplaneta.wordpress.com/wp-content/uploads/2026/09/brumm-i.png', sizes: '512x512', type: 'image/png' }]
  });
  navigator.mediaSession.setActionHandler('play', () => { if (!isPlaying) togglePlay(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) pausePlayback(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
  navigator.mediaSession.setActionHandler('seekto', e => {
    if (!audioBuffer) return;
    pausePlayback();
    pausedAt = e.seekTime;
    playFrom(e.seekTime);
  });
}

function updateMediaSessionState(playing) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

// ── CONTROLES Y NAVEGACIÓN ────────────────────────────────
function togglePlay() {
  if (AC.state === 'suspended') AC.resume();
  if (!library.length && !catalogSource) { openFolder(); return; }
  if (videoMode) {
    const vid = document.getElementById('videoEl');
    if (vid.paused) { vid.play(); isPlaying = true; document.getElementById('playBtn').textContent = '⏸'; updateMediaSessionState(true); }
    else { vid.pause(); isPlaying = false; document.getElementById('playBtn').textContent = '▶'; updateMediaSessionState(false); }
    return;
  }
  if (isPlaying) pausePlayback();
  else { playFrom(pausedAt); }
}

function prevTrack() {
  if (catalogSource !== null) {
    const elapsed = isPlaying ? AC.currentTime - startedAt : pausedAt;
    if (elapsed > 3) { pausePlayback(); pausedAt = 0; playFrom(0); return; }
    playJamendoTrack(Math.max(0, curJamendoIdx - 1));
    return;
  }
  if (!library.length) return;
  const elapsed = isPlaying ? AC.currentTime - startedAt : pausedAt;
  if (elapsed > 3) { pausePlayback(); pausedAt = 0; playFrom(0); return; }
  curIdx = (curIdx - 1 + queue.length) % queue.length;
  loadTrack(curIdx);
}

function nextTrack() {
  if (catalogSource !== null) {
    if (repeatMode === 2) { pausePlayback(); pausedAt = 0; playFrom(0); return; }
    const newIdx = shuffle
      ? Math.floor(Math.random() * jamendoResults.length)
      : (curJamendoIdx + 1) % jamendoResults.length;
    playJamendoTrack(newIdx);
    return;
  }
  if (!library.length) return;
  if (repeatMode === 2) { pausePlayback(); pausedAt = 0; playFrom(0); return; }
  if (shuffle) curIdx = Math.floor(Math.random() * queue.length);
  else curIdx = (curIdx + 1) % queue.length;
  loadTrack(curIdx);
}

function toggleShuffle() {
  shuffle = !shuffle;
  document.getElementById('shuffleBtn').classList.toggle('on', shuffle);
  toast(shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado');
}

function cycleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  const btn = document.getElementById('repeatBtn');
  const labels = ['↻', '↻¹', '↻'];
  btn.textContent = labels[repeatMode];
  btn.classList.toggle('on', repeatMode > 0);
  const msgs = ['Repetición desactivada', 'Repetir pista', 'Repetir todo'];
  toast(msgs[repeatMode]);
}

function toggleHeart() {
  liked = !liked;
  const btn = document.getElementById('heartBtn');
  btn.textContent = liked ? '♥' : '♡';
  btn.classList.toggle('on', liked);
}

function setVolume(el) {
  const v = Math.pow(el.value / 100, 2);
  gainNode.gain.value = v;
  const pct = el.value;
  let s = document.getElementById('vol-style');
  if (!s) { s = document.createElement('style'); s.id = 'vol-style'; document.head.appendChild(s); }
  s.textContent = `input[type=range].vol::-webkit-slider-runnable-track{background:linear-gradient(to right,var(--text) ${pct}%,var(--surface2) ${pct}%);}`;
}

// Búsqueda en Barra de Progreso
document.getElementById('progWrap').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (videoMode) {
    const vid = document.getElementById('videoEl');
    if (vid.duration) vid.currentTime = ratio * vid.duration;
    return;
  }
  if (!audioBuffer) return;
  const seekTo = ratio * audioBuffer.duration;
  pausePlayback();
  pausedAt = seekTo;
  playFrom(seekTo);
});

// ── BUCLE DE SEGUIMIENTO Y TIEMPOS ───────────────────────
setInterval(() => {
  if (videoMode) return;
  if (!isPlaying || !audioBuffer) return;
  const cur = AC.currentTime - startedAt;
  const ratio = Math.min(1, cur / audioBuffer.duration) * 100;
  document.getElementById('progFill').style.width = ratio + '%';
  document.getElementById('progThumb').style.left = ratio + '%';
  document.getElementById('timeCur').textContent = fmtTime(cur);
}, 250);

function videoTick() {
  const vid = document.getElementById('videoEl');
  if (!vid.duration) return;
  const ratio = (vid.currentTime / vid.duration) * 100;
  document.getElementById('progFill').style.width = ratio + '%';
  document.getElementById('progThumb').style.left = ratio + '%';
  document.getElementById('timeCur').textContent = fmtTime(vid.currentTime);
}

function videoReady() {
  const vid = document.getElementById('videoEl');
  const t = library[queue[curIdx]];
  if (t) {
    t.duration = vid.duration;
    t.durationStr = fmtTime(vid.duration);
  }
  document.getElementById('timeDur').textContent = fmtTime(vid.duration);
  audioBuffer = { duration: vid.duration };
}

// ── ECUALIZADOR INTERFAZ ──────────────────────────────────
function buildEQUI() {
  const c = document.getElementById('eqBands');
  c.innerHTML = EQ_BANDS.map((b, i) => `
    <div class="eq-band">
      <div class="eq-val" id="eqv${i}">0</div>
      <input type="range" min="-24" max="24" value="0" step="1"
        oninput="setEQBand(${i},+this.value)"
        id="eqs${i}" title="${b.f}Hz">
      <div class="eq-label">${b.f < 1000 ? b.f : (b.f / 1000) + 'k'}</div>
    </div>`).join('');
}

function setEQBand(i, v) {
  if (eqFilters[i]) eqFilters[i].gain.value = v;
  document.getElementById('eqv' + i).textContent = (v > 0 ? '+' : '') + v;
}

function applyPreset(name) {
  const vals = PRESETS[name] || PRESETS.flat;
  vals.forEach((v, i) => {
    document.getElementById('eqs' + i).value = v;
    setEQBand(i, v);
  });
}

function toggleEQ() {
  eqEnabled = !eqEnabled;
  const btn = document.getElementById('eqToggle');
  btn.textContent = eqEnabled ? 'ON' : 'OFF';
  btn.classList.toggle('on', eqEnabled);
  if (isPlaying) {
    const cur = AC.currentTime - startedAt;
    pausePlayback();
    connectSource(audioBuffer);
    sourceNode.connect(eqEnabled ? eqFilters[0] : gainNode);
    startedAt = AC.currentTime - cur;
    sourceNode.start(0, cur);
    isPlaying = true;
    document.getElementById('playBtn').textContent = '⏸';
    resumeViz();
  }
  toast(eqEnabled ? 'Ecualizador activado' : 'Ecualizador en bypass');
}

// ── VISUALIZADOR ──────────────────────────────────────────
let vizRAF = null;
const vizCanvas = document.getElementById('vizCanvas');
const vizCtx = vizCanvas.getContext('2d');

function drawViz() {
  const buf = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(buf);
  const W = vizCanvas.offsetWidth, H = 28;
  if (vizCanvas.width !== W) vizCanvas.width = W;
  vizCtx.clearRect(0, 0, W, H);
  const bars = Math.min(buf.length, 64);
  const bw = W / bars - 1;
  for (let i = 0; i < bars; i++) {
    const h = (buf[i] / 255) * H;
    const x = i * (bw + 1);
    vizCtx.fillStyle = `rgba(242,241,238,${0.15 + buf[i] / 255 * 0.7})`;
    vizCtx.fillRect(x, H - h, bw, h);
  }
  vizRAF = requestAnimationFrame(drawViz);
}
function resumeViz() { if (!vizRAF) drawViz(); }
function stopViz() { cancelAnimationFrame(vizRAF); vizRAF = null; vizCtx.clearRect(0, 0, vizCanvas.width, 28); }

// ── GENERADOR DE PORTADAS ─────────────────────────────────
function drawArt(seed) {
  const c = document.getElementById('artCanvas');
  const ctx = c.getContext('2d');
  const palettes = [
    ['#2A2A27', '#3A3A36'], ['#1C1C1A', '#252523'],
    ['#2E2E2B', '#000000'], ['#3A3A36', '#2A2A27']
  ];
  const [bg, fg] = palettes[Math.abs(seed) % palettes.length];
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = fg;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(10 + i * 13 + Math.sin(seed * 1.3 + i) * 9, 32 + Math.cos(seed + i * 0.7) * 15, 9 + i * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── RENDERIZADO DE PANELES ────────────────────────────────
function renderPanel() {
  if (activeTab === 'queue') renderQueue();
  else if (activeTab === 'library') renderLibrary();
  else renderFolders();
}

function renderQueue() {
  const body = document.getElementById('panelBody');
  if (!queue.length) {
    body.innerHTML = '<div class="empty-state"><strong>Cola vacía</strong>Abre una carpeta para cargar audio o video.</div>';
    return;
  }
  body.innerHTML = queue.map((ti, qi) => {
    const t = library[ti];
    if (!t) return '';
    const active = qi === curIdx;
    return `<div class="track-row${active ? ' active' : ''}" draggable="true"
      ondragstart="dragStart(event,${qi})" ondragover="dragOver(event,${qi})" ondrop="dragDrop(event,${qi})" ondragleave="dragLeave(event)">
      <div class="tr-drag">⋮⋮</div>
      <div class="tr-n${active ? ' playing' : ''}"> ${active ? '♪' : qi + 1}</div>
      <div class="tr-info" onclick="loadTrack(${qi})" style="cursor:pointer;">
        <div class="tr-title${active ? ' playing' : ''}">${esc(t.name)}</div>
        <div class="tr-sub">${esc(t.artist)}</div>
      </div>
      <div class="tr-fmt">${t.isVideo ? '🎬 ' : ''}${t.format}</div>
      <div class="tr-dur">${t.durationStr}</div>
      <button class="tr-del" onclick="removeFromQueue(${qi})" title="Eliminar">✕</button>
    </div>`;
  }).join('');
  const activeEl = body.querySelector('.track-row.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function renderLibrary() {
  const body = document.getElementById('panelBody');
  if (!library.length) {
    body.innerHTML = '<div class="empty-state"><strong>Biblioteca vacía</strong>Añade carpetas para explorar tu música aquí.</div>';
    return;
  }
  const sorted = [...library].sort((a, b) => a.artist.localeCompare(b.artist));
  body.innerHTML = sorted.map((t, i) => `
    <div class="track-row" onclick="jumpToTrack('${esc(t.name)}','${esc(t.artist)}')">
      <div class="tr-n">${i + 1}</div>
      <div class="tr-info">
        <div class="tr-title">${esc(t.name)}</div>
        <div class="tr-sub">${esc(t.artist)}</div>
      </div>
      <div class="tr-fmt">${t.format}</div>
      <div class="tr-dur">${t.durationStr}</div>
    </div>`).join('');
}

function renderFolders() {
  const body = document.getElementById('panelBody');
  if (!folders.length) {
    body.innerHTML = '<div class="empty-state"><strong>Sin fuentes</strong>Agrega carpetas o conecta un USB</div>';
    return;
  }
  body.innerHTML = folders.map((f, i) => `
    <div class="track-row">
      <div class="tr-n">📂</div>
      <div class="tr-info"><div class="tr-title">${esc(f)}</div><div class="tr-sub">${library.filter((_, li) => folderMap[li] === i).length} pistas</div></div>
      <button class="tr-del" onclick="removeFolder(${i})" title="Eliminar fuente" style="opacity:1;">✕</button>
    </div>`).join('') +
    `<div class="track-row" onclick="openFolder()" style="color:var(--text2);">
      <div class="tr-n">+</div>
      <div class="tr-info"><div class="tr-title">Agregar fuente…</div></div>
    </div>`;
}

function jumpToTrack(name, artist) {
  const idx = queue.findIndex(ti => library[ti] && library[ti].name === name && library[ti].artist === artist);
  if (idx >= 0) { loadTrack(idx); showTab('queue'); }
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  renderPanel();
}

// ── MODAL PRO / LICENCIAS ────────────────────────────────
document.getElementById('proBtn').onclick = () => document.getElementById('modalBg').classList.add('show');
function closeModal(e) { if (e.target === document.getElementById('modalBg')) document.getElementById('modalBg').classList.remove('show'); }

// ── TOAST NOTIFICATION ────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── TECLADO Y ATAJOS ──────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight') nextTrack();
  if (e.code === 'ArrowLeft') prevTrack();
  if (e.code === 'ArrowUp') { const v = document.getElementById('volSlider'); v.value = Math.min(100, +v.value + 5); setVolume(v); }
  if (e.code === 'ArrowDown') { const v = document.getElementById('volSlider'); v.value = Math.max(0, +v.value - 5); setVolume(v); }
});

// ── UTILIDADES ────────────────────────────────────────────
function fmtTime(s) {
  if (!s || isNaN(s)) return '—';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── SERVICE WORKER ────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .catch(e => console.warn('SW:', e));
  });
}

// ── COLA DRAG & DROP ─────────────────────────────────────
let dragSrc = null;
function dragStart(e, qi) { dragSrc = qi; e.dataTransfer.effectAllowed = 'move'; }
function dragOver(e, qi) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function dragDrop(e, qi) {
  e.currentTarget.classList.remove('drag-over');
  if (dragSrc === null || dragSrc === qi) return;
  const moved = queue.splice(dragSrc, 1)[0];
  queue.splice(qi, 0, moved);
  if (curIdx === dragSrc) curIdx = qi;
  else if (dragSrc < curIdx && qi >= curIdx) curIdx--;
  else if (dragSrc > curIdx && qi <= curIdx) curIdx++;
  dragSrc = null;
  renderQueue();
}

function removeFromQueue(qi) {
  if (qi === curIdx && isPlaying) pausePlayback();
  queue.splice(qi, 1);
  if (curIdx >= queue.length) curIdx = Math.max(0, queue.length - 1);
  renderQueue();
  toast('Pista eliminada de la cola');
}

function removeFolder(fi) {
  const toRemove = library.map((_, li) => folderMap[li] === fi ? li : -1).filter(i => i >= 0);
  library = library.filter((_, li) => folderMap[li] !== fi);
  folderMap = folderMap.filter((_, li) => !toRemove.includes(li));
  folders.splice(fi, 1);
  queue = library.map((_, i) => i);
  curIdx = 0;
  renderPanel();
  toast('Fuente removida');
}

function clearLibrary() {
  if (!confirm('¿Limpiar toda la biblioteca?')) return;
  library = []; queue = []; folderMap = []; folders = []; curIdx = 0;
  if (isPlaying) pausePlayback();
  audioBuffer = null;
  document.getElementById('npTitle').textContent = 'Sin reproducción';
  document.getElementById('npArtist').textContent = 'Abre una carpeta para comenzar';
  document.getElementById('npFormat').textContent = '—';
  renderPanel();
  document.getElementById('settingsBg').classList.remove('show');
  toast('Biblioteca limpiada');
}

// ── AJUSTES Y TEMAS ───────────────────────────────────────
const settingsState = { resume: true, crossfade: false, normalize: false, viz: true };

function toggleSetting(btn, key) {
  settingsState[key] = !settingsState[key];
  btn.classList.toggle('on', settingsState[key]);
  if (key === 'viz') {
    document.querySelector('.viz-wrap').style.display = settingsState.viz ? 'block' : 'none';
  }
  toast(key.charAt(0).toUpperCase() + key.slice(1) + (settingsState[key] ? ' activado' : ' desactivado'));
}

const THEME_DARK = {
  '--bg': '#000000', '--surface': '#030103', '--surface2': '#121210', '--surface3': '#2E2E2B',
  '--text': '#F2F1EE', '--text2': '#9B9B96', '--text3': '#5A5A56',
  '--border': '#2A2A27', '--border2': '#3A3A36'
};
const THEME_LIGHT = {
  '--bg': '#F7F7F5', '--surface': '#FFFFFF', '--surface2': '#F2F1EE', '--surface3': '#ECEAE6',
  '--text': '#1A1A18', '--text2': '#6B6B67', '--text3': '#ABABAB',
  '--border': '#E4E2DD', '--border2': '#D0CEC9'
};

function applyTheme(theme) {
  const colors = (theme === 'light') ? THEME_LIGHT : THEME_DARK;
  const r = document.documentElement;
  Object.keys(colors).forEach(k => r.style.setProperty(k, colors[k]));
  const sw = document.getElementById('sw-dark');
  if (sw) sw.classList.toggle('on', theme === 'dark');
  try { localStorage.setItem('brumm_theme', theme); } catch (e) {}
}

function toggleDarkMode() {
  const current = localStorage.getItem('brumm_theme') || 'dark';
  const next = (current === 'dark') ? 'light' : 'dark';
  applyTheme(next);
  toast(next === 'dark' ? '🌙 Modo oscuro' : '☀️ Modo claro');
}

applyTheme(localStorage.getItem('brumm_theme') || 'dark');

// ── INICIALIZACIÓN ────────────────────────────────────────
buildEQUI();
drawArt(0);
renderPanel();
checkProStatus();

// ── PRO & INTEGRACIÓN ONLINE ──────────────────────────────
const JAMENDO_ID = 'a1eb6b2d';
let isPro = false;

function showProModal() { document.getElementById('modalBg').classList.add('show'); }

function checkProStatus() {
  try {
    const k = localStorage.getItem('brumm_pro_key');
    if (k && k.length > 8) { isPro = true; applyProUI(); }
  } catch (e) {}
}

function showLicenseInput() {
  const w = document.getElementById('licenseInputWrap');
  w.style.display = w.style.display === 'none' ? 'flex' : 'none';
  w.style.flexDirection = 'column';
}

function activateLicense() {
  const key = document.getElementById('licenseKey').value.trim().toUpperCase();
  if (key.length < 8) { toast('Clave inválida'); return; }
  try { localStorage.setItem('brumm_pro_key', key); } catch (e) {}
  applyProUI();
  document.getElementById('modalBg').classList.remove('show');
  document.getElementById('settingsProStatus').textContent = '✦ Pro Activo';
  toast('¡Pro Activado! Bienvenido.');
}

function applyProUI() {
  isPro = true;
  document.getElementById('proBtn').textContent = '✦ Pro Activo';
  document.getElementById('proBtn').style.background = '#16a34a';
  document.getElementById('settingsProStatus').textContent = '✦ Pro Activo';
}

// ── CATÁLOGO JAMENDO ──────────────────────────────────────
const JAMENDO = 'https://api.jamendo.com/v3.0';
const GENRES = ['lounge', 'classical', 'electronic', 'jazz', 'pop', 'rock', 'hiphop', 'relaxation', 'songwriter', 'world', 'metal', 'soundtrack'];
let catalogTab = 'search';
let jamendoResults = [];
let catalogSource = null;
let curJamendoIdx = 0;
let jamendoPage = 1;
let jamendoLastQuery = '';
let jamendoLastIsGenre = false;
let jamendoHasMore = true;

function activateSource(btn, src) {
  document.querySelectorAll('.src').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('catalogPanel').style.display = 'none';
  document.getElementById('archivePanel').style.display = 'none';
  if (src === 'folder' || src === 'usb') {
    openFolder();
  } else if (src === 'catalog') {
    if (!isPro) { showProModal(); document.getElementById('src-folder').classList.add('active'); btn.classList.remove('active'); return; }
    document.getElementById('catalogPanel').style.display = 'flex';
    loadGenres();
    loadJamendoNew();
  } else if (src === 'archive') {
    if (!isPro) { showProModal(); document.getElementById('src-folder').classList.add('active'); btn.classList.remove('active'); return; }
    document.getElementById('archivePanel').style.display = 'flex';
    renderArchiveCats();
  }
}

function switchCatalogTab(tab) {
  catalogTab = tab;
  document.querySelectorAll('[id^="ctab-"]').forEach(t => t.classList.remove('active'));
  document.getElementById('ctab-' + tab).classList.add('active');
  const searchRow = document.getElementById('catalogSearchRow');
  const genreBar = document.getElementById('genreBar');
  if (tab === 'search') { searchRow.style.display = 'flex'; genreBar.style.display = 'none'; searchJamendo(''); }
  else if (tab === 'genres') { searchRow.style.display = 'none'; genreBar.style.display = 'flex'; loadGenres(); }
  else if (tab === 'new') { searchRow.style.display = 'none'; genreBar.style.display = 'none'; loadJamendoNew(); }
}

function loadGenres() {
  const bar = document.getElementById('genreBar');
  bar.style.display = 'flex';
  bar.innerHTML = GENRES.map(g =>
    `<button onclick="searchByGenre('${g}')"
      style="padding:4px 10px;border:1px solid var(--border);border-radius:20px;font-size:11px;background:var(--surface);cursor:pointer;font-family:var(--font);color:var(--text2);text-transform:capitalize;">
      ${g}</button>`
  ).join('');
}

function searchByGenre(genre) {
  document.getElementById('catalogSearch').value = genre;
  searchJamendo(genre, true);
}

async function loadJamendoNew() {
  jamendoPage = 1; jamendoResults = []; jamendoHasMore = true;
  jamendoLastQuery = ''; jamendoLastIsGenre = false;
  setCatalogLoading();
  const limit = document.getElementById('jamendoPageSize')?.value || 30;
  try {
    const url = `${JAMENDO}/tracks/?client_id=${JAMENDO_ID}&format=json&limit=${limit}&offset=0&order=releasedate_desc&include=musicinfo&imagesize=100`;
    const data = await (await fetch(url)).json();
    jamendoResults = data.results || [];
    jamendoHasMore = jamendoResults.length >= limit;
    renderCatalog();
  } catch (e) { setCatalogError(); }
}

async function searchJamendo(query, isGenre) {
  const q = query !== undefined ? query : document.getElementById('catalogSearch').value.trim();
  const limit = parseInt(document.getElementById('jamendoPageSize')?.value || 30);
  jamendoPage = 1; jamendoResults = []; jamendoHasMore = true;
  jamendoLastQuery = q; jamendoLastIsGenre = !!isGenre;
  setCatalogLoading();
  await _fetchJamendo(q, isGenre, 1, limit, false);
}

async function loadMoreJamendo() {
  const limit = parseInt(document.getElementById('jamendoPageSize')?.value || 30);
  jamendoPage++;
  await _fetchJamendo(jamendoLastQuery, jamendoLastIsGenre, jamendoPage, limit, true);
}

async function _fetchJamendo(q, isGenre, page, limit, append) {
  const offset = (page - 1) * limit;
  try {
    let url;
    if (isGenre && q) {
      url = `${JAMENDO}/tracks/?client_id=${JAMENDO_ID}&format=json&limit=${limit}&offset=${offset}&tags=${encodeURIComponent(q)}&featured=1&groupby=artist_id&include=musicinfo&imagesize=100`;
    } else if (q) {
      url = `${JAMENDO}/tracks/?client_id=${JAMENDO_ID}&format=json&limit=${limit}&offset=${offset}&search=${encodeURIComponent(q)}&include=musicinfo&imagesize=100`;
    } else {
      url = `${JAMENDO}/tracks/?client_id=${JAMENDO_ID}&format=json&limit=${limit}&offset=${offset}&order=popularity_total&featured=1&include=musicinfo&imagesize=100`;
    }
    const data = await (await fetch(url)).json();
    const results = data.results || [];
    if (append) jamendoResults = [...jamendoResults, ...results];
    else jamendoResults = results;
    jamendoHasMore = results.length >= limit;
    renderCatalog();
  } catch (e) { setCatalogError(); }
}

function setCatalogLoading() {
  document.getElementById('catalogBody').innerHTML =
    '<div class="empty-state"><strong>Buscando…</strong>Consultando catálogo en línea</div>';
}

function setCatalogError() {
  document.getElementById('catalogBody').innerHTML =
    '<div class="empty-state"><strong>Error de conexión</strong>Comprueba tu conexión a internet e intenta nuevamente</div>';
}

function renderCatalog() {
  const body = document.getElementById('catalogBody');
  if (!jamendoResults.length) {
    body.innerHTML = '<div class="empty-state"><strong>Sin resultados</strong>Intenta con otro término o género</div>';
    return;
  }
  const playAllBtn = `<div style="padding:8px 14px;border-bottom:1px solid var(--border);">
    <button onclick="playJamendoTrack(0)" class="btn-action" style="width:100%;">
      ▶ Reproducir todo (${jamendoResults.length} pistas)
    </button>
  </div>`;
  const loadMoreBtn = jamendoHasMore ? `
    <div style="padding:10px 14px;text-align:center;">
      <button onclick="loadMoreJamendo()" class="btn-secondary">
        Cargar más…
      </button>
    </div>` : `<div style="padding:10px;text-align:center;font-size:11px;color:var(--text3);">Fin de los resultados</div>`;
  body.innerHTML = playAllBtn + jamendoResults.map((t, i) => {
    const active = catalogSource && curJamendoIdx === i;
    return `<div class="track-row${active ? ' active' : ''}" onclick="playJamendoTrack(${i})">
      <div class="tr-n${active ? ' playing' : ''}">${active ? '♪' : i + 1}</div>
      ${t.image ? `<img src="${t.image}" width="32" height="32" style="border-radius:5px;flex-shrink:0;object-fit:cover;" onerror="this.style.display='none'">` : ''}
      <div class="tr-info">
        <div class="tr-title${active ? ' playing' : ''}">${esc(t.name)}</div>
        <div class="tr-sub">${esc(t.artist_name)}</div>
      </div>
      <div class="tr-dur">${fmtTime(t.duration)}</div>
    </div>`;
  }).join('') + loadMoreBtn;
  const activeEl = body.querySelector('.track-row.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

async function playJamendoTrack(idx) {
  if (AC.state === 'suspended') AC.resume();
  const t = jamendoResults[idx];
  if (!t || !t.audio) { toast('No se encontró URL de audio'); return; }
  if (isPlaying) pausePlayback();
  pausedAt = 0;
  catalogSource = t;
  curJamendoIdx = idx;
  document.getElementById('npTitle').textContent = t.name;
  document.getElementById('npArtist').textContent = t.artist_name + ' · Jamendo';
  document.getElementById('npFormat').textContent = 'MP3 · Jamendo CC';
  document.getElementById('timeDur').textContent = fmtTime(t.duration);
  document.getElementById('playBtn').classList.add('loading');
  document.getElementById('playBtn').textContent = '…';
  drawArt(idx);
  updateMediaSession(t.name, t.artist_name, 'Jamendo', t.image || null);
  if (t.image) {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.getElementById('artCanvas');
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 64, 64);
    };
    img.src = t.image;
  }
  renderCatalog();
  toast(`Cargando: ${t.name}`);
  try {
    const resp = await fetch(t.audio);
    const ab = await resp.arrayBuffer();
    audioBuffer = await AC.decodeAudioData(ab);
    document.getElementById('playBtn').classList.remove('loading');
    playFrom(0);
    if (lyricsVisible) fetchLyrics(t.artist_name, t.name);
  } catch (e) {
    toast('No se pudo cargar esta pista');
    document.getElementById('playBtn').classList.remove('loading');
    document.getElementById('playBtn').textContent = '▶';
  }
}

// ── PANTALLA COMPLETA & ACTUALIZACIONES ───────────────────
function toggleFullscreen() {
  const vid = document.getElementById('videoEl');
  const wrap = document.getElementById('videoWrap');
  const el = document.fullscreenElement || document.webkitFullscreenElement;
  if (el) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const target = vid.requestFullscreen ? vid : wrap;
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (req) req.call(target).catch(() => {});
  }
}

function checkForUpdates() {
  const status = document.getElementById('updateStatus');
  status.textContent = '…';
  if (!('serviceWorker' in navigator)) { status.textContent = 'No disponible'; return; }
  navigator.serviceWorker.getRegistration().then(reg => {
    if (!reg) {
      status.textContent = 'Recargando…';
      window.location.reload(true);
      return;
    }
    reg.update().then(() => {
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        status.textContent = '↻ Actualizando…';
        toast('Actualizando — recargando en 2 segundos…');
        setTimeout(() => window.location.reload(true), 2000);
      } else if (reg.installing) {
        status.textContent = '↻ Instalando…';
        toast('Instalando actualización…');
        reg.installing.addEventListener('statechange', ev => {
          if (ev.target.state === 'installed') {
            ev.target.postMessage({ type: 'SKIP_WAITING' });
            setTimeout(() => window.location.reload(true), 1500);
          }
        });
      } else {
        status.textContent = '✓ Al día';
        toast('Ya tienes la versión más reciente');
        setTimeout(() => status.textContent = '→', 3000);
      }
    });
  });
}

// ── LETRAS SINCRONIZADAS (LRC) ───────────────────────────
let lyricsVisible = false;
let lrcLines = [];
let plainLyrics = '';
let lyricsMode = 'none';
let lyricsRAF = null;

function toggleLyrics() {
  lyricsVisible = !lyricsVisible;
  const panel = document.getElementById('lyricsPanel');
  const btn = document.getElementById('lyricsBtn');
  panel.style.display = lyricsVisible ? 'block' : 'none';
  btn.classList.toggle('on', lyricsVisible);
  if (lyricsVisible && lrcLines.length === 0 && !plainLyrics) {
    fetchLyrics();
  }
}

async function fetchLyrics(artist, title) {
  const a = artist || document.getElementById('npArtist').textContent.replace(' · Jamendo', '').trim();
  const t = title || document.getElementById('npTitle').textContent.trim();
  if (!a || !t || a === 'Abre una carpeta para comenzar') return;

  lrcLines = []; plainLyrics = ''; lyricsMode = 'none';
  document.getElementById('lyricsBody').innerHTML = '<div class="lyrics-empty">Buscando letra…</div>';
  document.getElementById('lyricsMeta').textContent = `${t} — ${a}`;

  try {
    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(a)}&track_name=${encodeURIComponent(t)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();

    if (data.syncedLyrics) {
      lrcLines = parseLRC(data.syncedLyrics);
      lyricsMode = 'lrc';
      renderLRC();
      startLRCSync();
    } else if (data.plainLyrics) {
      plainLyrics = data.plainLyrics;
      lyricsMode = 'plain';
      renderPlain();
    } else {
      throw new Error('empty');
    }
  } catch (e) {
    document.getElementById('lyricsBody').innerHTML =
      '<div class="lyrics-empty">No se encontró letra para esta pista</div>';
  }
}

function parseLRC(lrc) {
  return lrc.split('\n')
    .map(line => {
      const m = line.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
      if (!m) return null;
      return { time: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() };
    })
    .filter(Boolean);
}

function renderLRC() {
  const body = document.getElementById('lyricsBody');
  if (!lrcLines.length) return;
  body.innerHTML = lrcLines.map((l, i) =>
    `<div class="lyric-line" id="ll${i}" onclick="seekToLine(${l.time})">${esc(l.text) || '·'}</div>`
  ).join('');
}

function renderPlain() {
  const body = document.getElementById('lyricsBody');
  body.innerHTML = plainLyrics
    .split('\n')
    .map(l => `<div class="lyric-line">${esc(l) || '<br>'}</div>`)
    .join('');
}

function seekToLine(t) {
  if (!audioBuffer) return;
  pausePlayback();
  pausedAt = t;
  playFrom(t);
}

function startLRCSync() {
  if (lyricsRAF) cancelAnimationFrame(lyricsRAF);
  let lastIdx = -1;
  function tick() {
    if (!isPlaying || lyricsMode !== 'lrc') { lyricsRAF = null; return; }
    const cur = AC.currentTime - startedAt;
    let idx = lrcLines.findIndex((l, i) => {
      const next = lrcLines[i + 1];
      return cur >= l.time && (!next || cur < next.time);
    });
    if (idx !== -1 && idx !== lastIdx) {
      document.querySelectorAll('.lyric-line').forEach(el => el.classList.remove('active'));
      const el = document.getElementById('ll' + idx);
      if (el) {
        el.classList.add('active');
        if (lyricsVisible) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      lastIdx = idx;
    }
    lyricsRAF = requestAnimationFrame(tick);
  }
  lyricsRAF = requestAnimationFrame(tick);
}

function stopLRCSync() {
  if (lyricsRAF) { cancelAnimationFrame(lyricsRAF); lyricsRAF = null; }
}

// ── INTERNET ARCHIVE ─────────────────────────────────────
const ARCHIVE_CATS = [
  { label: '🎬 Cine Clásico', q: 'mediatype:movies subject:"feature film" year:[1900 TO 1970]', sort: 'downloads desc' },
  { label: '🎥 Documentales', q: 'mediatype:movies subject:documentary', sort: 'downloads desc' },
  { label: '🎵 Conciertos', q: 'mediatype:movies subject:concert', sort: 'downloads desc' },
  { label: '📺 Noticieros', q: 'mediatype:movies subject:news', sort: 'date desc' },
  { label: '🎞 Cortometrajes', q: 'mediatype:movies subject:"short film"', sort: 'downloads desc' },
  { label: '🎭 Animación', q: 'mediatype:movies subject:animation OR subject:cartoon', sort: 'downloads desc' },
  { label: '📡 TV Clásica', q: 'mediatype:movies subject:television', sort: 'downloads desc' },
  { label: '🔬 Ciencia', q: 'mediatype:movies subject:science OR subject:nature', sort: 'downloads desc' },
];

let archiveTab = 'cats';
let archiveResults = [];
let curArchiveIdx = 0;
let archiveSource = null;
let archivePage = 1;
let archiveLastQuery = '';
let archiveLastSort = 'downloads desc';
let archiveHasMore = true;

function switchArchiveTab(tab) {
  archiveTab = tab;
  document.querySelectorAll('[id^="atab-"]').forEach(t => t.classList.remove('active'));
  document.getElementById('atab-' + tab).classList.add('active');
  const catGrid = document.getElementById('archiveCatGrid');
  const searchRow = document.getElementById('archiveSearchRow');
  const body = document.getElementById('archiveBody');
  if (tab === 'cats') {
    catGrid.style.display = 'grid';
    searchRow.style.display = 'none';
    body.style.display = 'none';
    renderArchiveCats();
  } else {
    catGrid.style.display = 'none';
    searchRow.style.display = 'flex';
    body.style.display = 'block';
    body.innerHTML = '<div class="empty-state">Escribe un término para buscar en el repositorio.</div>';
  }
}

function renderArchiveCats() {
  const grid = document.getElementById('archiveCatGrid');
  grid.innerHTML = ARCHIVE_CATS.map((c, i) =>
    `<button onclick="loadArchiveCat(${i})" class="btn-secondary" style="text-align:left;padding:10px 8px;border-radius:10px;">${c.label}</button>`
  ).join('');
}

async function loadArchiveCat(idx) {
  const cat = ARCHIVE_CATS[idx];
  document.getElementById('archiveCatGrid').style.display = 'none';
  const body = document.getElementById('archiveBody');
  body.style.display = 'block';
  body.innerHTML = `<div class="empty-state"><strong>Cargando ${cat.label}…</strong></div>`;
  archivePage = 1; archiveResults = []; archiveHasMore = true;
  await fetchArchive(cat.q, cat.sort, false);
}

async function searchArchive() {
  const q = document.getElementById('archiveSearch').value.trim();
  if (!q) return;
  const body = document.getElementById('archiveBody');
  body.style.display = 'block';
  body.innerHTML = '<div class="empty-state"><strong>Buscando…</strong></div>';
  archivePage = 1; archiveResults = []; archiveHasMore = true;
  await fetchArchive(`mediatype:movies AND (title:(${q}) OR creator:(${q}))`, 'downloads desc', false);
}

async function fetchArchive(query, sort, append) {
  const rows = parseInt(document.getElementById('archivePageSize')?.value || 30);
  const page = append ? archivePage : 1;
  archiveLastQuery = query;
  archiveLastSort = sort;
  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}`
      + `&fl[]=identifier,title,creator,year,description,runtime,downloads`
      + `&sort[]=${encodeURIComponent(sort)}&rows=${rows}&page=${page}&output=json`;
    const data = await (await fetch(url)).json();
    const results = (data.response?.docs || []).filter(d => d.identifier);
    if (append) archiveResults = [...archiveResults, ...results];
    else archiveResults = results;
    archiveHasMore = results.length >= rows;
    renderArchiveResults();
  } catch (e) {
    document.getElementById('archiveBody').innerHTML =
      '<div class="empty-state"><strong>Error de conexión</strong>Comprueba tu internet</div>';
  }
}

async function loadMoreArchive() {
  archivePage++;
  const body = document.getElementById('archiveBody');
  const btn = body.querySelector('.load-more-btn');
  if (btn) btn.textContent = 'Cargando…';
  await fetchArchive(archiveLastQuery, archiveLastSort, true);
}

function renderArchiveResults() {
  const body = document.getElementById('archiveBody');
  if (!archiveResults.length) {
    body.innerHTML = '<div class="empty-state"><strong>Sin resultados</strong>Intenta con otra búsqueda</div>';
    return;
  }
  const header = `<div style="padding:8px 14px;border-bottom:1px solid var(--border);display:flex;gap:6px;align-items:center;">
    <button onclick="backToArchiveCats()" class="btn-secondary">← Volver</button>
    <button onclick="playArchiveTrack(0)" class="btn-action" style="flex:1;">
      ▶ Reproducir todo (${archiveResults.length})</button>
  </div>`;
  const loadMoreBtn = archiveHasMore ? `
    <div style="padding:10px 14px;text-align:center;">
      <button class="load-more-btn btn-secondary" onclick="loadMoreArchive()">
        Cargar más…
      </button>
    </div>` : `<div style="padding:10px;text-align:center;font-size:11px;color:var(--text3);">Fin de los resultados</div>`;
  body.innerHTML = header + archiveResults.map((item, i) => {
    const thumb = `https://archive.org/services/img/${item.identifier}`;
    const year = item.year ? ` · ${item.year}` : '';
    const active = archiveSource && curArchiveIdx === i;
    return `<div class="track-row${active ? ' active' : ''}" onclick="playArchiveTrack(${i})">
      <div class="tr-n${active ? ' playing' : ''}">${active ? '♪' : i + 1}</div>
      <img src="${thumb}" width="44" height="30"
        style="border-radius:4px;flex-shrink:0;object-fit:cover;background:var(--surface2);"
        onerror="this.style.display='none'">
      <div class="tr-info">
        <div class="tr-title${active ? ' playing' : ''}">${esc(item.title || item.identifier)}</div>
        <div class="tr-sub">${esc((item.creator || 'Archive.org') + year)}</div>
      </div>
      ${item.runtime ? `<div class="tr-dur">${esc(item.runtime)}</div>` : ''}
    </div>`;
  }).join('') + loadMoreBtn;
}

function backToArchiveCats() {
  document.getElementById('archiveCatGrid').style.display = 'grid';
  document.getElementById('archiveBody').style.display = 'none';
  archiveResults = [];
}

async function playArchiveTrack(idx) {
  if (AC.state === 'suspended') AC.resume();
  const item = archiveResults[idx];
  if (!item) return;
  curArchiveIdx = idx;
  archiveSource = item;
  catalogSource = null;

  document.getElementById('npTitle').textContent = item.title || item.identifier;
  document.getElementById('npArtist').textContent = (item.creator || 'Archive.org') + (item.year ? ` · ${item.year}` : '');
  document.getElementById('npFormat').textContent = 'Archive.org · Dominio público';
  document.getElementById('playBtn').classList.add('loading');
  document.getElementById('playBtn').textContent = '…';
  drawArt(idx);

  const thumb = `https://archive.org/services/img/${item.identifier}`;
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => { const c = document.getElementById('artCanvas'); c.getContext('2d').drawImage(img, 0, 0, 64, 64); };
  img.src = thumb;

  toast(`Cargando: ${item.title || item.identifier}`);
  try {
    const meta = await (await fetch(`https://archive.org/metadata/${item.identifier}`)).json();
    const files = meta.files || [];
    const videoExts = ['mp4', 'ogv', 'mpeg', 'mpg', 'avi', 'mov', 'webm'];
    let videoFile = files.find(f => f.name?.toLowerCase().endsWith('.mp4') && !f.name.includes('512') && !f.name.includes('thumb'));
    if (!videoFile) videoFile = files.find(f => videoExts.some(e => f.name?.toLowerCase().endsWith('.' + e)));
    if (!videoFile) { toast('No se encontró video en este recurso'); document.getElementById('playBtn').classList.remove('loading'); document.getElementById('playBtn').textContent = '▶'; return; }

    const videoURL = `https://archive.org/download/${item.identifier}/${videoFile.name}`;
    if (isPlaying) pausePlayback();
    pausedAt = 0;
    setVideoMode(true);
    document.getElementById('videoBadge').textContent = videoFile.name.split('.').pop().toUpperCase();
    const vid = document.getElementById('videoEl');
    vid._archiveURL = videoURL;
    vid.src = videoURL;
    vid.load();
    if (!vid._connected) {
      const src = AC.createMediaElementSource(vid);
      src.connect(eqEnabled ? eqFilters[0] : gainNode);
      vid._connected = true;
    }
    vid.play().then(() => {
      isPlaying = true;
      audioBuffer = { duration: vid.duration || 0 };
      document.getElementById('playBtn').classList.remove('loading');
      document.getElementById('playBtn').textContent = '⏸';
      updateMediaSessionState(true);
    }).catch(() => {
      toast('No se pudo reproducir el título seleccionado');
      document.getElementById('playBtn').classList.remove('loading');
      document.getElementById('playBtn').textContent = '▶';
    });
    renderArchiveResults();
  } catch (e) {
    toast('Error al consultar el video');
    document.getElementById('playBtn').classList.remove('loading');
    document.getElementById('playBtn').textContent = '▶';
  }
}

// ── VENTANA ACERCA DE ─────────────────────────────────────
function toggleAbout() {
  const el = document.getElementById('aboutPopup');
  el.classList.toggle('show');
}

document.addEventListener('click', e => {
  const popup = document.getElementById('aboutPopup');
  const btn = document.getElementById('aboutBtn');
  if (popup && popup.classList.contains('show') && !popup.contains(e.target) && e.target !== btn) {
    popup.classList.remove('show');
  }
});
