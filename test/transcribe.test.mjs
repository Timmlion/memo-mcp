import assert from 'node:assert/strict';
import test from 'node:test';
import { degenerate, parseSegments } from '../src/transcribe.js';

test('reads segments sorted by start', () => {
  const r = parseSegments('{"segments":[{"start":3,"end":4,"text":"b"},{"start":0,"end":1,"text":"a"}]}');
  assert.deepEqual(r.segments.map((s) => s.text), ['a', 'b']);
  assert.equal(r.duration, 4);
});

test('tolerates prose around the json', () => {
  const r = parseSegments('Here you go:\n{"segments":[{"start":0,"end":2,"text":"hi"}]}\nDone.');
  assert.equal(r.segments.length, 1);
});

test('rejects an answer with no segments', () => {
  assert.throws(() => parseSegments('{"segments":[]}'), /no segments/);
});

test('flags timings that collapse to one moment', () => {
  assert.equal(degenerate(parseSegments('{"segments":[{"start":0.07,"end":0.07,"text":"one two three four five six"}]}')), true);
});

test('accepts spreading timings', () => {
  assert.equal(degenerate(parseSegments('{"segments":[{"start":0,"end":2.8,"text":"a"},{"start":3.2,"end":6.1,"text":"b"}]}')), false);
});
