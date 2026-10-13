// Dependency-free view behavior checks; Node is a development-only test tool.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map();
const node = id => {
 if (!nodes.has(id)) nodes.set(id, {innerHTML:'',textContent:'',value:'',className:'',dataset:{},
  classList:{toggle(){}},addEventListener(){},showModal(){},close(){}});
 return nodes.get(id);
};
const state = {plans:[],archived_plans:[],tasks:[],attentions:[],
 summary:{active_plans:0,human_attentions:0,ready_tasks:0,completed_plans:0},
 settings:{vault:'/tmp/synthetic',limits:{initial_tasks:10,total_tasks:20,revisions:5}}};
let posts=0;
const context = vm.createContext({document:{querySelector:node,querySelectorAll:()=>[]},
 location:{hash:''},window:{addEventListener(){}},FormData:class{},
 fetch:async(path, options)=>{
  if(options?.method==='POST')posts++;
  return {ok:true,json:async()=>path.endsWith('/session')?{token:'test-only'}:path.endsWith('/connections')?{providers:[],connections:[]}:state};
 }});
vm.runInContext(fs.readFileSync('nidus/web/app.js','utf8'),context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(node('#content').innerHTML,/진행 중 Plan/,'Empty hash must render Dashboard');
 assert.match(node('#content').innerHTML,/새 Plan을 만들어/,'Empty vault has actionable guidance');
 assert.equal(posts,0,'Opening Dashboard must not mutate');
 assert.equal(vm.runInContext('esc("<script>bad</script>")',context),'&lt;script&gt;bad&lt;/script&gt;');
 await vm.runInContext("mutate('plans/test/run',{revision:'test'})",context);
 assert.equal(posts,1,'One user action issues one mutation');
 assert.equal(vm.runInContext('busy',context),false,'Busy resets after response');
 context.location.hash='#settings';
 vm.runInContext('render()',context);
 assert.match(node('#content').innerHTML,/Read only/);
 posts=0;
 await vm.runInContext("Promise.all([mutate('plans/test/run',{}),mutate('plans/test/run',{})])",context);
 assert.equal(posts,1,'In-flight duplicate clicks are suppressed');
 vm.runInContext("connections={providers:[{id:'gemini',name:'Google Gemini',connection_kind:'direct',credential_label:'Gemini API Key',default_base_url:'https://generativelanguage.googleapis.com/v1beta',endpoint_editable:false,api_key_required:true},{id:'omniroute',name:'OmniRoute',connection_kind:'gateway',credential_label:'Endpoint Key',default_base_url:'http://127.0.0.1:20128/v1',endpoint_editable:true,api_key_required:false},{id:'openai-compatible',name:'OpenAI-compatible API',connection_kind:'compatible',credential_label:'API Key',default_base_url:'',endpoint_editable:true,api_key_required:false}],connections:[]};render()",context);
 assert.match(node('#content').innerHTML,/AI 연결/);
 assert.match(node('#content').innerHTML,/type="password"/);
 assert.match(node('#content').innerHTML,/Gemini API Key/);
 assert.match(node('#content').innerHTML,/직접 API/);
 assert.match(node('#content').innerHTML,/통합 Gateway/);
 assert.match(node('#content').innerHTML,/호환 API/);
 assert.match(node('#content').innerHTML,/OmniRoute/);
 assert.match(node('#content').innerHTML,/id="connection-name" hidden/);
 assert.match(node('#content').innerHTML,/name="secret"[^>]* required/);
 assert.match(node('#content').innerHTML,/id="connection-endpoint" hidden/);
 assert.doesNotMatch(node('#content').innerHTML,/name="model"|name="policy"/);
 assert.match(vm.runInContext("connectionSummary({discovery:{status:'failed'},probe:{generation:'passed',structured_output:'failed'}})",context),/검증 실패/);
 console.log('10 frontend checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
