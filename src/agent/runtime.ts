import {webFailureMessage} from '../vault/page-state.js';
import {webToolsAvailable} from './capabilities.js';
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
  respond(request:ToolModelRequest,signal:AbortSignal){return this.engine.agentChat(this.provider,request,{signal,timeoutMs:this.provider==='nvidia'?120000:30000});}
}
export interface AgentLimits {modelCalls:number;toolInvocations:number;executionMs:number;resultBytes:number}
export interface AgentStep {stepId:string;index:number;state:'MODEL'|'TOOLS'|'COMPLETED'|'FAILED';invocations:{invocationId:string;callId:string;tool:string;result:ToolResult}[]}
export interface AgentTask {taskId:string;executionId:string;vaultId:string;status:'COMPLETED'|'LIMIT_REACHED'|'CANCELLED'|'FAILED'|'UNCONFIRMED';text:string;code:string;modelSource:'mock'|'provider';webStatus:'unavailable'|'not_used'|'used'|'captcha_required'|'search_failed'|'no_results';steps:AgentStep[]}
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
  async run(input:{vaultId:string;model:string;prompt:string;requiresWeb?:boolean;signal?:AbortSignal;limits?:Partial<AgentLimits>;onEvent?:(event:Record<string,unknown>)=>void}):Promise<AgentTask>{
    if(this.running)fail('agent_busy');
    const limits={...defaults,...input.limits};for(const k of Object.keys(defaults) as (keyof AgentLimits)[])if(!Number.isSafeInteger(limits[k])||limits[k]<1||limits[k]>defaults[k])fail('invalid_limits');
    if(typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>65536)fail('invalid_prompt');
    this.running=true;const deadline=new AbortController(),signal=input.signal?AbortSignal.any([input.signal,deadline.signal]):deadline.signal;
    const timer=setTimeout(()=>deadline.abort(),limits.executionMs);
    const task:AgentTask={taskId:randomUUID(),executionId:randomUUID(),vaultId:input.vaultId,status:'FAILED',text:'',code:'not_started',modelSource:this.model.source,webStatus:webToolsAvailable(this.tools.available())?'not_used':'unavailable',steps:[]};
    const history:ToolModelRequest['history']=[],seen=new Set<string>();let invocations=0,resultBytes=0;
    try{
      if(signal.aborted)fail('cancelled');
      if(input.requiresWeb===true && task.webStatus==='unavailable'){task.code='web_unavailable';task.text='현재 웹 검색과 인터넷 브라우저가 비활성화되어 최신 정보를 확인할 수 없습니다. 모델·VM 호출은 실행하지 않았습니다.';return task;}
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
        if(!turn.calls.length){if(!turn.text)fail('empty_model_turn');if(input.requiresWeb&&task.webStatus!=='used'){task.code='web_not_used';task.text=webFailureMessage(task.webStatus==='no_results'?'search_no_results':'search_failed');step.state='FAILED';return task;}step.state='COMPLETED';task.status='COMPLETED';task.code='ok';task.text=(task.webStatus==='search_failed'||task.webStatus==='no_results'?webFailureMessage(task.webStatus==='no_results'?'search_no_results':'search_failed')+'\n\n':'')+turn.text;return task;}
        if(invocations+turn.calls.length>limits.toolInvocations)fail('tool_limit');
        step.state='TOOLS';const results:ToolResult[]=[];
        for(const c of turn.calls){
          if(signal.aborted)fail('cancelled');if(resultBytes>=limits.resultBytes)fail('result_limit');
          seen.add(c.id);invocations++;
          // Do not race a mutation promise: wait for helper close and classify interruption as unknown.
          input.onEvent?.({event:'tool',name:c.name,callId:c.id});
          const r=await this.tools.invoke({vaultId:input.vaultId,executionId:task.executionId,signal},c);
          input.onEvent?.({event:'tool-result',name:c.name,result:r});
          if(r.status==='succeeded' && ['browser_search','browser_navigate','browser_read_page'].includes(c.name))task.webStatus='used';
          if(r.status==='succeeded'&&['browser_start','browser_open','browser_observe','browser_click','browser_type','browser_press','browser_select','browser_check','browser_read','browser_scroll','browser_back'].includes(c.name)){try{if(JSON.parse(r.content.text).networkResponses>0)task.webStatus='used';}catch{}}
          step.invocations.push({invocationId:randomUUID(),callId:c.id,tool:c.name,result:r});results.push(r);resultBytes+=bytes(r);
          if(r.code==='captcha_required'){task.webStatus='captcha_required';task.status='FAILED';task.code='captcha_required';task.text=webFailureMessage(r.code);step.state='FAILED';return task;}
          if(c.name.startsWith('browser_')&&r.status==='failed')task.webStatus=r.code==='search_no_results'?'no_results':'search_failed';
          if(r.status==='unknown'){task.status='UNCONFIRMED';task.code=r.code;step.state='FAILED';return task;}
          if(signal.aborted)fail('cancelled');if(resultBytes>limits.resultBytes)fail('result_limit');
        }
        step.state='COMPLETED';history.push({turn:structuredClone(turn),results});
      }
      return fail('model_limit');
    }catch(e){
      const code=signal.aborted?'cancelled':e instanceof ToolError?e.code:e instanceof NidusError?`provider_${e.code}`:'provider_error';
      task.code=deadline.signal.aborted?'execution_limit':code;
      if(code==='provider_invalid_response'){const reasons:Record<string,string>={text_protocol_truncated:'모델 응답이 토큰 한도로 잘렸습니다.',text_protocol_filtered:'Provider가 응답을 필터링했습니다.',text_protocol_empty:'모델이 빈 응답을 반환했습니다.',text_protocol_json:'모델 응답이 유효한 JSON이 아닙니다.',text_protocol_shape:'모델 응답이 Nidus 응답 구조와 맞지 않습니다.',text_protocol_call:'모델의 도구 호출 구조가 잘못됐습니다.',text_protocol_arguments:'모델이 미지원 도구 또는 잘못된 도구 인자를 반환했습니다.',text_protocol_size:'모델 응답이 크기 한도를 초과했습니다.'};const reason=e instanceof NidusError?e.reason:undefined;task.text=(reason&&reasons[reason]?`[${reason}] ${reasons[reason]}`:'Provider 응답 형식을 해석하지 못했습니다.')+' 이 단계의 도구는 실행하지 않았으며 자동 재시도하지 않았습니다. 앞선 브라우저 입력 성공과는 별개의 모델 응답 오류입니다.';}
      if(code==='provider_timeout')task.text='모델 API의 응답 대기 시간이 초과되었습니다. 브라우저 조회와 별개의 모델 호출 실패이며 자동 재시도하지 않았습니다. 반환된 검색 결과만으로 조사가 완료된 것은 아닙니다.';
      task.status=deadline.signal.aborted||['model_limit','tool_limit','result_limit'].includes(code)?'LIMIT_REACHED':code==='cancelled'?'CANCELLED':'FAILED';
      const last=task.steps.at(-1);if(last && last.state!=='COMPLETED')last.state='FAILED';return task;
    }finally{clearTimeout(timer);deadline.abort();try{await this.tools.finishExecution(task.executionId);}catch{task.status='UNCONFIRMED';task.code='browser_cleanup_unconfirmed';}this.running=false;}
  }
}
