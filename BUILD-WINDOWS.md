# Building the Windows installer

ClaudeIDE ships a native module (`node-pty`, the terminal backend), which **must
be compiled on Windows**. You can't cross-build a working Windows installer from
WSL/Linux — do the build on the Windows side (or a Windows CI runner).

The result is `dist/ClaudeIDE-Setup-<version>.exe` — a normal installer with
Start Menu + desktop shortcuts and a "choose install location" step.

---

## Option A — build locally on Windows (recommended)

### 1. Prerequisites (one time)

Open **PowerShell as Administrator** and install the toolchain:

- **Node.js LTS** (x64) — https://nodejs.org  (or `winget install OpenJS.NodeJS.LTS`)
- **Visual Studio Build Tools** with the *Desktop development with C++* workload —
  needed to compile `node-pty`:
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools `
    --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```
- **Python 3** (for node-gyp) — `winget install Python.Python.3.12`

> If you already build native Node modules on Windows, you likely have these.

### 2. Get the source onto Windows

The project currently lives in WSL. Copy it to a **native Windows path** (building
from a `\\wsl$\...` path is slow and flaky). From PowerShell:

```powershell
# adjust the distro name if needed (wsl -l -q lists them)
robocopy \\wsl$\Ubuntu\home\dudu\aicode $env:USERPROFILE\claudeide /E /XD node_modules dist .git
cd $env:USERPROFILE\claudeide
```

### 3. Install + build

```powershell
npm install        # compiles node-pty for Windows, pulls electron-builder
npm run dist       # produces dist\ClaudeIDE-Setup-<version>.exe
```

Double-click the installer in `dist\` to install. Done.

> Tip: `npm run pack` builds an unpacked app into `dist\win-unpacked\` (no
> installer) for a quick smoke test — run `dist\win-unpacked\ClaudeIDE.exe`.

---

## Option B — build in GitHub Actions (no local toolchain)

If you push this to a GitHub repo, a Windows runner can build the installer and
hand you the `.exe` as a downloadable artifact — no VS Build Tools on your
machine. Ask and a ready-to-use `.github/workflows/build-windows.yml` can be
added.

---

## How it behaves once installed

ClaudeIDE runs as a native Windows app. Per-workspace **Connection** options map to:

- **WSL** (default) → launches `wsl.exe` into your default distro — this is where
  Claude Code lives, so new panes run `claude` there.
- **PowerShell** → a native Windows PowerShell pane.
- **SSH** → `ssh.exe <host>` (uses Windows' built-in OpenSSH client).

Make sure WSL is installed (`wsl --install`) and Claude Code is set up inside your
distro, so the default WSL connection works out of the box.

---

## Notes / troubleshooting

- **`node-pty` build errors** → the C++ Build Tools or Python are missing/not on
  PATH. Re-open a fresh terminal after installing them.
- **App icon** → drop a `build/icon.ico` before `npm run dist` (see `build/README.md`).
- **Code signing** → the installer is unsigned, so SmartScreen may warn on first
  run ("More info → Run anyway"). Signing needs a code-signing certificate; ask if
  you want that wired up.
- **Architecture** → configured for x64. For ARM64 Windows, say so and it can be added.
