const { detect } = require('../src/detector.js');

let pass = 0, fail = 0;
function check(name, lines, expected, expectDetail) {
  const r = detect(lines);
  const ok = r.state === expected && (!expectDetail || (r.detail || '').includes(expectDetail));
  console.log(`${ok ? '✓' : '✗'} ${name}  -> state=${r.state} label="${r.label}" detail="${r.detail}" meta=${JSON.stringify(r.meta)}`);
  if (ok) pass++; else { fail++; console.log(`    EXPECTED state=${expected}${expectDetail ? ` detail~"${expectDetail}"` : ''}`); }
}

check('working (spinner + tool + tokens)', [
  "● I'll run the tests now.",
  '',
  '● Bash(npm test)',
  '  ⎿ Running…',
  '',
  '✻ Cogitating… (12s · ↑ 3.4k tokens · esc to interrupt)',
], 'working', 'Bash');

check('working (spinner only, no tool)', [
  '● Let me think about this.',
  '',
  '✶ Pondering… (3s · esc to interrupt)',
], 'working', 'Pondering');

check('approval (permission prompt)', [
  '● Bash(rm -rf build)',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again",
  '  3. No, and tell Claude what to do differently (esc)',
], 'approval', 'proceed');

check('approval (edit confirmation)', [
  '● Update(src/main.js)',
  'Do you want to make this edit to main.js?',
  '❯ 1. Yes',
  '  2. No',
], 'approval');

check('idle input box', [
  '● Done! All tests pass.',
  '',
  '╭───────────────────────────────╮',
  '│ >                             │',
  '╰───────────────────────────────╯',
  '  ? for shortcuts        45% context left',
], 'input', 'Done');

check('lingering approval but now idle -> input', [
  'Do you want to proceed?',
  '❯ 1. Yes',
  '● Sure, all done.',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
  '  ? for shortcuts',
], 'input');

check('needs you: finished, last paragraph is a question', [
  '● Want me to dig into any specific leg?',
  '',
  '❋ Sautéed for 2m 28s',
  '',
  '❯',
  '▶▶ auto mode on (shift+tab to cycle) · ← for agents',
], 'approval', 'dig into');

check('needs you: question after a done-timer + empty prompt', [
  'billing guard (skip if a non-deleted bill with that',
  'readingId exists) would cover both cases cleanly. Want',
  'me to look at that next?',
  '❋ Brewed for 22m 58s',
  '',
  '❯',
  '▶▶ auto mode on (shift+tab to cycle) · ← for agents',
], 'approval', 'look at that next');

check('needs you: question (other done-verb timer)', [
  "oolify will redeploy both automatically. Per my notes,",
  'the API blips with a Traefik 503 for a few minutes',
  "during the swap, that's the normal deploy cutover. Want",
  'e to verify the live /capabilities response once the',
  'eploy settles?',
  '❋ Crunched for 2m 33s',
  '',
  '❯',
  '▶▶ auto mode on (shift+tab to cycle) · ← for agents',
], 'approval', 'settles');

check('idle (statement, not a question -> stays ready)', [
  '● All set.',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
], 'input');

check('working: spinner + auto-mode footer, "esc to interrupt" truncated', [
  '● Backend builds. Let me check existing routes.',
  '',
  '✳ Fixing TC-DOC document upload… (39m 57s)',
  '  ⎿ TC-DOC-001/002: Document upload + versioni…',
  '     ✓ Map loan-management architecture for triag…',
  '     … +3 completed',
  '',
  '> ',
  '▶▶ auto mode on (shift+tab to cycle) · esc to interrup',   // clipped final 't'
], 'working', 'Fixing');

check('working: long multi-word gerund line, no interrupt on it', [
  '✶ Reticulating splines and warming caches… (2m 5s)',
  '▶▶ auto mode on (shift+tab to cycle) · esc to interrupt',
], 'working');

check('working wins over old idle hint above', [
  '  ? for shortcuts',
  '● Now running the build.',
  '● Bash(npm run build)',
  '✳ Building… (8s · ↑ 1.2k tokens · esc to interrupt)',
], 'working', 'Bash');

check('error', [
  '● Bash(npm test)',
  '  ⎿ Error: command failed with exit code 1',
  'Traceback (most recent call last):',
], 'error');

check('empty screen', [], 'ready');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
