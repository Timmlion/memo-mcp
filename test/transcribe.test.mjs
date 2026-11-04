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

test('a failed url is named in the error, with what went wrong', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  const { transcribeAudio } = await import('../src/transcribe.js');

  const answers = {
    'https://hq.mega.dev/media/s02e03/missing.mp3': new Response('nope', { status: 404 }),
    'https://hq.mega.dev/login': new Response('<html>hi</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => answers[String(url)] ?? new Response('', { status: 500 });
  try {
    await assert.rejects(transcribeAudio('https://hq.mega.dev/media/s02e03/missing.mp3'), (err) => {
      assert.match(err.message, /could not read the audio: HTTP 404/);
      return true;
    });
    await assert.rejects(transcribeAudio('https://hq.mega.dev/login'), /is a web page, not a recording/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
