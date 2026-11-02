import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, scenariosEn, statusNames, statusNamesEn, getFrame, advance, isFinished } from '../src/demo.mjs';

test('Every workflow ends with a completed, collected result and clamps at its final frame', () => {
  for (const [mode, scenario] of Object.entries(scenarios)) {
    let index = 0;
    for (let i = 0; i < scenario.frames.length + 3; i++) index = advance(mode, index);
    assert.equal(index, scenario.frames.length - 1);
    const final = getFrame(mode, index);
    assert.equal(final.status, 'done'); assert.equal(final.progress, 100);
    assert.equal(final.sentinel, true); assert.equal(final.collected, true);
    assert.equal(isFinished(mode, index), true);
  }
});
test('Interjection interrupts the old turn and preserves history before resuming', () => {
  const frames = scenarios.interject.frames, interrupted = frames.findIndex(f => f.status === 'interrupted');
  assert.ok(interrupted > 0);
  assert.equal(frames[interrupted].preserved, true);
  assert.equal(frames[interrupted + 1].status, 'running');
  assert.equal(frames[interrupted + 1].preserved, true);
});
test('Process loss stops the current turn; session restoration happens before a new run', () => {
  const frames = scenarios.resume.frames;
  assert.equal(frames[1].status, 'interrupted');
  assert.equal(frames[2].status, 'detached');
  assert.equal(frames[3].status, 'idle');
  assert.equal(frames[3].preserved, true);
  assert.equal(frames[4].status, 'running');
  assert.equal(frames[1].sentinel, undefined);
  assert.equal(frames[2].progress, frames[1].progress);
  assert.ok(frames.every(f => f.persisted));
});
test('Parallel jobs progress independently and all complete without overrunning 100%', () => {
  const frames = scenarios.parallel.frames;
  for (const f of frames) { assert.equal(f.jobs.length, 3); assert.ok(f.jobs.every(n => n >= 0 && n <= 100)); }
  assert.deepEqual(frames.at(-1).jobs, [100, 100, 100]);
  assert.ok(frames.some(f => f.jobs[2] === 100 && f.jobs[0] < 100));
});
test('Invalid workflow state cannot silently display misleading content', () => {
  assert.throws(() => getFrame('unknown', 0), RangeError);
  for (const value of [-1, 6, 1.5, NaN]) assert.throws(() => getFrame('dispatch', value), RangeError);
});
test('English demo mirrors every scenario, frame count, and status label', () => {
  assert.deepEqual(Object.keys(scenariosEn), Object.keys(scenarios));
  assert.deepEqual(Object.keys(statusNamesEn), Object.keys(statusNames));
  for (const mode of Object.keys(scenarios)) {
    assert.equal(scenariosEn[mode].frames.length, scenarios[mode].frames.length, mode);
    assert.ok(scenariosEn[mode].label && scenariosEn[mode].summary && scenariosEn[mode].description);
    assert.ok(scenariosEn[mode].frames.every(f => f.title && f.detail && f.log));
  }
  assert.equal(statusNamesEn.done, 'Done');
  assert.equal(getFrame('dispatch', 0, scenariosEn).title.startsWith('Meet'), true);
  assert.equal(advance('dispatch', 0, scenariosEn), 1);
  assert.equal(isFinished('dispatch', scenariosEn.dispatch.frames.length - 1, scenariosEn), true);
});

test('Demo snippets use the real MCP argument and response keys', () => {
  const frames = Object.values(scenarios).flatMap(s => s.frames);
  const interject = frames.filter(f => f.tool === 'dsh_interject');
  const reads = frames.filter(f => f.tool === 'dsh_read');
  const status = frames.filter(f => f.tool === 'dsh_status');
  assert.ok(interject.length > 0 && reads.length > 0 && status.length > 0);
  for (const f of interject) {
    assert.match(f.code, /message:/);
    assert.doesNotMatch(f.code, /\bprompt:/);
  }
  for (const f of reads) {
    assert.match(f.code, /cursor:/);
    assert.doesNotMatch(f.code, /next_cursor/);
  }
  for (const f of status) assert.doesNotMatch(f.code, /\bhistory:/);
});
