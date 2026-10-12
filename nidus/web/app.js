'use strict';
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = value => `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
const statuses = {planning:'계획 중',active:'진행 중',queued:'대기',ready:'실행 가능',waiting:'사람 판단 필요',completed:'완료',blocked:'차단됨',cancelled:'취소됨',final_review:'최종 검토',running:'진행 중',verifying:'검증 중'};
const badge = (status, ready=false) => `<span class="badge" data-status="${esc(ready?'ready':status)}">${esc(statuses[ready?'ready':status]||status)}</span>`;
const date = value => value ? String(value).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}).*$/, '$1.$2.$3 $4:$5:$6 UTC') : '—';
const types = {transmission:'외부 모델 전송 승인',overwrite:'출력 덮어쓰기 승인',task_quality:'Task 품질 판단 · ESCALATE',plan_escalate:'Plan Final ESCALATE',plan_resume:'Plan 재개 필요'};
const actions = {approve:'승인',reject:'거부',rework:'재작업',cancel:'취소',resume:'계속'};
let state, token, busy=false, selected, tab='tasks';
const navItems = [['home','⌂','홈'],['plans','▤','Plans'],['tasks','☷','Tasks'],['attention','◈','사람 판단함'],['archive','▣','Archive'],['settings','⚙','설정']];
$('#nav').innerHTML = navItems.map(([key,icon,label])=>`<a href="#${key}" data-nav="${key}">${icon} &nbsp; ${label}</a>`).join('');
$('#advanced').innerHTML = ['worker','review','final'].map(name=>`<label>${name} policy · 비워두면 기본값 사용<textarea name="${name}_policy"></textarea></label>`).join('');
async function api(path, data) {
 const response = await fetch('/api/'+path, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Nidus-Token':token},body:JSON.stringify(data)});
 const body = await response.json();
 if(!response.ok) throw new Error(`${body.error}: ${body.message}`);
 return body;
}
function notice(message='', error=false) { $('#notice').className = error?'error':''; $('#notice').textContent=message; }
async function refresh() { state = await api('overview'); $('#vault').textContent=state.settings.vault; render(); }
function planCard(p) {return `<button class="plan-card ${p.id===selected?'selected':''}" data-select="${esc(p.id)}">${badge(p.status)}<p>${esc(p.goal||p.original_request)}</p><div class="meta">${p.progress.completed} / ${p.progress.total} Tasks · v${p.plan_version}<br>${esc(p.manager)} · ${esc(date(p.created_at))}${p.human_attention?'<br>◈ 사람 판단 필요':''}</div></button>`;}
function taskTable(p) {return `<div class="table-wrap"><table><thead><tr><th>Task</th><th>제목</th><th>상태</th><th>의존성</th><th>담당</th><th>Ready</th><th>완료 / 실행 기록</th></tr></thead><tbody>${p.board.map(t=>{
 const full=state.tasks.find(x=>x.id===t.id); const event=full?.history?.filter(x=>['verified_completed','claimed'].includes(x.kind)).slice(-1)[0];
 return `<tr><td><button data-task="${esc(t.id)}">${esc(t.local_key)}</button></td><td class="title"><button data-task="${esc(t.id)}">${esc(t.title)}</button></td><td>${badge(t.status,t.ready)}</td><td>${esc(t.depends_on.map(id=>p.board.find(x=>x.id===id)?.local_key||id).join(', ')||'—')}</td><td>${esc(t.assigned_worker)}<br><small>${esc(t.assigned_manager)}</small></td><td>${t.ready?'✓':'—'}</td><td>${full?.completed_at||full?.last_run_at?esc(date(full.completed_at||full.last_run_at)):event?`#${event.seq} ${esc(event.kind)}`:'—'}</td></tr>`;
 }).join('')}</tbody></table></div>`;}
function planDetail(p) {
 let body;
 if(tab==='dependencies') body=p.board.map(t=>`<div class="dag-row">${esc(t.depends_on.map(id=>p.board.find(x=>x.id===id)?.local_key||id).join(' + ')||'시작')} → <a href="#task/${esc(t.id)}">${esc(t.local_key)} · ${esc(t.title)}</a><br>${badge(t.status,t.ready)}</div>`).join('');
 else if(tab==='info') body=json(p);
 else if(tab==='history') body=json(p.history);
 else body=taskTable(p);
 return `<div class="panel"><div class="detail-header"><div><h2>${esc(p.goal||p.original_request)}</h2>${badge(p.status)}<p class="goal">${esc(p.contract?.scope||p.original_request)}</p><div class="meta">${esc(date(p.created_at))} · ${esc(p.manager)} · Plan v${p.plan_version}</div></div>${p.allowed_actions.includes('run')?`<button class="primary" data-run="${esc(p.id)}" ${busy?'disabled':''}>${busy?'실행 중...':'다음 단계 실행'}</button>`:''}</div><div class="tabs">${[['tasks','작업 목록'],['dependencies','의존 관계'],['info','전체 정보'],['history','실행 기록']].map(([key,label])=>`<button data-tab="${key}" class="${tab===key?'active':''}">${label}</button>`).join('')}</div>${p.error?`<p class="goal">Runtime: ${esc(p.error)}</p>`:''}${body||'<div class="empty">아직 계획된 Task가 없습니다. 다음 단계 실행으로 계획을 시작하세요.</div>'}<div class="progress"><span>전체 진행도</span><strong>${p.progress.completed} / ${p.progress.total} 완료</strong></div><progress value="${p.progress.completed}" max="${p.progress.total||1}"></progress>${p.status==='completed'?'<details><summary>Final Review</summary>'+json(p.final_review)+'</details><details><summary>승인 결과</summary>'+json(p.result)+'</details>':''}</div>`;
}
function attentionCard(a) {return `<article class="attention-card ${a.group}"><small>${a.group==='permission'?'PERMISSION':'QUALITY / HUMAN JUDGMENT'}</small><h3>${esc(types[a.type]||a.type)}</h3><div class="meta">${esc(a.role)} · ${a.created_at?esc(date(a.created_at)):'발생 시각 미기록'}<br>${esc(a.id)}${a.plan_id?'<br>Plan '+esc(a.plan_id):''}</div><p>${esc(a.reason)}</p><details><summary>정확한 전송 / 판단 범위</summary>${json(a.scope)}</details>${a.group==='quality'?'<label>판단 이유<textarea data-note placeholder="계속할 조건 또는 판단 이유"></textarea></label>'+ (a.entity==='tasks'?'<label>재작업 지시 · 한 줄에 하나<textarea data-instructions></textarea></label>':''):''}<div class="actions">${a.allowed_actions.map(action=>`<button data-decision="${action}" data-entity="${a.entity}" data-id="${esc(a.id)}" class="${['approve','resume'].includes(action)?'primary':''}" ${busy?'disabled':''}>${actions[action]}</button>`).join('')}</div></article>`;}
function recentTasks(){return state.tasks.filter(t=>t.status==='completed').slice(-3).reverse().map(t=>`<div class="recent-task"><a href="#task/${esc(t.id)}">${esc(t.title||t.request)}</a><p>${badge(t.status)}</p><div class="meta">${esc(t.local_key||t.employee)}</div></div>`).join('')||'<div class="empty">완료된 Task가 없습니다.</div>';}
function taskDetail(t){const fields=[['Completion Contract',t.manager_contract||t.contract],['Runtime contract',t.contract],['Worker result / self-check',t.submission||t.generation],['Deterministic checks',t.verification],['Manager Review',t.manager_review],['REWORK history',t.revisions],['Result reference',t.contract?.result],['Output hash',t.candidate_hash],['관련 timestamps / 실행 기록',t.history]];return `<div class="panel"><h2>${esc(t.title||t.request)}</h2>${badge(t.status)}<p class="goal">${esc(t.goal||t.request)}</p><div class="meta">${esc(t.id)} · ${esc(t.local_key)}<br>Manager: ${esc(t.assigned_manager||'manager-1')} · Worker: ${esc(t.assigned_worker||t.employee)}<br>Dependencies: ${esc(t.depends_on?.join(', ')||'—')}<br>${esc(date(t.created_at))}<br>최근 실행: ${esc(date(t.last_run_at))} · 완료: ${esc(date(t.completed_at))}</div>${fields.map(([label,value])=>`<details open><summary>${label}</summary>${json(value??null)}</details>`).join('')}</div>`;}
function render(){
 const [route,id] = location.hash.slice(1).split('/'); const view=route||'home';
 document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===(view==='plan'?'plans':view==='task'?'tasks':view)));
 const headings={home:'Dashboard',plans:'Plans',plan:'Plan 상세',tasks:'Tasks',task:'Task 상세',attention:'사람 판단함',archive:'Archive',settings:'설정'};$('#heading').textContent=headings[view]||'Dashboard';
 const plans=state.plans; const allPlans=[...plans,...state.archived_plans];let html='';
 if(view==='home'){
 if(!plans.find(p=>p.id===selected))selected=plans[0]?.id;
 const p=plans.find(x=>x.id===selected);
 const metrics=[['▤','진행 중 Plan',state.summary.active_plans],['◈','사람 판단 필요',state.summary.human_attentions],['▷','실행 가능한 Task',state.summary.ready_tasks],['✓','완료된 Plan',state.summary.completed_plans]];
 html=`<div class="metrics">${metrics.map(([icon,label,value])=>`<div class="metric"><div class="icon">${icon}</div><div><small>${label}</small><strong>${value}</strong></div></div>`).join('')}</div><div class="workspace"><div class="center"><div class="panel recent"><h2>최근 Plans <small>${plans.length}</small></h2>${plans.slice(-6).reverse().map(planCard).join('')||'<div class="empty">새 Plan을 만들어 시작하세요.</div>'}</div>${p?planDetail(p):'<div class="panel empty">현재 진행 중인 Plan이 없습니다.</div>'}</div><aside class="side"><div><h2>사람 판단함 <small>${state.attentions.length}</small></h2>${state.attentions.slice(0,4).map(attentionCard).join('')||'<div class="panel empty">모든 판단을 처리했습니다.</div>'}</div><div><h2>최근 완료 Task</h2>${recentTasks()}</div></aside></div>`;
 }else if(view==='plans')html=`<div class="grid-list">${plans.map(p=>`<div class="panel">${planCard(p)}<a href="#plan/${esc(p.id)}">Plan 상세 보기 →</a></div>`).join('')||'<div class="empty">활성 Plan이 없습니다.</div>'}</div>`;
 else if(view==='plan') {const p=allPlans.find(x=>x.id===id);html=p?planDetail(p):'<div class="empty">Plan을 찾을 수 없습니다.</div>';}
 else if(view==='tasks')html=`<div class="grid-list">${state.tasks.filter(t=>t.status!=='completed').map(t=>`<div class="panel"><a href="#task/${esc(t.id)}">${esc(t.title||t.request)}</a><p>${badge(t.status)}</p><small>${esc(t.local_key||t.id)}</small></div>`).join('')||'<div class="empty">활성 Task가 없습니다.</div>'}</div>`;
 else if(view==='task'){const t=state.tasks.find(x=>x.id===id);html=t?taskDetail(t):'<div class="empty">Task를 찾을 수 없습니다.</div>';}
 else if(view==='attention')html=`<div class="grid-list">${state.attentions.map(attentionCard).join('')||'<div class="empty">판단 요청이 없습니다.</div>'}</div>`;
 else if(view==='archive')html=`<h2>완료된 Plans</h2><div class="grid-list">${state.archived_plans.map(p=>`<div class="panel">${planCard(p)}<a href="#plan/${esc(p.id)}">Final Review / 결과 보기 →</a><div class="meta">${esc(date(p.result?.archived_at))}</div></div>`).join('')||'<p class="muted">완료된 Plan이 없습니다.</p>'}</div><h2 class="archive-tasks">완료된 Tasks</h2>${recentTasks()}<div class="grid-list">${state.tasks.filter(t=>t.status==='completed').map(t=>`<div class="panel"><a href="#task/${esc(t.id)}">${esc(t.title||t.request)}</a>${json(t.contract?.result)}</div>`).join('')}</div>`;
 else if(view==='settings')html=`<div class="panel"><h2>Local workspace · Read only</h2>${json(state.settings)}</div>`;
 $('#content').innerHTML=html;
 if(busy) document.querySelectorAll('button').forEach(b=>b.disabled=true);
}
async function mutate(path,data){if(busy)return;busy=true;notice('실행 중... 요청이 끝날 때까지 기다려 주세요.');document.querySelectorAll('button').forEach(b=>b.disabled=true);try{const r=await api(path,data);await refresh();if(r.status==='blocked')notice('차단됨: '+(r.error||r.model_error?.code||'Runtime 검증 실패'),true);else notice('요청을 처리했습니다. 다음 실행은 버튼을 눌러 시작하세요.');return r;}catch(e){notice(e.message,true);try{await refresh();}catch(_){}return null;}finally{busy=false;render();document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
$('#content').addEventListener('click',async event=>{
 const b=event.target.closest('button');if(!b||busy)return;
 if(b.dataset.select){selected=b.dataset.select;tab='tasks';if(location.hash!=='#home')location.hash='plan/'+selected;else render();}
 if(b.dataset.task)location.hash='task/'+b.dataset.task;
 if(b.dataset.tab){tab=b.dataset.tab;render();}
 if(b.dataset.run){const p=[...state.plans,...state.archived_plans].find(p=>p.id===b.dataset.run);await mutate(`plans/${p.id}/run`,{revision:p.revision});}
 if(b.dataset.decision){const a=state.attentions.find(a=>a.id===b.dataset.id&&a.entity===b.dataset.entity);const card=b.closest('article');const data={revision:a.revision,decision:b.dataset.decision,note:card.querySelector('[data-note]')?.value||'',instructions:(card.querySelector('[data-instructions]')?.value||'').split('\n').filter(Boolean)};await mutate(`${a.entity}/${a.id}/${a.group==='quality'&&a.entity==='tasks'?'quality':'decision'}`,data);}
});
$('#refresh').onclick=()=>refresh().then(()=>notice()).catch(e=>notice(e.message,true));
$('#new-plan').onclick=()=>{$('#create').showModal();};$('#close-create').onclick=()=>$('#create').close();
$('#create-form').onsubmit=async event=>{event.preventDefault();try{const form=new FormData(event.target);const data={request:form.get('request'),sources:form.get('sources').split('\n').map(x=>x.trim()).filter(Boolean),policy:JSON.parse(form.get('policy')),limits:{}};['initial_tasks','total_tasks','revisions'].forEach(k=>data.limits[k]=Number(form.get(k)));['worker','review','final'].forEach(k=>{if(form.get(k+'_policy').trim())data[k+'_policy']=JSON.parse(form.get(k+'_policy'));});$('#create').close();const r=await mutate('plans',data);if(r)location.hash='plan/'+r.id;}catch(e){notice('입력 확인: '+e.message,true);}};
window.addEventListener('hashchange',()=>{tab='tasks';if(state)render();});
(async()=>{try{token=(await api('session')).token;await refresh();Object.entries(state.settings.limits).forEach(([k,v])=>{$(`[name="${k}"]`).value=v;});}catch(e){notice(e.message,true);}})();
