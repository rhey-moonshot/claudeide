'use strict';

/* global Terminal, FitAddon */

// ---------------------------------------------------------------------------
// ClaudeIDE renderer — a grid of live terminals, each a Claude Code session,
// each with a derived status (busy / ready / waiting / dead).
// ---------------------------------------------------------------------------

// Theme the chrome before first paint, from the value main passed in (boot later
// re-confirms it from the saved store, which is authoritative).
try { document.documentElement.dataset.theme = (window.hydra && window.hydra.initialTheme) || 'dark'; } catch (_) {}

const grid = document.getElementById('grid');
const summaryEl = document.getElementById('summary');

let env = { home: '', shell: '', platform: 'linux' };
let seq = 0;
let panes = new Map(); // id -> pane object (order == on-screen order)
let draggingEl = null;  // pane element currently being dragged to rearrange
let zenId = null;       // id of the pane in focus (zen) mode, or null
let focusedId = null;   // id of the currently focused pane (drives the git footer)
let zenFitTimer = null; // refit after the zen transition settles
let tabSeq = 0;         // monotonic counter for unique tab instance ids

// How many bottom rows of the live screen the detector inspects.
const SCREEN_ROWS = 30;

// Default number of panes a fresh workspace is seeded with.
const DEFAULT_PANES = 3;

// Visual mapping for each detected state.
const STATE_UI = {
  working:  { dot: 'busy',     css: 'busy' },
  approval: { dot: 'approval', css: 'approval' },
  input:    { dot: 'ready',    css: 'ready' },
  ready:    { dot: 'ready',    css: 'ready' },
  error:    { dot: 'error',    css: 'error' },
  dead:     { dot: 'dead',     css: 'dead' },
  init:     { dot: 'dead',     css: 'dead' },
};

// Terminal (xterm) palettes per color theme. The window chrome is driven by CSS
// variables (styles.css); these keep each terminal's colors in step with it.
const XTERM_THEMES = {
  dark: {
    background: '#1e1e1e', foreground: '#cccccc',
    cursor: '#aeafad', selectionBackground: '#264f78',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
    blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
    brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
    brightCyan: '#29b8db', brightWhite: '#e5e5e5',
  },
  light: {
    background: '#ffffff', foreground: '#3b3b3b',
    cursor: '#000000', selectionBackground: '#add6ff',
    black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800',
    blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
    brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14',
    brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc',
    brightCyan: '#0598bc', brightWhite: '#a5a5a5',
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2',
    cursor: '#f8f8f0', selectionBackground: '#49483e',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
    blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
    brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2',
    cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#839496',
    cursor: '#839496', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
    brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

// Theme metadata for the picker. `swatch`/`accent` drive the menu preview chips.
const THEMES = [
  { id: 'dark',           name: 'Dark+ (default dark)',  swatch: '#1e1e1e', accent: '#0078d4' },
  { id: 'light',          name: 'Light+ (default light)', swatch: '#ffffff', accent: '#005fb8' },
  { id: 'monokai',        name: 'Monokai',                swatch: '#272822', accent: '#a6e22e' },
  { id: 'dracula',        name: 'Dracula',                swatch: '#282a36', accent: '#bd93f9' },
  { id: 'solarized-dark', name: 'Solarized Dark',         swatch: '#002b36', accent: '#268bd2' },
];

let themeId = 'dark';   // current color theme; persisted on the store
function xtermTheme(id) { return XTERM_THEMES[id] || XTERM_THEMES.dark; }

// Read the bottom `maxRows` lines of the composited xterm screen as plain text.
// We read the rendered buffer (not the raw stream) so the TUI's in-place
// redraws are already resolved into a clean snapshot.
function readScreen(term, maxRows) {
  const buf = term.buffer.active;
  const total = buf.length;
  const start = Math.max(0, total - (maxRows || term.rows));
  const lines = [];
  for (let i = start; i < total; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines;
}

function layoutColumns(n) {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 6) return 3;
  if (n <= 12) return 4;
  return Math.ceil(Math.sqrt(n));
}

// Panes belonging to a workspace (Map order == on-screen order).
function panesOf(ws) {
  return [...panes.values()].filter((p) => p.workspace === ws);
}

// Rebuild the panes Map to match the current DOM order (after a drag). This
// keeps per-workspace ordering — and therefore persistence — in sync.
function rebuildPaneOrder() {
  const next = new Map();
  for (const el of grid.children) {
    const id = el.dataset.id;
    if (id && panes.has(id)) next.set(id, panes.get(id));
  }
  for (const [id, p] of panes) if (!next.has(id)) next.set(id, p); // safety
  panes = next;
}

function relayout() {
  const n = panesOf(store ? store.active : null).length; // only the visible workspace
  const cols = layoutColumns(n);
  const rows = Math.ceil(n / cols) || 1;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  // fit terminals after the DOM settles
  requestAnimationFrame(() => {
    for (const p of panes.values()) fitPane(p);
  });
}

function fitPane(p) {
  if (p.el.offsetParent === null) return; // hidden (background ws or zen) — can't measure
  try {
    p.fit.fit();
    window.hydra.resize(p.id, p.term.cols, p.term.rows);
  } catch (_) { /* not yet attached */ }
}

// Normalize an OSC title from the terminal program into a tidy one-line label.
function cleanTitle(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// Paint the pane title from its current source: a pinned manual name, else the
// program's live title, else the seed ("Agent N"). Skips writes while the user
// is editing the title so we don't clobber their cursor.
function renderPaneTitle(p) {
  if (document.activeElement === p.title) return;
  const text = (p.pinned && p.label) ? p.label : (p.auto || p.seed);
  if (p.title.textContent !== text) p.title.textContent = text;
  p.title.title = text;                       // tooltip shows the full title
  p.el.classList.toggle('auto-title', !p.pinned && !!p.auto);
}

// Quote a filesystem path for the shell the way VSCode's terminal does: leave
// "safe" paths bare, otherwise wrap in single quotes (escaping embedded ones).
function shellQuotePath(pth) {
  if (!pth) return '';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(pth)) return pth;   // no special chars
  return `'${pth.replace(/'/g, `'\\''`)}'`;                // POSIX single-quote
}

// Normalize a raw dropped/pasted path or URI into a path usable in this shell.
// Mirrors main.js's normalizeCwd for the shapes a drag produces: `file://` URIs,
// `\\wsl$`/`wsl.localhost` UNC paths, and `C:\…` drive paths (translated to
// `/mnt/c/…` only when we're actually running on WSL).
function toLocalPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return '';
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/\//i, '');           // file://host/path -> host/path
    try { s = decodeURIComponent(s); } catch (_e) { /* leave as-is */ }
  }
  // Files that live on the Linux side (\\wsl$\Distro\home\x or wsl.localhost/…).
  const uncBack = s.match(/^\\\\?wsl(?:\$|\.localhost)\\[^\\]+\\(.*)$/i);
  if (uncBack) return '/' + uncBack[1].replace(/\\/g, '/');
  const uncFwd = s.match(/^\/{0,2}wsl(?:\$|\.localhost)\/[^/]+\/(.*)$/i);
  if (uncFwd) return '/' + uncFwd[1];
  s = s.replace(/^\/([A-Za-z]:)/, '$1');         // /C:/Users -> C:/Users (from file:///C:/)
  if (env.isWsl) {
    const drive = s.match(/^([A-Za-z]):[\\/](.*)$/);
    if (drive) return `/mnt/${drive[1].toLowerCase()}/` + drive[2].replace(/\\/g, '/');
  }
  return s;
}

// Collect raw path strings out of a DataTransfer. Native file managers hand over
// real File objects; dragging from Windows Explorer into the WSLg window gives no
// File objects at all — only a `text/uri-list` (or plain text) of file:// URIs or
// Windows paths — so we fall back to those. `getData` is only readable on
// drop/paste (not dragover), which is exactly where this runs.
function rawPathsFromDataTransfer(dt, allowPlainText) {
  if (!dt) return [];
  const raws = [];
  if (dt.files && dt.files.length) {
    for (const file of dt.files) {
      const pth = window.hydra.getPathForFile(file);
      if (pth) raws.push(pth);
    }
  }
  if (!raws.length && typeof dt.getData === 'function') {
    // uri-list is unambiguous (file copies/drags only), so it's always safe.
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) raws.push(t);   // '#' lines are uri-list comments
      }
    }
    // Plain text is only trusted for drops — for a paste it IS the literal text
    // the user means to paste, which must stay verbatim (not get shell-quoted).
    if (!raws.length && allowPlainText) {
      const text = dt.getData('text/plain');
      if (text) for (const line of text.split(/\r?\n/)) { const t = line.trim(); if (t) raws.push(t); }
    }
    // Image drags (from a browser or some Windows apps into WSLg) can carry ONLY
    // a text/html payload — an `<img src>`/`<a href>`. Pull a file path out of it.
    // Drop-only, since a normal paste of rich text shouldn't be read as a path.
    if (!raws.length && allowPlainText) {
      const html = dt.getData('text/html');
      if (html) {
        const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
        let m;
        while ((m = re.exec(html))) {
          const u = m[1].trim();
          // Only real on-disk targets — skip web/blob/data URLs that aren't paths.
          if (/^(file:|[A-Za-z]:[\\/]|\\\\|\/)/i.test(u)) raws.push(u);
        }
      }
    }
  }
  return raws;
}

