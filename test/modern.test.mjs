import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-modern-'));
const { handleModern, isModernRequest, MODERN_VERSION } = await import('../src/modern.js');

const MODERN = { 'mcp-protocol-version': MODERN_VERSION };

function request(body, headers = MODERN, method = 'POST') {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, body, get: (name) => lower[name.toLowerCase()] };
}

function response() {
  return {
    statusCode: 0,
    payload: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    type() {
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    }
  };
}

async function call(body, headers = MODERN, method = 'POST') {
  const res = response();
  await handleModern(request(body, headers, method), res);
  return res;
}

const rpc = (method, params, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params })
});

test('server/discover answers with both eras and a cache hint', async () => {
  const res = await call(rpc('server/discover', {}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.result.resultType, 'complete');
  assert.deepEqual(res.payload.result.supportedVersions.includes(MODERN_VERSION), true);
  assert.deepEqual(res.payload.result.supportedVersions.includes('2025-11-25'), true);
  assert.equal(res.payload.result._meta['io.modelcontextprotocol/serverInfo'].name, 'memo');
  assert.ok(res.payload.result.ttlMs >= 0);
});

test('a request without the version header is a header mismatch', async () => {
  const res = await call(rpc('tools/list'), {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, -32020);
});

test('an unsupported version lists what the server does speak', async () => {
  const res = await call(rpc('tools/list'), { 'mcp-protocol-version': '1900-01-01' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, -32022);
  assert.ok(res.payload.error.data.supported.includes(MODERN_VERSION));
});

test('a body version that differs from the header is refused', async () => {
  const body = rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } });
  const res = await call(body);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, -32020);
});

test('a Mcp-Method header that differs from the body is refused', async () => {
  const res = await call(rpc('tools/list'), { ...MODERN, 'mcp-method': 'tools/call' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, -32020);
});

test('tools/list declares an input and an output schema for every tool', async () => {
  const res = await call(rpc('tools/list'));
  const { tools } = res.payload.result;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['memo_write', 'memo_search', 'upload', 'transcribe']
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.outputSchema.type, 'object');
  }
});

test('tools/call memo_write returns structured content with an id', async () => {
  const res = await call(rpc('tools/call', { name: 'memo_write', arguments: { text: 'hello' } }));
  assert.equal(res.payload.result.resultType, 'complete');
  assert.equal(typeof res.payload.result.structuredContent.id, 'string');
  assert.equal(res.payload.result.structuredContent.text, 'hello');
});

test('tools/call with a Mcp-Name header that differs is refused', async () => {
  const res = await call(rpc('tools/call', { name: 'memo_write', arguments: { text: 'x' } }), {
    ...MODERN,
    'mcp-name': 'memo_search'
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, -32020);
});

test('an unknown tool is invalid params and an unknown method is 404', async () => {
  const tool = await call(rpc('tools/call', { name: 'nope', arguments: {} }));
  assert.equal(tool.payload.error.code, -32602);

  const method = await call(rpc('resources/list', {}));
  assert.equal(method.statusCode, 404);
  assert.equal(method.payload.error.code, -32601);
});

test('GET is not part of this revision', async () => {
  const res = await call(undefined, MODERN, 'GET');
  assert.equal(res.statusCode, 405);
});

test('a modern request is recognised by its header or its _meta', () => {
  assert.equal(isModernRequest(request(rpc('tools/list'))), true);
  assert.equal(
    isModernRequest(request(rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION } }), {})),
    true
  );
  assert.equal(isModernRequest(request(rpc('initialize'), { 'mcp-protocol-version': '2025-11-25' })), false);
  // An unknown version is answered with the supported list instead of a legacy error.
  assert.equal(isModernRequest(request(rpc('tools/list'), { 'mcp-protocol-version': '2019-01-01' })), true);
});

test('a multi-megabyte upload goes through instead of blowing the regex stack', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 'line of a log file\n');
  const res = await call(
    rpc('tools/call', {
      name: 'upload',
      arguments: { name: 'big.log', mime: 'text/plain', content_base64: big.toString('base64') }
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.result.structuredContent.size, big.length);
});
