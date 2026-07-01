'use strict';

// File Explorer + editor window. A lightweight VSCode-style two-pane view: a
// lazily-expanded file tree on the left, a tabbed text editor on the right.
// All filesystem access goes through the secure `window.hydra` bridge — this
// window never touches Node directly. It opens rooted at the cwd of the pane
// that launched it (passed in on the query string by the main process).

// `hydra` (the contextBridge bridge from preload.js) is referenced directly as
// the global it already is. NOTE: do NOT add `const hydra = window.hydra` here —
// contextBridge exposes `hydra` as a non-configurable global property, so a
// top-level `const`/`let` with the same name is a redeclaration that throws a
// SyntaxError and aborts this entire file (symptom: dead window controls + an
// empty file tree, because none of the wiring below ever runs).

// ---- icons (inline SVG; match the app's stroke style) ----------------------
const ICON_CHEVRON =
  '<svg class="xp-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const ICON_FOLDER =
  '<svg class="xp-ico xp-ico-folder" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_FILE =
  '<svg class="xp-ico xp-ico-file" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

// ---- path helpers (POSIX; the host fs is Linux/WSL) -------------------------
function joinPath(dir, name) { return dir.replace(/\/+$/, '') + '/' + name; }
function baseName(p) { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); }

// ---- state -----------------------------------------------------------------
// The connection (WSL / local / ssh) this Explorer operates on, passed in by
// the main process. Every fs op carries it so we hit the pane's filesystem.
let target = null;
try { target = JSON.parse(new URLSearchParams(location.search).get('target') || 'null'); }
catch (_) { target = null; }

function connLabel(t) {
  if (!t) return '';
  if (t.kind === 'ssh') return 'SSH: ' + (t.host || '?');
  if (t.kind === 'wsl') return t.distro ? 'WSL: ' + t.distro : 'WSL';
  if (t.kind === 'local') return 'Local';
  return '';
}

let rootDir = '';
const openFiles = new Map();   // path -> { name, content, saved, dirty, caret, scroll }
let activePath = null;

const treeEl = document.getElementById('xp-tree');
const tabsEl = document.getElementById('xp-tabs');
const editorEl = document.getElementById('xp-editor');
const gutterEl = document.getElementById('xp-gutter');
const editorWrap = document.getElementById('xp-editor-wrap');
const emptyEl = document.getElementById('xp-empty');
const rootNameEl = document.getElementById('xp-root-name');
const titlePathEl = document.getElementById('xp-titlepath');
const statusPathEl = document.getElementById('xp-status-path');
const statusPosEl = document.getElementById('xp-status-pos');
const statusDirtyEl = document.getElementById('xp-status-dirty');

// ===========================================================================
// File tree
// ===========================================================================

// Build one row (folder or file). Folders carry a collapsible child container
// that is populated lazily the first time they're expanded.
function makeRow(name, fullPath, isDir, depth) {
  const row = document.createElement('div');
  row.className = 'xp-row' + (isDir ? ' is-dir' : ' is-file');
  row.dataset.path = fullPath;
  row.style.setProperty('--depth', depth);

  const label = document.createElement('div');
  label.className = 'xp-row-label';
  label.innerHTML =
    (isDir ? ICON_CHEVRON : '<span class="xp-chevron-spacer"></span>') +
    (isDir ? ICON_FOLDER : ICON_FILE) +
    '<span class="xp-row-name"></span>';
  label.querySelector('.xp-row-name').textContent = name;
  row.appendChild(label);

  if (isDir) {
    const kids = document.createElement('div');
    kids.className = 'xp-children';
    kids.hidden = true;
    row.appendChild(kids);
    label.addEventListener('click', () => toggleFolder(row, fullPath, kids, depth));
  } else {
    label.addEventListener('click', () => openFile(fullPath));
  }
  return row;
}

async function toggleFolder(row, fullPath, kids, depth) {
  if (row.classList.contains('open')) {
    row.classList.remove('open');
    kids.hidden = true;
    return;
  }
  row.classList.add('open');
  kids.hidden = false;
  if (!kids.dataset.loaded) {
    kids.dataset.loaded = '1';
    const res = await hydra.fsList({ path: fullPath, target });
    fillContainer(kids, res, depth + 1);
  }
}

function fillContainer(container, res, depth) {
  container.innerHTML = '';
  if (res && res.unreachable) {
    const note = document.createElement('div');
    note.className = 'xp-tree-empty';
    note.style.setProperty('--depth', depth);
    note.textContent = "couldn't reach this connection";
    container.appendChild(note);
    return;
  }
  if (!res || (!res.dirs.length && !res.files.length)) {
    const empty = document.createElement('div');
    empty.className = 'xp-tree-empty';
    empty.style.setProperty('--depth', depth);
    empty.textContent = 'empty';
    container.appendChild(empty);
    return;
  }
  for (const d of res.dirs) container.appendChild(makeRow(d, joinPath(res.path, d), true, depth));
  for (const f of res.files) container.appendChild(makeRow(f, joinPath(res.path, f), false, depth));
  markActiveRow();
}