// Turn a DataTransfer's dropped/pasted files into a space-joined, shell-quoted
// path string. Returns '' when nothing path-like is present. `allowPlainText`
// lets a drop treat a bare text payload as a path; pastes leave text alone.
function pathsFromDataTransfer(dt, allowPlainText) {
  const parts = [];
  for (const raw of rawPathsFromDataTransfer(dt, allowPlainText)) {
    const pth = toLocalPath(raw);
    if (pth) parts.push(shellQuotePath(pth));
  }
  return parts.join(' ');
}

function createPane(opts = {}) {
  const workspace = opts.workspace || store.active;
  if (!workspace) return null;   // no tab to host it (welcome screen) — caller starts one
  const id = `p${++seq}`;
  const label = opts.label || `Agent ${panesOf(workspace).length + 1}`;

  const el = document.createElement('div');
  el.className = 'pane' + (workspace !== store.active ? ' hidden' : '');
  el.dataset.id = id;
  el.innerHTML = `
    <div class="pane-head" draggable="true">
      <span class="grip" title="Drag to rearrange">⠿</span>
      <span class="dot dead"></span>
      <span class="pane-title" contenteditable="true" spellcheck="false" draggable="false"></span>
      <span class="pane-state-label state-dead">init</span>
      <span class="pane-status"></span>
      <button class="pane-btn paste-path" title="Insert file/image path from the Windows clipboard (Ctrl+Shift+V)">ℹ</button>
      <button class="pane-btn restart" title="Restart command">↻</button>
      <button class="pane-btn close" title="Close pane">✕</button>
    </div>
    <div class="pane-body"></div>`;
  grid.appendChild(el);

  const term = new Terminal({
    theme: xtermTheme(themeId),
    fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, monospace',
    fontSize: 14,            // VSCode's default terminal/editor font size
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.pane-body'));

  // Intercept app shortcuts before xterm forwards the keys to the PTY.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (handleShortcut(e)) { e.preventDefault(); e.stopPropagation(); return false; }
    return true;
  });

  const p = {
    id, el, term, fit,
    dot: el.querySelector('.dot'),
    stateLabel: el.querySelector('.pane-state-label'),
    status: el.querySelector('.pane-status'),
    title: el.querySelector('.pane-title'),
    git: null,        // last-seen { branch, repo, detached } or null
    lastData: 0,
    state: 'init',
    exited: false,
    pid: null,
    label,
    workspace,   // the TAB id this pane belongs to
    wsName: (store.tabs[workspace] && store.tabs[workspace].name) || '', // for notifications
    // Pane title, VSCode-style: `auto` is the live title the running program
    // (Claude Code) sets via an OSC escape — "what I'm working on". `seed` is the
    // fallback name shown before any title arrives. A manual rename `pinned`s a
    // fixed `label` so the live title stops overriding it (clear it to un-pin).
    seed: label,
    auto: '',
    pinned: !!opts.pinned,
    // Each pane remembers its own working dir + command so the tab can be
    // restored exactly. New panes inherit the current toolbar template.
    cwd: opts.cwd !== undefined ? opts.cwd : cwdInput(),
    command: opts.command !== undefined ? opts.command : cmdValue(),
    // The connection captured at creation (so a later workspace edit can't
    // redirect a pane mid-spawn). New panes adopt their workspace's connection.
    target: opts.target !== undefined ? opts.target : workspaceTarget(workspace),
  };
  panes.set(id, p);
  renderPaneTitle(p);

  // The program's OSC title sequence (e.g. Claude Code's current task) drives the
  // pane title unless the user pinned a manual name or is mid-edit.
  term.onTitleChange((t) => {
    p.auto = cleanTitle(t);
    if (!p.pinned && document.activeElement !== p.title) renderPaneTitle(p);
  });

  // focus tracking
  el.addEventListener('mousedown', () => focusPane(p));
  term.onData((data) => window.hydra.input(id, data));

  // VSCode-style file drop & paste: dragging files from the OS (or pasting a
  // copied file) into the terminal inserts their shell-quoted paths instead of
  // doing nothing. `draggingEl` means an internal pane-reorder drag — skip those.
  const body = el.querySelector('.pane-body');
  // Accept native File drags AND the uri-list / plain-text payloads that a drag
  // from Windows Explorer into WSLg produces (it carries no File objects). Plain
  // text is safe to accept because an internal pane-reorder drag is excluded by
  // the `draggingEl` guard, and dropping selected text into a terminal is useful.
  const isFileDrag = (e) =>
    !draggingEl && e.dataTransfer &&
    ['Files', 'text/uri-list', 'text/plain', 'text/html'].some(
      (t) => Array.prototype.includes.call(e.dataTransfer.types || [], t));
  const overFiles = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
  };
  body.addEventListener('dragenter', overFiles);
  body.addEventListener('dragover', overFiles);
  body.addEventListener('dragleave', (e) => {
    // Only clear when the pointer actually leaves the pane, not on child crossings.
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    el.classList.remove('drop-target');
  });
  body.addEventListener('drop', (e) => {
    el.classList.remove('drop-target');
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const paths = pathsFromDataTransfer(e.dataTransfer, true);  // text payload may be a path
    if (paths) { window.hydra.input(id, paths); focusPane(p); }
    else {
      // Nothing path-like came through — dump what the drag actually carried so
      // we can tell an empty WSLg cross-host drop from a format we don't parse.
      const dt = e.dataTransfer;
      const dump = {};
      for (const t of dt.types || []) { try { dump[t] = dt.getData(t); } catch (_e) { dump[t] = '<unreadable>'; } }
      console.warn('[file-drop] no path extracted. files:', dt.files && dt.files.length, 'data:', dump);
    }
  });
  // Capture-phase so we run before xterm's own paste handler on the textarea.
  body.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    const paths = pathsFromDataTransfer(cd, false);  // only real copied files
    if (paths) {                   // a copied file the renderer could resolve
      e.preventDefault();
      e.stopPropagation();
      window.hydra.input(id, paths);
      return;
    }
    // Ordinary text paste — let xterm insert it verbatim.
    const hasText = cd && Array.prototype.includes.call(cd.types || [], 'text/plain') &&
      (cd.getData('text/plain') || '').trim() !== '';
    if (hasText) return;
    // No resolvable file and no text: under WSLg this is almost always a Windows
    // clipboard image/file the renderer can't see. Reach across to the Windows
    // clipboard, materialise it to a path, and insert that — like VSCode pasting
    // a screenshot's path. Swallow the keystroke either way (nothing else to do).
    if (!window.hydra.grabClipboard) return;
    e.preventDefault();
    e.stopPropagation();
    window.hydra.grabClipboard().then((raws) => {
      if (!raws || !raws.length) return;
      const quoted = raws.map((r) => shellQuotePath(toLocalPath(r)))
        .filter(Boolean).join(' ');
      if (quoted) { window.hydra.input(id, quoted); focusPane(p); }
    }).catch(() => {});
  }, true);

  el.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closePane(p);
  });
  el.querySelector('.restart').addEventListener('click', (e) => {
    e.stopPropagation();
    runCommand(p);
  });
  el.querySelector('.paste-path').addEventListener('click', (e) => {
    e.stopPropagation();
    focusPane(p);
    insertClipboardPath(p);
  });
  // Enter on the title commits the rename instead of inserting a newline.
  p.title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); p.title.blur(); }
  });
  p.title.addEventListener('blur', () => {
    const text = (p.title.textContent || '').trim();
    // A real custom name pins the title; blank or "same as the live title" un-pins
    // and hands control back to the program's OSC title.
    if (text && text !== (p.auto || p.seed)) { p.pinned = true; p.label = text; }
    else { p.pinned = false; p.label = ''; }
    renderPaneTitle(p);
    scheduleSave();
  });

  // Drag the header to rearrange panes within the tab. The terminal body and
  // the editable title / buttons are excluded so they keep working normally.
  const head = el.querySelector('.pane-head');
  head.addEventListener('dragstart', (e) => {
    if (e.target.closest('.pane-title, .pane-btn')) { e.preventDefault(); return; }
    draggingEl = el;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id); // Firefox needs some payload
  });
  head.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    draggingEl = null;
    rebuildPaneOrder();   // sync the Map (persistence) to the new DOM order
    for (const q of panes.values()) fitPane(q);
    scheduleSave();
  });
  // Double-click the title bar (like maximizing a window) toggles focus mode.
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('.pane-title, .pane-btn')) return; // editing/buttons
    e.preventDefault();
    toggleZen(p);
  });

  spawnPty(p);
  if (workspace === store.active) { relayout(); focusPane(p); }
  scheduleSave();
  return p;
}

