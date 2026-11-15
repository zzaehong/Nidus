// Access tokens for Google Cloud's management APIs (Cloud Quotas, Cloud Monitoring, Cloud Billing).
// These are not the Gemini API: an API key cannot read them. A token comes from, in this order:
//   1. what the user stored in the Keychain (account "google-cloud"): a service account key, or
//      the refresh token from signing in with a Google account in the app (google-login.ts)
//   2. Application Default Credentials: $GOOGLE_APPLICATION_CREDENTIALS, or the file that
//      "gcloud auth application-default login" writes
//   3. the gcloud CLI, if it is installed and signed in ("gcloud auth print-access-token")
// Tokens stay in memory. Nothing here is written to a log, and a secret is only ever sent to
// Google's token endpoint.
import { createSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NidusError } from '../../errors.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Cloud Quotas accepts only this scope; Monitoring and Billing accept it too. */
export const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export type AuthSource = 'service-account' | 'user' | 'adc-service-account' | 'adc-user' | 'gcloud';

export interface AccessToken {
  token: string;
  source: AuthSource;
  /** A person's credentials: Google then needs to be told which project the request is billed against. */
  user: boolean;
  /** The service account's address, when there is one (not a secret). */
  account: string | null;
}

export interface GoogleAuthOptions {
  /** The stored credentials (JSON text: a service account key, or a user's refresh token), or null. */
  secret?: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetcher?: typeof fetch;
  /** Runs gcloud and gives its output; rejects when gcloud is missing or not signed in. */
  gcloud?: () => Promise<string>;
  now?: () => number;
}

const fail = (reason: string, message: string) => Object.assign(new NidusError('authentication', message), { reason });

