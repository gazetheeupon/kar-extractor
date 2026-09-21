const $ = (id) => document.getElementById(id);

let currentParsed = null;
let currentFileBase = 'karaoke';

let playState = { playing: false, startedAt: null, elapsedAtPause: 0, raf: null, currentLineIndex: -1 };

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resetPlayback() {
  playState.playing = false;
  playState.startedAt = null;
  playState.elapsedAtPause = 0;
  playState.currentLineIndex = -1;
  if (playState.raf) cancelAnimationFrame(playState.raf);
  playState.raf = null;
  $('playBtn').textContent = 'Play preview';
  $('elapsedTime').textContent = '00:00.00';
  document.querySelectorAll('#linesList .line').forEach((el) => el.classList.remove('current', 'past'));
}

async function handleFile(file) {
  $('fname').textContent = file.name;
  currentFileBase = (file.name || 'karaoke').replace(/\.(kar|mid|midi)$/i, '');
  setStatus('Reading and parsing…');
  ['overviewCard', 'metadataCard', 'previewCard', 'exportCard', 'warningsCard'].forEach((id) => { $(id).style.display = 'none'; });
  currentParsed = null;
  resetPlayback();
  try {
    const buf = await file.arrayBuffer();
    const parsed = KarParser.parseMidiBuffer(buf);
    currentParsed = parsed;
    render(parsed);
    setStatus(`Parsed ${parsed.lyricEvents.length} lyric event(s) across ${parsed.trackCount} track(s).`);
  } catch (err) {
    setStatus((err && err.message) || String(err), true);
  }
}

function render(parsed) {
  renderOverview(parsed);
  renderMetadata(parsed);
  renderPreview(parsed);
  if (parsed.lines.length) $('exportCard').style.display = '';
  if (parsed.warnings.length) {
    $('warningsCard').style.display = '';
    $('warningsList').innerHTML = parsed.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  }
}

function renderOverview(parsed) {
  $('overviewCard').style.display = '';
  $('overviewBody').innerHTML = `
    <table class="kv">
      <tr><td>Format</td><td>Type ${parsed.format} (${parsed.format === 0 ? 'single multi-channel track' : parsed.format === 1 ? 'multiple simultaneous tracks' : 'multiple independent sequences'})</td></tr>
      <tr><td>Tracks</td><td>${parsed.trackCount}</td></tr>
      <tr><td>Ticks per quarter note</td><td>${parsed.ppq}</td></tr>
      <tr><td>Tempo changes</td><td>${parsed.tempoSegments.length}</td></tr>
      <tr><td>Duration</td><td>${KarParser.formatTime(parsed.durationSeconds)}</td></tr>
      <tr><td>Lyric events</td><td>${parsed.lyricEvents.length}</td></tr>
      <tr><td>Lyric lines</td><td>${parsed.lines.length}</td></tr>
    </table>
  `;
}

function renderMetadata(parsed) {
  const m = parsed.metadata;
  const hasAny = m.isKarFile || m.language || m.titleLines.length || m.other.length || parsed.copyright || parsed.trackNames.length;
  if (!hasAny) return;
  $('metadataCard').style.display = '';
  $('metadataBody').innerHTML = `
    <table class="kv">
      ${m.isKarFile ? `<tr><td>Soft Karaoke file</td><td>Yes ("@KMIDI KARAOKE FILE" marker present)</td></tr>` : ''}
      ${m.titleLines.length ? `<tr><td>Title / credit lines</td><td>${m.titleLines.map(escapeHtml).join('<br>')}</td></tr>` : ''}
      ${m.language ? `<tr><td>Language</td><td>${escapeHtml(m.language)}</td></tr>` : ''}
      ${parsed.copyright ? `<tr><td>Copyright</td><td>${escapeHtml(parsed.copyright)}</td></tr>` : ''}
      ${parsed.trackNames.length ? `<tr><td>Track names</td><td>${parsed.trackNames.map(escapeHtml).join(', ')}</td></tr>` : ''}
      ${m.other.length ? `<tr><td>Other metadata</td><td>${m.other.map(escapeHtml).join('<br>')}</td></tr>` : ''}
    </table>
  `;
}

function renderPreview(parsed) {
  if (!parsed.lines.length) return;
  $('previewCard').style.display = '';
  $('linesList').innerHTML = parsed.lines
    .map((line, i) => `<div class="line${line.newPage ? ' newpage' : ''}" id="line-${i}" data-seconds="${line.seconds}">
      <span class="line-time">${KarParser.formatTime(line.seconds)}</span>
      <span class="line-text">${escapeHtml(line.text.trim()) || '&nbsp;'}</span>
    </div>`)
    .join('');
}

function tick() {
  if (!playState.playing || !currentParsed) return;
  const elapsed = playState.elapsedAtPause + (performance.now() - playState.startedAt) / 1000;
  $('elapsedTime').textContent = KarParser.formatTime(elapsed);

  const lines = currentParsed.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].seconds <= elapsed) idx = i;
    else break;
  }
  if (idx !== playState.currentLineIndex) {
    if (playState.currentLineIndex >= 0) {
      const prevEl = $(`line-${playState.currentLineIndex}`);
      if (prevEl) { prevEl.classList.remove('current'); prevEl.classList.add('past'); }
    }
    if (idx >= 0) {
      const el = $(`line-${idx}`);
      if (el) {
        el.classList.add('current');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    playState.currentLineIndex = idx;
  }

  if (elapsed >= currentParsed.durationSeconds + 1) {
    pausePreview();
    return;
  }
  playState.raf = requestAnimationFrame(tick);
}

function playPreview() {
  if (!currentParsed) return;
  playState.playing = true;
  playState.startedAt = performance.now();
  $('playBtn').textContent = 'Pause preview';
  playState.raf = requestAnimationFrame(tick);
}

function pausePreview() {
  if (!playState.playing) return;
  playState.elapsedAtPause += (performance.now() - playState.startedAt) / 1000;
  playState.playing = false;
  $('playBtn').textContent = 'Play preview';
  if (playState.raf) cancelAnimationFrame(playState.raf);
}

function togglePreview() {
  if (playState.playing) pausePreview();
  else playPreview();
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportLrc() {
  if (!currentParsed) return;
  download(`${currentFileBase}.lrc`, KarParser.toLrc(currentParsed), 'text/plain');
}

function exportTxt() {
  if (!currentParsed) return;
  download(`${currentFileBase}.txt`, KarParser.toPlainText(currentParsed), 'text/plain');
}

function exportCleanMidi() {
  if (!currentParsed) return;
  const buf = KarParser.stripLyricsToBuffer(currentParsed);
  download(`${currentFileBase}-no-lyrics.mid`, buf, 'audio/midi');
}

function bindDrop() {
  const dz = $('dropzone');
  const input = $('fileInput');
  const setDrag = (on) => dz.classList.toggle('drag', on);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(true); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(false); }));
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleFile(input.files[0]);
    input.value = '';
  });
}

bindDrop();
$('playBtn').addEventListener('click', togglePreview);
$('resetBtn').addEventListener('click', resetPlayback);
$('exportLrcBtn').addEventListener('click', exportLrc);
$('exportTxtBtn').addEventListener('click', exportTxt);
$('exportCleanMidiBtn').addEventListener('click', exportCleanMidi);