async function spawnPty(p) {
  fitPane(p);
  const r = await window.hydra.createPty({
    id: p.id,
    cols: p.term.cols || 80,
    rows: p.term.rows || 24,
    cwd: p.cwd,   // empty → the target picks its own default (local home / remote home)
    target: p.target || workspaceTarget(p.workspace),   // the pane's connection
  });
  p.pid = r.pid;
  // Adopt the normalized path (e.g. a Windows path the picker returned, now a
  // real Linux path) so restart/persist/cd all use the clean value. Only when the
  // user actually set a dir — we never backfill an empty cwd with the home default,
  // or an SSH pane would try to `cd` into a *local* path the remote doesn't have.
  if (r.requested) p.cwd = r.requested;
  if (r.warning) {
    p.term.write(`\r\n\x1b[33m[ClaudeIDE] ${r.warning} — started in ${r.cwd} instead\x1b[0m\r\n`);
  }
  applyStatus(p, { state: 'ready', label: 'ready', detail: 'shell ready', meta: {} });
  refreshGit(p);
  // Auto-run is per-tab (the pane may belong to a background tab whose toolbar
  // isn't the one currently shown).
  const t = store.tabs[p.workspace];
  const autorun = t ? t.toolbar.autorun !== false : document.getElementById('autorun').checked;
  if (autorun) {
    // small delay so the login shell prints its prompt first
    setTimeout(() => runCommand(p), 350);
  }
}

// Run this pane's own command (in its own working dir). Used on spawn + restart.
// SSH panes never cd: their cwd is a local path the remote host can't resolve,
// so the remote session just starts in its own home.
function runCommand(p) {
  if (p.exited) return;
  const isSsh = (p.target && p.target.kind) === 'ssh';
  const cd = (!isSsh && p.cwd) ? `cd ${shellQuote(p.cwd)} && ` : '';
  const line = cd + (p.command || '');
  if (line.trim()) window.hydra.input(p.id, line + '\r');
}

// ---- git status (bottom status bar) ----------------------------------------
// VSCode-style: the footer shows the repo + branch of the *focused* pane, so you
// can always tell which project/branch the pane you're typing in is on. The
// lookup follows the pane's live cwd (so `cd` into a repo lights it up); SSH
// panes are skipped since the repo lives on the remote host, not locally.
async function refreshGit(p) {
  if (!p || p.exited || !p.pid) return;
  let info = null;
  if (((p.target && p.target.kind) || 'wsl') !== 'ssh') {
    try { info = await window.hydra.gitInfo({ pid: p.pid, cwd: p.cwd }); } catch (_) { /* ignore */ }
  }
  if (!panes.has(p.id)) return;       // closed while awaiting
  p.git = info || null;
  if (p.id === focusedId) renderGitStatus();
}

// Paint the bottom-bar indicator from whatever the focused pane last reported.
function renderGitStatus() {
  const el = document.getElementById('git-status');
  if (!el) return;
  const p = panes.get(focusedId);
  // Only reflect a pane that's actually visible in the current tab.
  const info = p && p.workspace === store.active ? p.git : null;
  if (!info) { el.hidden = true; return; }
  el.querySelector('.git-branch').textContent = info.branch;
  el.querySelector('.git-branch').classList.toggle('detached', !!info.detached);
  el.querySelector('.git-repo').textContent = info.repo;
  el.hidden = false;
}

function shellQuote(s) { return `'${s.replace(/'/g, `'\\''`)}'`; }
function cmdValue() { return document.getElementById('cmd').value.trim(); }
function cwdInput() { return document.getElementById('cwd').value.trim(); }

function focusPane(p) {
  for (const q of panes.values()) q.el.classList.toggle('focused', q === p);
  focusedId = p.id;
  renderGitStatus();   // show this pane's cached git immediately…
  refreshGit(p);       // …then refresh it in the background
  p.term.focus();
}

// ---- focus (zen) mode ------------------------------------------------------
// Expand one pane full-window and melt away the chrome, like VSCode zen mode.
function isZen() { return zenId !== null; }

function enterZen(p) {
  zenId = p.id;
  document.body.classList.add('zen');
  for (const q of panes.values()) q.el.classList.toggle('zen-target', q === p);
  focusPane(p);
  clearTimeout(zenFitTimer);
  zenFitTimer = setTimeout(() => { fitPane(p); p.term.focus(); }, 240); // after transition
  flash('Focus mode — F11 or double-click the title bar to exit');
}

function exitZen() {
  if (!isZen()) return;
  const p = panes.get(zenId);
  zenId = null;
  document.body.classList.remove('zen');
  if (p) p.el.classList.remove('zen-target');
  relayout();
  clearTimeout(zenFitTimer);
  zenFitTimer = setTimeout(() => {
    for (const q of panesOf(store.active)) fitPane(q);
    if (p) p.term.focus();
  }, 240);
}

function toggleZen(p) {
  if (zenId === p.id) exitZen();
  else enterZen(p); // (re-targets if another pane was already zen)
}

// F11: toggle zen on the focused pane (or the first pane if none focused).
function toggleZenFocused() {
  if (isZen()) { exitZen(); return; }
  const active = panesOf(store.active);
  const target = active.find((p) => p.el.classList.contains('focused')) || active[0];
  if (target) enterZen(target);
}

function closePane(p) {
  if (p.id === zenId) exitZen();
  window.hydra.kill(p.id);
  p.term.dispose();
  p.el.remove();
  panes.delete(p.id);
  relayout();
  updateSummary();
  renderGitStatus();   // clears the footer if this was the focused pane
  scheduleSave();
}

// ---- workspace store -------------------------------------------------------
// We can't serialize a live PTY (bash + claude in-memory state is gone when the
// app closes), so we persist the *workspace*: pane order, labels, each pane's
// cwd + command, and toolbar settings. Multiple named workspaces are kept in a
// single store so you can switch between projects.
//   store = { version:2, active, workspaces: { name: { toolbar, panes } } }
let saveTimer = null;
let store = null;

function defaultToolbar() {
  return { autorun: true, notify: true, cmd: 'claude', cwd: '', target: defaultRemote() };
}

// The connection a workspace's new panes spawn on (WSL / Local / SSH), stored on
// its toolbar. Falls back to this machine for older saves that predate the field.
function workspaceTarget(wsId) {
  const t = store && store.tabs[wsId];
  return (t && t.toolbar && t.toolbar.target && t.toolbar.target.kind) ? t.toolbar.target : defaultRemote();
}
// store = {
//   version:4, active:<tabId>, open:[tabId...],
//   tabs:    { tabId: { name, toolbar, panes } },  // open tab INSTANCES (independent;
//                                                  //   many tabs may share a `name`)
//   recents: { name:  { toolbar } }                // registry of known workspaces for
//                                                  //   the Open menu (name + cwd/settings)
// }
function freshStore() {
  const id = 't' + (++tabSeq);
  return {
    version: 4, active: id, open: [id],
    tabs: { [id]: { name: 'default', toolbar: defaultToolbar(), panes: [] } },
    recents: { default: { toolbar: defaultToolbar() } },
  };
}
// Build a v4 store from the older "named workspace" shape.
function tabsFromNamed(workspaces, openNames, activeName) {
  const tabs = {}; const open = []; const recents = {}; let activeId = null;
  for (const name of Object.keys(workspaces)) {
    recents[name] = { toolbar: workspaces[name].toolbar || defaultToolbar() };
  }
  for (const name of openNames) {
    if (!workspaces[name]) continue;
    const id = 't' + (++tabSeq);
    tabs[id] = { name, toolbar: workspaces[name].toolbar || defaultToolbar(), panes: workspaces[name].panes || [] };
    open.push(id);
    if (name === activeName && !activeId) activeId = id;
  }
  if (!open.length) return freshStore();
  return { version: 4, active: activeId || open[0], open, tabs, recents };
}
function normalizeStore(s) {
  if (s && s.version === 4 && s.tabs && Array.isArray(s.open)) {
    for (const id of Object.keys(s.tabs)) {                  // keep tabSeq ahead of saved ids
      const num = parseInt(String(id).replace(/^t/, ''), 10);
      if (Number.isFinite(num) && num > tabSeq) tabSeq = num;
    }
    s.open = s.open.filter((id) => s.tabs[id]);
    if (!s.open.length) return freshStore();
    if (!s.tabs[s.active]) s.active = s.open[0];
    s.recents = s.recents || {};
    for (const id of s.open) {                               // open tabs are always reopenable
      const nm = s.tabs[id].name;
      if (nm && !s.recents[nm]) s.recents[nm] = { toolbar: s.tabs[id].toolbar || defaultToolbar() };
    }
    return s;
  }
  if (s && s.version === 3 && s.workspaces && Array.isArray(s.open)) {
    const open = s.open.filter((n) => s.workspaces[n]);
    return tabsFromNamed(s.workspaces, open.length ? open : Object.keys(s.workspaces).slice(0, 1), s.active);
  }
  if (s && s.version === 2 && s.workspaces && Object.keys(s.workspaces).length) {
    return tabsFromNamed(s.workspaces, Object.keys(s.workspaces), s.active);
  }
  if (s && Array.isArray(s.panes)) { // v1 single workspace
    return tabsFromNamed({ default: { toolbar: s.toolbar || defaultToolbar(), panes: s.panes } }, ['default'], 'default');
  }
  return freshStore();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

function currentToolbar() {
  return {
    autorun: document.getElementById('autorun').checked,
    notify: document.getElementById('notify-toggle').checked,
    cmd: document.getElementById('cmd').value,
    cwd: document.getElementById('cwd').value,
    // The connection isn't a toolbar input — it's set via Add/Edit Workspace —
    // so carry the active tab's value through unchanged on every save.
    target: workspaceTarget(store && store.active),
  };
}

// Serialize each OPEN tab from its live panes. The active tab's toolbar is also
// mirrored into the recents registry so the workspace's settings stay fresh.
function saveState() {
  if (!store) return;
  for (const id of store.open) {
    if (!store.tabs[id]) continue;
    store.tabs[id].panes = panesOf(id).map((p) => ({
      // Persist the base name (pinned manual name, or the seed) — not the live
      // OSC title, which is session-specific and re-arrives when the program runs.
      label: p.pinned ? p.label : p.seed,
      pinned: p.pinned,
      cwd: p.cwd || '',
      command: p.command || '',
    }));
  }
  if (store.tabs[store.active]) {
    const tb = currentToolbar();
    store.tabs[store.active].toolbar = tb;
    const nm = store.tabs[store.active].name;
    if (nm) store.recents[nm] = { toolbar: tb };
  }
  window.hydra.saveState(store);
}

function restoreToolbar(t) {
  t = t || {};
  document.getElementById('autorun').checked = t.autorun !== false;
  document.getElementById('notify-toggle').checked = t.notify !== false;
  document.getElementById('cmd').value = typeof t.cmd === 'string' ? t.cmd : 'claude';
  document.getElementById('cwd').value = typeof t.cwd === 'string' ? t.cwd : '';
}

// ---- tabs (independent workspace instances) --------------------------------
// Aggregate the live status of a tab's panes, for its tab indicator.
function workspaceStatus(ws) {
  let working = 0, approval = 0, error = 0, ready = 0, dead = 0, total = 0;
  for (const p of panesOf(ws)) {
    total++;
    if (p.state === 'working') working++;
    else if (p.state === 'approval') approval++;
    else if (p.state === 'error') error++;
    else if (p.state === 'dead') dead++;
    else ready++;
  }
  let dot = 'ready';
  if (approval) dot = 'approval';
  else if (error) dot = 'error';
  else if (working) dot = 'busy';
  else if (total && dead === total) dot = '';
  return { working, approval, error, ready, dead, total, dot };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  // count duplicate names so we can disambiguate them with "#k"
  const counts = {};
  for (const id of store.open) { const nm = store.tabs[id].name; counts[nm] = (counts[nm] || 0) + 1; }
  const seen = {};
  let i = 0;
  for (const id of store.open) {
    const t = store.tabs[id];
    const base = t.name;
    let disp = base;
    if (counts[base] > 1) { seen[base] = (seen[base] || 0) + 1; disp = `${base} #${seen[base]}`; }
    const n = ++i; // 1-based tab position
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === store.active ? ' active' : '');
    tab.dataset.tab = id;
    tab.title = n <= 9 ? `${disp}  ·  Ctrl+${n}` : disp;
    tab.innerHTML = `
      <span class="tab-num">${n <= 9 ? n : ''}</span>
      <span class="tab-dot"></span>
      <span class="tab-name" spellcheck="false">${escapeHtml(disp)}</span>
      <span class="tab-meta"></span>
      <button class="tab-close" title="Close tab (reopen from Open)">✕</button>`;
    const nameEl = tab.querySelector('.tab-name');

    tab.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      if (nameEl.isContentEditable) return; // mid-rename: let the click edit text
      switchTab(id);
    });
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      nameEl.textContent = base; // edit the raw name, not the "#k" display
      nameEl.contentEditable = 'true';
      nameEl.focus();
      document.getSelection().selectAllChildren(nameEl);
    });
    nameEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = disp; nameEl.blur(); }
    });
    nameEl.addEventListener('blur', () => {
      nameEl.contentEditable = 'false';
      renameTab(id, (nameEl.textContent || '').trim());
    });
    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    tabsEl.appendChild(tab);
  }
  // No open tabs → reveal the welcome screen and hide the (empty) grid.
  document.body.classList.toggle('no-tabs', store.open.length === 0);
  updateTabStatus();
}

