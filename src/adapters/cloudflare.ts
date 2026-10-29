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
