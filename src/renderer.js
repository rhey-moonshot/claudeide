'use strict';

/* global Terminal, FitAddon */

// ---------------------------------------------------------------------------
// ClaudeIDE renderer — a grid of live terminals, each a Claude Code session,
// each with a derived status (busy / ready / waiting / dead).
// ---------------------------------------------------------------------------

// Theme the chrome before first paint, from the value main passed in (boot later
// re-confirms it from the saved store, which is authoritative).
try { document.documentElement.dataset.theme = (window.hydra && window.hydra.initialTheme) || 'dark'; } catch (_) {}

const editor = document.getElementById('editor');
const summaryEl = document.getElementById('summary');

let env = { home: '', shell: '', platform: 'linux' };
let seq = 0;
let panes = new Map(); // id -> pane object (order == on-screen order)
let draggingEl = null;  // pane element currently being dragged to rearrange
let zenId = null;       // id of the pane in focus (zen) mode, or null
let focusedId = null;   // id of the currently focused pane (drives the git footer)
let zenFitTimer = null; // refit after the zen transition settles
let tabSeq = 0;         // monotonic counter for unique tab instance ids
let gSeq = 0;           // monotonic counter for unique editor-group ids

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

// ---- editor groups ---------------------------------------------------------
// The editor area (#editor) holds one or more groups side by side, VSCode-style.
// Each group owns an ordered list of open tabs and a single active tab. The flat
// store.active / store.open fields are kept as a mirror of the group structure
// (store.active = the focused group's active tab) so the rest of the app — which
// keys off a single "current tab" — keeps working unchanged.
function groupById(id) { return (store.groups || []).find((g) => g.id === id) || null; }
function activeGroupObj() {
  return groupById(store.activeGroup) || (store.groups || [])[0] || null;
}
function groupOf(tabId) {
  return (store.groups || []).find((g) => g.open.includes(tabId)) || null;
}
// The set of tabs visible right now — one (the active tab) per group.
function visibleTabIds() {
  return new Set((store.groups || []).map((g) => g.active).filter(Boolean));
}
function groupGridEl(groupId) {
  const sec = editor.querySelector(`.group[data-group="${groupId}"]`);
  return sec ? sec.querySelector('.group-grid') : null;
}
// Mirror the flat fields onto the group structure (after any structural change).
function syncOpenActive() {
  store.open = (store.groups || []).flatMap((g) => g.open);
  const ag = activeGroupObj();
  store.active = ag ? ag.active : null;
  store.activeGroup = ag ? ag.id : null;
}
// Enforce the invariants: every open tab in exactly one group, each group's
// `active` is one of its tabs, empty groups dropped, a valid focused group.
function ensureGroups() {
  if (!store.groups || !store.groups.length) {
    store.groups = (store.open && store.open.length)
      ? [{ id: 'g' + (++gSeq), open: [...store.open], active: store.active, flex: 1 }]
      : [];
  }
  for (const g of store.groups) {
    g.open = g.open.filter((id) => store.tabs[id]);
    if (!g.open.includes(g.active)) g.active = g.open[0] || null;
    if (!g.flex) g.flex = 1;
  }
  store.groups = store.groups.filter((g) => g.open.length);
  syncOpenActive();
}

// Park a pane's element inside the grid of the group its tab belongs to.
function placePane(p) {
  const g = groupOf(p.workspace);
  const gridEl = g ? groupGridEl(g.id) : null;
  if (gridEl && p.el.parentElement !== gridEl) gridEl.appendChild(p.el);
}

function makeGroupSection(g) {
  const sec = document.createElement('section');
  sec.className = 'group';
  sec.dataset.group = g.id;
  sec.innerHTML = '<nav class="group-tabbar"><div class="group-tabs"></div></nav>'
    + '<div class="group-grid"></div>';
  // Focus the group when you click anywhere inside it.
  sec.addEventListener('mousedown', () => focusGroup(g.id));
  return sec;
}

// Reconcile #editor's DOM (group sections + sashes) to match store.groups,
// preserving each live .group-grid (and the pane elements inside it). Sections
// are only re-attached when the group set/order actually changes — re-parenting
// a section that holds the focused terminal would blur it.
function ensureGroupsDom() {
  const want = store.groups || [];
  const existing = new Map();
  for (const sec of editor.querySelectorAll('.group')) existing.set(sec.dataset.group, sec);
  for (const [id, sec] of existing) {
    if (!want.find((g) => g.id === id)) { sec.remove(); existing.delete(id); }
  }
  const wantIds = want.map((g) => g.id);
  const curIds = [...editor.querySelectorAll('.group')].map((s) => s.dataset.group);
  const sashCount = editor.querySelectorAll('.group-sash').length;
  const inOrder = curIds.length === wantIds.length
    && curIds.every((id, i) => id === wantIds[i])
    && sashCount === Math.max(0, wantIds.length - 1)
    && wantIds.every((id) => existing.has(id));

  if (!inOrder) {
    for (const s of editor.querySelectorAll('.group-sash')) s.remove();
    let prev = null;
    for (const g of want) {
      let sec = existing.get(g.id);
      if (!sec) { sec = makeGroupSection(g); existing.set(g.id, sec); }
      if (prev) {
        const sash = document.createElement('div');
        sash.className = 'group-sash';
        wireSash(sash, prev, g.id);
        editor.appendChild(sash);
      }
      editor.appendChild(sec);   // moves existing nodes into order; new ones appended
      prev = g.id;
    }
  }
  // Flex weights + pane parenting are cheap and never reattach terminals.
  for (const g of want) {
    const sec = existing.get(g.id);
    if (sec) sec.style.flex = `${g.flex || 1} 1 0`;
  }
  for (const p of panes.values()) placePane(p);
}

