import { baseModel, array, object, string, validateModelID, validateChatRequest } from './base.js';
import { bounded, HttpClient, keyValue, optionalObject } from '../http.js';
import { NidusError } from '../errors.js';
import { completionBody, completionResponse } from './compatible.js';
import { reviewedFreeModels } from '../providers.js';
import type { ChatRequest, Model, RequestOptions } from '../types.js';
function validatedCredential(key: string, accountId: unknown) {
  if (typeof accountId !== 'string' || !/^[a-fA-F0-9]{32}$/.test(accountId)) {
    throw new NidusError('invalid_request', 'Cloudflare requires a 32-character hexadecimal Account ID.');
  }
  return { token: keyValue(key), accountId };
}
export function cloudflareCredential(key: string, accountId: unknown): string {
  return JSON.stringify(validatedCredential(key, accountId));
}

export const CLOUDFLARE_ENDPOINT = 'https://api.cloudflare.com/client/v4';

/** The accounts an API token can see (GET /accounts). Workers AI lives under one of them. */
export async function listCloudflareAccounts(token: string, http: HttpClient, endpoint = CLOUDFLARE_ENDPOINT, options: RequestOptions = {}): Promise<{ id: string; name: string }[]> {
  return bounded(options, async signal => {
    const raw = await http.json(`${endpoint}/accounts?per_page=50`, { authorization: `Bearer ${keyValue(token)}` }, signal);
    if (raw.success !== true) throw new NidusError('provider_error', 'Cloudflare did not list the accounts of this token.');
    return array(raw.result).map(item => { const r = object(item); return { id: string(r.id), name: typeof r.name === 'string' ? r.name : '' }; }).filter(a => /^[a-fA-F0-9]{32}$/.test(a.id));
  });
}

/**
 * The stored credential for Cloudflare: the token plus the Account ID. When the user left the ID empty,
 * it is looked up with the token; only an unambiguous answer (exactly one account) is used.
 */
export async function resolveCloudflareCredential(key: string, accountId: unknown, http: HttpClient, endpoint = CLOUDFLARE_ENDPOINT, options: RequestOptions = {}): Promise<{ credential: string; accountId: string; discovered: boolean }> {
  const typed = typeof accountId === 'string' ? accountId.trim() : '';
  if (typed) return { credential: cloudflareCredential(key, typed), accountId: typed, discovered: false };
  let accounts: { id: string; name: string }[];
  try { accounts = await listCloudflareAccounts(key, http, endpoint, options); }
  catch (error) {
    const code = error instanceof NidusError ? error.code : 'provider_error';
    if (code === 'authentication' || code === 'permission') throw new NidusError(code, '이 토큰으로는 계정 목록을 볼 수 없습니다. Cloudflare 대시보드의 Workers AI 페이지 → "Use REST API"에 보이는 Account ID를 직접 적어 주세요. (토큰이 틀렸을 수도 있습니다.)');
    throw error;
  }
  if (accounts.length === 1) return { credential: cloudflareCredential(key, accounts[0]!.id), accountId: accounts[0]!.id, discovered: true };
  if (accounts.length === 0) throw new NidusError('invalid_request', '이 토큰이 볼 수 있는 Cloudflare 계정이 없습니다. Workers AI 페이지의 "Use REST API"에서 만든 토큰인지, 그 화면의 Account ID를 직접 적어 주세요.');
  const names = accounts.slice(0, 5).map(a => `${a.name || '(이름 없음)'}: ${a.id}`).join(' / ');
  throw new NidusError('invalid_request', `이 토큰은 계정 ${accounts.length}개를 볼 수 있어 하나를 고를 수 없습니다. Account ID를 직접 적어 주세요 — ${names}`);
}
function unpack(key: string) {
  try {
    const raw = object(JSON.parse(key));
    return validatedCredential(string(raw.token), raw.accountId);
  } catch {
    throw new NidusError('invalid_request', 'Reconnect Cloudflare with API token and Account ID.');
  }
}
export class CloudflareAdapter {
  readonly id='cloudflare' as const;
  constructor(private endpoint='https://api.cloudflare.com/client/v4', private http=new HttpClient()) {}
  async listModels(key:string, options:RequestOptions={}) {
    const {token,accountId}=unpack(key);
    return bounded(options,async signal=>{
      const models=new Map<string,Model>();
      for(let page=1;page<=100;page++) {
        const raw=await this.http.json(`${this.endpoint}/accounts/${accountId}/ai/models/search?page=${page}&per_page=100`,{authorization:`Bearer ${token}`},signal);
        if(raw.success!==true) throw new NidusError('provider_error','Cloudflare model discovery failed; cache preserved.');
        const items=array(raw.result);
        for(const item of items) {
          const r=object(item), id=string(r.name), task=optionalObject(r.task);
          const m=baseModel(this.id,id,typeof r.description==='string'?r.description:id);
          m.capabilities.chat=task.name==='Text Generation' || reviewedFreeModels.cloudflare?.includes(id) ? 'supported' : typeof task.name==='string' ? 'unsupported' : 'unknown';
          m.details={task:typeof task.name==='string'?task.name:null,source:'https://developers.cloudflare.com/workers-ai/models/',access:'catalog-listed; inference permission not verified'};
          if(models.has(id)) throw new NidusError('invalid_response','Repeated Cloudflare model page.');
          models.set(id,m);
        }
        if(items.length<100) return [...models.values()];
      }
      throw new NidusError('invalid_response','Excessive Cloudflare model pagination.');
    });
  }
  async getModel(key:string, model:string, options:RequestOptions={}) {
    validateModelID(model);
    const match=(await this.listModels(key,options)).find(m=>m.id===model);
    if(!match) throw new NidusError('not_found','Model was not returned by the provider.');return match;
  }
  async chat(key:string, request:ChatRequest, options:RequestOptions={}) {
    validateChatRequest(request);const {token,accountId}=unpack(key);
    // Official text compatibility endpoint handles model-specific text schemas; media is excluded upstream.
    return bounded(options,async signal=>completionResponse(this.id,await this.http.json(`${this.endpoint}/accounts/${accountId}/ai/v1/chat/completions`,{authorization:`Bearer ${token}`},signal,completionBody(request),options.onHeaders),request.model));
  }
}
