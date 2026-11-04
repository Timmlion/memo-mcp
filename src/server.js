import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { buildServer } from './tools.js';
import { handleModern, isModernRequest, SUPPORTED_VERSIONS } from './modern.js';
import { approvePageError, handleApprove, makeProvider } from './oauth.js';
import { BASE_URL, PLAN_URL, PORT, RESOURCE_URL } from './config.js';
import { db, load, readUpload } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
load();

const provider = makeProvider();
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: BASE_URL,
    serviceDocumentationUrl: PLAN_URL,
    resourceServerUrl: RESOURCE_URL,
    resourceName: 'memo',
    scopesSupported: []
  })
);

app.post('/approve', (req, res) => {
  const result = handleApprove(req.body || {});
  res.setHeader('Cache-Control', 'no-store');
  if (result.error) return res.status(401).type('html').send(approvePageError(result.error));
  return res.redirect(303, result.redirect);
});

const planHtml = fs.readFileSync(path.join(here, '..', 'public', 'plan.html'), 'utf8');
app.get('/plan', (_req, res) => res.type('html').send(planHtml));
app.get('/', (_req, res) => res.redirect(302, '/plan'));
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, notes: db().notes.length, protocols: SUPPORTED_VERSIONS })
);

app.get(['/f/:id', '/f/:id/:name'], (req, res) => {
  const file = readUpload(req.params.id);
  if (!file) return res.status(404).type('text').send('no such file');
  res.type(file.mime);
  res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/["\\]/g, '')}"`);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.send(file.bytes);
});

app.use(
  '/mcp',
  requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(RESOURCE_URL),
    expectedResource: RESOURCE_URL
  })
);

const transports = new Map();

async function handleMcp(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (sessionId) {
      return res
        .status(404)
        .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    }
    if (req.method !== 'POST' || req.body?.method !== 'initialize') {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Send an initialize request first' },
        id: req.body?.id ?? null
      });
    }
    // This SDK passes the new session id, not the transport, so keep the transport in a closure.
    let sessionTransport;
    sessionTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => transports.set(sessionId, sessionTransport)
    });
    transport = sessionTransport;
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await buildServer().connect(transport);
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp request failed', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

app.post('/mcp', (req, res) => (isModernRequest(req) ? handleModern(req, res) : handleMcp(req, res)));
for (const method of ['get', 'delete']) {
  app[method]('/mcp', (req, res) => (isModernRequest(req) ? handleModern(req, res) : handleMcp(req, res)));
}

app.use((_req, res) => res.status(404).type('text').send('not found'));

app.listen(PORT, () => {
  console.log(`memo on ${BASE_URL.origin}, mcp at ${RESOURCE_URL.href}, plan at ${PLAN_URL.href}`);
  console.log(`approve pass phrase: ${process.env.APPROVE_PHRASE ? '(from env)' : db().meta.phrase}`);
});