// Drag a sash to resize the two groups it sits between.
function wireSash(sash, leftId, rightId) {
  sash.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const leftSec = editor.querySelector(`.group[data-group="${leftId}"]`);
    const rightSec = editor.querySelector(`.group[data-group="${rightId}"]`);
    const lg = groupById(leftId), rg = groupById(rightId);
    if (!leftSec || !rightSec || !lg || !rg) return;
    const startX = e.clientX;
    const lw = leftSec.getBoundingClientRect().width;
    const rw = rightSec.getBoundingClientRect().width;
    const totalFlex = (lg.flex || 1) + (rg.flex || 1);
    sash.classList.add('dragging');
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const nlw = Math.max(140, lw + dx);
      const nrw = Math.max(140, rw - dx);
      const sum = nlw + nrw;
      lg.flex = totalFlex * (nlw / sum);
      rg.flex = totalFlex * (nrw / sum);
      leftSec.style.flex = `${lg.flex} 1 0`;
      rightSec.style.flex = `${rg.flex} 1 0`;
      for (const p of [...panesOf(lg.active), ...panesOf(rg.active)]) fitPane(p);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      sash.classList.remove('dragging');
      relayout();
      scheduleSave();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Rebuild the panes Map to match the current DOM order (after a drag). This
// keeps per-workspace ordering — and therefore persistence — in sync. Panes are
// spread across each group's grid, so we walk the grids in on-screen order.
function rebuildPaneOrder() {
  const next = new Map();
  for (const gridEl of editor.querySelectorAll('.group-grid')) {
    for (const el of gridEl.children) {
      const id = el.dataset.id;
      if (id && panes.has(id)) next.set(id, panes.get(id));
    }
  }
  for (const [id, p] of panes) if (!next.has(id)) next.set(id, p); // safety
  panes = next;
}

// Lay out each group's grid for its active tab's pane count.
function relayout() {
  for (const g of (store.groups || [])) {
    const gridEl = groupGridEl(g.id);
    if (!gridEl) continue;
    const n = g.active ? panesOf(g.active).length : 0;
    const cols = layoutColumns(n);
    const rows = Math.ceil(n / cols) || 1;
    gridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    gridEl.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  }
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
  el.className = 'pane' + (visibleTabIds().has(workspace) ? '' : ' hidden');
  el.dataset.id = id;
  el.innerHTML = `
    <div class="pane-head" draggable="true">
      <span class="grip" title="Drag to rearrange">⠿</span>
      <span class="dot dead"></span>
      <span class="pane-title" contenteditable="true" spellcheck="false" draggable="false"></span>
      <span class="pane-state-label state-dead">init</span>
      <span class="pane-status"></span>
      <button class="pane-btn explorer" title="Open File Explorer for this folder (F4)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>
      <button class="pane-btn paste-path" title="Insert file/image path from the Windows clipboard (Ctrl+Shift+V)">ℹ</button>
      <button class="pane-btn restart" title="Restart command">↻</button>
      <button class="pane-btn close" title="Close pane">✕</button>
    </div>
    <div class="pane-body"></div>`;
  // Park the pane in its group's grid (falls back to the first group's grid).
  const hostGrid = (groupOf(workspace) && groupGridEl(groupOf(workspace).id))
    || editor.querySelector('.group-grid');
  if (hostGrid) hostGrid.appendChild(el); else editor.appendChild(el);

  const term = new Terminal({
    theme: xtermTheme(themeId),
    // Match VSCode's default terminal font per platform: Consolas (Windows),
    // Menlo (macOS), Droid Sans Mono (Linux), with a generic fallback.
    fontFamily: 'Consolas, "Courier New", Menlo, Monaco, "Droid Sans Mono", monospace',
    fontSize: 14,            // VSCode's default terminal/editor font size
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // SerializeAddon snapshots the live screen on demand — used to seed a Super
  // Saiyan mirror so the popup shows the prompt instantly. Idle until called.
  const serialize = new SerializeAddon.SerializeAddon();
  term.loadAddon(serialize);
  term.open(el.querySelector('.pane-body'));

  // Intercept app shortcuts before xterm forwards the keys to the PTY.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (handleShortcut(e)) { e.preventDefault(); e.stopPropagation(); return false; }
    return true;
  });

  const p = {
    id, el, term, fit, serialize,
    dot: el.querySelector('.dot'),
    stateLabel: el.querySelector('.pane-state-label'),
    status: el.querySelector('.pane-status'),
    title: el.querySelector('.pane-title'),
    git: null,        // last-seen { branch, repo, detached } or null
    lastData: 0,
    state: 'init',
    // "Your turn": set when the pane finishes a turn (was busy, now idle) and you
    // weren't watching it; cleared when you focus the pane. `settling` debounces a
    // single-tick spinner misread; `lastRes` lets focus repaint the badge at once.
    awaiting: false,
    settling: false,
    lastRes: null,
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
  el.querySelector('.explorer').addEventListener('click', (e) => {
    e.stopPropagation();
    focusPane(p);
    openExplorerForPane(p);
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
  if (visibleTabIds().has(workspace)) { relayout(); focusPane(p); }
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

// Mark which group has keyboard focus (a faint accent line on its tab strip).
function highlightActiveGroup() {
  for (const sec of editor.querySelectorAll('.group'))
    sec.classList.toggle('focused-group', sec.dataset.group === store.activeGroup);
}

// Make `id` the focused group: swap the toolbar/footer/remote to its active tab.
function focusGroup(id) {
  if (!groupById(id)) return;
  if (store.activeGroup === id) { highlightActiveGroup(); return; }
  if (store.tabs[store.active]) store.tabs[store.active].toolbar = currentToolbar();
  store.activeGroup = id;
  syncOpenActive();
  if (store.tabs[store.active]) restoreToolbar(store.tabs[store.active].toolbar);
  highlightActiveGroup();
  renderRemote();
  renderGitStatus();
}

function focusPane(p) {
  for (const q of panes.values()) q.el.classList.toggle('focused', q === p);
  focusedId = p.id;
  // Focusing a pane focuses its group (drives the toolbar/footer/remote pill).
  const g = groupOf(p.workspace);
  if (g && g.id !== store.activeGroup) focusGroup(g.id);
  // Returning to the pane answers its "your turn" — clear the attention flag and
  // repaint its badge right away (don't wait for the next status tick).
  if (p.awaiting || p.settling) {
    p.awaiting = false;
    p.settling = false;
    if (p.lastRes) applyStatus(p, p.lastRes);
    updateSummary();
  }
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
  // Mark the target's group so CSS can hide the other groups + sashes in zen.
  const g = groupOf(p.workspace);
  for (const sec of editor.querySelectorAll('.group'))
    sec.classList.toggle('zen-group', !!g && sec.dataset.group === g.id);
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
  for (const sec of editor.querySelectorAll('.group.zen-group')) sec.classList.remove('zen-group');
  relayout();
  clearTimeout(zenFitTimer);
  zenFitTimer = setTimeout(() => {
    for (const q of visiblePanes()) fitPane(q);
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
  if (superSaiyan) recomputeStack();   // drop its card if it was stacked
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
  // A fresh install (or an emptied store) boots to the welcome screen — we don't
  // auto-load any default workspace. This is the same empty state you reach by
  // closing the last tab: no open tabs, no active tab, nothing in the registry.
  return { version: 5, active: null, open: [], tabs: {}, recents: {}, groups: [], activeGroup: null };
}
// Wrap a flat (open, active) tab list into a single editor group — the shape a
// pre-split (v4 or earlier) save upgrades into.
function groupsFromFlat(open, active) {
  if (!open || !open.length) return { groups: [], activeGroup: null };
  const g = {
    id: 'g' + (++gSeq),
    open: [...open],
    active: active && open.includes(active) ? active : open[0],
    flex: 1,
  };
  return { groups: [g], activeGroup: g.id };
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
// Bring any saved store up to the current (v5) shape: first normalize to the
// flat v4 layout, then fold it into the editor-group structure.
function normalizeStore(s) {
  if (s && s.version === 5 && s.tabs && Array.isArray(s.groups)) {
    for (const id of Object.keys(s.tabs)) {                  // keep tabSeq ahead of saved ids
      const num = parseInt(String(id).replace(/^t/, ''), 10);
      if (Number.isFinite(num) && num > tabSeq) tabSeq = num;
    }
    for (const g of s.groups) {                              // keep gSeq ahead of saved ids
      const num = parseInt(String(g.id).replace(/^g/, ''), 10);
      if (Number.isFinite(num) && num > gSeq) gSeq = num;
      g.open = (g.open || []).filter((id) => s.tabs[id]);
    }
    s.groups = s.groups.filter((g) => g.open.length);
    s.recents = s.recents || {};
    if (!s.groups.length) return { ...freshStore(), recents: s.recents, theme: s.theme, zoom: s.zoom };
    for (const g of s.groups) {
      if (!g.open.includes(g.active)) g.active = g.open[0];
      if (!g.flex) g.flex = 1;
    }
    if (!s.groups.find((g) => g.id === s.activeGroup)) s.activeGroup = s.groups[0].id;
    s.open = s.groups.flatMap((g) => g.open);
    s.active = (s.groups.find((g) => g.id === s.activeGroup) || s.groups[0]).active;
    for (const id of s.open) {
      const nm = s.tabs[id].name;
      if (nm && !s.recents[nm]) s.recents[nm] = { toolbar: s.tabs[id].toolbar || defaultToolbar() };
    }
    return s;
  }
  const v4 = normalizeToV4(s);
  v4.version = 5;
  const { groups, activeGroup } = groupsFromFlat(v4.open, v4.active);
  v4.groups = groups;
  v4.activeGroup = activeGroup;
  return v4;
}
function normalizeToV4(s) {
  if (s && s.version === 4 && s.tabs && Array.isArray(s.open)) {
    for (const id of Object.keys(s.tabs)) {                  // keep tabSeq ahead of saved ids
      const num = parseInt(String(id).replace(/^t/, ''), 10);
      if (Number.isFinite(num) && num > tabSeq) tabSeq = num;
    }
    s.open = s.open.filter((id) => s.tabs[id]);
    // No open tabs → welcome screen, but KEEP the saved-workspace registry and
    // prefs (so closing the last tab, or a blank New Window, still lists them).
    if (!s.open.length) return { ...freshStore(), recents: s.recents || {}, theme: s.theme, zoom: s.zoom };
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
  let working = 0, approval = 0, error = 0, ready = 0, dead = 0, awaiting = 0, total = 0;
  for (const p of panesOf(ws)) {
    total++;
    if (p.state === 'working') working++;
    else if (p.state === 'approval') approval++;
    else if (p.state === 'error') error++;
    else if (p.state === 'dead') dead++;
    else if (p.awaiting) awaiting++;   // idle, but finished a turn → your turn
    else ready++;
  }
  let dot = 'ready';
  if (approval) dot = 'approval';
  else if (error) dot = 'error';
  else if (working) dot = 'busy';
  else if (awaiting) dot = 'approval';   // same attention color as a permission prompt
  else if (total && dead === total) dot = '';
  return { working, approval, error, ready, dead, awaiting, total, dot };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTabs() {
  ensureGroupsDom();   // make sure each group's section + tab strip exist
  // Global duplicate-name counts so the "#k" suffix stays stable across groups.
  const counts = {};
  for (const id of store.open) { const nm = store.tabs[id].name; counts[nm] = (counts[nm] || 0) + 1; }
  const seen = {};
  for (const g of (store.groups || [])) {
    const sec = editor.querySelector(`.group[data-group="${g.id}"]`);
    if (!sec) continue;
    const tabsEl = sec.querySelector('.group-tabs');
    tabsEl.innerHTML = '';
    const focusedGroup = g.id === store.activeGroup;
    let i = 0;
    for (const id of g.open) {
      const t = store.tabs[id];
      const base = t.name;
      let disp = base;
      if (counts[base] > 1) { seen[base] = (seen[base] || 0) + 1; disp = `${base} #${seen[base]}`; }
      const n = ++i; // 1-based position within this group
      // Ctrl+1..9 acts on the focused group, so only annotate those tabs.
      const numbered = focusedGroup && n <= 9;
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === g.active ? ' active' : '');
      tab.dataset.tab = id;
      tab.title = numbered ? `${disp}  ·  Ctrl+${n}` : disp;
      tab.innerHTML = `
        <span class="tab-num">${numbered ? n : ''}</span>
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
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTabMenu(e, id);
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
  }
  // No open tabs → reveal the welcome screen and hide the (empty) editor.
  document.body.classList.toggle('no-tabs', store.open.length === 0);
  highlightActiveGroup();
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
    if (s.awaiting) bits.push(`🔔${s.awaiting}`);
    if (s.error) bits.push(`✗${s.error}`);
    tab.querySelector('.tab-meta').textContent = bits.length ? bits.join(' ') : `${s.total}`;
    tab.classList.toggle('attn', s.approval + s.error + s.awaiting > 0);
  }
}

// Panes on screen right now — the active tab of each group.
function visiblePanes() {
  const vis = visibleTabIds();
  return [...panes.values()].filter((p) => vis.has(p.workspace));
}

// Show each group's active-tab panes; hide the rest (all stay alive in the
// background). Also keeps every pane parented under its group's grid.
function applyVisibility() {
  const vis = visibleTabIds();
  for (const p of panes.values()) {
    placePane(p);
    p.el.classList.toggle('hidden', !vis.has(p.workspace));
  }
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
  renderTabs();          // (re)build group sections before parenting/laying out
  applyVisibility();
  relayout();
  for (const p of visiblePanes()) fitPane(p);
  renderGitStatus();   // footer reflects the now-visible tab's focused pane
  updateSummary();
  renderRemote();   // pill reflects the now-active workspace's connection
}

// Switching tabs is non-destructive: other tabs' terminals keep running in the
// background; we only change what's visible.
function switchTab(id) {
  const g = groupOf(id);
  if (!g) return;
  if (isZen()) exitZen();
  // Already the active tab of the already-focused group → nothing to do.
  if (g.id === store.activeGroup && g.active === id) return;
  if (store.tabs[store.active]) store.tabs[store.active].toolbar = currentToolbar();
  g.active = id;
  store.activeGroup = g.id;
  syncOpenActive();
  showActiveWorkspace();
  const first = panesOf(id)[0];
  if (first) focusPane(first);
  saveState();
  flash(`workspace: ${store.tabs[id].name}`);
}

// Open a NEW tab instance for `name` (always a fresh tab — you can have several
// tabs for the same workspace). Seeds from `paneDefs` or DEFAULT_PANES. The tab
// lands in the focused editor group.
function openTab(name, toolbar, paneDefs) {
  if (isZen()) exitZen();
  if (store.tabs[store.active]) store.tabs[store.active].toolbar = currentToolbar();
  const id = 't' + (++tabSeq);
  store.tabs[id] = { name, toolbar: { ...toolbar }, panes: [] };
  let g = activeGroupObj();
  if (!g) { g = { id: 'g' + (++gSeq), open: [], active: null, flex: 1 }; store.groups.push(g); }
  g.open.push(id);
  g.active = id;
  store.activeGroup = g.id;
  syncOpenActive();
  restoreToolbar(store.tabs[id].toolbar);
  renderTabs();        // build the group's DOM before any pane is parented in
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

// Edit Workspace from the File menu: let the user choose WHICH workspace to
// edit (don't assume the active tab). With one workspace, skip the chooser.
async function editWorkspace() {
  const names = Array.from(new Set([
    ...Object.keys(store.recents),
    ...store.open.map((id) => store.tabs[id] && store.tabs[id].name).filter(Boolean),
  ])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (!names.length) { flash('no workspaces to edit'); return; }
  const activeName = store.tabs[store.active] && store.tabs[store.active].name;
  const name = names.length === 1 ? names[0] : await chooseWorkspace('Edit workspace', names, activeName);
  if (!name) return;
  await editWorkspaceNamed(name);
}

// The bottom-left connection pill edits the ACTIVE workspace directly (its whole
// point is "this tab's connection"), so it bypasses the chooser.
function editActiveWorkspace() {
  const t = store.tabs[store.active];
  if (!t) { flash('no active workspace'); return; }
  editWorkspaceNamed(t.name);
}

// Edit a workspace by name: its name, working dir, and connection. Updates the
// saved definition AND every open tab of that workspace. A new connection
// applies to NEW panes; terminals already running keep their shell.
async function editWorkspaceNamed(name) {
  const openIds = store.open.filter((id) => store.tabs[id] && store.tabs[id].name === name);
  // Source the live definition from an open tab if there is one (prefer the
  // active tab), else from the saved recents entry.
  const srcTab = openIds.includes(store.active) ? store.active : openIds[0];
  const rec = store.recents[name];
  const baseToolbar = (srcTab && store.tabs[srcTab].toolbar) || (rec && rec.toolbar) || defaultToolbar();
  const curDir = ((srcTab === store.active) ? cwdInput() : baseToolbar.cwd) || '';
  const curTarget = (baseToolbar.target && baseToolbar.target.kind) ? baseToolbar.target : defaultRemote();

  const res = await askWorkspace('Edit workspace', { name, dir: curDir, target: curTarget, okLabel: 'Save' });
  if (!res) return;
  const { name: newName, dir, target } = res;
  const connChanged = JSON.stringify(curTarget) !== JSON.stringify(target);
  const renamed = newName !== name;

  // Saved definition under the (possibly new) name; drop the old key on rename.
  const savedToolbar = { ...((rec && rec.toolbar) || baseToolbar), cwd: dir || '', target };
  if (renamed && rec) delete store.recents[name];
  store.recents[newName] = { toolbar: savedToolbar };

  // Apply to every open tab of this workspace.
  for (const id of openIds) {
    store.tabs[id].toolbar = { ...store.tabs[id].toolbar, cwd: dir || '', target };
    if (renamed) {
      store.tabs[id].name = newName;
      for (const p of panesOf(id)) p.wsName = newName;
    }
  }
  // Reflect dir/connection in the toolbar inputs if the active tab was edited.
  if (openIds.includes(store.active)) { document.getElementById('cwd').value = dir || ''; renderRemote(); }

  renderTabs();
  saveState();
  const note = (connChanged && openIds.length) ? ' — new connection applies to new panes' : '';
  flash(`updated: ${newName}${note}`);
}

// Small modal to choose a workspace by name (for Edit Workspace). Resolves to
// the chosen name or null. The active workspace is preselected for quick Enter.
function chooseWorkspace(title, names, activeName) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ws-choose">
        <div class="modal-title"></div>
        <div class="ws-choose-list"></div>
        <div class="modal-actions"><button class="modal-cancel">Cancel</button></div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = title;
    const listEl = overlay.querySelector('.ws-choose-list');
    const done = (v) => { overlay.remove(); resolve(v); };
    for (const nm of names) {
      const rec = store.recents[nm];
      const cwd = (rec && rec.toolbar && rec.toolbar.cwd) || '';
      const openCount = store.open.filter((id) => store.tabs[id] && store.tabs[id].name === nm).length;
      const row = document.createElement('button');
      row.className = 'ws-choose-row' + (nm === activeName ? ' active' : '');
      row.innerHTML = `<span class="ws-choose-main"><span class="ws-choose-name"></span><span class="ws-choose-path"></span></span><span class="ws-choose-tag"></span>`;
      row.querySelector('.ws-choose-name').textContent = nm;
      row.querySelector('.ws-choose-path').textContent = cwd || env.home || '~';
      if (openCount) row.querySelector('.ws-choose-tag').textContent = `${openCount} open`;
      row.addEventListener('click', () => done(nm));
      listEl.appendChild(row);
    }
    overlay.querySelector('.modal-cancel').onclick = () => done(null);
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      if (e.key === 'Enter') { e.preventDefault(); const f = listEl.querySelector('.ws-choose-row:focus') || listEl.querySelector('.ws-choose-row.active'); if (f) f.click(); }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    document.body.appendChild(overlay);
    const act = listEl.querySelector('.ws-choose-row.active') || listEl.firstChild;
    if (act && act.focus) act.focus();
  });
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
    { label: 'New Window', hint: 'Ctrl+Shift+N', run: () => window.hydra.newWindow() },
    { sep: true },
    { label: 'New Workspace…', run: () => newWorkspace() },
    { label: 'Open Workspace…', run: () => showWorkspaceMenu(anchor) },
    { label: 'Edit Workspace…', run: () => editWorkspace() },
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
  // Remove the tab from its group; if that empties the group, drop the group
  // (its section + sash disappear and the neighbors reflow to fill the space).
  const g = groupOf(id);
  const wasActiveTab = id === store.active;
  const wasFocusedGroup = g && g.id === store.activeGroup;
  if (g) {
    g.open = g.open.filter((x) => x !== id);
    if (g.active === id) g.active = g.open[0] || null;
    if (!g.open.length) store.groups = store.groups.filter((x) => x !== g);
  }
  if (!store.groups.find((x) => x.id === store.activeGroup)) {
    store.activeGroup = store.groups[0] ? store.groups[0].id : null;
  }
  syncOpenActive();
  if (wasActiveTab || wasFocusedGroup || !store.open.length) {
    if (isZen()) exitZen();
    // Falls back to the welcome screen when that was the last tab.
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

// ---- split / move tabs between editor groups -------------------------------
// Reparent a tab (with its live panes) into another group. Used by the tab
// context menu. The tab becomes the active tab of the destination group, which
// also becomes the focused group; an emptied source group is dropped.
function moveTabToGroup(id, targetGroupId) {
  const src = groupOf(id);
  const dst = groupById(targetGroupId);
  if (!src || !dst || src === dst) return;
  if (isZen()) exitZen();
  if (store.tabs[store.active]) store.tabs[store.active].toolbar = currentToolbar();
  src.open = src.open.filter((x) => x !== id);
  if (src.active === id) src.active = src.open[0] || null;
  dst.open.push(id);
  dst.active = id;
  if (!src.open.length) store.groups = store.groups.filter((x) => x !== src);
  store.activeGroup = dst.id;
  syncOpenActive();
  showActiveWorkspace();   // rebuilds the group DOM + reparents panes + lays out
  const first = panesOf(id)[0];
  if (first) focusPane(first);
  saveState();
  flash('moved tab');
}

// Split: peel a tab off into a NEW group inserted just to the right of its own.
function splitTabRight(id) {
  const src = groupOf(id);
  if (!src) return;
  if (src.open.length < 2) { flash('only tab in this group — nothing to split'); return; }
  if (isZen()) exitZen();
  if (store.tabs[store.active]) store.tabs[store.active].toolbar = currentToolbar();
  const ng = { id: 'g' + (++gSeq), open: [], active: null, flex: src.flex || 1 };
  store.groups.splice(store.groups.indexOf(src) + 1, 0, ng);
  src.open = src.open.filter((x) => x !== id);
  if (src.active === id) src.active = src.open[0] || null;
  ng.open.push(id);
  ng.active = id;
  store.activeGroup = ng.id;
  syncOpenActive();
  showActiveWorkspace();
  const first = panesOf(id)[0];
  if (first) focusPane(first);
  saveState();
  flash('split → new group');
}

let tabMenuEl = null;
function closeTabMenu() {
  if (tabMenuEl) { tabMenuEl.remove(); tabMenuEl = null; }
  document.removeEventListener('mousedown', onTabMenuOutside, true);
  document.removeEventListener('keydown', onTabMenuKey, true);
}
function onTabMenuOutside(e) { if (tabMenuEl && !tabMenuEl.contains(e.target)) closeTabMenu(); }
function onTabMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeTabMenu(); } }

// Right-click a tab: split it into a new group, move it to another group, or
// close it (VSCode's editor-tab context menu, pared to what we support).
function showTabMenu(ev, id) {
  closeTabMenu();
  const src = groupOf(id);
  if (!src) return;
  const menu = document.createElement('div');
  menu.className = 'app-menu';
  tabMenuEl = menu;

  const items = [
    { label: 'Split Right (new group)', disabled: src.open.length < 2, run: () => splitTabRight(id) },
  ];
  const others = store.groups.filter((g) => g.id !== src.id);
  if (others.length) {
    items.push({ sep: true });
    for (const g of others) {
      items.push({ label: `Move to Group ${store.groups.indexOf(g) + 1}`, run: () => moveTabToGroup(id, g.id) });
    }
  }
  items.push({ sep: true }, { label: 'Close Tab', run: () => closeTab(id) });

  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'menu-item' + (it.disabled ? ' disabled' : '');
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    else b.addEventListener('click', () => { closeTabMenu(); it.run(); });
    menu.appendChild(b);
  }

  document.body.appendChild(menu);
  // Keep the menu on-screen near the cursor.
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, vw - r.width - 4)}px`;
  menu.style.top = `${Math.min(ev.clientY, vh - r.height - 4)}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', onTabMenuOutside, true);
    document.addEventListener('keydown', onTabMenuKey, true);
  }, 0);
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

// Name + connection + working-directory prompt for a workspace. Used for both
// "New workspace" and "Edit workspace". `initial` prefills the fields:
//   { name, dir, target, okLabel }. Resolves to { name, dir, target } or null.
//
// Two-step wizard: pick the name + connection first (step 1), verify it can be
// reached, THEN choose the working directory (step 2) — because "Browse" lists
// the chosen connection's filesystem, so the connection must be settled first.
function askWorkspace(title, initial = {}) {
  return new Promise((resolve) => {
    const isEdit = !!initial.okLabel;            // Edit passes okLabel ('Save')
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ws-wizard">
        <div class="modal-title"><span class="ws-title-text"></span><span class="ws-step-badge"></span></div>

        <div class="ws-step ws-step-1">
          <label class="modal-label">Name</label>
          <input class="modal-input ws-name" type="text" spellcheck="false" placeholder="e.g. backend" />
          <label class="modal-label">Connection</label>
          <div class="conn-options"></div>
          <select class="modal-input ws-distro" style="display:none; margin-top:6px;"></select>
          <input class="modal-input ws-ssh" type="text" spellcheck="false" placeholder="user@hostname" style="display:none; margin-top:6px;" />
          <div class="ws-status" style="display:none;"></div>
          <div class="modal-actions">
            <button class="modal-cancel">Cancel</button>
            <button class="modal-ok ws-next"></button>
          </div>
        </div>

        <div class="ws-step ws-step-2" style="display:none;">
          <div class="ws-conn-summary"></div>
          <label class="modal-label">Working directory</label>
          <div class="modal-row">
            <input class="modal-input ws-dir" type="text" spellcheck="false" placeholder="default: home directory" />
            <button class="modal-browse">Browse…</button>
          </div>
          <div class="modal-actions">
            <button class="ws-back">← Back</button>
            <button class="modal-ok ws-finish"></button>
          </div>
        </div>
      </div>`;
    overlay.querySelector('.ws-title-text').textContent = title;
    const stepBadge = overlay.querySelector('.ws-step-badge');
    const nextBtn = overlay.querySelector('.ws-next');
    const finishBtn = overlay.querySelector('.ws-finish');
    nextBtn.textContent = isEdit ? 'Update →' : 'Connect →';
    finishBtn.textContent = initial.okLabel || 'Create';

    const nameEl = overlay.querySelector('.ws-name');
    const dirEl = overlay.querySelector('.ws-dir');
    const sshEl = overlay.querySelector('.ws-ssh');
    const distroEl = overlay.querySelector('.ws-distro');
    const optsEl = overlay.querySelector('.conn-options');
    const statusEl = overlay.querySelector('.ws-status');
    const summaryEl = overlay.querySelector('.ws-conn-summary');
    const step1El = overlay.querySelector('.ws-step-1');
    const step2El = overlay.querySelector('.ws-step-2');
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
    const choiceOf = (k) => choices.find((c) => c.kind === k) || choices[0];

    // WSL distro picker (Windows only): the system "default" distro often isn't
    // the one with the user's files, so let them choose which to connect to.
    let wslDistros = [];
    let wslDefault = '';
    const wantDistro = (initial.target && initial.target.kind === 'wsl' && initial.target.distro) || '';
    function hasDistroPicker() { return env.isWin && wslDistros.length > 0; }
    function populateDistro() {
      distroEl.innerHTML = '';
      for (const d of wslDistros) {
        const o = document.createElement('option');
        o.value = d;
        o.textContent = d + (d === wslDefault ? ' (default)' : '');
        distroEl.appendChild(o);
      }
      // Prefer the workspace's saved distro, else the system default, else first.
      distroEl.value = (wantDistro && wslDistros.includes(wantDistro)) ? wantDistro
        : (wslDefault && wslDistros.includes(wslDefault)) ? wslDefault
        : (wslDistros[0] || '');
      syncExtras();
    }
    if (env.isWin && window.hydra.wslList) {
      window.hydra.wslList().then((r) => {
        wslDistros = (r && r.distros) || [];
        wslDefault = (r && r.default) || '';
        populateDistro();
      }).catch(() => {});
    }

    // Show the SSH host / WSL distro input that matches the selected connection.
    function syncExtras() {
      sshEl.style.display = sel === 'ssh' ? '' : 'none';
      distroEl.style.display = (sel === 'wsl' && hasDistroPicker()) ? '' : 'none';
    }

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
          clearStatus();
          paint();
          if (sel === 'ssh') sshEl.focus();
        });
        optsEl.appendChild(row);
      }
      syncExtras();
    }

    const done = (val) => { overlay.remove(); resolve(val); };

    function setStatus(msg, kind) {
      statusEl.style.display = '';
      statusEl.className = 'ws-status' + (kind ? ' ws-status-' + kind : '');
      statusEl.textContent = msg;
    }
    function clearStatus() { statusEl.style.display = 'none'; statusEl.textContent = ''; statusEl.className = 'ws-status'; }

    let committed = null;   // the connection target, locked in once step 1 passes

    function showStep(n) {
      step1El.style.display = n === 1 ? '' : 'none';
      step2El.style.display = n === 2 ? '' : 'none';
      stepBadge.textContent = `Step ${n} of 2`;
      if (n === 1) { nameEl.focus(); if (nameEl.value) nameEl.select(); return; }
      const c = choiceOf(sel);
      summaryEl.innerHTML = c.icon + `<span class="ws-conn-summary-text"></span>`;
      summaryEl.querySelector('.ws-conn-summary-text').textContent =
        sel === 'ssh' ? `SSH · ${committed.host}`
        : (sel === 'wsl' && committed.distro) ? `WSL · ${committed.distro}`
        : `${c.name} · ${c.sub}`;
      dirEl.focus();
    }

    // Step 1 → step 2: validate, then verify the connection is reachable before
    // moving on (SSH host / WSL distro) so Browse on step 2 has a real
    // filesystem to list. wsl/local on this machine pass instantly.
    async function goNext() {
      if (nextBtn.disabled) return;
      const name = (nameEl.value || '').trim();
      if (!name) { nameEl.focus(); setStatus('Please enter a workspace name.', 'error'); return; }
      const host = (sshEl.value || '').trim();
      if (sel === 'ssh' && !host) { sshEl.focus(); setStatus('Enter an SSH host (user@hostname).', 'error'); return; }
      const target = { kind: sel, host: sel === 'ssh' ? host : '' };
      if (sel === 'wsl' && hasDistroPicker()) target.distro = distroEl.value || '';

      // Verify the ones that actually reach off this process: ssh always, and
      // wsl on Windows (a specific distro can be stopped/uninstalled).
      const verify = sel === 'ssh' || (sel === 'wsl' && env.isWin);
      if (verify) {
        const label = sel === 'ssh' ? host : (target.distro || 'default distro');
        nextBtn.disabled = true;
        setStatus(`Connecting to ${label}…`, 'busy');
        const res = await window.hydra.testConn(target);
        nextBtn.disabled = false;
        if (!res || !res.ok) {
          setStatus(`Could not connect: ${(res && res.error) || 'unknown error'}`, 'error');
          return;
        }
        if (res.note) setStatus(res.note, 'ok'); else clearStatus();
      } else {
        clearStatus();
      }
      committed = target;
      showStep(2);
    }

    const submit = () => {
      const name = (nameEl.value || '').trim();
      if (!name || !committed) { showStep(1); return; }   // shouldn't happen; bounce back
      done({ name, dir: (dirEl.value || '').trim(), target: committed });
    };

    nextBtn.onclick = goNext;
    finishBtn.onclick = submit;
    overlay.querySelector('.ws-back').onclick = () => { clearStatus(); showStep(1); };
    overlay.querySelector('.modal-cancel').onclick = () => done(null);
    overlay.querySelector('.modal-browse').onclick = async () => {
      // Browse the filesystem of the connection committed in step 1.
      const picked = await browseDir(dirEl.value || '', committed);
      if (picked) dirEl.value = picked;
      dirEl.focus();
    };
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (step2El.style.display === 'none') goNext(); else submit();
      }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });

    paint();
    document.body.appendChild(overlay);
    showStep(1);
  });
}

// In-app, VSCode-themed folder picker. The native GTK dialog can't be themed
// under WSLg, so we navigate directories ourselves via fs:listDir. `connTarget`
// is the chosen connection (wsl/local/ssh) so we browse THAT filesystem — e.g.
// the WSL distro's tree from a native Windows build, not the Windows host.
// Resolves to the chosen absolute path, or null if cancelled.
function browseDir(startPath, connTarget) {
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

    async function navigate(dir) {
      const res = await window.hydra.listDir({ path: dir, target: connTarget || null });
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
      if (res.unreachable) {
        const empty = document.createElement('div');
        empty.className = 'dir-empty';
        empty.textContent = "Couldn't list this connection — type the path manually.";
        listEl.appendChild(empty);
      } else if (!res.entries.length && !res.parent) {
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

function needsAttention(p) { return p.state === 'approval' || p.state === 'error' || !!p.awaiting; }

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
      const why = cand.state === 'approval' ? 'needs you' : cand.state === 'error' ? 'error' : 'your turn';
      flash(`${cand.wsName || ''} / ${name} — ${why}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Super Saiyan Mode — a center-screen "deck of cards" of every pane that needs
// you. The FRONT card is a live mirror (a 2nd xterm fed the same PTY, input
// routed back to the same shell); cards behind are static and only go live when
// they reach the front. Submitting a reply (Enter) pops the front card; the next
// slides up. The originals in the tab never move or close — this is a reflection.
// Performance: at most ONE extra terminal exists at a time.
// ---------------------------------------------------------------------------
let superSaiyan = false;     // mode on/off
let ssOverlay = null;        // the overlay DOM, or null
let ssStack = [];            // pane ids in the deck, front = index 0
let ssMirror = null;         // { paneId, term, fit, inputDispose, restore } for the front
const ssSuppressed = new Set(); // ids dismissed via Enter, hidden until their state clears

function ssAttentionPanes() {
  // Stable on-screen order; skip panes the user just replied to (state lags).
  return [...panes.values()].filter((p) => needsAttention(p) && !ssSuppressed.has(p.id));
}

function toggleSuperSaiyan() { superSaiyan ? exitSuperSaiyan() : enterSuperSaiyan(); }

function enterSuperSaiyan() {
  if (superSaiyan) return;
  superSaiyan = true;
  const btn = document.getElementById('ss-toggle');
  if (btn) btn.classList.add('active');
  buildSuperSaiyanOverlay();
  ssStack = ssAttentionPanes().map((p) => p.id);
  renderDeck();
}

function exitSuperSaiyan() {
  if (!superSaiyan) return;
  superSaiyan = false;
  const btn = document.getElementById('ss-toggle');
  if (btn) btn.classList.remove('active');
  disposeFrontMirror();
  if (ssOverlay) { ssOverlay.remove(); ssOverlay = null; }
  ssStack = [];
  ssSuppressed.clear();
  // Whatever pane was focused before stays focused; refit visible panes.
  for (const q of visiblePanes()) fitPane(q);
}

function buildSuperSaiyanOverlay() {
  if (ssOverlay) return;
  const ov = document.createElement('div');
  ov.className = 'ss-overlay';
  ov.innerHTML = `
    <div class="ss-panel">
      <div class="ss-bar">
        <span class="ss-brand"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg> Super Saiyan</span>
        <span class="ss-count"></span>
        <button class="ss-exit" title="Exit Super Saiyan (button, F10, or Ctrl+Shift+S)">Exit ⤬</button>
      </div>
      <div class="ss-stage">
        <div class="ss-deck"></div>
        <div class="ss-empty">✓ Nothing needs you right now.</div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ssOverlay = ov;
  ov.querySelector('.ss-exit').onclick = () => exitSuperSaiyan();
}

// Reconcile the deck with the live attention set (called on state changes).
// The FRONT card is sticky — it leaves only when you reply (Enter) or its pane
// closes — so a transient state flip can't yank the card you're working on.
function recomputeStack() {
  if (!superSaiyan) return;
  const want = ssAttentionPanes().map((p) => p.id);
  ssStack = ssStack.filter((id, i) => (i === 0 ? panes.has(id) : want.includes(id)));
  for (const id of want) if (!ssStack.includes(id)) ssStack.push(id); // append new
  renderDeck();
}

function renderDeck() {
  if (!ssOverlay) return;
  const deck = ssOverlay.querySelector('.ss-deck');
  const countEl = ssOverlay.querySelector('.ss-count');
  const emptyEl = ssOverlay.querySelector('.ss-empty');
  const n = ssStack.length;
  countEl.textContent = n ? `${n} pane${n > 1 ? 's' : ''} need you` : '';
  emptyEl.style.display = n ? 'none' : '';
  deck.style.display = n ? '' : 'none';

  // Front card: keep the live mirror if the front pane is unchanged; otherwise
  // rebuild it. (Rebuilding only on change avoids flicker / losing focus.)
  const frontId = ssStack[0] || null;
  if (!frontId) { disposeFrontMirror(); deck.innerHTML = ''; return; }
  if (!ssMirror || ssMirror.paneId !== frontId) { disposeFrontMirror(); buildDeckDom(deck); createFrontMirror(frontId); }
  else { layoutBehindCards(deck); }
}

// (Re)build the deck DOM: behind cards (static) + the persistent front card.
function buildDeckDom(deck) {
  deck.innerHTML = '';
  layoutBehindCards(deck);
  const front = document.createElement('div');
  front.className = 'ss-card ss-front';
  front.innerHTML = `<div class="ss-card-head"><span class="ss-card-title"></span><span class="ss-card-tag">needs you</span></div><div class="ss-card-body"></div>`;
  deck.appendChild(front);
}

// Static cards peeking out behind the front, so the pile reads as a deck. Capped
// at a few visible offsets; the real total is in the count badge.
function layoutBehindCards(deck) {
  for (const old of [...deck.querySelectorAll('.ss-behind')]) old.remove();
  const behind = ssStack.slice(1);
  const shown = Math.min(behind.length, 4);
  for (let i = shown - 1; i >= 0; i--) {
    const p = panes.get(behind[i]);
    const card = document.createElement('div');
    card.className = 'ss-card ss-behind';
    const depth = i + 1;                                   // 1 = just behind front
    // Fan up-and-back with a growing tilt, like a held hand of cards — so the
    // pile reads as a deck and the peeking heads hint at the count.
    card.style.transform = `translate(-50%, -50%) translate(${depth * 11}px, ${depth * -15}px) rotate(${depth * 1.6}deg) scale(${1 - depth * 0.035})`;
    card.style.zIndex = String(10 - depth);
    card.style.opacity = String(1 - depth * 0.17);
    const name = p ? `${p.wsName ? p.wsName + ' / ' : ''}${(p.title.textContent || p.id).trim()}` : '(closed)';
    card.innerHTML = `<div class="ss-card-head"><span class="ss-card-title"></span><span class="ss-card-tag">needs you</span></div>`;
    card.querySelector('.ss-card-title').textContent = name;
    // insert behind any existing front card
    deck.insertBefore(card, deck.querySelector('.ss-front'));
  }
}

function createFrontMirror(paneId) {
  const src = panes.get(paneId);
  const front = ssOverlay && ssOverlay.querySelector('.ss-front');
  if (!src || !front) return;
  front.querySelector('.ss-card-title').textContent =
    `${src.wsName ? src.wsName + ' / ' : ''}${(src.title.textContent || src.id).trim()}`;
  const body = front.querySelector('.ss-card-body');
  body.innerHTML = '';

  const term = new Terminal({
    theme: xtermTheme(themeId),
    // Match VSCode's default terminal font per platform: Consolas (Windows),
    // Menlo (macOS), Droid Sans Mono (Linux), with a generic fallback.
    fontFamily: 'Consolas, "Courier New", Menlo, Monaco, "Droid Sans Mono", monospace',
    fontSize: 14, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(body);
  // Seed instantly from the source's current screen (works even for an idle
  // prompt that won't emit new data on its own).
  try { term.write(src.serialize.serialize()); } catch (_) {}

  // Input goes to the SAME shell. Enter = reply submitted → pop this card.
  const inputDispose = term.onData((data) => {
    window.hydra.input(paneId, data);
    if (data.indexOf('\r') !== -1) setTimeout(() => { if (ssStack[0] === paneId) ssDismissFront(); }, 30);
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && handleShortcut(e)) { e.preventDefault(); e.stopPropagation(); return false; }
    return true;
  });

  // Fit the mirror to the big card and resize the PTY to match so the TUI
  // repaints to fill it. We restore the PTY to the original pane's size when the
  // card is dismissed — the original xterm's own cols/rows never changed.
  const restore = () => { try { window.hydra.resize(paneId, src.term.cols, src.term.rows); } catch (_) {} };
  ssMirror = { paneId, term, fit, inputDispose, restore };
  requestAnimationFrame(() => {
    if (!ssMirror || ssMirror.paneId !== paneId) return;
    try { fit.fit(); window.hydra.resize(paneId, term.cols, term.rows); } catch (_) {}
    term.focus();
  });
}

function disposeFrontMirror() {
  if (!ssMirror) return;
  const m = ssMirror; ssMirror = null;
  try { m.inputDispose.dispose(); } catch (_) {}
  try { m.restore(); } catch (_) {}     // PTY back to the original pane's size
  try { m.term.dispose(); } catch (_) {}
}

// Pop the front card after a reply: hide its pane until its state actually
// clears (so it doesn't flash back while detection catches up), advance.
function ssDismissFront() {
  const id = ssStack.shift();
  if (id) ssSuppressed.add(id);
  disposeFrontMirror();
  renderDeck();
}

function handleShortcut(e) {
  if (e.key === 'F11') { toggleZenFocused(); return true; }
  // F4 — open the File Explorer window rooted at the focused pane's folder.
  if (e.key === 'F4') { openExplorerForPane(); return true; }
  // F10 (or Ctrl+Shift+S) — toggle Super Saiyan Mode.
  if (e.key === 'F10') { toggleSuperSaiyan(); return true; }
  if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) { toggleSuperSaiyan(); return true; }
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

// Open the File Explorer window for a pane's folder. The main process resolves
// the pane's *live* cwd from its pid (so it follows `cd`), falling back to the
// tracked cwd. Without an argument, acts on the focused pane.
function openExplorerForPane(target) {
  const p = target || panes.get(focusedId);
  if (!p) { flash('No pane to open the explorer for'); return; }
  if (!window.hydra.openExplorer) return;
  window.hydra.openExplorer({ pid: p.pid, cwd: p.cwd || '', target: p.target || null });
}

// Ctrl+1..9 and Ctrl+Tab act within the focused group's tab strip.
function switchTabByIndex(i) {
  const g = activeGroupObj();
  if (g && g.open[i] && g.open[i] !== store.active) switchTab(g.open[i]);
}
function switchTabBy(delta) {
  const g = activeGroupObj();
  if (!g || g.open.length < 2) return;
  const cur = g.open.indexOf(g.active);
  switchTab(g.open[(cur + delta + g.open.length) % g.open.length]);
}

// Apply a detector result (or a bare state string) to a pane's UI.
function applyStatus(p, res) {
  const state = res.state;
  const prev = p.state;
  p.state = state;
  p.lastRes = res;

  const isIdle = state === 'ready' || state === 'input';
  // A pane that finishes a turn (was busy/at a prompt, now idle) is YOUR TURN:
  // it's done and waiting on your reply. Flag it for attention until you focus
  // the pane — unless you're already watching it finish.
  if (isIdle) {
    if (prev === 'working' || prev === 'approval') {
      p.settling = true;            // confirm on the next tick (debounce flicker)
    } else if (p.settling) {
      p.settling = false;
      const watching = p.id === focusedId && p.workspace === store.active && document.hasFocus();
      if (!watching && !p.awaiting) { p.awaiting = true; notifyDone(p, res); }
    }
  } else {
    p.settling = false;             // back to working / a prompt / exited
    p.awaiting = false;
  }

  const attention = state === 'approval' || p.awaiting;
  const ui = p.awaiting ? STATE_UI.approval : (STATE_UI[state] || STATE_UI.ready);

  // Edge-trigger a desktop notification when a pane first starts needing you.
  // (Edge, not level, so a pane stuck at the prompt only pings once.)
  if (state === 'approval' && prev !== 'approval') notifyNeedsYou(p, res);

  p.dot.className = `dot ${ui.dot}`;
  p.stateLabel.className = `pane-state-label state-${ui.css}`;
  p.stateLabel.textContent = (p.awaiting ? 'your turn' : (res.label || state)).slice(0, 16);

  // status line = activity detail + compact meta (elapsed / tokens / context)
  const meta = res.meta || {};
  const metaBits = [meta.elapsed, meta.tokens, meta.context].filter(Boolean);
  let text = res.detail || '';
  if (metaBits.length) text += (text ? '   ' : '') + metaBits.join(' · ');
  p.status.textContent = text;
  p.status.title = text;

  // draw the eye to panes that need a human decision (or whose turn it now is)
  p.el.classList.toggle('needs-attention', attention);
  p.el.classList.toggle('has-error', state === 'error');

  // Keep the Super Saiyan deck in sync: a pane that resolved becomes eligible to
  // re-stack again later; the deck recomputes to add/drop cards as states change.
  if (superSaiyan) {
    if (!needsAttention(p)) ssSuppressed.delete(p.id);
    if (state !== prev) recomputeStack();
  }
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

// A pane that just finished its turn and is waiting on your reply ("your turn").
function notifyDone(p, res) {
  const t = store && store.tabs[p.workspace];
  const notifyOn = t ? t.toolbar.notify !== false : true;
  if (!notifyOn) return;
  const name = (p.title.textContent || p.id).trim();
  window.hydra.notify({
    id: p.id,
    title: `${p.wsName || 'ClaudeIDE'} / ${name} — your turn`,
    body: res.detail || 'Finished — awaiting your response',
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
    statusSeg('approval', a.awaiting, 'your turn') +
    statusSeg('ready', a.ready, 'ready') +
    statusSeg('error', a.error, 'error') +
    statusSeg('dead', a.dead, 'exited');
  summaryEl.classList.toggle('alert', a.approval + a.error + a.awaiting > 0);

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
  // Live Super Saiyan mirror of the front pane sees the same stream.
  if (ssMirror && ssMirror.paneId === id) ssMirror.term.write(data);
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
document.getElementById('ss-toggle').addEventListener('click', toggleSuperSaiyan);
document.getElementById('remote-indicator').addEventListener('click', (e) => {
  e.stopPropagation();
  editActiveWorkspace();   // the pill edits THIS tab's workspace connection
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
  // Keep the live Super Saiyan mirror filling its (resized) card.
  if (ssMirror) {
    try { ssMirror.fit.fit(); window.hydra.resize(ssMirror.paneId, ssMirror.term.cols, ssMirror.term.rows); } catch (_) {}
  }
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
// pane under the cursor (left half = before, right half = after). Delegated on
// #editor; reordering only happens within the dragged pane's own group grid.
editor.addEventListener('dragover', (e) => {
  if (!draggingEl) return;
  const homeGrid = draggingEl.parentElement;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest('.pane');
  if (!target || target === draggingEl || target.classList.contains('hidden')
      || target.parentElement !== homeGrid) return;
  const r = target.getBoundingClientRect();
  const before = e.clientX < r.left + r.width / 2;
  homeGrid.insertBefore(draggingEl, before ? target : target.nextSibling);
});
editor.addEventListener('drop', (e) => { if (draggingEl) e.preventDefault(); });

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
  ensureGroups();        // validate the group structure…
  ensureGroupsDom();     // …and build its DOM before any pane is parented into it

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
  // An open-but-empty active tab gets seeded with the default panes. A fresh
  // install has no active tab at all (store.active === null) — it boots straight
  // to the welcome screen, with no default workspace loaded.
  if (store.active && store.tabs[store.active] && !panesOf(store.active).length) {
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
