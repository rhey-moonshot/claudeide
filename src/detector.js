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
    // "✻ Cogitating… (12s · ↑ 2.3k tokens · esc to interrupt)"
    interrupt: /esc to interrupt/i,
    // permission / confirmation prompts
    approval: /(do you want to (?:proceed|make this edit|create|run|allow)|yes,?\s*and don'?t ask again|❯\s*1\.\s*yes\b|press\s+enter\s+to)/i,
    // idle input box footer hint — covers the plain "? for shortcuts" footer and
    // the mode footers Claude shows when waiting at the prompt: "⏵⏵ accept edits
    // on", "▶▶ auto mode on (shift+tab to cycle)", "auto-accept edits on", etc.
    shortcuts: /(\?\s*for shortcuts|[⏵▶]{2}\s*(?:accept edits|auto[- ]?accept|auto mode)|auto[- ]?accept edits on|bypass permissions on)/i,
    // "● Bash(npm test)"  /  "● Update(src/foo.ts)"
    tool: /●\s*([A-Z][A-Za-z]+)\(([^)]*)\)/,
    // any assistant action bullet
    bullet: /●\s+(\S.*)/,
    // spinner gerund: leading glyph then a word ending in … or ...
    verb: /[✻✶✳✢✽✦✺·*◍○●⠿⡿⣷⣯⣟⢿]\s*([A-Za-z][a-z]+)(?:…|\.\.\.)/,
    tokens: /([\d][\d.,]*\s*[kmKM]?)\s*tokens/i,
    elapsed: /(?:^|[(\s·])(\d+(?:\.\d+)?)s(?=[\s·)]|$)/,
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
      if (el) meta.elapsed = el[1] + 's';
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
    const iWorking = lastIndex(lines, RE.interrupt);
    const iIdle = lastIndex(lines, RE.shortcuts);
    const meta = collectMeta(lines, iWorking);

    // pick the live signal nearest the bottom of the screen
    const winner = Math.max(iApproval, iWorking, iIdle);

    if (winner >= 0 && winner === iApproval) {
      let q = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/do you want to/i.test(lines[i])) { q = clean(lines[i]); break; }
      }
      const detail = q || (meta.tool ? 'approve ' + meta.tool : 'awaiting your approval');
      return { state: 'approval', label: 'needs you', detail: detail.slice(0, 120), meta };
    }

    if (winner >= 0 && winner === iWorking) {
      const vm = lines[iWorking].match(RE.verb);
      const verb = vm ? vm[1] : null;
      const detail = meta.tool || (verb ? verb + '…' : lastBullet(lines)) || 'working…';
      return { state: 'working', label: verb ? verb.toLowerCase() : 'working', detail, meta };
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
