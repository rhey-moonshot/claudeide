'use strict';

// ---------------------------------------------------------------------------
// Claude Code status detector.
//
// Input: an array of plain-text lines from the *current* terminal screen
// (already composited by xterm, so TUI in-place redraws are resolved).
//
// Strategy: the live REPL state is always painted at the very BOTTOM of the
// screen (spinner while working, a permission box when it needs you, or the
// input box when idle). So we locate each signal and let the *lowest* one on
// screen win — that way leftover text from a previous turn up in the
// scrollback never wins over what's actually live right now.
//
// Returns: { state, label, detail, meta }
//   state ∈ working | approval | input | ready | error | dead
// ---------------------------------------------------------------------------

(function () {
  const RE = {
    // "esc to interrupt" — but a narrow pane truncates it ("…· esc to interrup"),
    // so match the stem, not the whole phrase.
    interrupt: /esc to interrup/i,
    // Active spinner line: a leading ANIMATED glyph (the cycling sparkle/braille
    // frames — NOT the solid ● / ○ used for completed bullets) followed by a
    // gerund. This is the most reliable "working" signal: it survives even when
    // the long line wraps or "esc to interrupt" is clipped off the right edge.
    // e.g. "✳ Fixing TC-DOC document upload… (39m 57s)"  -> verb "Fixing"
    spinner: /^[\s│]*[✻✶✳✢✽✦✺✷❂✣⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷⠿]\s+([A-Za-z][a-z]+)/,
    // permission / confirmation prompts
    approval: /(do you want to (?:proceed|make this edit|create|run|allow)|yes,?\s*and don'?t ask again|❯\s*1\.\s*yes\b|press\s+enter\s+to)/i,
    // idle input box footer hint — the plain "? for shortcuts" / "← for agents"
    // footer, or the mode footers ("▶▶ auto mode on", "⏵⏵ accept edits on"). NOTE:
    // the mode footers appear in BOTH idle AND working states, so they only count
    // as "idle" when there's no live working signal — detect() enforces that by
    // giving the spinner / interrupt a hard priority over this.
    shortcuts: /(\?\s*for shortcuts|←\s*for agents|[⏵▶]{2}\s*(?:accept edits|auto[- ]?accept|auto mode)|auto[- ]?accept edits on|bypass permissions on)/i,
    // "● Bash(npm test)"  /  "● Update(src/foo.ts)"
    tool: /●\s*([A-Z][A-Za-z]+)\(([^)]*)\)/,
    // any assistant action bullet
    bullet: /●\s+(\S.*)/,
    // spinner gerund: leading glyph then a word ending in … or ...
    verb: /[✻✶✳✢✽✦✺·*◍○●⠿⡿⣷⣯⣟⢿]\s*([A-Za-z][a-z]+)(?:…|\.\.\.)/,
    tokens: /([\d][\d.,]*\s*[kmKM]?)\s*tokens/i,
    // elapsed timer, incl. minutes/hours: "12s", "39m 57s", "1h 2m 3s"
    elapsed: /(?:^|[(\s·])((?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?s)(?=[\s·)]|$)/,
    context: /(\d+%)\s*context\s*(?:left|remaining)/i,
    error: /(✗\s|^[\s│╭╮╯╰─]*error[:!]|\bfailed\b|\bexception\b|traceback \(most recent)/i,
  };

  function lastIndex(lines, re) {
    for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i;
    return -1;
  }
  function lastMatch(lines, re) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(re);
      if (m) return m;
    }
    return null;
  }
  function clean(s) {
    return s.replace(/[│╭╮╯╰─┃┏┓┗┛━]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function collectMeta(lines, interruptIdx) {
    const meta = {};
    const tk = lastMatch(lines, RE.tokens);
    if (tk) meta.tokens = tk[1].replace(/\s+/g, '') + ' tok';
    const ctx = lastMatch(lines, RE.context);
    if (ctx) meta.context = ctx[1] + ' ctx';
    // elapsed time is most meaningful from the live spinner line
    if (interruptIdx >= 0) {
      const el = lines[interruptIdx].match(RE.elapsed);
      if (el) meta.elapsed = el[1].replace(/\s+/g, ' ').trim();   // already includes the unit(s)
    }
    const tm = lastMatch(lines, RE.tool);
    if (tm) meta.tool = tm[1] + (tm[2].trim() ? ' ' + clean(tm[2]).slice(0, 60) : '');
    return meta;
  }

  function lastBullet(lines) {
    const m = lastMatch(lines, RE.bullet);
    return m ? clean(m[1]).slice(0, 120) : null;
  }

  function detect(lines) {
    if (!lines || !lines.length) return { state: 'ready', label: 'ready', detail: '', meta: {} };

    const iApproval = lastIndex(lines, RE.approval);
    const iSpinner = lastIndex(lines, RE.spinner);
    const iInterrupt = lastIndex(lines, RE.interrupt);
    const iWorking = Math.max(iSpinner, iInterrupt);
    const iIdle = lastIndex(lines, RE.shortcuts);
    // elapsed/tokens read best off the spinner line itself when there is one.
    const meta = collectMeta(lines, iSpinner >= 0 ? iSpinner : iInterrupt);

    // WORKING WINS. An active spinner or an "esc to interrupt" hint means Claude
    // is processing right NOW, and that must outrank everything below it — the
    // persistent mode footer ("▶▶ auto mode on …") sits at the very bottom in
    // both working and idle states, so a "lowest signal wins" race would let it
    // masquerade as idle whenever "esc to interrupt" is clipped off a narrow pane.
    if (iWorking >= 0) {
      const spin = iSpinner >= 0 ? lines[iSpinner].match(RE.spinner) : null;
      const vm = spin || lines[iWorking].match(RE.verb);
      const verb = vm ? vm[1] : null;
      const detail = meta.tool || (verb ? verb + '…' : lastBullet(lines)) || 'working…';
      return { state: 'working', label: verb ? verb.toLowerCase() : 'working', detail, meta };
    }

    // No live working signal — pick the lowest of an approval prompt / idle hint.
    const winner = Math.max(iApproval, iIdle);

    if (winner >= 0 && winner === iApproval) {
      let q = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/do you want to/i.test(lines[i])) { q = clean(lines[i]); break; }
      }
      const detail = q || (meta.tool ? 'approve ' + meta.tool : 'awaiting your approval');
      return { state: 'approval', label: 'needs you', detail: detail.slice(0, 120), meta };
    }

    if (winner >= 0 && winner === iIdle) {
      return { state: 'input', label: 'ready', detail: lastBullet(lines) || 'awaiting instruction', meta };
    }

    // no live REPL signal — check for an error, else assume settled
    const iErr = lastIndex(lines, RE.error);
    if (iErr >= 0) return { state: 'error', label: 'error', detail: clean(lines[iErr]).slice(0, 120), meta };

    return { state: 'ready', label: 'ready', detail: lastBullet(lines) || '', meta };
  }

  // expose for renderer (and make it unit-testable under Node)
  if (typeof window !== 'undefined') window.detectClaudeStatus = detect;
  if (typeof module !== 'undefined' && module.exports) module.exports = { detect };
})();
