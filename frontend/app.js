const isGhPages = location.hostname.endsWith("github.io");
const BACKEND_URL = isGhPages ? "https://color-playlist-app.herokuapp.com" : (localStorage.getItem("backend") || location.origin);

const loginBtn = document.getElementById("loginBtn");
const controls = document.getElementById("controls");
const statusEl = document.getElementById("status");
const result = document.getElementById("result");
const gallery = document.getElementById("gallery");
const grid = document.getElementById("grid");
const topnInput = document.getElementById("topn");
const saveBtn = document.getElementById("saveBtn");
const hexInput = document.getElementById("hex");
const swatch = document.getElementById("swatch");
const sourceSel = document.getElementById("source");
const playlistRow = document.getElementById("playlistRow");
const playlistUrl = document.getElementById("playlistUrl");
// Threshold controls removed
const limitInput = document.getElementById("limit");
const buildBtn = document.getElementById("buildBtn");
const colorCanvas = document.getElementById("colorCanvas");
const pickerDot = document.getElementById("pickerDot");

function updateSwatch() {
  const v = (hexInput.value || "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v) || /^#?[0-9a-fA-F]{3}$/.test(v)) {
    const hex = v.startsWith('#') ? v : ('#' + v);
    swatch.style.background = hex;
    // reflect on picker
    try { positionPickerFromHex(hex); } catch {}
  }
}

hexInput.addEventListener("input", updateSwatch);
sourceSel.addEventListener("change", () => {
  playlistRow.classList.toggle("hidden", sourceSel.value !== "playlist");
});

//

loginBtn.addEventListener("click", () => {
  location.href = `${BACKEND_URL}/auth/login`;
});

function authed() {
  const h = location.hash;
  return /authed=1/.test(h);
}

async function fetchJson(url, options = {}) {
  const r = await fetch(url, { credentials: "include", ...options });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials: 'include', signal: controller.signal, ...options });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

async function run() {
  if (authed()) {
    loginBtn.classList.add("hidden");
    controls.classList.remove("hidden");
  }
}

buildBtn.addEventListener("click", async () => {
  result.classList.add("hidden");
  statusEl.textContent = "Fetching tracks...";
  const rawHex = (hexInput.value || "").trim();
  if (!rawHex) { statusEl.textContent = "Enter a hex color"; return; }
  const hex = rawHex.startsWith('#') ? rawHex : ('#' + rawHex);
  const threshold = 0.0;
  let source = sourceSel.value;
  let playlist_url = undefined;
  if (source === 'playlist') {
    playlist_url = (playlistUrl.value || '').trim();
    if (!playlist_url) { statusEl.textContent = "Enter a playlist URL"; return; }
  }

  try {
    const considerLimit = parseInt((limitInput && limitInput.value) || '0', 10);
    const apiLimit = considerLimit === 0 ? 10000 : Math.max(50, considerLimit);
    const tracksResp = await fetchJsonWithTimeout(`${BACKEND_URL}/fetch-tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, playlist_url, limit: apiLimit })
    });
    const tracks = tracksResp.tracks || [];
    statusEl.textContent = `Fetched ${tracks.length} tracks. Analyzing colors...`;
    
    showProgress();
    showInvestigationPanel(tracks.length);
    const startTime = Date.now();
    
    // Simulate real-time progress updates
    let analyzedCount = 0;
    const progressInterval = setInterval(() => {
      if (analyzedCount < tracks.length) {
        analyzedCount++;
        updateInvestigationProgress(analyzedCount, tracks.length, startTime, tracks[analyzedCount - 1]);
        updateProgress(analyzedCount, tracks.length, startTime);
      } else {
        // Stop the interval when we reach the total
        clearInterval(progressInterval);
      }
    }, 200); // Update every 200ms for smooth progress
    
    const analysis = await fetchJsonWithTimeout(`${BACKEND_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hex, threshold, tracks })
    }, 120000); // 2 minutes timeout for analysis
    
    // Ensure progress is complete
    clearInterval(progressInterval);
    updateInvestigationProgress(tracks.length, tracks.length, startTime, tracks[tracks.length - 1]);
    updateProgress(tracks.length, tracks.length, startTime);
    
    // Small delay to show completion
    await new Promise(resolve => setTimeout(resolve, 500));
    
    hideProgress();
    hideInvestigationPanel();
    statusEl.textContent = "";
    renderGallery(analysis.results, hex);
  } catch (e) {
    clearInterval(progressInterval);
    hideProgress();
    hideInvestigationPanel();
    if (e.name === 'AbortError') {
      statusEl.textContent = 'Analysis timed out. Try with fewer tracks or check your connection.';
    } else {
      statusEl.textContent = `Error: ${e.message}`;
    }
  }
});

run();