async function loadRoot(dir) {
  const res = await hydra.fsList({ path: dir || '', target });
  if (!res) return;
  rootDir = res.path;
  const label = connLabel(target);
  rootNameEl.textContent = baseName(rootDir) || rootDir;
  rootNameEl.title = rootDir;
  titlePathEl.textContent = (label ? label + '  —  ' : '') + rootDir;
  document.title = `${baseName(rootDir) || 'Explorer'}${label ? ' [' + label + ']' : ''} — ClaudeIDE`;
  fillContainer(treeEl, res, 0);
}

// Highlight the row of the active file (if it's currently rendered in the tree).
function markActiveRow() {
  for (const r of treeEl.querySelectorAll('.xp-row.active')) r.classList.remove('active');
  if (!activePath) return;
  const r = treeEl.querySelector(`.xp-row.is-file[data-path="${cssEscape(activePath)}"]`);
  if (r) r.classList.add('active');
}

// Minimal attribute-selector escaping for paths (quotes/backslashes).
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

// ===========================================================================
// Editor + tabs
// ===========================================================================

async function openFile(fullPath) {
  if (openFiles.has(fullPath)) { activateFile(fullPath); return; }

  const res = await hydra.fsRead({ path: fullPath, target });
  if (!res || res.error) {
    flash(res && res.error ? res.error : 'Could not open file');
    return;
  }
  openFiles.set(fullPath, {
    name: baseName(fullPath),
    content: res.content,
    saved: res.content,
    dirty: false,
    caret: 0,
    scroll: 0,
  });
  addTab(fullPath);
  activateFile(fullPath);
}

function addTab(fullPath) {
  const f = openFiles.get(fullPath);
  const tab = document.createElement('div');
  tab.className = 'xp-tab';
  tab.dataset.path = fullPath;
  tab.title = fullPath;
  tab.innerHTML =
    '<span class="xp-tab-name"></span>' +
    '<span class="xp-tab-dirty"></span>' +
    '<button class="xp-tab-close" title="Close">' + ICON_CLOSE + '</button>';
  tab.querySelector('.xp-tab-name').textContent = f.name;
  tab.addEventListener('mousedown', (e) => {
    if (e.target.closest('.xp-tab-close')) return;
    activateFile(fullPath);
  });
  tab.querySelector('.xp-tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeFile(fullPath);
  });
  tabsEl.appendChild(tab);
}

function activateFile(fullPath) {
  // Stash the outgoing file's caret + scroll so switching back is seamless.
  if (activePath && openFiles.has(activePath) && activePath !== fullPath) {
    const prev = openFiles.get(activePath);
    prev.caret = editorEl.selectionStart;
    prev.scroll = editorEl.scrollTop;
  }
  activePath = fullPath;
  const f = openFiles.get(fullPath);
  if (!f) return;

  emptyEl.style.display = 'none';
  editorWrap.style.display = 'flex';
  editorEl.value = f.content;
  editorEl.readOnly = false;
  renderGutter();
  editorEl.focus();
  editorEl.setSelectionRange(f.caret, f.caret);
  editorEl.scrollTop = f.scroll;
  syncGutterScroll();

  for (const t of tabsEl.querySelectorAll('.xp-tab.active')) t.classList.remove('active');
  const tab = tabsEl.querySelector(`.xp-tab[data-path="${cssEscape(fullPath)}"]`);
  if (tab) tab.classList.add('active');

  statusPathEl.textContent = fullPath;
  markActiveRow();
  updateDirtyUi(fullPath);
  updateCaretUi();
}

function closeFile(fullPath) {
  const f = openFiles.get(fullPath);
  if (f && f.dirty && !confirm(`Discard unsaved changes to ${f.name}?`)) return;
  openFiles.delete(fullPath);
  const tab = tabsEl.querySelector(`.xp-tab[data-path="${cssEscape(fullPath)}"]`);
  if (tab) tab.remove();

  if (activePath === fullPath) {
    activePath = null;
    const next = tabsEl.querySelector('.xp-tab');
    if (next) activateFile(next.dataset.path);
    else showEmpty();
  }
}

function showEmpty() {
  activePath = null;
  editorWrap.style.display = 'none';
  emptyEl.style.display = 'flex';
  editorEl.value = '';
  statusPathEl.textContent = '';
  statusPosEl.textContent = '';
  statusDirtyEl.textContent = '';
  markActiveRow();
}