// Update just the status dot + counts on each tab (cheap; runs every tick).
function updateTabStatus() {
  if (!store) return;
  for (const tab of document.querySelectorAll('.tab')) {
    const id = tab.dataset.tab;
    if (!store.tabs[id]) continue;
    const s = workspaceStatus(id);
    tab.querySelector('.tab-dot').className = 'tab-dot ' + s.dot;
    const bits = [];
    if (s.working) bits.push(`⚙${s.working}`);
    if (s.approval) bits.push(`⚠${s.approval}`);
    if (s.error) bits.push(`✗${s.error}`);
    tab.querySelector('.tab-meta').textContent = bits.length ? bits.join(' ') : `${s.total}`;
    tab.classList.toggle('attn', s.approval + s.error > 0);
  }
}

// Show the active tab's panes; hide the rest (all stay alive in the background).
function applyVisibility() {
  for (const p of panes.values()) p.el.classList.toggle('hidden', p.workspace !== store.active);
}

function showActiveWorkspace() {
  // No open tabs → the welcome screen takes over (see renderTabs / body.no-tabs).
  if (!store.active || !store.tabs[store.active]) {
    applyVisibility();   // hide any lingering panes
    renderTabs();
    updateSummary();
    renderGitStatus();
    renderRemote();
    return;
  }
  restoreToolbar(store.tabs[store.active].toolbar);
  applyVisibility();
  relayout();
  for (const p of panesOf(store.active)) fitPane(p);
  renderGitStatus();   // footer reflects the now-visible tab's focused pane
  renderTabs();
  updateSummary();
  renderRemote();   // pill reflects the now-active workspace's connection
}

// Switching tabs is non-destructive: other tabs' terminals keep running in the
// background; we only change what's visible.
function switchTab(id) {
  if (!store.open.includes(id) || id === store.active) return;
  if (isZen()) exitZen();
  if (store.tabs[store.active]) store.tabs[store.active].toolbar = currentToolbar();
  store.active = id;
  showActiveWorkspace();
  const first = panesOf(id)[0];
  if (first) focusPane(first);
  saveState();
  flash(`workspace: ${store.tabs[id].name}`);
}

// Open a NEW tab instance for `name` (always a fresh tab — you can have several
// tabs for the same workspace). Seeds from `paneDefs` or DEFAULT_PANES.
function openTab(name, toolbar, paneDefs) {
  if (isZen()) exitZen();
  if (store.tabs[store.active]) store.tabs[store.active].toolbar = currentToolbar();
  const id = 't' + (++tabSeq);
  store.tabs[id] = { name, toolbar: { ...toolbar }, panes: [] };
  store.open.push(id);
  store.active = id;
  restoreToolbar(store.tabs[id].toolbar);
  applyVisibility();   // other tabs -> hidden, but still running
  if (paneDefs && paneDefs.length) {
    for (const sp of paneDefs) createPane({ workspace: id, label: sp.label, pinned: sp.pinned, cwd: sp.cwd, command: sp.command });
  } else {
    setPaneCount(DEFAULT_PANES);
  }
  renderTabs();     // also clears the welcome screen (body.no-tabs)
  relayout();       // refit now that the grid is visible again
  updateSummary();
  renderRemote();   // new tab is now active — show its connection
  saveState();
  return id;
}

async function newWorkspace() {
  const res = await askWorkspace('New workspace');
  if (!res) return;
  const { name, dir, target } = res;
  const toolbar = { ...defaultToolbar(), cwd: dir || '', target };
  store.recents[name] = { toolbar };          // remember it for the Open menu
  openTab(name, toolbar);
  flash(dir ? `created: ${name} → ${dir}` : `created: ${name}`);
}

// Edit the active tab's workspace: name, working dir, and connection. The new
// connection applies to NEW panes; terminals already running keep their shell.
async function editWorkspace(id) {
  const t = store.tabs[id];
  if (!t) return;
  const res = await askWorkspace('Edit workspace', {
    name: t.name,
    dir: (id === store.active ? cwdInput() : (t.toolbar && t.toolbar.cwd)) || '',
    target: workspaceTarget(id),
    okLabel: 'Save',
  });
  if (!res) return;
  const { name, dir, target } = res;
  const prev = workspaceTarget(id);
  const connChanged = JSON.stringify(prev) !== JSON.stringify(target);

  // Apply working dir + connection to the tab (and the active toolbar inputs).
  t.toolbar = { ...(t.toolbar || defaultToolbar()), cwd: dir || '', target };
  if (id === store.active) { document.getElementById('cwd').value = dir || ''; renderRemote(); }
  store.recents[name] = { toolbar: t.toolbar };
  if (name !== t.name) renameTab(id, name);    // also re-points recents + tab UI
  else { renderTabs(); saveState(); }

  const note = (connChanged && panesOf(id).length) ? ' — new connection applies to new panes' : '';
  flash(`updated: ${name}${note}`);
}

// Open a known workspace from the recents list — ALWAYS in a new tab, so opening
// the same workspace again gives you another tab to work in.
function openWorkspace(name) {
  const rec = store.recents[name];
  const toolbar = rec ? rec.toolbar : { ...defaultToolbar() };
  openTab(name, toolbar);
  flash(`opened: ${name}`);
}

// Remove a workspace from the recents registry (does not touch files).
async function forgetWorkspace(name) {
  const openCount = store.open.filter((id) => store.tabs[id].name === name).length;
  if (openCount > 0) {
    flash(`close ${name}'s ${openCount} open tab${openCount > 1 ? 's' : ''} first`);
    return;
  }
  const ok = await askConfirm({
    title: `Remove “${name}” from your workspaces?`,
    message: `This forgets the saved workspace “${name}” — its working directory and `
      + `settings. It does not delete any files on disk.`,
    confirmLabel: 'Remove',
  });
  if (!ok) return;
  delete store.recents[name];
  saveState();
  flash(`removed: ${name}`);
}

