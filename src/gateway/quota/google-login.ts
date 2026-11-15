// Signing in with a Google account from the app, for reading quotas when a service account key
// cannot be made (an organization policy often forbids it) and gcloud is not installed.
// The OAuth 2.0 flow for desktop apps (RFC 8252): the browser opens Google's sign-in page, Google
// sends the browser back to a one-off server on 127.0.0.1 with a code, and the code is exchanged
// for a refresh token at Google's token endpoint only. The result has the same shape as the file
// "gcloud auth application-default login" writes, so GoogleAuth uses it unchanged.
// The OAuth client comes from a JSON file the user downloads in the Cloud Console ("Desktop app").
// Its client_secret is not a secret in the usual sense for desktop apps, but it is still kept out
// of logs and errors.
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { NidusError } from '../../errors.js';
import { CLOUD_SCOPE, TOKEN_URL } from './google-auth.js';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** cloud-platform for the management APIs; openid + email only to show which account signed in. */
export const SIGN_IN_SCOPES = ['openid', 'email', CLOUD_SCOPE];

export interface OAuthClient { clientId: string; clientSecret: string }

/** The user's stored credentials after a sign-in: what GoogleAuth reads, plus the account for display. */
export interface StoredUser { type: 'authorized_user'; client_id: string; client_secret: string; refresh_token: string; account?: string }

const fail = (reason: string, message: string) => Object.assign(new NidusError('authentication', message), { reason });

/** Reads the client JSON downloaded from the Cloud Console. Only the "Desktop app" type can use a loopback redirect. */
export function parseOAuthClient(text: string): OAuthClient {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw fail('oauth_client_invalid', 'The OAuth client file is not valid JSON.'); }
  if (raw?.web && !raw?.installed) throw fail('oauth_client_web', 'This OAuth client is a "Web application". Make one of the "Desktop app" type.');
  const client = raw?.installed ?? raw;
  if (typeof client?.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com') || typeof client?.client_secret !== 'string' || !client.client_secret) {
    throw fail('oauth_client_invalid', 'Expected an OAuth client file from the Cloud Console (JSON with "installed": { "client_id", "client_secret" }).');
  }
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

export interface SignInOptions {
  /** Opens the sign-in page in the user's browser. */
  open?: (url: string) => Promise<void>;
  fetcher?: typeof fetch;
  /** How long to wait for the browser. The app's bridge gives a call 5 minutes. */
  timeoutMs?: number;
  /** Fixed port, for tests; 0 picks a free one. */
  port?: number;
  /** Told the URL once the loopback server listens (tests play the browser). */
  onUrl?: (url: string) => void;
}

function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // macOS: "open" hands the URL to the default browser. The URL has no secret (PKCE keeps the verifier here).
    execFile('open', [url], { timeout: 10_000 }, error => { if (error) reject(error); else resolve(); });
  });
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:-apple-system,sans-serif;max-width:32em;margin:4em auto;line-height:1.5"><h2>${title}</h2><p>${body}</p></body>`;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('no port')); return; }
      resolve(address.port);
    });
  });
}

/** Reads the account's address from the id_token Google returned with the tokens. It arrived straight from Google over TLS, so it is used for display without a signature check. */
function emailOf(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof claims?.email === 'string' && claims.email.includes('@') ? claims.email : undefined;
  } catch { return undefined; }
}

/** Runs the sign-in and resolves with the credentials to store. Rejects when the user declines, the browser never comes back, or Google refuses. */
export async function signIn(client: OAuthClient, options: SignInOptions = {}): Promise<StoredUser> {
  const fetcher = options.fetcher ?? fetch;
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');

  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  // The browser may answer (or decline) before "open" has returned; the rejection waits for the await below.
  code.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const reply = (status: number, html: string) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html); };
    if (url.pathname !== '/' || !settle) { reply(404, page('Nidus', '')); return; }
    if (url.searchParams.get('state') !== state) { reply(400, page('로그인 확인 실패', '이 창은 Nidus가 연 로그인이 아닙니다. 앱에서 다시 시도하세요.')); return; }
    const error = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    if (error || !got) {
      reply(200, page('로그인이 취소됐습니다', 'Nidus로 돌아가 다시 시도할 수 있습니다. 이 창은 닫아도 됩니다.'));
      settle.reject(fail(error === 'access_denied' ? 'sign_in_declined' : 'sign_in_failed', error === 'access_denied' ? 'The sign-in was declined in the browser.' : 'Google did not return a sign-in code.'));
    } else {
      reply(200, page('로그인됐습니다', 'Nidus로 돌아가세요. 이 창은 닫아도 됩니다.'));
      settle.resolve(got);
    }
    settle = null;
  });

  const port = await listen(server, options.port ?? 0);
  const redirect = `http://127.0.0.1:${port}`;
  const timer = setTimeout(() => settle?.reject(fail('sign_in_timeout', 'The browser did not come back in time. Try again.')), options.timeoutMs ?? 4 * 60_000);
  try {
    const url = new URL(AUTH_URL);
    for (const [k, v] of Object.entries({ client_id: client.clientId, redirect_uri: redirect, response_type: 'code', scope: SIGN_IN_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state })) url.searchParams.set(k, v);
    options.onUrl?.(url.toString());
    try { await (options.open ?? openInBrowser)(url.toString()); } catch { throw fail('sign_in_failed', 'Could not open the browser.'); }
    const granted = await code;

    let response: Response;
    try {
      response = await fetcher(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: granted, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirect, code_verifier: verifier }).toString(), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch { throw new NidusError('network', 'Could not reach Google to finish signing in.'); }
    let raw: any = null;
    try { raw = await response.json(); } catch {}
    if (!response.ok || typeof raw?.refresh_token !== 'string' || !raw.refresh_token) throw fail('sign_in_failed', 'Google did not accept the sign-in. Check that the OAuth client belongs to this project and that you are listed as a test user.');
    return { type: 'authorized_user', client_id: client.clientId, client_secret: client.clientSecret, refresh_token: raw.refresh_token, account: emailOf(raw.id_token) };
  } finally {
    clearTimeout(timer);
    settle = null;
    server.close();
  }
}
