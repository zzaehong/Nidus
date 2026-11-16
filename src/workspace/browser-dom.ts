// @ts-nocheck — this function is serialized with toString() and evaluated inside the page
// (an isolated world of the VM browser), never run on the host. Shared with the guest copy
// scripts/vault-vm/browser-dom.mjs used by the older live browser.
export function createDOMReader() {
  let revision=0; const watched=new WeakSet(), secrets=new WeakSet();
  const compact=s=>String(s??'').replace(/\s+/g,' ').trim();
  const docs=()=>{const out=[document];for(let i=0;i<out.length&&out.length<9;i++)for(const frame of out[i].querySelectorAll('iframe,frame')){try{const d=frame.contentDocument;if(d?.documentElement&&!out.includes(d)&&out.length<9)out.push(d);}catch{}}return out;};
  const watch=()=>{for(const d of docs())if(!watched.has(d)){watched.add(d);new MutationObserver(()=>revision++).observe(d,{subtree:true,attributes:true,childList:true,characterData:true});d.addEventListener('input',()=>revision++,true);d.addEventListener('change',()=>revision++,true);}};
  const label=e=>compact(e.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>e.ownerDocument.getElementById(id)?.textContent??'').join(' ')||e.getAttribute('aria-label')||Array.from(e.labels??[],l=>l.innerText).join(' ')||e.getAttribute('placeholder')||e.getAttribute('title')||(e.isContentEditable?'':e.innerText)||e.getAttribute('alt')||e.name||'').slice(0,160);
  const geometry=e=>{
    const d=e.ownerDocument,w=d.defaultView,r=e.getBoundingClientRect(),s=w.getComputedStyle(e);
    let x=r.x+r.width/2,y=r.y+r.height/2,visible=r.width>0&&r.height>0&&x>=0&&y>=0&&x<w.innerWidth&&y<w.innerHeight&&s.visibility==='visible'&&s.display!=='none';
    let hit=visible&&e.contains(d.elementFromPoint(x,y)),v=w,depth=0;
    while(v!==window&&depth++<8){const frame=v.frameElement;if(!frame)return {visible:false,hit:false,x:0,y:0};const rect=frame.getBoundingClientRect(),parent=frame.ownerDocument.defaultView,style=parent.getComputedStyle(frame);if(style.transform!=='none'||style.visibility!=='visible'||style.display==='none')visible=false;x+=rect.x+frame.clientLeft;y+=rect.y+frame.clientTop;hit=hit&&frame.ownerDocument.elementFromPoint(x,y)===frame;visible=visible&&x>=0&&y>=0&&x<parent.innerWidth&&y<parent.innerHeight;v=parent;}
    return {visible,hit:!!hit,x:Math.round(x),y:Math.round(y)};
  };
  const metadata=e=>{
    const secret=e.type==='password'||/(?:password|one-time-code|cc-number|cc-csc)/.test(e.autocomplete??'');if(secret)secrets.add(e);
    const editable=e.isContentEditable,tag=e.tagName,type=e.type??'',explicit=e.getAttribute('role');
    const role=explicit||(tag==='SELECT'?'combobox':tag==='TEXTAREA'||editable?'textbox':tag==='INPUT'?({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',search:'searchbox'}[type]??'textbox'):tag==='A'?'link':tag==='BUTTON'?'button':'');
    const value=secrets.has(e)?'[redacted]':String(editable?e.innerText:e.value??'').slice(0,160);
    const checked=typeof e.checked==='boolean'?e.indeterminate?'mixed':e.checked:e.getAttribute('aria-checked')==='mixed'?'mixed':e.hasAttribute('aria-checked')?e.getAttribute('aria-checked')==='true':null;
    const options=tag==='SELECT'?Array.from(e.options).slice(0,40).map(o=>({value:o.value.slice(0,160),name:compact(o.text).slice(0,160),selected:o.selected,disabled:o.disabled||o.parentElement?.disabled===true})):undefined;
    return {tag,type,role,name:label(e),value,editable,disabled:e.matches(':disabled')||e.closest('[inert],[aria-disabled="true"]')!==null,readonly:!!e.readOnly||e.getAttribute('aria-readonly')==='true',checked,expanded:e.getAttribute('aria-expanded'),required:!!e.required||e.getAttribute('aria-required')==='true',href:e.getAttribute('href')??'',target:e.getAttribute('target')??'',formAction:e.form?.action??'',formMethod:e.form?.method??'',frameUrl:e.ownerDocument.location.href,options,optionsOmitted:tag==='SELECT'?Math.max(0,e.options.length-40):undefined,...geometry(e)};
  };
  const fingerprint=e=>JSON.stringify({...metadata(e),raw:secrets.has(e)?'[redacted]':String(e.isContentEditable?e.innerText:e.value??'')});
  const state=()=>{watch();return {revision,url:location.href,ready:docs().every(d=>d.readyState!=='loading'&&!!d.body),busy:docs().some(d=>Array.from(d.querySelectorAll('[aria-busy="true"]')).some(e=>geometry(e).visible))};};
  return {
    state,metadata,fingerprint,
    scan(){watch();const all=[];for(const d of docs())for(const e of d.querySelectorAll('input:not([type="hidden"]),textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="tab"],[role="menuitem"],[role="option"]')){if(all.length>=2000)break;if(geometry(e).visible)all.push(e);}return all.sort((a,b)=>(metadata(a).role==='link')-(metadata(b).role==='link'));},
    page(){const frames=[];for(const d of docs())for(const f of d.querySelectorAll('iframe,frame')){if(frames.length>=8)break;let supported=false;try{supported=!!f.contentDocument?.body&&docs().includes(f.contentDocument);}catch{}frames.push({url:f.src??'',supported,visible:geometry(f).visible,reason:supported?'same-origin':'cross-origin-or-unavailable'});}
      const text=docs().map(d=>d.body?.innerText??'').join('\n').replace(/\n\s*\n\s*\n/g,'\n\n');return {url:location.href,title:document.title.slice(0,512),text:text.slice(0,60000),textTruncated:text.length>60000,language:navigator.language,languages:navigator.languages,frames,challengeVisible:docs().some(d=>Array.from(d.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],#captcha-form')).some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.ownerDocument.defaultView.getComputedStyle(e).visibility!=='hidden';}))};},
    valid(e,expected){return e.isConnected&&e.ownerDocument.defaultView?.document===e.ownerDocument&&fingerprint(e)===expected&&geometry(e).hit;},
    verify(e,kind,value){if(!e.isConnected)return false;if(kind==='type')return String(e.isContentEditable?e.innerText:e.value)===value;if(kind==='check')return metadata(e).checked===value;if(kind==='select')return e.value===value;return true;},
    select(e,value){if(e.tagName!=='SELECT'||e.multiple)throw Error('browser_select_unsupported');const candidates=Array.from(e.options).filter(o=>o.value===value);if(candidates.length!==1||candidates[0].disabled||candidates[0].parentElement?.disabled)throw Error('browser_option_unavailable');const w=e.ownerDocument.defaultView;Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value').set.call(e,value);e.dispatchEvent(new w.Event('input',{bubbles:true}));e.dispatchEvent(new w.Event('change',{bubbles:true}));}
  };
}
