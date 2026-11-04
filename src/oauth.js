import { randomUUID, timingSafeEqual } from 'node:crypto';
import { InvalidTokenError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { RESOURCE_URL } from './config.js';
import { db, persist, nowIso } from './store.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_S = 12 * 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function samePhrase(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(db().meta.phrase || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function page(body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>memo — approve a client</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.2rem}
code{font-size:.9em;background:#8882;padding:.1em .3em;border-radius:.25em}
input{font:inherit;width:100%;padding:.5rem;margin:.4rem 0 1rem;box-sizing:border-box}
button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}
label{font-weight:600;font-size:.9rem}
.warn{color:#b4530a}
</style>
<h1>memo</h1>
${body}`;
}

export function authorizePage(client, params) {
  const hidden = [
    ['client_id', client.client_id],
    ['redirect_uri', params.redirectUri],
    ['code_challenge', params.codeChallenge],
    ['state', params.state],
    ['scope', (params.scopes || []).join(' ')]
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join('\n');

  return page(`
<p>A client asks to use your memo server.</p>
<dl>
<dt>Client</dt><dd><code>${esc(client.client_name || client.client_id)}</code></dd>
<dt>Can do</dt><dd>save notes, search notes, upload files, transcribe audio</dd>
</dl>
<form method="post" action="/approve">
${hidden}
<label for="phrase">Pass phrase</label>
<input id="phrase" name="phrase" type="password" autocomplete="off" autofocus required>
<button type="submit">Approve</button>
</form>
<p class="warn">If you did not start this, close this page.</p>`);
}

export function approvePageError(message) {
  return page(`<p class="warn">${esc(message)}</p><p><a href="/plan">What this server does</a></p>`);
}

export function handleApprove({ client_id, redirect_uri, code_challenge, state, scope, phrase }) {
  if (!samePhrase(phrase)) return { error: 'Wrong pass phrase.' };
  const client = db().clients[client_id];
  if (!client) return { error: 'Unknown client.' };
  if (!code_challenge) return { error: 'Missing code challenge.' };

  let target;
  try {
    target = new URL(redirect_uri || client.redirect_uris?.[0]);
  } catch {
    return { error: 'Bad redirect address.' };
  }
  if (!(client.redirect_uris || []).includes(target.origin + target.pathname) && !(client.redirect_uris || []).includes(target.href)) {
    return { error: 'Redirect address is not registered for this client.' };
  }

  const code = randomUUID();
  db().codes[code] = {
    clientId: client_id,
    codeChallenge: code_challenge,
    redirectUri: target.href,
    scopes: scope ? scope.split(' ').filter(Boolean) : [],
    expiresAt: Date.now() + CODE_TTL_MS
  };
  persist();

  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return { redirect: target.href };
}

export function makeProvider() {
  return {
    clientsStore: {
      getClient(clientId) {
        return db().clients[clientId];
      },
      registerClient(client) {
        const full = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        db().clients[full.client_id] = full;
        persist();
        return full;
      }
    },

    async authorize(client, params, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(authorizePage(client, params));
    },

    async challengeForAuthorizationCode(client, code) {
      const grant = db().codes[code];
      if (!grant || grant.clientId !== client.client_id) throw new InvalidRequestError('Unknown authorization code');
      return grant.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, _redirectUri, resource) {
      const grant = db().codes[code];
      if (!grant || grant.clientId !== client.client_id) throw new InvalidRequestError('Unknown authorization code');
      if (grant.expiresAt < Date.now()) {
        delete db().codes[code];
        persist();
        throw new InvalidRequestError('Authorization code expired');
      }
      delete db().codes[code];

      const tokens = issueTokens(client, {
        scopes: grant.scopes,
        resource: resource || new URL(RESOURCE_URL)
      });
      return tokens;
    },

    async exchangeRefreshToken(client, refreshToken, scopes) {
      const grant = db().refresh[refreshToken];
      if (!grant || grant.clientId !== client.client_id) throw new InvalidRequestError('Unknown refresh token');
      if (grant.expiresAt < Date.now()) {
        delete db().refresh[refreshToken];
        persist();
        throw new InvalidRequestError('Refresh token expired');
      }
      delete db().refresh[refreshToken];
      return issueTokens(client, { scopes: scopes || grant.scopes, resource: grant.resource });
    },

    async verifyAccessToken(token) {
      const record = db().tokens[token];
      if (!record) throw new InvalidTokenError('Unknown access token');
      if (record.expiresAt * 1000 < Date.now()) {
        delete db().tokens[token];
        persist();
        throw new InvalidTokenError('Access token expired');
      }
      return {
        token,
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAt: record.expiresAt,
        resource: new URL(record.resource)
      };
    },

    async revokeToken(_client, request) {
      let changed = false;
      if (db().tokens[request.token]) {
        delete db().tokens[request.token];
        changed = true;
      }
      if (db().refresh[request.token]) {
        delete db().refresh[request.token];
        changed = true;
      }
      if (changed) persist();
    }
  };
}

function issueTokens(client, { scopes, resource }) {
  const access = randomUUID() + randomUUID().replace(/-/g, '');
  const refresh = randomUUID() + randomUUID().replace(/-/g, '');
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const resourceHref = String(resource);

  db().tokens[access] = { clientId: client.client_id, scopes, resource: resourceHref, expiresAt, createdAt: nowIso() };
  db().refresh[refresh] = {
    clientId: client.client_id,
    scopes,
    resource: resourceHref,
    expiresAt: Date.now() + REFRESH_TTL_MS
  };
  persist();

  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_S,
    refresh_token: refresh,
    scope: scopes.join(' ')
  };
}