// ---- "Open workspace" dropdown (VSCode-style recent list) ------------------
let wsMenuEl = null;
function closeWorkspaceMenu() {
  if (wsMenuEl) { wsMenuEl.remove(); wsMenuEl = null; }
  document.removeEventListener('mousedown', onWsMenuOutside, true);
  document.removeEventListener('keydown', onWsMenuKey, true);
}
function onWsMenuOutside(e) {
  if (wsMenuEl && !wsMenuEl.contains(e.target) && !e.target.closest('#file-menu')) closeWorkspaceMenu();
}
function onWsMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeWorkspaceMenu(); } }

function showWorkspaceMenu(anchor) {
  if (wsMenuEl) { closeWorkspaceMenu(); return; } // toggle off
  const menu = document.createElement('div');
  menu.className = 'ws-menu';
  wsMenuEl = menu;

  const head = document.createElement('div');
  head.className = 'ws-menu-head';
  head.textContent = 'Workspaces';
  menu.appendChild(head);

  const list = document.createElement('div');
  list.className = 'ws-menu-list';
  const names = Object.keys(store.recents).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'ws-empty';
    empty.textContent = 'No saved workspaces yet.';
    list.appendChild(empty);
  }
  for (const name of names) {
    const openCount = store.open.filter((id) => store.tabs[id].name === name).length;
    const cwd = (store.recents[name].toolbar && store.recents[name].toolbar.cwd) || '';

    const row = document.createElement('div');
    row.className = 'ws-row';

    const dot = document.createElement('span');
    dot.className = 'ws-row-dot ' + (openCount ? 'open' : 'closed');
    row.appendChild(dot);

    const main = document.createElement('span');
    main.className = 'ws-row-main';
    const nm = document.createElement('span');
    nm.className = 'ws-row-name';
    nm.textContent = name;
    const pth = document.createElement('span');
    pth.className = 'ws-row-path';
    pth.textContent = cwd || env.home || '~';
    main.append(nm, pth);
    row.appendChild(main);

    const tag = document.createElement('span');
    tag.className = 'ws-row-tag';
    tag.textContent = openCount ? `${openCount} open · +tab` : 'open';
    row.appendChild(tag);

    const x = document.createElement('button');
    x.className = 'ws-row-x';
    x.textContent = '✕';
    x.title = openCount ? 'Remove (close its tabs first)' : 'Remove from list';
    row.appendChild(x);

    row.addEventListener('click', (e) => {
      if (e.target === x) return;
      closeWorkspaceMenu();
      openWorkspace(name); // always opens a NEW tab for this workspace
    });
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeWorkspaceMenu();
      await forgetWorkspace(name);
    });
    list.appendChild(row);
  }
  menu.appendChild(list);

  const newBtn = document.createElement('button');
  newBtn.className = 'ws-menu-new';
  newBtn.textContent = '+  New workspace…';
  newBtn.addEventListener('click', () => { closeWorkspaceMenu(); newWorkspace(); });
  menu.appendChild(newBtn);

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 4}px`;

  setTimeout(() => {
    document.addEventListener('mousedown', onWsMenuOutside, true);
    document.addEventListener('keydown', onWsMenuKey, true);
  }, 0);
}

// ---- File menu (title-bar dropdown) ----------------------------------------
let fileMenuEl = null;
function closeFileMenu() {
  if (fileMenuEl) { fileMenuEl.remove(); fileMenuEl = null; }
  const btn = document.getElementById('file-menu');
  if (btn) btn.classList.remove('open');
  document.removeEventListener('mousedown', onFileMenuOutside, true);
  document.removeEventListener('keydown', onFileMenuKey, true);
}
function onFileMenuOutside(e) {
  if (fileMenuEl && !fileMenuEl.contains(e.target) && !e.target.closest('#file-menu')) closeFileMenu();
}
function onFileMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeFileMenu(); } }

function showFileMenu(anchor) {
  if (fileMenuEl) { closeFileMenu(); return; } // toggle off
  const menu = document.createElement('div');
  menu.className = 'app-menu';
  fileMenuEl = menu;

  const items = [
    { label: 'New Workspace…', run: () => newWorkspace() },
    { label: 'Open Workspace…', run: () => showWorkspaceMenu(anchor) },
    { label: 'Edit Workspace…', run: () => editWorkspace(store.active) },
    { sep: true },
    { label: 'Color Theme…', run: () => showThemeMenu(anchor) },
    { sep: true },
    { label: 'Zoom In',    hint: 'Ctrl +',  keepOpen: true, run: () => window.hydra.zoom('in') },
    { label: 'Zoom Out',   hint: 'Ctrl -',  keepOpen: true, run: () => window.hydra.zoom('out') },
    { label: 'Reset Zoom', hint: 'Ctrl 0',  keepOpen: true, run: () => window.hydra.zoom('reset') },
    { sep: true },
    { label: 'Exit', run: () => window.hydra.closeWindow() },
  ];
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'menu-item';
    if (it.hint) {
      b.innerHTML = '<span class="mi-label"></span><span class="mi-hint"></span>';
      b.querySelector('.mi-label').textContent = it.label;
      b.querySelector('.mi-hint').textContent = it.hint;
    } else {
      b.textContent = it.label;
    }
    // Zoom items stay open so you can step repeatedly; others close on use.
    b.addEventListener('click', () => { if (!it.keepOpen) closeFileMenu(); it.run(); });
    menu.appendChild(b);
  }

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 2}px`;
  anchor.classList.add('open');

  setTimeout(() => {
    document.addEventListener('mousedown', onFileMenuOutside, true);
    document.addEventListener('keydown', onFileMenuKey, true);
  }, 0);
}

// ---- color theme -----------------------------------------------------------
// Apply a theme: re-skin the chrome (CSS var block via data-theme), recolor every
// live terminal, keep native chrome in step, and persist the choice.
function applyTheme(id, { persist = true } = {}) {
  if (!XTERM_THEMES[id]) id = 'dark';
  themeId = id;
  document.documentElement.dataset.theme = id;
  const palette = xtermTheme(id);
  for (const p of panes.values()) {
    try { p.term.options.theme = palette; } catch (_) { /* not yet attached */ }
  }
  if (window.hydra.setNativeTheme) window.hydra.setNativeTheme(id === 'light' ? 'light' : 'dark');
  if (persist && store) { store.theme = id; scheduleSave(); }
}

let themeMenuEl = null;
function closeThemeMenu() {
  if (themeMenuEl) {
    themeMenuEl.remove(); themeMenuEl = null;
    // Dismissed without committing? Drop any hover-preview back to the saved theme.
    const committed = (store && store.theme) || 'dark';
    if (themeId !== committed) applyTheme(committed, { persist: false });
  }
  document.removeEventListener('mousedown', onThemeMenuOutside, true);
  document.removeEventListener('keydown', onThemeMenuKey, true);
}
function onThemeMenuOutside(e) {
  if (themeMenuEl && !themeMenuEl.contains(e.target) && !e.target.closest('#file-menu')) closeThemeMenu();
}
function onThemeMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeThemeMenu(); } }