async function saveActive() {
  if (!activePath) return;
  const f = openFiles.get(activePath);
  if (!f || !f.dirty) return;
  f.content = editorEl.value;
  const res = await hydra.fsWrite(activePath, f.content, target);
  if (res && res.ok) {
    f.saved = f.content;
    f.dirty = false;
    updateDirtyUi(activePath);
    flash('Saved ' + f.name);
  } else {
    flash((res && res.error) || 'Save failed');
  }
}

// ---- editor change / gutter / caret ----------------------------------------
function onEditorInput() {
  if (!activePath) return;
  const f = openFiles.get(activePath);
  if (!f) return;
  f.content = editorEl.value;
  f.dirty = f.content !== f.saved;
  renderGutter();
  updateDirtyUi(activePath);
  updateCaretUi();
}

function renderGutter() {
  const lines = editorEl.value.split('\n').length;
  // Rebuild only when the count changes — cheap and avoids per-keystroke churn.
  if (gutterEl.dataset.lines === String(lines)) return;
  gutterEl.dataset.lines = String(lines);
  const nums = [];
  for (let i = 1; i <= lines; i++) nums.push(i);
  gutterEl.textContent = nums.join('\n');
}

function syncGutterScroll() { gutterEl.scrollTop = editorEl.scrollTop; }

function updateCaretUi() {
  const pos = editorEl.selectionStart;
  const upto = editorEl.value.slice(0, pos);
  const line = upto.split('\n').length;
  const col = pos - (upto.lastIndexOf('\n') + 1) + 1;
  statusPosEl.textContent = `Ln ${line}, Col ${col}`;
}

function updateDirtyUi(fullPath) {
  const f = openFiles.get(fullPath);
  const tab = tabsEl.querySelector(`.xp-tab[data-path="${cssEscape(fullPath)}"]`);
  if (tab) tab.classList.toggle('dirty', !!(f && f.dirty));
  if (fullPath === activePath) statusDirtyEl.textContent = f && f.dirty ? '● Unsaved' : '';
}

function flash(msg) {
  let el = document.getElementById('xp-flash');
  if (!el) { el = document.createElement('div'); el.id = 'xp-flash'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove('show'), 1400);
}

// ===========================================================================
// Wiring
// ===========================================================================
editorEl.addEventListener('input', onEditorInput);
editorEl.addEventListener('scroll', syncGutterScroll);
editorEl.addEventListener('keyup', updateCaretUi);
editorEl.addEventListener('click', updateCaretUi);

// Ctrl+S saves; Tab inserts two spaces instead of moving focus.
editorEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    e.stopPropagation();   // don't also hit the window-level Ctrl+S handler
    saveActive();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editorEl.selectionStart, en = editorEl.selectionEnd;
    editorEl.setRangeText('  ', s, en, 'end');
    onEditorInput();
  }
});

// Window-level shortcuts: Ctrl+S works even when focus isn't in the textarea.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveActive();
  }
});

document.getElementById('xp-refresh').addEventListener('click', () => loadRoot(rootDir));
document.getElementById('xp-up').addEventListener('click', async () => {
  const res = await hydra.fsList({ path: rootDir, target });
  if (res && res.parent) loadRoot(res.parent);
});

// ---- title bar (window controls + manual drag; same approach as renderer.js) ----
document.getElementById('win-min').addEventListener('click', () => hydra.minimize());
document.getElementById('win-max').addEventListener('click', () => hydra.toggleMaximize());
document.getElementById('win-close').addEventListener('click', () => hydra.closeWindow());
hydra.onWindowState(({ maximized }) => {
  document.getElementById('win-max').classList.toggle('is-maximized', maximized);
});

(function setupTitlebarDrag() {
  const bar = document.getElementById('xp-titlebar');
  const INTERACTIVE = 'button, .window-controls';
  let dragging = false, pending = null, rafId = 0;
  const flush = () => { rafId = 0; if (dragging && pending) { hydra.dragMove(pending.x, pending.y); pending = null; } };
  const endDrag = () => { if (!dragging) return; dragging = false; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } pending = null; hydra.dragEnd(); };
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest(INTERACTIVE)) return;
    if (e.detail >= 2) { endDrag(); hydra.toggleMaximize(); return; }
    dragging = true;
    hydra.dragStart(e.screenX, e.screenY);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    pending = { x: e.screenX, y: e.screenY };
    if (!rafId) rafId = requestAnimationFrame(flush);
  });
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
})();

// ---- sash: drag to resize the sidebar --------------------------------------
(function setupSash() {
  const sash = document.getElementById('xp-sash');
  const sidebar = document.getElementById('xp-sidebar');
  let dragging = false;
  sash.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.classList.add('xp-resizing'); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(140, Math.min(560, e.clientX));
    sidebar.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.classList.remove('xp-resizing'); });
})();

// ---- boot ------------------------------------------------------------------
const startDir = new URLSearchParams(location.search).get('dir') || '';
showEmpty();
loadRoot(startDir);
