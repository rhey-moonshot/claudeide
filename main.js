'use strict';

const { app, BrowserWindow, ipcMain, Notification, nativeTheme, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const pty = require('node-pty');

let mainWindow = null;   // the single app window
let ipcReady = false;    // guard so handlers register exactly once

// ---------------------------------------------------------------------------
// Notifications.
//
// Under WSLg there is no Linux notification daemon, so Electron's native
// Notification is unsupported and would silently show nothing. We fall back to
// a real Windows toast via powershell.exe interop, which surfaces in the
// Windows Action Center. Native path is used wherever it actually works.
// ---------------------------------------------------------------------------
const IS_WSL = process.platform === 'linux' &&
  (!!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP);
const IS_WIN = process.platform === 'win32';   // native Windows build (installed app)
let wslToastBroken = false; // disable after a hard failure (e.g. no interop)

const TOAST_PS = [
  "$ErrorActionPreference='Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null',
  '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$x=$t.GetElementsByTagName('text')",
  '$x.Item(0).AppendChild($t.CreateTextNode($env:HYDRA_TITLE))|Out-Null',
  '$x.Item(1).AppendChild($t.CreateTextNode($env:HYDRA_BODY))|Out-Null',
  '$toast=[Windows.UI.Notifications.ToastNotification]::new($t)',
  "$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast)',
].join('\n');

function showWindowsToast(title, body) {
  if (wslToastBroken) return false;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', TOAST_PS],
    { env: { ...process.env, HYDRA_TITLE: title, HYDRA_BODY: body || '' }, stdio: 'ignore' }
  );
  child.on('error', () => { wslToastBroken = true; }); // e.g. interop unavailable
  return true;
}

// Pull files/an image off the *Windows* clipboard. Under WSLg the Chromium
// renderer can't see Windows-side clipboard files or screenshot bitmaps, so a
// Ctrl+V of a copied image yields nothing locally. We reach across to the real
// clipboard via powershell.exe (same interop as the toast): copied files are
// returned as their paths; a raw bitmap is saved to %TEMP% and that path is
// returned. Output is one Windows path per line, or 'NONE'. STA is required for
// the clipboard APIs.
const CLIP_PS = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$f=[System.Windows.Forms.Clipboard]::GetFileDropList()',
  'if($f -and $f.Count -gt 0){ foreach($i in $f){ [Console]::Out.WriteLine($i) }; exit 0 }',
  '$img=[System.Windows.Forms.Clipboard]::GetImage()',
  'if($img -ne $null){',
  "  $name='claudeide_clip_'+(Get-Date -Format 'yyyyMMdd_HHmmssfff')+'.png'",
  '  $p=Join-Path $env:TEMP $name',
  '  $img.Save($p,[System.Drawing.Imaging.ImageFormat]::Png)',
  '  [Console]::Out.WriteLine($p); exit 0',
  '}',
  "[Console]::Out.WriteLine('NONE')",
].join('\n');

function grabWindowsClipboard() {
  return new Promise((resolve) => {
    if (!IS_WSL) return resolve([]);
    let out = '';
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Sta', '-Command', CLIP_PS],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch (_) { return resolve([]); }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const lines = out.split(/\r?\n/).map((s) => s.trim())
        .filter((s) => s && s !== 'NONE');
      resolve(lines);
    });
  });
}

// WSLg uses software rendering; disabling GPU accel avoids noisy init errors.
app.disableHardwareAcceleration();
app.setName('ClaudeIDE'); // identity for desktop notifications

// ---------------------------------------------------------------------------
// PTY manager — one real pseudo-terminal per grid pane, keyed by a renderer id.
// ---------------------------------------------------------------------------
const ptys = new Map(); // id -> { proc, exited }