function showThemeMenu(anchor) {
  if (themeMenuEl) { closeThemeMenu(); return; }
  const menu = document.createElement('div');
  menu.className = 'app-menu theme-menu';
  themeMenuEl = menu;
  const original = themeId;   // for live preview on hover; restored if cancelled

  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'menu-item theme-item' + (t.id === themeId ? ' active' : '');
    b.innerHTML =
      `<span class="theme-swatch" style="background:${t.swatch};--sw-accent:${t.accent}"></span>`
      + `<span class="theme-name"></span><span class="theme-check">✓</span>`;
    b.querySelector('.theme-name').textContent = t.name;
    b.addEventListener('mouseenter', () => applyTheme(t.id, { persist: false }));   // live preview
    b.addEventListener('click', () => {
      applyTheme(t.id);                 // commit + persist
      closeThemeMenu();
      flash(`Theme: ${t.name}`);
    });
    menu.appendChild(b);
  }
  // Leaving the list without picking restores the committed theme.
  menu.addEventListener('mouseleave', () => applyTheme(original, { persist: false }));

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 2}px`;

  setTimeout(() => {
    document.addEventListener('mousedown', onThemeMenuOutside, true);
    document.addEventListener('keydown', onThemeMenuKey, true);
  }, 0);
}

function renameTab(id, name) {
  const t = store.tabs[id];
  if (!t) return;
  if (!name || name === t.name) { renderTabs(); return; }
  t.name = name;
  store.recents[name] = { toolbar: t.toolbar }; // the new name becomes reopenable
  for (const p of panesOf(id)) p.wsName = name;
  renderTabs();
  saveState();
  flash(`renamed: ${name}`);
}

// Close a tab: stop its terminals. The workspace stays in your Open list so you
// can open a fresh tab for it again later.
async function closeTab(id) {
  const t = store.tabs[id];
  const tabPanes = panesOf(id);
  const total = tabPanes.length;
  // "not yet done" = an agent actively working, or one waiting on your approval.
  const busy = tabPanes.filter((p) => p.state === 'working' || p.state === 'approval');

  // First confirmation — always.
  const ok = await askConfirm({
    title: `Close “${t.name}”?`,
    message: `This stops ${total} terminal${total !== 1 ? 's' : ''} in this tab. `
      + `“${t.name}” stays in your Open list — you can open it again anytime.`,
    confirmLabel: 'Close tab',
    danger: busy.length > 0,
  });
  if (!ok) { flash('kept'); return; }

  // Second, stronger confirmation if an agent is still in progress.
  if (busy.length > 0) {
    const names = busy.map((p) => (p.title.textContent || p.id).trim()).join(', ');
    const ok2 = await askConfirm({
      title: '⚠ Agents are still working',
      message: `${busy.length} agent${busy.length !== 1 ? 's are' : ' is'} still in progress `
        + `(${names}).\n\nClosing now interrupts them and the unfinished work is lost. `
        + `Are you absolutely sure?`,
      confirmLabel: 'Discard & close',
      danger: true,
    });
    if (!ok2) { flash('kept'); return; }
  }

  // Keep the workspace name reopenable (with fresh settings).
  store.recents[t.name] = { toolbar: id === store.active ? currentToolbar() : t.toolbar };

  for (const p of panesOf(id)) {
    window.hydra.kill(p.id);
    p.term.dispose();
    p.el.remove();
    panes.delete(p.id);
  }
  delete store.tabs[id];
  store.open = store.open.filter((x) => x !== id);
  if (store.active === id) {
    if (isZen()) exitZen();
    // Falls back to null when that was the last tab → the welcome screen.
    store.active = store.open[0] || null;
    showActiveWorkspace();
    const first = store.active ? panesOf(store.active)[0] : null;
    if (first) focusPane(first);
  } else {
    renderTabs();
    updateSummary();
  }
  saveState();
  flash(`closed: ${t.name}`);
}

// A yes/no confirmation modal. Resolves to true (confirmed) or false.
// When `danger` is set, the confirm button is red and focus defaults to Cancel
// (so a stray Enter can't blow away running work).
function askConfirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title"></div>
        <div class="modal-message"></div>
        <div class="modal-actions">
          <button class="modal-cancel">Cancel</button>
          <button class="modal-ok ${danger ? 'danger' : ''}"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = title;
    overlay.querySelector('.modal-message').textContent = message;
    const okBtn = overlay.querySelector('.modal-ok');
    const cancelBtn = overlay.querySelector('.modal-cancel');
    okBtn.textContent = confirmLabel;
    document.body.appendChild(overlay);
    (danger ? cancelBtn : okBtn).focus();

    const done = (val) => { overlay.remove(); resolve(val); };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      // Enter confirms only for non-danger prompts; danger requires a click.
      if (e.key === 'Enter' && !danger) { e.preventDefault(); done(true); }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
  });
}

// Name + working-directory + connection prompt for a workspace. Used for both
// "New workspace" and "Edit workspace". `initial` prefills the fields:
//   { name, dir, target, okLabel }. Resolves to { name, dir, target } or null.
function askWorkspace(title, initial = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title"></div>
        <label class="modal-label">Name</label>
        <input class="modal-input ws-name" type="text" spellcheck="false" placeholder="e.g. backend" />
        <label class="modal-label">Working directory</label>
        <div class="modal-row">
          <input class="modal-input ws-dir" type="text" spellcheck="false" placeholder="default: home directory" />
          <button class="modal-browse">Browse…</button>
        </div>
        <label class="modal-label">Connection</label>
        <div class="conn-options"></div>
        <input class="modal-input ws-ssh" type="text" spellcheck="false" placeholder="user@hostname" style="display:none; margin-top:6px;" />
        <div class="modal-actions">
          <button class="modal-cancel">Cancel</button>
          <button class="modal-ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = title;
    overlay.querySelector('.modal-ok').textContent = initial.okLabel || 'Create';
    const nameEl = overlay.querySelector('.ws-name');
    const dirEl = overlay.querySelector('.ws-dir');
    const sshEl = overlay.querySelector('.ws-ssh');
    const optsEl = overlay.querySelector('.conn-options');
    nameEl.value = initial.name || '';
    dirEl.value = initial.dir || '';

    // Connection options, mirroring the bottom-left indicator picker.
    const init = (initial.target && initial.target.kind) ? initial.target : defaultRemote();
    let sel = init.kind;
    sshEl.value = init.kind === 'ssh' ? (init.host || '') : '';
    const choices = [];
    if (env.isWin) {
      // Native Windows install: WSL (where Claude Code lives) + PowerShell.
      choices.push({ kind: 'wsl', icon: ICO_WSL, name: 'WSL', sub: 'Default WSL distro' });
      choices.push({ kind: 'local', icon: ICO_WIN, name: 'PowerShell', sub: 'Windows shell' });
    } else {
      choices.push({ kind: 'wsl', icon: ICO_WSL,
        name: env.isWsl ? `WSL: ${env.distro || 'Linux'}` : 'Local',
        sub: env.isWsl ? 'This machine (WSL distro)' : 'This machine' });
      if (env.isWsl) choices.push({ kind: 'local', icon: ICO_WIN, name: 'Local (Windows)', sub: 'Windows host via WSL interop' });
    }
    choices.push({ kind: 'ssh', icon: ICO_SSH, name: 'Connect via SSH', sub: 'A remote host over ssh' });

    function paint() {
      optsEl.innerHTML = '';
      for (const c of choices) {
        const row = document.createElement('div');
        row.className = 'remote-item' + (c.kind === sel ? ' active' : '');
        row.innerHTML = c.icon
          + `<span class="remote-item-main"><span class="remote-item-name"></span><span class="remote-item-sub"></span></span>`
          + `<span class="remote-item-tag"></span>`;
        row.querySelector('.remote-item-name').textContent = c.name;
        row.querySelector('.remote-item-sub').textContent = c.sub;
        if (c.kind === sel) row.querySelector('.remote-item-tag').textContent = '✓';
        row.addEventListener('click', () => {
          sel = c.kind;
          sshEl.style.display = sel === 'ssh' ? '' : 'none';
          paint();
          if (sel === 'ssh') sshEl.focus();
        });
        optsEl.appendChild(row);
      }
      sshEl.style.display = sel === 'ssh' ? '' : 'none';
    }
    paint();

    document.body.appendChild(overlay);
    nameEl.focus();
    if (initial.name) nameEl.select();

    const done = (val) => { overlay.remove(); resolve(val); };
    const submit = () => {
      const name = (nameEl.value || '').trim();
      if (!name) { nameEl.focus(); return; }       // name is required
      const host = (sshEl.value || '').trim();
      if (sel === 'ssh' && !host) { sshEl.focus(); return; }   // SSH needs a host
      const target = { kind: sel, host: sel === 'ssh' ? host : '' };
      done({ name, dir: (dirEl.value || '').trim(), target });
    };
    overlay.querySelector('.modal-ok').onclick = submit;
    overlay.querySelector('.modal-cancel').onclick = () => done(null);
    overlay.querySelector('.modal-browse').onclick = async () => {
      const picked = await browseDir(dirEl.value || '');
      if (picked) dirEl.value = picked;
      nameEl.focus();
    };
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
  });
}

// In-app, VSCode-themed folder picker. The native GTK dialog can't be themed
// under WSLg, so we navigate directories ourselves via fs:listDir. Resolves to
// the chosen absolute path, or null if cancelled.
function browseDir(startPath) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal dir-picker">
        <div class="modal-title">Select working directory</div>
        <div class="dir-path"><span class="dir-path-text"></span></div>
        <div class="dir-list"></div>
        <div class="modal-actions">
          <button class="modal-cancel">Cancel</button>
          <button class="modal-ok">Select this folder</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Inline SVGs (matching the toolbar icon style) — emoji don't render here.
    const FOLDER_ICON = '<svg class="dir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    const UP_ICON = '<svg class="dir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';

    const pathEl = overlay.querySelector('.dir-path-text');
    const listEl = overlay.querySelector('.dir-list');
    let current = null;   // absolute path currently shown

    const done = (val) => { overlay.remove(); resolve(val); };

    async function navigate(target) {
      const res = await window.hydra.listDir(target);
      if (!res) return;
      current = res.path;
      pathEl.textContent = res.path;
      listEl.innerHTML = '';

      if (res.parent) {
        const up = document.createElement('div');
        up.className = 'dir-entry dir-up';
        up.innerHTML = UP_ICON + '<span class="dir-name">..</span>';
        up.onclick = () => navigate(res.parent);
        listEl.appendChild(up);
      }
      if (!res.entries.length && !res.parent) {
        const empty = document.createElement('div');
        empty.className = 'dir-empty';
        empty.textContent = 'No subfolders';
        listEl.appendChild(empty);
      }
      for (const name of res.entries) {
        const row = document.createElement('div');
        row.className = 'dir-entry';
        row.innerHTML = FOLDER_ICON + '<span class="dir-name"></span>';
        row.querySelector('.dir-name').textContent = name;
        row.onclick = () => navigate(current.replace(/\/+$/, '') + '/' + name);
        listEl.appendChild(row);
      }
      listEl.scrollTop = 0;
    }

    overlay.querySelector('.modal-ok').onclick = () => done(current);
    overlay.querySelector('.modal-cancel').onclick = () => done(null);
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(current); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });

    navigate(startPath || '');
  });
}

// ---- connection indicator (per-workspace; VSCode-style bottom-left) --------
// The bottom-left pill shows the ACTIVE workspace's connection. The connection
// is a workspace property, chosen in Add/Edit Workspace — clicking the pill
// opens Edit Workspace for the active tab.

// The machine ClaudeIDE runs on. Under WSL that's the distro ("WSL: Ubuntu", like
// VSCode); on a plain Linux/Mac host it's just "Local".
function defaultRemote() { return { kind: 'wsl', host: '' }; }

function remoteLabel(r) {
  if (!r) return 'Local';
  if (r.kind === 'ssh') return `SSH: ${r.host || '?'}`;
  if (r.kind === 'local') return env.isWin ? 'PowerShell' : 'Local (Windows)';
  // 'wsl' kind: a WSL distro on a WSL/Windows host, else the plain local shell.
  if (env.isWsl) return `WSL: ${env.distro || 'Linux'}`;
  if (env.isWin) return 'WSL';
  return 'Local';
}

// Connection icons, reused by the indicator and the Add/Edit Workspace picker.
const REMOTE_SVG = (d) =>
  `<svg class="remote-item-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICO_WSL = REMOTE_SVG('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/>');
