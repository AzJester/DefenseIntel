/* Public viewing with local filters/exports; the hosting API enforces write access. */
(()=>{
  const editForms=new Set(['entry-form','competitor-form','priorities-form','entity-form','finding-form','workshop-form','pursuit-form','pursuit-assessment-form','capture-plan-form']);
  const hiddenForms=new Set(['entry-form','competitor-form','entity-form','finding-form']);
  const filterControls=new Set(['pursuit-assessment-company','pursuit-assessment-criterion','capture-source-search']);
  const localButtons='[data-workshop-export],[data-capture-export],[data-capture-filter],[data-capture-expand],[data-capture-refresh]';
  const privateControls='#add,#refresh,#import,#commit-import,#template,#data-file,#import-file,#import-kind,[data-edit-company],[data-edit-entity],[data-edit-finding],[data-ack],[data-ack-event],[data-workshop-new],[data-workshop-role],[data-workshop-add],[data-workshop-remove],[data-pursuit-new],[data-pursuit-add-criterion],[data-pursuit-remove-criterion],[data-pursuit-apply-plan],[data-capture-new],[data-capture-add],[data-capture-remove],[data-naics-save]';
  const locked=new Map(),hidden=new Set(),renamed=new Map(),ephemeralSnapshots=new Set();
  let lastAccess=null,mirrorNumber=0,scheduled=false;
  const info=()=>typeof cloud!=='undefined'&&cloud.access?cloud.access:lastAccess;
  const readOnly=()=>info()?.readOnly===true;
  function editorUrl(){try{const value=new URL(info()?.editorUrl||'');return value.protocol==='https:'&&!value.username&&!value.password?value.href:'';}catch{return '';}}
  function hide(element){if(!element)return;hidden.add(element);element.classList.add('access-private-control');}
  function rename(element,text){if(!element)return;if(!renamed.has(element))renamed.set(element,element.textContent);if(element.textContent!==text)element.textContent=text;}
  function lockControl(control){
    if(!control.name||['hidden','submit','button','reset'].includes(control.type))return;
    if(filterControls.has(control.id)||control.matches('[data-workshop-search],[data-pursuit-evidence-search]'))return;
    if(locked.has(control))return;
    const state={disabled:control.disabled,readOnly:control.readOnly,mirrors:[]};locked.set(control,state);
    // Read-only text remains in FormData. Disabled choices need hidden mirrors so
    // existing plan readers and downloads preserve the complete shared record.
    if(control.tagName==='SELECT'||['checkbox','radio','file'].includes(control.type)){
      let values=[];
      if(!control.disabled&&control.type!=='file')values=control.tagName==='SELECT'?[...control.options].filter(option=>option.selected).map(option=>option.value):control.checked?[control.value]:[];
      for(const value of values){const mirror=document.createElement('input');mirror.type='hidden';mirror.name=control.name;mirror.value=value;mirror.dataset.accessMirror=String(++mirrorNumber);control.insertAdjacentElement('afterend',mirror);state.mirrors.push(mirror);}
      control.disabled=true;
    }else control.readOnly=true;
    control.classList.add('access-readonly-field');
  }
  function cleanSnapshots(){if(typeof cloud!=='undefined'&&Array.isArray(cloud.snapshots)&&ephemeralSnapshots.size)cloud.snapshots=cloud.snapshots.filter(row=>!ephemeralSnapshots.has(row.id));}
  function restore(){
    for(const [control,state]of locked){control.disabled=state.disabled;control.readOnly=state.readOnly;control.classList.remove('access-readonly-field');state.mirrors.forEach(mirror=>mirror.remove());}locked.clear();
    for(const element of hidden)element.classList.remove('access-private-control');hidden.clear();
    for(const [element,text]of renamed)element.textContent=text;renamed.clear();
    document.getElementById('public-view-banner')?.remove();document.body.classList.remove('public-readonly');
  }
  function apply(){
    if(!readOnly()){restore();return;}
    cleanSnapshots();document.body.classList.add('public-readonly');
    if(!document.getElementById('public-access-style')){const style=document.createElement('style');style.id='public-access-style';style.textContent='.public-readonly .access-private-control{display:none!important}.public-readonly .access-readonly-field{color:#172b3d!important;opacity:1!important;cursor:default}.public-access-banner{background:#f1f5f8;border:1px solid #cad5df;border-left:4px solid #c5a04e;padding:16px 20px;border-radius:6px;margin:0 0 22px;display:flex;align-items:center;justify-content:space-between;gap:18px}.public-access-banner p{margin:5px 0 0}.public-access-banner a{white-space:nowrap}@media(max-width:650px){.public-access-banner{display:block}.public-access-banner a{display:inline-block;margin-top:12px}}';document.head.appendChild(style);}
    let banner=document.getElementById('public-view-banner');
    if(!banner){banner=document.createElement('section');banner.id='public-view-banner';banner.className='public-access-banner';banner.setAttribute('aria-label','Workspace access');const text=document.createElement('div'),title=document.createElement('strong'),description=document.createElement('p');title.textContent='Public view · owner editing is separate';description.className='small';description.textContent='Browse shared intelligence, plans and charts. Filters, brief selections and downloads stay local to this browser. Changes and collection are available in the owner preview.';text.append(title,description);banner.appendChild(text);const main=document.querySelector('main');if(main)main.insertBefore(banner,document.getElementById('content'));}
    const url=editorUrl(),existing=banner.querySelector('[data-access-editor]');
    if(url&&!existing){const anchor=document.createElement('a');anchor.href=url;anchor.className='source-link';anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.dataset.accessEditor='true';anchor.textContent='Open owner preview ↗';banner.appendChild(anchor);}else if(existing&&existing.href!==url){if(url)existing.href=url;else existing.remove();}
    document.querySelectorAll(privateControls).forEach(hide);
    document.querySelectorAll('form').forEach(form=>{
      if(!editForms.has(form.id))return;
      if(hiddenForms.has(form.id)){hide(form);return;}
      form.querySelectorAll('input,textarea,select').forEach(lockControl);
      form.querySelectorAll('button').forEach(button=>{if(!button.matches(localButtons))hide(button);});
    });
    for(const [control,state]of locked)if(control.isConnected===false){state.mirrors.forEach(mirror=>mirror.remove());locked.delete(control);}
    document.querySelectorAll('[data-save]').forEach(button=>{const saved=button.classList.contains('selected')||String(button.textContent).includes('★');rename(button,saved?'★ Selected for local brief':'☆ Select for local brief');});
    document.querySelectorAll('[data-pursuit-open-assessment]').forEach(button=>{button.title='Review the shared analyst assessment and its source links';});
    const nav=document.querySelector('[data-view="data"]');if(nav){const span=nav.querySelector('span');if(span)rename(span,'Shared data');}
    const savedHeading=[...document.querySelectorAll('#content h2')].find(heading=>heading.textContent==='Saved brief snapshots');
    if(savedHeading){const paragraph=savedHeading.parentElement.querySelector('p');if(paragraph)rename(paragraph,'Shared saved snapshots remain available below. Your public-view downloads are frozen local copies and do not create or update a shared snapshot.');}
    const naics=document.getElementById('naics-selection');if(naics){rename(naics.querySelector('h2'),'Explore pursuit codes');const paragraph=naics.querySelector('p');if(paragraph)rename(paragraph,'Browse shared pursuit tags or make a local code selection. Shared tags can be updated in the owner preview.');}
    const side=document.querySelector('.side-bottom');if(side)for(const node of side.childNodes)if(node.nodeType===3&&node.textContent.includes('Private workspace'))rename(node,node.textContent.replace('Private workspace','Public view'));
    const weekly=document.getElementById('weekly-draft');if(weekly)rename(weekly,'Prepare local weekly draft');
    for(const id of ['workshop-save-status','pursuit-save-status','capture-save-status']){const status=document.getElementById(id);if(status)rename(status,'Shared plan in public view. Open the owner preview to make changes.');}
  }
  function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;apply();});}
  function block(event){
    if(!readOnly())return;
    if(event.type==='submit'&&editForms.has(event.target.id)||event.type==='click'&&event.target.closest?.(privateControls)){
      event.preventDefault();event.stopImmediatePropagation();if(typeof toast==='function')toast('Public view. Open the owner preview to change shared data.');
    }
  }
  window.addEventListener('click',block,true);window.addEventListener('submit',block,true);
  const originalApi=api;
  api=async function(path,body){
    if(readOnly()&&body&&!(path==='/api/workspace'&&['snapshot_get','brief_snapshot','bootstrap'].includes(body.action)))throw Error('Public view. Open the owner preview to change shared data.');
    if(readOnly()&&path==='/api/workspace'&&body?.action==='bootstrap')return {ok:true,readOnly:true};
    const result=await originalApi(path,body);
    if(result?.access){lastAccess=result.access;schedule();}
    if(readOnly()&&body?.action==='brief_snapshot'&&result?.options?.snapshotId)ephemeralSnapshots.add(result.options.snapshotId);
    return result;
  };
  function selectSharedPlan(){
    if(!readOnly())return;const route=location.hash.slice(1),content=document.getElementById('content');
    if(route==='workshops'&&typeof workshopDraft!=='undefined'&&!workshopDraft?.id&&Array.isArray(cloud.workshops)&&cloud.workshops.length){workshopDraft=workshopNormalize(cloud.workshops[0]);workshopDirty=false;content.innerHTML=workshopsView();}
    if(route==='pursuits'&&typeof pursuitDraft!=='undefined'&&!pursuitDraft?.id&&Array.isArray(cloud.pursuits)&&cloud.pursuits.length){pursuitDraft=pursuitNormalize(cloud.pursuits[0]);pursuitDirty=false;content.innerHTML=pursuitsView();}
    if(route==='capture'&&typeof captureDraft!=='undefined'&&!captureDraft?.id&&Array.isArray(cloud.capturePlans)&&cloud.capturePlans.length){captureDraft=captureNormalize(cloud.capturePlans[0]);captureDirty=false;content.innerHTML=captureView();}
    const shared=route==='workshops'?cloud.workshops:route==='pursuits'?cloud.pursuits:route==='capture'?cloud.capturePlans:null;
    if(Array.isArray(shared)&&!shared.length)content.innerHTML='<section class="panel empty"><h2>No shared plan yet</h2><p>The owner can prepare and save this plan in the owner preview. Shared plans will appear here when available.</p></section>';
  }
  const priorRender=render;render=function(){cleanSnapshots();priorRender();selectSharedPlan();apply();};window.removeEventListener('hashchange',priorRender);window.addEventListener('hashchange',render);
  const observer=new MutationObserver(schedule);observer.observe(document.getElementById('content'),{childList:true,subtree:true});
  window.IntelAccessPresentation=Object.freeze({apply,isReadOnly:readOnly});
  selectSharedPlan();apply();
})();
