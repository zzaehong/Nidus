import { randomUUID } from 'node:crypto';
import { NidusError } from '../errors.js';
import { ConnectivityEngine } from '../engine.js';
import type { ProviderId } from '../types.js';
import { ToolDispatcher } from '../tools/dispatcher.js';
import { bytes, ToolError, fail, type ToolResult } from '../tools/contracts.js';
import type { AgentModel, ModelTurn, ToolModelRequest } from './model.js';
export class EngineAgentModel implements AgentModel {
  readonly source='provider' as const;
  constructor(private readonly engine:ConnectivityEngine,private readonly provider:ProviderId){}
  respond(request:ToolModelRequest,signal:AbortSignal){return this.engine.toolChat(this.provider,request,{signal});}
}
export interface AgentLimits {modelCalls:number;toolInvocations:number;executionMs:number;resultBytes:number}
export interface AgentStep {stepId:string;index:number;state:'MODEL'|'TOOLS'|'COMPLETED'|'FAILED';invocations:{invocationId:string;callId:string;tool:string;result:ToolResult}[]}
export interface AgentTask {taskId:string;executionId:string;vaultId:string;status:'COMPLETED'|'LIMIT_REACHED'|'CANCELLED'|'FAILED'|'UNCONFIRMED';text:string;code:string;modelSource:'mock'|'provider';steps:AgentStep[]}
const defaults:AgentLimits={modelCalls:20,toolInvocations:100,executionMs:900000,resultBytes:1048576};
async function interruptible<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  let listener:(()=>void)|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{listener=()=>reject(new ToolError('cancelled'));signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();})]);}
  finally{if(listener)signal.removeEventListener('abort',listener);}
}
/** Ephemeral single-task runtime. No disk context, automatic resume, VM backend or execution lease. */
export class SingleAgentRuntime {
  private running=false;
  constructor(private readonly model:AgentModel,private readonly tools:ToolDispatcher){}
  async run(input:{vaultId:string;model:string;prompt:string;signal?:AbortSignal;limits?:Partial<AgentLimits>;onEvent?:(event:Record<string,unknown>)=>void}):Promise<AgentTask>{
    if(this.running)fail('agent_busy');
    const limits={...defaults,...input.limits};for(const k of Object.keys(defaults) as (keyof AgentLimits)[])if(!Number.isSafeInteger(limits[k])||limits[k]<1||limits[k]>defaults[k])fail('invalid_limits');
    if(typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>65536)fail('invalid_prompt');
    this.running=true;const deadline=new AbortController(),signal=input.signal?AbortSignal.any([input.signal,deadline.signal]):deadline.signal;
    const timer=setTimeout(()=>deadline.abort(),limits.executionMs);
    const task:AgentTask={taskId:randomUUID(),executionId:randomUUID(),vaultId:input.vaultId,status:'FAILED',text:'',code:'not_started',modelSource:this.model.source,steps:[]};
    const history:ToolModelRequest['history']=[],seen=new Set<string>();let invocations=0,resultBytes=0;
    try{
      await this.tools.validateVault(input.vaultId);input.onEvent?.({event:'task',executionId:task.executionId});
      for(let i=0;i<limits.modelCalls;i++){
        if(signal.aborted)fail('cancelled');
        const step:AgentStep={stepId:randomUUID(),index:i+1,state:'MODEL',invocations:[]};task.steps.push(step);input.onEvent?.({event:'step',index:step.index});
        const request:ToolModelRequest={model:input.model,prompt:input.prompt,tools:this.tools.available(),history:structuredClone(history)};
        const turn:ModelTurn=await interruptible(this.model.respond(request,signal),signal);
        if(signal.aborted)fail('cancelled');
        if(!turn || typeof turn.text!=='string'||!Array.isArray(turn.calls)||bytes(turn)>1048576)fail('invalid_model_turn');
        // Validate a whole batch before any side effect, including duplicate IDs across steps.
        const batch=new Set<string>();for(const c of turn.calls){if(!c || typeof c.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(c.id)||typeof c.name!=='string'||seen.has(c.id)||batch.has(c.id))fail('duplicate_or_invalid_call');batch.add(c.id);}
        if(!turn.calls.length){if(!turn.text)fail('empty_model_turn');step.state='COMPLETED';task.status='COMPLETED';task.code='ok';task.text=turn.text;return task;}
        if(invocations+turn.calls.length>limits.toolInvocations)fail('tool_limit');
        step.state='TOOLS';const results:ToolResult[]=[];
        for(const c of turn.calls){
          if(signal.aborted)fail('cancelled');if(resultBytes>=limits.resultBytes)fail('result_limit');
          seen.add(c.id);invocations++;
          // Do not race a mutation promise: wait for helper close and classify interruption as unknown.
          input.onEvent?.({event:'tool',name:c.name,callId:c.id});
          const r=await this.tools.invoke({vaultId:input.vaultId,executionId:task.executionId,signal},c);
          input.onEvent?.({event:'tool-result',name:c.name,result:r});
          step.invocations.push({invocationId:randomUUID(),callId:c.id,tool:c.name,result:r});results.push(r);resultBytes+=bytes(r);
          if(r.status==='unknown'){task.status='UNCONFIRMED';task.code=r.code;step.state='FAILED';return task;}
          if(signal.aborted)fail('cancelled');if(resultBytes>limits.resultBytes)fail('result_limit');
        }
        step.state='COMPLETED';history.push({turn:structuredClone(turn),results});
      }
      return fail('model_limit');
    }catch(e){
      const code=signal.aborted?'cancelled':e instanceof ToolError?e.code:e instanceof NidusError?`provider_${e.code}`:'provider_error';
      task.code=deadline.signal.aborted?'execution_limit':code;
      task.status=deadline.signal.aborted||['model_limit','tool_limit','result_limit'].includes(code)?'LIMIT_REACHED':code==='cancelled'?'CANCELLED':'FAILED';
      const last=task.steps.at(-1);if(last && last.state!=='COMPLETED')last.state='FAILED';return task;
    }finally{clearTimeout(timer);deadline.abort();this.tools.finishExecution(task.executionId);this.running=false;}
  }
}
