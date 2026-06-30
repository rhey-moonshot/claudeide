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

check('idle (auto mode footer, no box)', [
  '● Want me to dig into any specific leg?',
  '',
  '❋ Sautéed for 2m 28s',
  '',
  '❯',
  '▶▶ auto mode on (shift+tab to cycle) · ← for agents',
], 'input', 'dig into');

check('idle (accept-edits footer)', [
  '● All set.',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
], 'input');

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