const ICO_WIN = REMOTE_SVG('<path d="M3 5l8-1v7H3zM11 4l10-1v9H11zM3 12h8v6l-8-1zM11 12h10v9l-10-1z"/>');
const ICO_SSH = REMOTE_SVG('<path d="M4 5h16v14H4z"/><path d="M8 9l3 3-3 3M13 15h4"/>');

// Paint the pill from the active workspace's connection.
function renderRemote() {
  const btn = document.getElementById('remote-indicator');
  if (!btn || !store) return;
  const label = remoteLabel(workspaceTarget(store.active));
  btn.querySelector('.remote-label').textContent = label;
  const name = (store.tabs[store.active] && store.tabs[store.active].name) || '';
  btn.title = `Connection for “${name}”: ${label} — click to edit workspace`;
}

// ---- attention jump + transient toast --------------------------------------
let flashTimer = null;
function flash(msg) {
  let f = document.getElementById('flash');
  if (!f) { f = document.createElement('div'); f.id = 'flash'; document.body.appendChild(f); }
  f.textContent = msg;
  f.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove('show'), 1300);
}

function needsAttention(p) { return p.state === 'approval' || p.state === 'error'; }

// Cycle focus to the next pane that needs you — ACROSS workspaces, switching
// tabs if the next one lives in a background workspace.
function jumpToAttention() {
  const order = [...panes.values()];
  if (!order.some(needsAttention)) { flash('✓ nothing needs you'); return; }
  const cur = order.findIndex((p) => p.el.classList.contains('focused'));
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(cur + i + order.length) % order.length];
    if (cand && needsAttention(cand)) {
      if (isZen() && cand.id !== zenId) exitZen();   // don't stay trapped in focus
      if (cand.workspace !== store.active) switchTab(cand.workspace);
      focusPane(cand);
      cand.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const name = (cand.title.textContent || cand.id).trim();
      flash(`${cand.wsName || ''} / ${name} — ${cand.state === 'approval' ? 'needs you' : 'error'}`);
      return;
    }
  }
}

function handleShortcut(e) {
  if (e.key === 'F11') { toggleZenFocused(); return true; }
  if (e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j')) { jumpToAttention(); return true; }
  // Ctrl+Shift+V — insert the path of a file/image copied to the Windows clipboard.
  // Under WSLg neither drag-from-Explorer nor a normal paste can deliver a Windows
  // file, so we reach across to the Windows clipboard and type its path instead.
  if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) { insertClipboardPath(); return true; }
  if (e.ctrlKey && !e.shiftKey && (e.key === 'T' || e.key === 't')) {
    if (store.active) createPane(); else newWorkspace();
    return true;
  }
  // Ctrl+Tab / Ctrl+Shift+Tab — cycle through workspace tabs
  if (store && e.ctrlKey && e.key === 'Tab') { switchTabBy(e.shiftKey ? -1 : 1); return true; }
  // Ctrl+1..9 — jump straight to the Nth tab
  if (store && e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
    switchTabByIndex(parseInt(e.key, 10) - 1);
    return true;
  }
  return false;
}

// Pull whatever file/image is on the Windows clipboard (via the main process'
// PowerShell bridge) and type its shell-quoted path into the focused pane. This
// is the WSLg-friendly stand-in for VSCode's "drag a file into the terminal".
function insertClipboardPath(target) {
  if (!window.hydra.grabClipboard) return;
  const p = target || panes.get(focusedId);
  if (!p) return;
  window.hydra.grabClipboard().then((raws) => {
    if (!raws || !raws.length) { flash('No file or image on the Windows clipboard'); return; }
    const quoted = raws.map((r) => shellQuotePath(toLocalPath(r))).filter(Boolean).join(' ');
    if (!quoted) { flash('Could not resolve the clipboard path'); return; }
    window.hydra.input(p.id, quoted);
    focusPane(p);
  }).catch(() => flash('Could not read the Windows clipboard'));
}

function switchTabByIndex(i) {
  const ids = store.open;
  if (ids[i] && ids[i] !== store.active) switchTab(ids[i]);
}
function switchTabBy(delta) {
  const ids = store.open;
  if (ids.length < 2) return;
  const cur = ids.indexOf(store.active);
  switchTab(ids[(cur + delta + ids.length) % ids.length]);
}

// Apply a detector result (or a bare state string) to a pane's UI.
function applyStatus(p, res) {
  const state = res.state;
  const prev = p.state;
  const ui = STATE_UI[state] || STATE_UI.ready;
  p.state = state;

  // Edge-trigger a desktop notification when a pane first starts needing you.
  // (Edge, not level, so a pane stuck at the prompt only pings once.)
  if (state === 'approval' && prev !== 'approval') notifyNeedsYou(p, res);

  p.dot.className = `dot ${ui.dot}`;
  p.stateLabel.className = `pane-state-label state-${ui.css}`;
  p.stateLabel.textContent = (res.label || state).slice(0, 16);

  // status line = activity detail + compact meta (elapsed / tokens / context)
  const meta = res.meta || {};
  const metaBits = [meta.elapsed, meta.tokens, meta.context].filter(Boolean);
  let text = res.detail || '';
  if (metaBits.length) text += (text ? '   ' : '') + metaBits.join(' · ');
  p.status.textContent = text;
  p.status.title = text;

  // draw the eye to panes that need a human decision
  p.el.classList.toggle('needs-attention', state === 'approval');
  p.el.classList.toggle('has-error', state === 'error');
}

function notifyNeedsYou(p, res) {
  // Honor the notify setting of the pane's OWN tab (it may be a background tab
  // whose toolbar isn't currently shown).
  const t = store && store.tabs[p.workspace];
  const notifyOn = t ? t.toolbar.notify !== false : true;
  if (!notifyOn) return;
  const name = (p.title.textContent || p.id).trim();
  window.hydra.notify({
    id: p.id,
    title: `${p.wsName || 'ClaudeIDE'} / ${name} needs you`,
    body: res.detail || 'Awaiting your approval',
  });
}

// ---- live status loop ------------------------------------------------------
function tick() {
  for (const p of panes.values()) {
    if (p.exited) {
      applyStatus(p, { state: 'dead', label: 'exited', detail: 'process exited', meta: {} });
      continue;
    }
    const lines = readScreen(p.term, SCREEN_ROWS);
    const res = window.detectClaudeStatus(lines);
    applyStatus(p, res);
  }
  updateSummary();
}

function statusSeg(dot, count, label) {
  return `<span class="st-item"><span class="st-dot ${dot}"></span>${count} ${label}</span>`;
}

function updateSummary() {
  if (!store) return;
  // Summary line describes the ACTIVE workspace (what's on screen)...
  const a = workspaceStatus(store.active);
  summaryEl.innerHTML =
    `<span class="st-item">${a.total} pane${a.total !== 1 ? 's' : ''}</span>` +
    statusSeg('busy', a.working, 'working') +
    statusSeg('approval', a.approval, 'need you') +
    statusSeg('ready', a.ready, 'ready') +
    statusSeg('error', a.error, 'error') +
    statusSeg('dead', a.dead, 'exited');
  summaryEl.classList.toggle('alert', a.approval + a.error > 0);

  // ...while the title + jump button count attention across ALL workspaces.
  let attnAll = 0;
  for (const p of panes.values()) if (needsAttention(p)) attnAll++;
  document.title = attnAll > 0 ? `(${attnAll}!) ClaudeIDE` : 'ClaudeIDE';

  const jb = document.getElementById('jump-attn');
  jb.querySelector('.jump-label').textContent = attnAll > 0 ? `next (${attnAll})` : 'next';
  jb.classList.toggle('armed', attnAll > 0);

  updateTabStatus();
}

// ---- pty stream wiring -----------------------------------------------------
window.hydra.onData(({ id, data }) => {
  const p = panes.get(id);
  if (!p) return;
  p.term.write(data);
  p.lastData = performance.now();
  // Status is derived from the composited screen on the next tick (readScreen),
  // which correctly resolves Claude's in-place TUI redraws.
});