function runGcloud(home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const PATH = ['/opt/homebrew/bin', '/usr/local/bin', join(home, 'google-cloud-sdk', 'bin'), '/usr/bin', '/bin'].join(':');
    execFile('gcloud', ['auth', 'print-access-token', '--quiet'], { env: { PATH, HOME: home }, timeout: 20_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

interface ServiceAccountKey { type: 'service_account'; client_email: string; private_key: string; token_uri?: string }
interface UserCredentials { type: 'authorized_user'; client_id: string; client_secret: string; refresh_token: string; account?: string }

function parseCredentials(text: string): ServiceAccountKey | UserCredentials {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw fail('cloud_auth_invalid', 'The Google Cloud credentials are not valid JSON.'); }
  if (raw?.type === 'service_account' && typeof raw.client_email === 'string' && typeof raw.private_key === 'string' && raw.private_key.includes('PRIVATE KEY')) return raw;
  if (raw?.type === 'authorized_user' && [raw.client_id, raw.client_secret, raw.refresh_token].every((v: unknown) => typeof v === 'string' && v)) {
    return { type: 'authorized_user', client_id: raw.client_id, client_secret: raw.client_secret, refresh_token: raw.refresh_token, account: typeof raw.account === 'string' ? raw.account : undefined };
  }
  throw fail('cloud_auth_invalid', 'Expected a service account key, or user credentials from a sign-in.');
}

/** The stored credentials parsed, for reusing the OAuth client of an earlier sign-in. */
export function storedUser(text: string): { client_id: string; client_secret: string; account?: string } | null {
  try { const c = parseCredentials(text); return c.type === 'authorized_user' ? { client_id: c.client_id, client_secret: c.client_secret, account: c.account } : null; } catch { return null; }
}

/** Checks that a text is a usable service account key; returns the account's address. */
export function serviceAccountEmail(text: string): string {
  const key = parseCredentials(text);
  if (key.type !== 'service_account') throw fail('cloud_auth_invalid', 'Expected a service account key (JSON with "type": "service_account").');
  return key.client_email;
}

export class GoogleAuth {
  private cached: { token: AccessToken; until: number } | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleAuthOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Forget the token (the stored key changed, or Google refused it). */
  reset(): void { this.cached = null; }

  private async adcText(): Promise<string | null> {
    const explicit = this.env.GOOGLE_APPLICATION_CREDENTIALS;
    for (const path of [explicit, join(this.home, '.config', 'gcloud', 'application_default_credentials.json')]) {
      if (!path) continue;
      try { return await readFile(path, 'utf8'); } catch {}
    }
    return null;
  }

  private async exchange(body: Record<string, string>): Promise<{ token: string; expiresIn: number }> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch { throw new NidusError('network', 'Could not reach Google to sign in.'); }
    let raw: any = null;
    try { raw = await response.json(); } catch {}
    if (!response.ok || typeof raw?.access_token !== 'string') {
      // invalid_grant: the refresh token was revoked or expired, or the key was deleted.
      const expired = raw?.error === 'invalid_grant';
      throw fail(expired ? 'cloud_auth_expired' : 'cloud_auth_refused', expired ? 'The Google Cloud sign-in has expired or was revoked. Sign in again.' : 'Google refused the Cloud credentials.');
    }
    return { token: raw.access_token, expiresIn: typeof raw.expires_in === 'number' ? raw.expires_in : 3600 };
  }

  private async fromCredentials(text: string, stored: boolean): Promise<{ token: AccessToken; expiresIn: number }> {
    const credentials = parseCredentials(text);
    if (credentials.type === 'service_account') {
      // The signed assertion goes to Google's token endpoint only, whatever the file says.
      if (credentials.token_uri && credentials.token_uri !== TOKEN_URL) throw fail('cloud_auth_invalid', 'The service account key names an unexpected token endpoint.');
      const seconds = Math.floor(this.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credentials.client_email, scope: CLOUD_SCOPE, aud: TOKEN_URL, iat: seconds, exp: seconds + 3600 })}`;
      let signature: string;
      try { signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key).toString('base64url'); }
      catch { throw fail('cloud_auth_invalid', 'The service account key could not be used to sign.'); }
      const { token, expiresIn } = await this.exchange({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
      return { token: { token, source: stored ? 'service-account' : 'adc-service-account', user: false, account: credentials.client_email }, expiresIn };
    }
    const { token, expiresIn } = await this.exchange({ grant_type: 'refresh_token', client_id: credentials.client_id, client_secret: credentials.client_secret, refresh_token: credentials.refresh_token });
    return { token: { token, source: stored ? 'user' : 'adc-user', user: true, account: credentials.account ?? null }, expiresIn };
  }

  /** Which way of signing in is set up, without asking Google. */
  async available(): Promise<{ source: AuthSource; account: string | null } | null> {
    const stored = await this.options.secret?.().catch(() => null);
    if (stored) {
      try { const c = parseCredentials(stored); return c.type === 'service_account' ? { source: 'service-account', account: c.client_email } : { source: 'user', account: c.account ?? null }; }
      catch { return { source: 'service-account', account: null }; }
    }
    const adc = await this.adcText();
    if (adc) { try { const c = parseCredentials(adc); return c.type === 'service_account' ? { source: 'adc-service-account', account: c.client_email } : { source: 'adc-user', account: null }; } catch {} }
    try { if ((await (this.options.gcloud ?? (() => runGcloud(this.home)))()).trim()) return { source: 'gcloud', account: null }; } catch {}
    return null;
  }

  async token(): Promise<AccessToken> {
    if (this.cached && this.cached.until > this.now()) return this.cached.token;
    const keep = (found: { token: AccessToken; expiresIn: number }) => {
      this.cached = { token: found.token, until: this.now() + Math.max(60, found.expiresIn - 120) * 1000 };
      return found.token;
    };
    const stored = await this.options.secret?.();
    if (stored) return keep(await this.fromCredentials(stored, true));
    const adc = await this.adcText();
    if (adc) return keep(await this.fromCredentials(adc, false));
    let printed = '';
    try { printed = (await (this.options.gcloud ?? (() => runGcloud(this.home)))()).trim(); } catch {}
    // gcloud prints the token alone on a line; anything else is not a token.
    if (/^[\w.~+\/-]{20,4096}=*$/.test(printed)) return keep({ token: { token: printed, source: 'gcloud', user: true, account: null }, expiresIn: 1800 });
    throw fail('cloud_auth_missing', 'No Google Cloud sign-in is set up. Sign in with a Google account, store a service account key, or run "gcloud auth application-default login".');
  }
}
