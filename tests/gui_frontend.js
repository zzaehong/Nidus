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
  return {ok:true,json:async()=>path.endsWith('/session')?{token:'test-only'}:state};
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
 console.log('5 frontend checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
