// MCP 2026-07-28: no handshake, no session. Every request carries its own version,
// identity and capabilities in _meta, and server/discover replaces initialize.
import { runTool, toolDescriptors } from './tools.js';

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

const SERVER_INFO = { name: 'memo', title: 'memo', version: '1.0.0' };
const INSTRUCTIONS =
  'memo keeps notes, files and transcripts. memo_write saves a note; memo_search finds notes by text, newest first; upload stores a file and returns a link anyone can open; transcribe turns audio at a url into timestamped text with start in seconds.';

const CACHE_MS = 60_000;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function fail(res, status, code, message, id, data) {
  const error = { code, message };
  if (data) error.data = data;
  res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error });
}

function ok(res, id, result) {
  res.status(200).json({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } });
}

export function isModernRequest(req) {
  const header = req.get('mcp-protocol-version');
  // An unknown version goes here too, so the reply lists what this server does speak.
  if (header) return header === MODERN_VERSION || !LEGACY_VERSIONS.includes(header);
  return req.body?.params?._meta?.[META_VERSION] === MODERN_VERSION;
}

export async function handleModern(req, res) {
  const id = req.body?.id ?? null;

  // This revision has no SSE stream, no session and no resumption: GET and DELETE are not used.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).type('text').send('only POST is used by MCP 2026-07-28');
  }

  const message = req.body;
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return fail(res, 400, INVALID_PARAMS, 'Body is not a JSON-RPC request', id);
  }

  const header = req.get('mcp-protocol-version');
  const declared = message.params?._meta?.[META_VERSION];

  if (!header) {
    return fail(res, 400, HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version is missing', id);
  }
  if (!SUPPORTED_VERSIONS.includes(header)) {
    return fail(res, 400, UNSUPPORTED_VERSION, 'Unsupported protocol version', id, {
      supported: SUPPORTED_VERSIONS,
      requested: header
    });
  }
  if (declared && declared !== header) {
    return fail(res, 400, HEADER_MISMATCH, 'Header mismatch: protocol version differs from body', id);
  }

  // Reject a header that disagrees with the body; a client that omits these headers is not rejected.
  const methodHeader = req.get('mcp-method');
  if (methodHeader && methodHeader !== message.method) {
    return fail(res, 400, HEADER_MISMATCH, 'Header mismatch: Mcp-Method differs from body', id);
  }

  if (message.id === undefined) return res.status(202).type('text').send('');

  switch (message.method) {
    case 'server/discover':
      return ok(res, id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: INSTRUCTIONS,
        ttlMs: CACHE_MS,
        cacheScope: 'public'
      });

    case 'tools/list':
      return ok(res, id, { tools: toolDescriptors(), ttlMs: CACHE_MS, cacheScope: 'public' });

    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string') return fail(res, 400, INVALID_PARAMS, 'tools/call needs a name', id);
      const nameHeader = req.get('mcp-name');
      if (nameHeader && nameHeader !== name) {
        return fail(res, 400, HEADER_MISMATCH, 'Header mismatch: Mcp-Name differs from body', id);
      }
      const outcome = await runTool(name, message.params?.arguments);
      if (!outcome) return fail(res, 400, INVALID_PARAMS, `unknown tool: ${name}`, id);
      const result = { content: [{ type: 'text', text: outcome.text }] };
      if (outcome.structuredContent) result.structuredContent = outcome.structuredContent;
      if (outcome.isError) result.isError = true;
      return ok(res, id, result);
    }

    case 'ping':
      return ok(res, id, {});

    default:
      return fail(res, 404, METHOD_NOT_FOUND, 'Method not found', id);
  }
}
