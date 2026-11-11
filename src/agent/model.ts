import type { ToolCall, ToolDefinition, ToolResult } from '../tools/contracts.js';
import type { Usage } from '../types.js';
import { NidusError } from '../errors.js';
import { checkSchema } from '../tools/registry.js';
export interface ModelTurn { text:string;calls:ToolCall[];continuation:unknown;usage:Usage|null }
export interface ToolModelRequest { model:string;prompt:string;tools:ToolDefinition[];history:{turn:ModelTurn;results:ToolResult[]}[];maxOutputTokens?:number }
export interface AgentModel { readonly source:'provider'|'mock'; respond(request:ToolModelRequest,signal:AbortSignal):Promise<ModelTurn> }
export function validateToolRequest(r:ToolModelRequest){
  if(!r || typeof r.model!=='string' || !r.model.trim() || typeof r.prompt!=='string' || !r.prompt.trim() || !Array.isArray(r.tools) || !Array.isArray(r.history) || Buffer.byteLength(JSON.stringify(r))>2*1024*1024 || r.tools.length>32 || (r.maxOutputTokens!==undefined && (!Number.isSafeInteger(r.maxOutputTokens)||r.maxOutputTokens<=0)))throw new NidusError('invalid_request','Invalid tool request.');
  const names=new Set<string>();for(const t of r.tools){checkSchema(t.inputSchema);if(names.has(t.name)||!t.implemented)throw new NidusError('invalid_request','Invalid tool definitions.');names.add(t.name);}
  const ids=new Set<string>();for(const h of r.history){if(!Array.isArray(h.turn.calls)||h.results.length!==h.turn.calls.length)throw new NidusError('invalid_request','Tool results must match calls.');for(const [i,c] of h.turn.calls.entries()){if(ids.has(c.id)||h.results[i]?.callId!==c.id)throw new NidusError('invalid_request','Mismatched or duplicate tool call.');ids.add(c.id);}}
}
export const toolCallingSupport=(provider:string,model:string)=>provider==='openai' && ['gpt-4.1','gpt-4.1-2025-04-14','gpt-4.1-mini','gpt-4.1-mini-2025-04-14'].includes(model);
/** Explicit test port: never submits usage to the production Ledger. */
export class MockAgentModel implements AgentModel {
  readonly source='mock' as const;
  constructor(private readonly responder:(request:ToolModelRequest,signal:AbortSignal)=>Promise<ModelTurn>){}
  respond(request:ToolModelRequest,signal:AbortSignal){return this.responder(request,signal);}
}