function defaultShell() {
  // On a native Windows install, default to the WSL distro — that's where Claude
  // Code runs. (Per-workspace "Local" picks PowerShell instead; see resolveTarget.)
  if (IS_WIN) return process.env.SHELL || 'wsl.exe';
  return process.env.SHELL || '/bin/bash';
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// "Maximize" = OS fullscreen. On WSLg neither native maximize() nor manual
// setBounds(workArea) reliably fills a frameless window (they resize partially or
// wedge — which is what made double-click feel stuck), but OS fullscreen fills
// the screen reliably and toggles back cleanly. Our custom title bar is page
// content, so it stays visible — this reads like a normal maximize/restore.
function toggleMaximize(win) {
  win.setFullScreen(!win.isFullScreen());
}

// Turn whatever the folder picker / user gives us into a real Linux path.
// On WSL the native picker can hand back Windows paths; users may also type
// `~/...`, a `file://` URI, or quoted paths. Normalize all of those.
function normalizeCwd(input) {
  if (!input || typeof input !== 'string') return '';
  let s = input.trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch (_) { /* leave as-is */ }
  }
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  // On native Windows the paths are already native (C:\...); no WSL translation.
  if (IS_WIN) return s;
  // \\wsl$\Distro\home\x  or  \\wsl.localhost\Distro\home\x  ->  /home/x
  const unc = s.match(/^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\(.*)$/i);
  if (unc) return '/' + unc[1].replace(/\\/g, '/');
  // C:\Users\foo  or  C:/Users/foo  ->  /mnt/c/Users/foo
  const drive = s.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/` + drive[2].replace(/\\/g, '/');
  return s;
}

// Decide what to actually launch for a pane based on the selected remote target
// (the VSCode-style indicator). Returns the node-pty spawn spec. Targets:
//   wsl   - the WSL distro (the default; where Claude Code lives)
//   local - the host OS shell directly (PowerShell on Windows, cmd via interop on WSL)
//   ssh   - a remote host over ssh (`-t` forces a remote PTY so TUIs work)
function resolveTarget(target, cwd) {
  const kind = target && target.kind;

  // --- Native Windows install ---------------------------------------------
  // The host is Windows, so paths are native and we launch Windows binaries.
  if (IS_WIN) {
    const winHome = os.homedir();                  // C:\Users\<name>
    const winCwd = (cwd && /^[A-Za-z]:[\\/]/.test(cwd.trim()) && fs.existsSync(cwd.trim()))
      ? cwd.trim() : winHome;                       // only an existing native path is a valid launch dir

    if (kind === 'ssh' && target.host) {
      return { file: 'ssh.exe', args: ['-t', target.host], cwd: winCwd, env: { ...process.env, TERM: 'xterm-256color' }, warning: null };
    }
    if (kind === 'local') {
      return { file: 'powershell.exe', args: ['-NoLogo'], cwd: winCwd, env: { ...process.env }, warning: null };
    }
    // default: drop into the default WSL distro. `--cd` accepts a Windows OR
    // Linux path; the process itself launches from the Windows home.
    const args = [];
    const want = (cwd || '').trim();
    if (want) args.push('--cd', want);
    return { file: 'wsl.exe', args, cwd: winHome, env: { ...process.env, TERM: 'xterm-256color' }, warning: null };
  }

  // --- Linux / WSL host (running under WSLg) -------------------------------
  const want = normalizeCwd(cwd);
  const exists = !!want && fs.existsSync(want);
  const home = os.homedir();

  if (kind === 'ssh' && target.host) {
    return {
      file: 'ssh', args: ['-t', target.host],
      cwd: exists ? want : home,                 // local launch dir; remote ignores it
      env: { ...process.env, TERM: 'xterm-256color' },
      warning: null,
    };
  }

  if (kind === 'local' && IS_WSL) {
    // cmd.exe can only start in a Windows-visible path; launch from the /mnt
    // mount when the requested dir is one, else the Windows drive root (a Linux
    // home would resolve to an unsupported UNC path and warn).
    const launchCwd = exists && want.startsWith('/mnt/') ? want : '/mnt/c';
    return { file: 'cmd.exe', args: [], cwd: launchCwd, env: { ...process.env }, warning: null };
  }

  return {
    file: defaultShell(), args: ['-l'],
    cwd: exists ? want : home,
    env: { ...process.env, TERM: 'xterm-256color' },
    warning: want && !exists ? `directory not found: ${want}` : null,
  };
}

function createPty({ id, cols, rows, cwd, target }) {
  const want = normalizeCwd(cwd);
  const spec = resolveTarget(target, cwd);

  let proc;
  try {
    proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: spec.cwd,
      env: spec.env,
    });
  } catch (e) {
    // A missing/blocked target binary (ssh, cmd.exe, wsl.exe) must not leave a
    // dead pane — fall back to a guaranteed host shell so the terminal is usable.
    const fbFile = IS_WIN ? 'powershell.exe' : defaultShell();
    const fbArgs = IS_WIN ? ['-NoLogo'] : ['-l'];
    proc = pty.spawn(fbFile, fbArgs, {
      name: 'xterm-256color', cols: cols || 80, rows: rows || 24,
      cwd: want && fs.existsSync(want) ? want : os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    spec.warning = `could not start ${spec.file} (${e.code || e.message}) — using ${fbFile}`;
    spec.cwd = proc.cwd || os.homedir();
  }

  ptys.set(id, { proc, exited: false });

  proc.onData((data) => send('pty:data', { id, data }));

  proc.onExit(({ exitCode }) => {
    const entry = ptys.get(id);
    if (entry) entry.exited = true;
    send('pty:exit', { id, code: exitCode });
  });

  // Return the normalized path so the renderer persists/uses a clean cwd,
  // plus any warning so the pane can show what actually happened.
  return { pid: proc.pid, cwd: spec.cwd, requested: want, warning: spec.warning };
}

// ---------------------------------------------------------------------------
// Git status for a pane's footer — which repo + branch it's sitting in.
// ---------------------------------------------------------------------------

// A pty's live working directory, which follows `cd`, read straight from the
// kernel (Linux/WSL). Falls back to null elsewhere so callers use the spawn dir.
function procCwd(pid) {
  if (!pid) return null;
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { return null; }
}

// Resolve the repo name + current branch for a directory, or null when it isn't
// a git work tree (or git is unavailable). One rev-parse gives the branch and
// the repo root; a detached HEAD falls back to a short commit hash.
function gitInfo(dir) {
  return new Promise((resolve) => {
    if (!dir) return resolve(null);
    execFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD', '--show-toplevel'],
      { timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null); // not a repo, or git missing
        const lines = String(stdout).trim().split('\n');
        const branch = (lines[0] || '').trim();
        const root = (lines[1] || '').trim();
        if (!root) return resolve(null);
        const repo = path.basename(root);
        if (branch && branch !== 'HEAD') return resolve({ branch, repo, detached: false });
        // Detached HEAD: show the short commit instead of an empty branch.
        execFile('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'],
          { timeout: 2000, windowsHide: true }, (e2, sha) => {
            resolve({ branch: e2 ? 'detached' : String(sha).trim(), repo, detached: true });
          });
      });
  });
}

// Workspace state (pane layout + labels + toolbar) lives in userData.
function statePath() {
  return path.join(app.getPath('userData'), 'workspace.json');
}

// Pre-paint window background + native-chrome mode per color theme, so launching
// in a light/alt theme doesn't flash the dark editor color first. Mirrors the
// `--bg` of each theme block in styles.css.
const THEME_CHROME = {
  dark:             { bg: '#1e1e1e', native: 'dark' },
  light:            { bg: '#ffffff', native: 'light' },
  monokai:          { bg: '#272822', native: 'dark' },
  dracula:          { bg: '#282a36', native: 'dark' },
  'solarized-dark': { bg: '#002b36', native: 'dark' },
};
function savedTheme() {
  try {
    const id = JSON.parse(fs.readFileSync(statePath(), 'utf8')).theme;
    return THEME_CHROME[id] ? id : 'dark';
  } catch (_) { return 'dark'; }
}

function registerIpc() {
  if (ipcReady) return;
  ipcReady = true;

  ipcMain.handle('pty:create', (_e, args) => createPty(args));

  // Keep native chrome (menus, scrollbars, dialogs) in step with the in-app theme.
  ipcMain.on('theme:native', (_e, mode) => {
    nativeTheme.themeSource = mode === 'light' ? 'light' : 'dark';
  });

  // Text zoom from in-app controls (File menu, boot restore). Keyboard
  // accelerators go through the application menu; both land in applyZoom.
  ipcMain.handle('zoom', (e, { action, value } = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    return applyZoom(win, action, value);
  });

  // Custom title-bar window controls (the window is frameless).
  ipcMain.on('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.on('win:toggle-maximize', () => { if (mainWindow) toggleMaximize(mainWindow); });
  ipcMain.on('win:close', () => { if (mainWindow) mainWindow.close(); });

  // Manual window dragging — the renderer streams cursor screen coords; we move
  // the window by the delta from where the drag began. (See toggleMaximize note:
  // WSLg swallows events on CSS drag regions, so the title bar drives this.)
  let dragOrigin = null;
  ipcMain.on('win:drag-start', (e, { x, y }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const [winX, winY] = win.getPosition();
    dragOrigin = { cursorX: x, cursorY: y, winX, winY };
  });
  ipcMain.on('win:drag-move', (e, { x, y }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !dragOrigin || win.isFullScreen()) return;
    win.setPosition(dragOrigin.winX + (x - dragOrigin.cursorX), dragOrigin.winY + (y - dragOrigin.cursorY));
  });
  ipcMain.on('win:drag-end', () => { dragOrigin = null; });

  ipcMain.on('pty:input', (_e, { id, data }) => {
    const entry = ptys.get(id);
    if (entry && !entry.exited) entry.proc.write(data);
  });

  ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
    const entry = ptys.get(id);
    if (entry && !entry.exited && cols > 0 && rows > 0) {
      try { entry.proc.resize(cols, rows); } catch (_) { /* race on exit */ }
    }
  });

  ipcMain.on('pty:kill', (_e, { id }) => {
    const entry = ptys.get(id);
    if (entry && !entry.exited) {
      try { entry.proc.kill(); } catch (_) { /* already gone */ }
    }
    ptys.delete(id);
  });

  ipcMain.handle('env:info', () => ({
    home: os.homedir(),
    shell: defaultShell(),
    platform: process.platform,
    isWsl: IS_WSL,
    isWin: IS_WIN,
    distro: process.env.WSL_DISTRO_NAME || '',
    host: os.hostname(),
  }));

  // Git repo + branch for a pane, looked up from its live cwd (follows `cd`).
  ipcMain.handle('git:info', (_e, { pid, cwd } = {}) => {
    const dir = procCwd(pid) || normalizeCwd(cwd) || '';
    return gitInfo(dir);
  });

  // Desktop notification when a pane needs the user. Clicking it focuses the
  // window and the specific pane; we also flash the taskbar as a fallback.
  ipcMain.handle('notify', (_e, { id, title, body }) => {
    // taskbar flash works everywhere and is a good "something needs you" cue
    if (mainWindow && !mainWindow.isFocused()) {
      try { mainWindow.flashFrame(true); } catch (_) {}
    }

    // Prefer Electron's native notification; it supports click-to-focus.
    if (Notification.isSupported()) {
      const n = new Notification({ title, body: body || '', silent: false, urgency: 'critical' });
      n.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        send('focus-pane', { id });
      });
      n.show();
      return 'native';
    }

    // WSL fallback: real Windows toast in the Action Center.
    if (IS_WSL && showWindowsToast(title, body)) return 'wsl-toast';

    return 'flash-only';
  });

  // Reach across to the Windows clipboard for copied files / images that the
  // WSLg renderer can't see (used as a Ctrl+V fallback for image pastes).
  ipcMain.handle('clipboard:grab', () => grabWindowsClipboard());

  // ---- workspace persistence ----
  ipcMain.handle('state:load', () => {
    try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
    catch (_) { return null; } // missing or corrupt → start fresh
  });

  ipcMain.handle('state:save', (_e, state) => {
    try {
      fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
      return true;
    } catch (_) { return false; }
  });

  // Folder picker backend. The native GTK dialog can't be themed under WSLg/
  // Linux (it ignores nativeTheme), so the renderer draws its own VSCode-dark
  // browser and asks us to list directories for it. Returns the resolved path,
  // its navigable parent, and immediate subdirectories (dotfiles hidden).
  ipcMain.handle('fs:listDir', async (_e, target) => {
    let dir = target && String(target).trim() ? normalizeCwd(target) : os.homedir();
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) dir = os.homedir();
    } catch (_) { dir = os.homedir(); }
    dir = path.resolve(dir);

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => {
          if (d.name.startsWith('.')) return false;       // hide dotfiles
          try {
            if (d.isDirectory()) return true;
            // resolve symlinks so linked dirs still show up
            return d.isSymbolicLink() && fs.statSync(path.join(dir, d.name)).isDirectory();
          } catch (_) { return false; }                   // unreadable entry
        })
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch (_) { /* unreadable dir -> empty list, still navigable up */ }

    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, entries };
  });
}

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: THEME_CHROME[savedTheme()].bg, // match saved theme — no wrong-color flash
    title: 'ClaudeIDE',
    icon: ICON_PATH, // ClaudeIDE hexagon mark (else WSLg shows the generic Tux icon)
    // Frameless: the native title bar / menu bar can't be themed (esp. under
    // WSLg), so we draw our own dark title bar inside the toolbar instead.
    frame: false,
    autoHideMenuBar: true, // keep menu accelerators, hide the native bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Hand the saved theme to the renderer synchronously so it can set the
      // <html data-theme> before first paint (no wrong-theme chrome flash).
      additionalArguments: [`--hydra-theme=${savedTheme()}`],
    },
  });

  mainWindow = win;

  // Some Linux/WSLg taskbars ignore the constructor `icon` — set it explicitly too.
  try { win.setIcon(ICON_PATH); } catch (_) {}

  // stop the attention flash once the user looks at the window
  win.on('focus', () => { try { win.flashFrame(false); } catch (_) {} });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // Keep the title-bar max/restore button icon in sync with the real state,
  // whether the change came from us or the compositor. We treat fullscreen as
  // "maximized"; native maximize (if the WM does it) counts too.
  win.on('enter-full-screen', () => send('win:state', { maximized: true }));
  win.on('leave-full-screen', () => send('win:state', { maximized: false }));
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));

  registerIpc();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

// ---------------------------------------------------------------------------
// Text zoom — scales the whole renderer (chrome + terminals). One step = 20%
// (Electron zoom level), clamped. After changing it we tell the renderer to
// refit terminals (so cols/rows reflow) and persist the level.
// ---------------------------------------------------------------------------
const ZOOM_MIN = -4, ZOOM_MAX = 8;   // ~50% … ~430%

function applyZoom(win, action, value) {
  if (!win || win.isDestroyed()) return 0;
  const wc = win.webContents;
  let lvl = wc.getZoomLevel();
  if (action === 'in') lvl += 1;
  else if (action === 'out') lvl -= 1;
  else if (action === 'reset') lvl = 0;
  else if (action === 'set') lvl = Number(value) || 0;
  lvl = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, lvl));
  wc.setZoomLevel(lvl);
  wc.send('zoom:changed', { level: lvl });
  return lvl;
}

// A minimal application menu. It's hidden (autoHideMenuBar) but its accelerators
// work app-wide — this is how Ctrl+= / Ctrl+- / Ctrl+0 reach us even while a
// terminal is focused. We also keep the standard editing/dev accelerators.
function buildAppMenu() {
  const zoom = (action, accel) => ({ label: `Zoom ${action}`, accelerator: accel, click: (_i, win) => applyZoom(win, action) });
  // alternate accelerators for the same action (registered via hidden items)
  const altZoom = (action, accel) => ({ label: 'Zoom', accelerator: accel, visible: false, acceleratorWorksWhenHidden: true, click: (_i, win) => applyZoom(win, action) });

  return Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { role: 'toggleDevTools', accelerator: 'F12' },
        { type: 'separator' },
        { label: 'Zoom In',  accelerator: 'CommandOrControl+=', click: (_i, win) => applyZoom(win, 'in') },
        altZoom('in', 'CommandOrControl+Plus'),
        altZoom('in', 'CommandOrControl+Shift+='),
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: (_i, win) => applyZoom(win, 'out') },
        altZoom('out', 'CommandOrControl+Shift+-'),
        { label: 'Reset Zoom', accelerator: 'CommandOrControl+0', click: (_i, win) => applyZoom(win, 'reset') },
        // No fullscreen accelerator here: F11 is the in-app zen-focus toggle
        // (renderer). Maximize via double-click on the title bar / the max button.
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'quit' }] },
  ]);
}

app.whenReady().then(() => {
  // Render native chrome (menus, scrollbars, dialogs) in the saved theme's
  // light/dark mode so it matches the in-app theme. The renderer keeps this in
  // step on later theme switches via the 'theme:native' channel.
  nativeTheme.themeSource = THEME_CHROME[savedTheme()].native;
  Menu.setApplicationMenu(buildAppMenu());   // hidden, but accelerators (zoom) live here
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const { proc, exited } of ptys.values()) {
    if (!exited) { try { proc.kill(); } catch (_) {} }
  }
  if (process.platform !== 'darwin') app.quit();
});
