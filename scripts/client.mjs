import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.env.MEMO_BASE || 'http://localhost:8787').replace(/\/$/, '');
const PHRASE = process.env.MEMO_PHRASE || '';
const REDIRECT = 'http://localhost:9999/callback';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function getToken() {
  const reg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'pi harness',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const client = await reg.json();

  const verifier = b64url(Buffer.from(randomUUID() + randomUUID()));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const approve = await fetch(`${BASE}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      state: 'harness',
      phrase: PHRASE
    }),
    redirect: 'manual'
  });
  const location = approve.headers.get('location');
  if (!location) throw new Error(`approve failed: ${approve.status} ${await approve.text()}`);
  const code = new URL(location).searchParams.get('code');

  const tok = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT
    })
  });
  if (!tok.ok) throw new Error(`token failed: ${tok.status} ${await tok.text()}`);
  return (await tok.json()).access_token;
}

export async function connect() {
  const token = await getToken();
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: 'pi-harness', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , tool, rawArgs] = process.argv;
  const client = await connect();
  if (!tool) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}(${Object.keys(t.inputSchema?.properties || {}).join(', ')})`);
  } else {
    const result = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
    console.log(JSON.stringify(result, null, 2));
  }
  await client.close();
}