window.hydra.onExit(({ id }) => {
  const p = panes.get(id);
  if (!p) return;
  p.exited = true;
  applyStatus(p, { state: 'dead', label: 'exited', detail: 'process exited', meta: {} });
});

// Clicking a desktop notification focuses (and scrolls to) the right pane,
// switching to its workspace tab first if needed.
window.hydra.onFocusPane(({ id }) => {
  const p = panes.get(id);
  if (!p) return;
  if (isZen() && p.id !== zenId) exitZen();
  if (p.workspace !== store.active) switchTab(p.workspace);
  focusPane(p);
  p.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

// ---- toolbar ---------------------------------------------------------------
// With no tab open there's nowhere to put a pane, so these start a workspace.
document.getElementById('add-pane').addEventListener('click', () => {
  if (!store.active) { newWorkspace(); return; }
  createPane();
});

document.querySelectorAll('.layout-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (!store.active) { newWorkspace(); return; }
    setPaneCount(parseInt(b.dataset.n, 10));
  });
});

// Welcome screen (shown when no tab is open) actions.
document.getElementById('welcome-new').addEventListener('click', () => newWorkspace());
document.getElementById('welcome-open').addEventListener('click', (e) =>
  showWorkspaceMenu(e.currentTarget));

function setPaneCount(target) {
  // operates on the ACTIVE workspace only
  while (panesOf(store.active).length < target) createPane();
  if (panesOf(store.active).length > target) {
    flash(`This workspace has ${panesOf(store.active).length} panes; close some to reach ${target}.`);
  }
}

document.addEventListener('keydown', (e) => {
  if (handleShortcut(e)) e.preventDefault();
});

// File menu + jump controls
document.getElementById('file-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  showFileMenu(e.currentTarget);
});
document.getElementById('jump-attn').addEventListener('click', jumpToAttention);
document.getElementById('remote-indicator').addEventListener('click', (e) => {
  e.stopPropagation();
  editWorkspace(store.active);   // connection lives on the workspace now
});
document.getElementById('zen-exit').addEventListener('click', exitZen);

// custom title-bar window controls (the window is frameless)
document.getElementById('win-min').addEventListener('click', () => window.hydra.minimize());
document.getElementById('win-max').addEventListener('click', () => window.hydra.toggleMaximize());
document.getElementById('win-close').addEventListener('click', () => window.hydra.closeWindow());
// Manual title-bar behavior: drag to move, double-click to maximize. We can't
// use CSS `-webkit-app-region: drag` because WSLg swallows mouse events on drag
// regions (so double-click never fires). We detect both here and drive the
// window over IPC. Interactive children (buttons/inputs/menu) are excluded.
(function setupTitlebarDrag() {
  const bar = document.getElementById('toolbar');
  const INTERACTIVE = 'button, input, select, label, .window-controls, .menu-btn';
  let dragging = false;
  let pending = null;   // latest cursor position awaiting a frame
  let rafId = 0;

  // Coalesce mousemove to at most one window move per animation frame. WSLg's
  // setPosition is slow, so firing it on every raw mousemove backlogs and the
  // window lags behind the cursor; sending only the newest position per frame
  // keeps it tracking smoothly.
  const flush = () => {
    rafId = 0;
    if (dragging && pending) { window.hydra.dragMove(pending.x, pending.y); pending = null; }
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    pending = null;
    window.hydra.dragEnd();
  };

  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest(INTERACTIVE)) return;
    if (e.detail >= 2) {                 // second click of a double-click → maximize
      endDrag();
      window.hydra.toggleMaximize();
      return;
    }
    dragging = true;
    window.hydra.dragStart(e.screenX, e.screenY);
    e.preventDefault();                  // don't start a text selection
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    pending = { x: e.screenX, y: e.screenY };
    if (!rafId) rafId = requestAnimationFrame(flush);
  });
  window.addEventListener('mouseup', endDrag);
  // If the cursor leaves the window or focus is lost mid-drag, stop cleanly.
  window.addEventListener('blur', endDrag);
})();
// reflect the real maximize state on the button (restore vs maximize icon)
window.hydra.onWindowState(({ maximized }) => {
  document.getElementById('win-max').classList.toggle('is-maximized', maximized);
});

// persist toolbar template changes
['autorun', 'notify-toggle', 'cmd', 'cwd'].forEach((elId) => {
  const elm = document.getElementById(elId);
  elm.addEventListener('change', scheduleSave);
  elm.addEventListener('input', scheduleSave);
});

window.addEventListener('resize', () => {
  for (const p of panes.values()) fitPane(p);
});

// ---- text zoom -------------------------------------------------------------
// Zoom scales the whole renderer (chrome + terminals); the main process drives
// it (menu accelerators Ctrl+= / Ctrl+- / Ctrl+0 + the File-menu items). Here we
// just reflow terminals to the new size, persist the level, and show a hint.
let suppressZoomFlash = false;   // set true around the silent boot-restore apply
window.hydra.onZoom(({ level }) => {
  // Refit after layout settles at the new scale (twice: immediate + a beat later).
  requestAnimationFrame(() => { for (const p of panes.values()) fitPane(p); });
  setTimeout(() => { for (const p of panes.values()) fitPane(p); }, 80);
  if (store) { store.zoom = level; scheduleSave(); }
  if (suppressZoomFlash) suppressZoomFlash = false;
  else flash(`Zoom: ${Math.round(Math.pow(1.2, level) * 100)}%`);
});

// Live reorder while dragging a pane: move the dragged element before/after the
// pane under the cursor (left half = before, right half = after).
grid.addEventListener('dragover', (e) => {
  if (!draggingEl) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest('.pane');
  if (!target || target === draggingEl || target.classList.contains('hidden')
      || target.parentElement !== grid) return;
  const r = target.getBoundingClientRect();
  const before = e.clientX < r.left + r.width / 2;
  grid.insertBefore(draggingEl, before ? target : target.nextSibling);
});
grid.addEventListener('drop', (e) => { if (draggingEl) e.preventDefault(); });

// Safety net: a file dropped anywhere other than a terminal body would otherwise
// make Electron navigate the whole window to that file. Swallow those drops so a
// near-miss outside a pane is a harmless no-op instead of blowing away the app.
const isExternalFileDrag = (e) =>
  !draggingEl && e.dataTransfer &&
  Array.prototype.includes.call(e.dataTransfer.types || [], 'Files');
window.addEventListener('dragover', (e) => {
  // A pane body's own handler accepts the drop ('copy'); leave it alone.
  if (e.target.closest && e.target.closest('.pane-body')) return;
  if (isExternalFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
});
window.addEventListener('drop', (e) => {
  if (e.target.closest && e.target.closest('.pane-body')) return;
  if (isExternalFileDrag(e)) e.preventDefault();
});

// flush a save synchronously when the window is closing
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); saveState(); });

// ---- boot ------------------------------------------------------------------
(async function boot() {
  env = await window.hydra.envInfo();
  document.getElementById('cwd').placeholder = `working dir (default: ${env.home})`;

  store = normalizeStore(await window.hydra.loadState());

  // Apply the saved color theme before any terminal is created, so panes spawn
  // with the right palette and the chrome paints correctly from the first frame.
  store.theme = XTERM_THEMES[store.theme] ? store.theme : 'dark';
  applyTheme(store.theme, { persist: false });

  // Restore the saved text-zoom level (no-op at 0). Triggers a zoom:changed that
  // refits terminals once they exist; suppress its toast (it's not a user action).
  if (typeof store.zoom === 'number' && store.zoom !== 0) {
    suppressZoomFlash = true;
    window.hydra.zoom('set', store.zoom);
  }

  // Migrate the old global connection (store.remote) into each workspace's
  // toolbar, then drop it — connection is per-workspace now. Workspaces that
  // never had one fall back to this machine.
  const legacy = store.remote && store.remote.kind ? store.remote : null;
  for (const t of Object.values(store.tabs)) {
    if (t.toolbar && !(t.toolbar.target && t.toolbar.target.kind)) t.toolbar.target = legacy || defaultRemote();
  }
  for (const r of Object.values(store.recents)) {
    if (r.toolbar && !(r.toolbar.target && r.toolbar.target.kind)) r.toolbar.target = legacy || defaultRemote();
  }
  delete store.remote;
  renderRemote();   // paint the active workspace's connection

  // Bring up every OPEN tab's panes (all alive); closed workspaces in the
  // recents registry stay dormant until reopened. Visibility hides inactive tabs.
  for (const id of store.open) {
    const t = store.tabs[id];
    for (const sp of t.panes || []) {
      createPane({ workspace: id, label: sp.label, pinned: sp.pinned, cwd: sp.cwd, command: sp.command });
    }
  }
  // First run (or an empty active tab): seed it with the default panes.
  if (!panesOf(store.active).length) {
    restoreToolbar(store.tabs[store.active].toolbar);
    setPaneCount(DEFAULT_PANES);
  }
  showActiveWorkspace();

  setInterval(tick, 400);
  // Keep the git footer fresh — branch/cwd can change inside the terminal
  // (checkout, cd) and we have no other signal for it. Only the focused pane
  // feeds the footer, so that's all we poll.
  setInterval(() => {
    if (document.hidden) return;
    refreshGit(panes.get(focusedId));
  }, 4000);
})();
