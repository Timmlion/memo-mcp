import { OPENROUTER_API_KEY, TRANSCRIBE_MODEL } from './config.js';

const MAX_BYTES = 20 * 1024 * 1024;

const FORMATS = [
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/ogg', 'ogg'],
  ['audio/webm', 'webm'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac']
];

const PROMPT = `Transcribe the speech in this audio. Reply with JSON only, no commentary:
{"segments":[{"start":<seconds>,"end":<seconds>,"text":"..."}]}
One segment per sentence or short phrase. start and end are numbers in seconds from the beginning of the audio.`;

const RETRY_HINT = `Your previous answer gave every segment the same timestamp. Give each segment a start and end in seconds that increase from the beginning of the audio: the first segment starts at 0, and the last ends at the length of the file.`;

export function degenerate(result) {
  const starts = new Set(result.segments.map((s) => s.start));
  const longest = Math.max(...result.segments.map((s) => s.end), 0);
  const words = result.segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  return starts.size < 2 && words > 5 && longest < 1;
}

function audioFormat(contentType, url) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const hit = FORMATS.find(([mime]) => mime === type);
  if (hit) return hit[1];
  const ext = (new URL(url).pathname.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (ext && FORMATS.some(([, f]) => f === ext.toLowerCase())) return ext.toLowerCase();
  return 'mp3';
}

export function parseSegments(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('model did not return JSON');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const list = Array.isArray(parsed.segments) ? parsed.segments : [];
  const segments = list
    .map((s, i) => ({
      start: Number(s.start ?? s.begin ?? i),
      end: Number(s.end ?? s.stop ?? i + 1),
      text: String(s.text ?? s.content ?? '').trim()
    }))
    .filter((s) => s.text && Number.isFinite(s.start));
  if (!segments.length) throw new Error('model returned no segments');
  segments.sort((a, b) => a.start - b.start);
  return {
    segments: segments.map((s) => ({ start: s.start, end: Number.isFinite(s.end) ? s.end : s.start, text: s.text })),
    duration: segments.length ? segments[segments.length - 1].end : undefined
  };
}

export async function transcribeAudio(url) {
  if (!OPENROUTER_API_KEY) throw new Error('no transcription key is configured on this server');

  const audioRes = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!audioRes.ok) throw new Error(`could not read the audio: HTTP ${audioRes.status}`);
  const buf = Buffer.from(await audioRes.arrayBuffer());
  if (!buf.length) throw new Error('the audio file is empty');
  if (buf.length > MAX_BYTES) throw new Error(`the audio is over ${MAX_BYTES} bytes`);
  const format = audioFormat(audioRes.headers.get('content-type'), url);

  const first = await callModel(buf, format, PROMPT);
  if (!degenerate(first)) return first;
  return callModel(buf, format, `${PROMPT}\n\n${RETRY_HINT}`);
}

async function callModel(buf, format, prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'memo mcp server'
    },
    body: JSON.stringify({
      model: TRANSCRIBE_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'input_audio',
              input_audio: { data: buf.toString('base64'), format }
            }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(120_000)
  });

  if (!res.ok) throw new Error(`transcription service answered HTTP ${res.status}`);
  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content;
  const rawText = typeof raw === 'string' ? raw : (raw || []).map((p) => p.text || '').join('');
  if (!rawText) throw new Error('transcription service returned nothing');
  return parseSegments(rawText);
}