// ---------- Color Picker ----------
function drawPicker() {
  if (!colorCanvas) return;
  const ctx = colorCanvas.getContext('2d');
  const w = colorCanvas.width;
  const h = colorCanvas.height;
  // Horizontal hue gradient
  const hueGrad = ctx.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 360; i += 60) {
    hueGrad.addColorStop(i/360, `hsl(${i}, 100%, 50%)`);
  }
  ctx.fillStyle = hueGrad;
  ctx.fillRect(0, 0, w, h);
  // Vertical saturation/value overlay
  const whiteGrad = ctx.createLinearGradient(0, 0, 0, h);
  whiteGrad.addColorStop(0, 'rgba(255,255,255,0)');
  whiteGrad.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = whiteGrad;
  ctx.fillRect(0, 0, w, h);
  const blackGrad = ctx.createLinearGradient(0, 0, 0, h);
  blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
  blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = blackGrad;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function getCanvasPos(evt) {
  const rect = colorCanvas.getBoundingClientRect();
  const x = clamp((evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left, 0, rect.width);
  const y = clamp((evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top, 0, rect.height);
  const scaleX = colorCanvas.width / rect.width;
  const scaleY = colorCanvas.height / rect.height;
  return { x: x * scaleX, y: y * scaleY, cssX: x, cssY: y };
}

function positionPicker(xCss, yCss) {
  pickerDot.style.left = `${xCss}px`;
  pickerDot.style.top = `${yCss}px`;
}

function rgbToHex(r,g,b){
  return '#' + [r,g,b].map(v=>{
    const s = v.toString(16).padStart(2,'0');
    return s;
  }).join('');
}

function positionPickerFromHex(hex) {
  // Approximate back to canvas by scanning a small grid for nearest color
  const ctx = colorCanvas.getContext('2d');
  const rect = colorCanvas.getBoundingClientRect();
  const w = colorCanvas.width, h = colorCanvas.height;
  const target = hex.toLowerCase();
  let best = {d: Infinity, x: 0, y: 0};
  const img = ctx.getImageData(0, 0, w, h).data;
  function dist(r,g,b, tr,tg,tb){
    return Math.hypot(r-tr,g-tg,b-tb);
  }
  const tr = parseInt(target.slice(1,3),16);
  const tg = parseInt(target.slice(3,5),16);
  const tb = parseInt(target.slice(5,7),16);
  const step = Math.max(1, Math.floor(Math.min(w,h)/60));
  for (let y=0; y<h; y+=step){
    for (let x=0; x<w; x+=step){
      const idx = (y*w + x)*4;
      const r = img[idx], g = img[idx+1], b = img[idx+2];
      const d = dist(r,g,b,tr,tg,tb);
      if (d < best.d) best = {d, x, y};
    }
  }
  const cssX = best.x * (rect.width / w);
  const cssY = best.y * (rect.height / h);
  positionPicker(cssX, cssY);
}

function pickAt(evt){
  const {x, y, cssX, cssY} = getCanvasPos(evt);
  const ctx = colorCanvas.getContext('2d');
  const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  const hex = rgbToHex(data[0], data[1], data[2]);
  hexInput.value = hex;
  swatch.style.background = hex;
  positionPicker(cssX, cssY);
}

let picking = false;
if (colorCanvas) {
  drawPicker();
  // Initialize picker to current hex if valid
  updateSwatch();
  colorCanvas.addEventListener('mousedown', e=>{ picking=true; pickAt(e); });
  colorCanvas.addEventListener('mousemove', e=>{ if(picking) pickAt(e); });
  window.addEventListener('mouseup', ()=>{ picking=false; });
  colorCanvas.addEventListener('touchstart', e=>{ picking=true; pickAt(e); e.preventDefault(); });
  colorCanvas.addEventListener('touchmove', e=>{ if(picking) pickAt(e); e.preventDefault(); });
  window.addEventListener('touchend', ()=>{ picking=false; });
}

// ---------- Results Gallery and Save ----------
let lastResults = [];
let currentTopN = 100;
function renderGallery(results, hex) {
  const filtered = results.filter(r => (100 - r.distance) > 0.0);
  lastResults = filtered;
  grid.innerHTML = '';
  gallery.classList.remove('hidden');
  filtered.forEach((r, idx) => {
    const t = r.track;
    const img = t.image_url ? `<img src="${t.image_url}" alt="${t.name}">` : '';
    const similarity = Math.max(0, Math.min(100, (100 - r.distance))).toFixed(1);
    const el = document.createElement('div');
    el.className = 'tile';
    if (idx < currentTopN) el.classList.add('included');
    el.innerHTML = `<div class="badge">${idx+1}</div>${img}<div class="meta"><div class="name">${t.name}</div><div>${t.artists}</div><div>Similarity: ${similarity}%</div></div>`;
    el.addEventListener('click', ()=>{
      currentTopN = idx + 1;
      topnInput.value = String(currentTopN);
      refreshIncluded();
    });
    grid.appendChild(el);
  });
  topnInput.value = String(Math.min(currentTopN, filtered.length));
  topnInput.oninput = () => { currentTopN = Math.max(1, Math.min(filtered.length, parseInt(topnInput.value||'1',10))); refreshIncluded(); };
  saveBtn.onclick = () => openSavePanel(hex);
}

function refreshIncluded(){
  const tiles = grid.querySelectorAll('.tile');
  tiles.forEach((tile, i)=>{
    tile.classList.toggle('included', i < currentTopN);
  });
}

const savePanel = document.getElementById('savePanel');
const chosenSwatch = document.getElementById('chosenSwatch');
const playlistNameInput = document.getElementById('playlistName');
const confirmSaveBtn = document.getElementById('confirmSaveBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const investigationPanel = document.getElementById('investigationPanel');
const totalTracksEl = document.getElementById('totalTracks');
const analyzedTracksEl = document.getElementById('analyzedTracks');
const currentTrackEl = document.getElementById('currentTrack');
const timeElapsedEl = document.getElementById('timeElapsed');
const timeRemainingEl = document.getElementById('timeRemaining');
const currentImageEl = document.getElementById('currentImage');
const currentDetailsEl = document.getElementById('currentDetails');
const trackNameEl = document.getElementById('trackName');
const artistNameEl = document.getElementById('artistName');
const colorInfoEl = document.getElementById('colorInfo');

function updateProgress(current, total, startTime) {
  const progress = (current / total) * 100;
  progressFill.style.width = `${progress}%`;
  
  if (current > 0) {
    const elapsed = Date.now() - startTime;
    const rate = current / (elapsed / 1000);
    const remaining = (total - current) / rate;
    const remainingMinutes = Math.ceil(remaining / 60);
    progressText.textContent = `Analyzing ${current}/${total} tracks (${remainingMinutes} min remaining)`;
  }
}

function showInvestigationPanel(totalTracks) {
  investigationPanel.classList.remove('hidden');
  totalTracksEl.textContent = totalTracks;
  analyzedTracksEl.textContent = '0';
  currentTrackEl.textContent = '1';
  timeElapsedEl.textContent = '0s';
  timeRemainingEl.textContent = '-';
  
  // Reset current analysis display
  currentImageEl.innerHTML = '<div style="color: var(--muted); font-size: 12px;">Loading...</div>';
  trackNameEl.textContent = 'Selecting next track...';
  artistNameEl.textContent = '-';
  colorInfoEl.textContent = '-';
}

function updateInvestigationProgress(current, total, startTime, currentTrack) {
  const elapsed = Date.now() - startTime;
  const elapsedSeconds = Math.floor(elapsed / 1000);
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const elapsedDisplay = elapsedMinutes > 0 ? `${elapsedMinutes}m ${elapsedSeconds % 60}s` : `${elapsedSeconds}s`;
  
  analyzedTracksEl.textContent = current;
  currentTrackEl.textContent = current + 1;
  timeElapsedEl.textContent = elapsedDisplay;
  
  if (current > 0) {
    const rate = current / (elapsed / 1000);
    const remaining = (total - current) / rate;
    const remainingMinutes = Math.ceil(remaining / 60);
    timeRemainingEl.textContent = `${remainingMinutes}m`;
  }
  
  // Update current track display
  if (currentTrack) {
    if (currentTrack.image_url) {
      currentImageEl.innerHTML = `<img src="${currentTrack.image_url}" alt="${currentTrack.name}">`;
    } else {
      currentImageEl.innerHTML = '<div style="color: var(--muted); font-size: 12px;">No Image</div>';
    }
    trackNameEl.textContent = currentTrack.name;
    artistNameEl.textContent = currentTrack.artists;
    colorInfoEl.textContent = 'Analyzing dominant color...';
  }
}

function hideInvestigationPanel() {
  investigationPanel.classList.add('hidden');
}

function showProgress() {
  progressContainer.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = 'Analyzing tracks...';
}

function hideProgress() {
  progressContainer.classList.add('hidden');
}

function openSavePanel(hex){
  chosenSwatch.style.background = hex;
  playlistNameInput.value = `Color Playlist - ${hex.toUpperCase()}`;
  savePanel.classList.remove('hidden');
  confirmSaveBtn.onclick = () => saveTopN(hex);
}

async function saveTopN(hex) {
  const n = currentTopN;
  const sorted = [...lastResults].sort((a,b)=>a.distance-b.distance).slice(0, n);
  const uris = sorted.map(r => r.track.uri);
  if (uris.length === 0) { statusEl.textContent = 'Nothing to save'; return; }
  statusEl.textContent = 'Creating playlist...';
  try {
    const buildResp = await fetchJson(`${BACKEND_URL}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hex, threshold: 100, tracks: sorted.map(r=>r.track), top_n: n, playlist_name: playlistNameInput.value })
    });
    const url = buildResp.playlist_url;
    statusEl.textContent = '';
    result.classList.remove('hidden');
    result.innerHTML = `<div class="row">Created <a target="_blank" rel="noopener" href="${url}">playlist</a> with ${buildResp.added} tracks.</div>`;
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}


