import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addNote, addUpload, findNotes } from './store.js';
import { transcribeAudio } from './transcribe.js';
import { BASE_URL } from './config.js';

const BASE64 = /^[A-Za-z0-9+/\r\n]{200,}={0,2}$/;
// Only the shape matters, and testing 11 MB of base64 overflows the regex stack: check a sample.
const looksBase64 = (value) => value.length >= 200 && BASE64.test(value.slice(0, 4096));

// A stranger calls these tools. Accept the field names a client is likely to use.
function pickUpload(input) {
  const keys = ['content_base64', 'content', 'data', 'file_base64', 'base64', 'file'];
  let bytes = null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && looksBase64(value)) {
      bytes = Buffer.from(value.replace(/\s/g, ''), 'base64');
      break;
    }
  }
  const name = input.name || input.filename || input.file_name || input.fileName || 'upload.bin';
  const mime = input.mime || input.mime_type || input.content_type || 'application/octet-stream';
  if (!bytes) {
    if (typeof input.text === 'string') bytes = Buffer.from(input.text, 'utf8');
  }
  return { bytes, name, mime };
}

// One definition per tool, used by both protocol eras: zod for 2025-11-25, JSON Schema for 2026-07-28.
const definitions = [
  {
    name: 'memo_write',
    title: 'Save a note',
    description: 'Saves a note on this server and returns its id.',
    input: z.object({ text: z.string().describe('the note text to keep') }).passthrough(),
    output: z.object({ id: z.string(), text: z.string(), createdAt: z.string() }),
    async run(input) {
      const body = String(input?.text ?? input?.note ?? input?.content ?? '');
      if (!body) return { text: 'memo_write needs a text', isError: true };
      const note = addNote(body);
      return { text: `saved note ${note.id}`, structuredContent: note };
    }
  },
  {
    name: 'memo_search',
    title: 'Find notes',
    description:
      'Finds notes whose text contains the query. Newest first. An empty query returns every note.',
    input: z
      .object({ query: z.string().optional().describe('text to look for; empty means every note') })
      .passthrough(),
    output: z.object({
      notes: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.string() }))
    }),
    async run(input) {
      const notes = findNotes(input?.query ?? input?.q ?? '');
      return { text: `${notes.length} note(s)`, structuredContent: { notes } };
    }
  },
  {
    name: 'upload',
    title: 'Store a file',
    description:
      'Puts a file on this server and returns a link anyone can open. Send the bytes as base64 in content_base64, or plain text in text.',
    input: z
      .object({
        name: z.string().optional().describe('file name, with extension'),
        mime: z.string().optional().describe('content type, e.g. text/plain'),
        content_base64: z.string().optional().describe('the file bytes, base64 encoded'),
        text: z.string().optional().describe('plain text file contents, instead of content_base64')
      })
      .passthrough(),
    output: z.object({ url: z.string(), id: z.string(), name: z.string(), size: z.number() }),
    async run(input) {
      const { bytes, name, mime } = pickUpload(input || {});
      if (!bytes) return { text: 'upload needs content_base64 or text', isError: true };
      const file = addUpload({ name, mime, bytes });
      const url = `${BASE_URL.origin}/f/${file.id}/${encodeURIComponent(file.name)}`;
      return { text: url, structuredContent: { url, id: file.id, name: file.name, size: file.size } };
    }
  },
  {
    name: 'transcribe',
    title: 'Transcribe audio',
    description: 'Turns audio at a url into timestamped text. Segments start in seconds.',
    input: z
      .object({ url: z.string().describe('public http(s) address of an audio file') })
      .passthrough(),
    output: z.object({
      segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
      duration: z.number().optional()
    }),
    async run(input) {
      const url = String(input?.url ?? input?.audio_url ?? '');
      if (!url) return { text: 'transcribe needs a url', isError: true };
      try {
        const result = await transcribeAudio(url);
        return { text: `${result.segments.length} segment(s)`, structuredContent: result };
      } catch (err) {
        return { text: `transcription failed: ${url}: ${err.message}`, isError: true };
      }
    }
  }
];

const withoutSchemaKey = ({ $schema, ...rest }) => rest;

export function toolDescriptors() {
  return definitions.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: withoutSchemaKey(z.toJSONSchema(tool.input, { io: 'input' })),
    outputSchema: withoutSchemaKey(z.toJSONSchema(tool.output, { io: 'output' }))
  }));
}

export async function runTool(name, args) {
  const tool = definitions.find((t) => t.name === name);
  if (!tool) return null;
  return tool.run(args || {});
}

function wire(outcome) {
  const result = { content: [{ type: 'text', text: outcome.text }] };
  if (outcome.structuredContent) result.structuredContent = outcome.structuredContent;
  if (outcome.isError) result.isError = true;
  return result;
}

export function buildServer() {
  const server = new McpServer({ name: 'memo', version: '1.0.0' });

  for (const tool of definitions) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output
      },
      async (input) => wire(await tool.run(input))
    );
  }

  return server;
}
