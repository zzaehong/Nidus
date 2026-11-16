import { BaseAdapter, validateModelID, baseModel, array, object, count, string, response, usage, support } from './base.js';
import { HttpClient, optionalObject } from '../http.js';
import { NidusError } from '../errors.js';
import { providerMetadata, reviewedFreeModels } from '../providers.js';
import type { ChatRequest, ProviderId, RequestOptions } from '../types.js';

export function completionBody(r: ChatRequest) {
  return { model:r.model, messages:[...(r.system ? [{role:'system',content:r.system}] : []), ...r.messages], max_tokens:r.maxOutputTokens ?? 1024, stream:false };
}
export function completionResponse(provider: ProviderId, raw: Record<string,unknown>, model: string) {
  const choice=object(array(raw.choices)[0]), message=object(choice.message), u=optionalObject(raw.usage);
  const text=typeof message.content==='string' ? message.content : Array.isArray(message.content) ? message.content.map(object).filter(p=>p.type==='text').map(p=>typeof p.text==='string'?p.text:'').join('') : '';
  return response(provider, typeof raw.model==='string'?raw.model:model, text, choice.finish_reason,
    usage(u,u.prompt_tokens,u.completion_tokens,u.total_tokens,optionalObject(u.prompt_tokens_details).cached_tokens,undefined,optionalObject(u.completion_tokens_details).reasoning_tokens));
}
export class CompatibleAdapter extends BaseAdapter {
  constructor(readonly id: 'nvidia'|'groq'|'mistral', endpoint = {nvidia:'https://integrate.api.nvidia.com/v1',groq:'https://api.groq.com/openai/v1',mistral:'https://api.mistral.ai/v1'}[id], http?:HttpClient) { super(endpoint,http); }
  protected headers(key:string) { return {authorization:`Bearer ${key}`}; }
  protected normalizeModel(raw:Record<string,unknown>) {
    const model=baseModel(this.id,string(raw.id),typeof raw.name==='string'?raw.name:string(raw.id));
    const caps=optionalObject(raw.capabilities);
    model.capabilities.chat = typeof caps.completion_chat==='boolean' ? support(caps.completion_chat) : reviewedFreeModels[this.id]?.includes(model.id) ? 'supported' : 'unknown';
    model.capabilities.tools=support(caps.function_calling);model.capabilities.vision=support(caps.vision);
    if(raw.active===false) model.capabilities.chat='unsupported';
    model.limits.contextTokens=count(raw.context_window ?? raw.max_context_length);
    model.limits.outputTokens=count(raw.max_completion_tokens);
    model.details={source:providerMetadata[this.id].source, access:'catalog-listed; inference permission not verified', active:typeof raw.active==='boolean'?raw.active:null};
    return model;
  }
  async getModel(key:string, model:string, options:RequestOptions={}) {
    validateModelID(model);
    const match=(await this.listModels(key,options)).find(m=>m.id===model);
    if(!match) throw new NidusError('not_found','Model was not returned by the provider.');
    return match;
  }
  protected chatBody(r:ChatRequest) {
    const body=completionBody(r);
    if (this.id==='groq') { const {max_tokens,...rest}=body; return {path:'/chat/completions',body:{...rest,max_completion_tokens:max_tokens,service_tier:'on_demand'}}; }
    return {path:'/chat/completions',body:this.id==='mistral'?{...body,service_tier:'standard_only'}:body};
  }
  protected normalizeChat(raw:Record<string,unknown>, model:string) { return completionResponse(this.id,raw,model); }
}
