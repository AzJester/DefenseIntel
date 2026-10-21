/* Official Census NAICS reference. Pursuit codes are analyst planning tags. */
(()=>{
  const naicsState={catalog:null,loading:null,error:'',query:'',sector:'',level:'',limit:100,detail:'',selected:new Set(),pursuitId:'',saving:false};
  const naicsExternal=(url,label)=>`<a href='${esc(url)}' target='_blank' rel='noopener noreferrer'>${esc(label)} ↗</a>`;
  const naicsDetailsUrl=code=>'https://www.census.gov/naics/?input='+encodeURIComponent(code)+'&year=2022&details='+encodeURIComponent(code);
  const naicsPursuits=()=>Array.isArray(cloud?.pursuits)?cloud.pursuits:[];
  const naicsLabels={2:'Sector',3:'Subsector',4:'Industry group',5:'NAICS industry',6:'U.S. industry'};
  const naicsLookup=()=>new Map((naicsState.catalog?.codes||[]).map(row=>[row.code,row]));
  function naicsValidCatalog(value){
    if(!value||value.metadata?.version!=='2022'||!Array.isArray(value.codes)||value.codes.length!==value.metadata.count)throw Error('The NAICS catalog did not pass its version and count check.');
    const unique=new Set();
    for(const row of value.codes){if(!row||typeof row.code!=='string'||!/^\d{2,6}$|^(?:31-33|44-45|48-49)$/.test(row.code)||typeof row.title!=='string'||!row.title||unique.has(row.code))throw Error('The NAICS catalog contains an invalid or duplicate code.');unique.add(row.code);}
    if(value.codes.some(row=>row.parent!==null&&!unique.has(row.parent)))throw Error('The NAICS catalog has an incomplete hierarchy.');
    return value;
  }
  async function naicsLoad(){
    if(naicsState.catalog)return naicsState.catalog;
    if(naicsState.loading)return naicsState.loading;
    naicsState.error='';
    naicsState.loading=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{const response=await fetch('/naics-2022.json',{credentials:'same-origin',cache:'force-cache',signal:controller.signal});if(!response.ok)throw Error('The catalog could not be loaded (HTTP '+response.status+').');const text=await response.text();if(text.length>1000000)throw Error('The catalog is larger than expected.');naicsState.catalog=naicsValidCatalog(JSON.parse(text));return naicsState.catalog;}
      catch(error){naicsState.error=error.name==='AbortError'?'The catalog request timed out. Retry or use the Census reference link.':error.message||'The catalog could not be loaded.';return null;}
      finally{clearTimeout(timer);naicsState.loading=null;if(location.hash.slice(1)==='naics')naicsRenderContent();}
    })();
    return naicsState.loading;
  }
  function naicsMatches(){
    const terms=naicsState.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (naicsState.catalog?.codes||[]).filter(row=>(!naicsState.sector||row.sector===naicsState.sector)&&(!naicsState.level||String(row.level)===naicsState.level)&&terms.every(term=>(row.code+' '+row.title).toLowerCase().includes(term)));
  }
  function naicsResults(){
    const all=naicsMatches(),rows=all.slice(0,naicsState.limit),lookup=naicsLookup();
    return `<p class='small' role='status'>Showing ${rows.length.toLocaleString()} of ${all.length.toLocaleString()} matching codes.</p><div class='table-wrap'><table><thead><tr><th scope='col'>SELECT</th><th scope='col'>CODE</th><th scope='col'>OFFICIAL TITLE</th><th scope='col'>LEVEL / SECTOR</th><th scope='col'>REFERENCE</th></tr></thead><tbody>${rows.map(row=>`<tr><td><input type='checkbox' data-naics-select='${esc(row.code)}' aria-label='Select ${esc(row.code+' '+row.title)}' ${naicsState.selected.has(row.code)?'checked':''}></td><td><button type='button' class='secondary' data-naics-detail='${esc(row.code)}'>${esc(row.code)}</button></td><td>${esc(row.title)}</td><td>${esc(naicsLabels[row.level])}<br><span class='small'>${esc(row.sector)} · ${esc(lookup.get(row.sector)?.title||'')}</span></td><td>${naicsExternal(naicsDetailsUrl(row.code),'Census definition')}</td></tr>`).join('')||`<tr><td colspan='5'>No matching codes. Try a broader title, a code prefix or another sector.</td></tr>`}</tbody></table></div>${all.length>rows.length?`<button type='button' class='secondary' data-naics-more>Show next 100</button>`:''}`;
  }
  function naicsSelected(){
    const lookup=naicsLookup(),rows=[...naicsState.selected].map(code=>lookup.get(code)).filter(Boolean),pursuit=naicsPursuits().find(row=>row.id===naicsState.pursuitId);
    return `<h2>Apply codes to a pursuit</h2><p>Use these as planning tags. Verify the solicitation's assigned NAICS code in SAM.gov before relying on it.</p><label>Saved pursuit<select id='naics-pursuit'><option value=''>Choose a saved pursuit</option>${naicsPursuits().map(row=>`<option value='${esc(row.id)}' ${row.id===naicsState.pursuitId?'selected':''}>${esc(row.title)}${row.customer?' · '+esc(row.customer):''}</option>`).join('')}</select></label>${naicsPursuits().length?'':`<p class='small'>Create and save a pursuit in <a href='#pursuits'>Pursuits &amp; assessments</a>, then return here.</p>`}<p class='small'>Choosing a pursuit loads its saved codes. The selection below replaces that pursuit's code tags when saved. Its other fields and assessments are retained.</p><div class='naics-chips'>${rows.map(row=>`<button type='button' class='secondary' data-naics-remove='${esc(row.code)}' aria-label='Remove ${esc(row.code+' '+row.title)}'>${esc(row.code)} · ${esc(row.title)} ×</button>`).join('')||`<p class='small'>No codes selected. Use the checkboxes in the catalog.</p>`}</div><p class='small' role='status'>${rows.length} of 20 planning codes selected${pursuit?' for '+esc(pursuit.title):''}.</p><div class='report-toolbar'><button type='button' class='primary' data-naics-save ${naicsState.saving||!naicsState.pursuitId?'disabled':''}>${naicsState.saving?'Saving…':'Save selection to pursuit'}</button><button type='button' class='secondary' data-naics-clear ${naicsState.saving||!rows.length?'disabled':''}>Clear selection</button></div><p id='naics-save-status' class='small' role='status'></p>`;
  }
  function naicsDetail(){
    const lookup=naicsLookup(),row=lookup.get(naicsState.detail);if(!row)return `<h2>Browse the hierarchy</h2><p>Select a code number to see its parent categories and immediate child codes.</p>`;
    const ancestors=[];let parent=lookup.get(row.parent);while(parent){ancestors.unshift(parent);parent=lookup.get(parent.parent);}
    const children=naicsState.catalog.codes.filter(code=>code.parent===row.code);
    return `<h2>${esc(row.code)} · ${esc(row.title)}</h2><p class='small'>${esc(naicsLabels[row.level])}${row.trilateral?' · Trilateral comparison marker in Census structure':''}</p><p>${ancestors.map(item=>`<button type='button' class='secondary' data-naics-detail='${esc(item.code)}'>${esc(item.code+' '+item.title)}</button>`).join(' › ')||'Top-level sector'}</p><p>${naicsExternal(naicsDetailsUrl(row.code),'Read official Census definition and cross-references')}</p>${children.length?`<h3>Immediate child codes</h3><div class='naics-chips'>${children.map(child=>`<button type='button' class='secondary' data-naics-detail='${esc(child.code)}'>${esc(child.code+' '+child.title)}</button>`).join('')}</div>`:`<p>This is a 6-digit U.S. industry. Review the Census definition and exclusions to test whether it fits the work.</p>`}<button type='button' class='secondary' data-naics-browse='${esc(row.code)}'>Search this code branch</button>`;
  }
  function naicsPage(){
    const catalog=naicsState.catalog;
    const intro=`<div class='status-banner'><div><strong>Official industry codes, connected to capture planning</strong><p>Search the U.S. Census Bureau's 2022 NAICS hierarchy, explore related industries and attach relevant codes to a saved pursuit.</p></div></div><section class='panel'><h2>Use NAICS to focus your research</h2><p>NAICS classifies industries. Search broad sectors to explore markets and 6-digit industries to refine a pursuit. Check the actual notice's assigned code and requirements in SAM.gov; a code saved here is a planning tag.</p><div class='report-toolbar'>${naicsExternal('https://www.census.gov/naics/','Census NAICS reference')}${naicsExternal('https://sam.gov/search/?index=opp','SAM.gov advanced opportunities search')}${naicsExternal('https://www.acquisition.gov/far/19.102','Federal NAICS guidance')}${naicsExternal('https://www.acquisition.gov/psc-manual/all','Official PSC reference')}</div><p class='small'>Catalog version: 2022. Census was still publishing the 2022 structure when this copy was retrieved; its 2027 revision was at the proposal stage. This reference does not determine small-business size or contract eligibility.</p></section>`;
    if(!catalog)return `<div class='naics-page'>${intro}<section class='panel'><p role='status'>${naicsState.error?esc(naicsState.error):'Loading the official NAICS catalog…'}</p>${naicsState.error?`<button type='button' class='secondary' data-naics-retry>Retry catalog</button>`:''}</section></div>`;
    const sectors=catalog.codes.filter(row=>row.level===2);
    return `<style>.naics-page .naics-chips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.naics-page .naics-chips button{white-space:normal;text-align:left}.naics-page .naics-layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr);gap:20px;align-items:start}.naics-page .naics-layout>.panel{min-width:0}.naics-page .report-toolbar>a{padding:8px 0;margin-right:14px}.naics-page th,.naics-page td{text-align:left;vertical-align:top}.naics-page td{padding:12px 10px}.naics-page td input[type=checkbox]{width:20px;height:20px}.naics-page #naics-detail{scroll-margin-top:20px}@media(max-width:1050px){.naics-page .naics-layout{grid-template-columns:1fr}}</style><div class='naics-page'>${intro}<div class='naics-layout'><section class='panel'><h2>Search ${catalog.metadata.count.toLocaleString()} official codes</h2><label>Code or title<input id='naics-query' type='search' value='${esc(naicsState.query)}' placeholder='Try 541330, engineering, aircraft or software' autocomplete='off'></label><div class='form-grid'><label>Sector<select id='naics-sector'><option value=''>All sectors</option>${sectors.map(row=>`<option value='${esc(row.code)}' ${row.code===naicsState.sector?'selected':''}>${esc(row.code+' · '+row.title)}</option>`).join('')}</select></label><label>Hierarchy level<select id='naics-level'><option value=''>All levels</option>${Object.keys(naicsLabels).map(level=>`<option value='${level}' ${level===naicsState.level?'selected':''}>${level} digits · ${esc(naicsLabels[level])}</option>`).join('')}</select></label></div><div class='report-toolbar'><button type='button' class='secondary' data-naics-example='engineering'>Engineering</button><button type='button' class='secondary' data-naics-example='aircraft'>Aircraft</button><button type='button' class='secondary' data-naics-example='software'>Software</button><button type='button' class='secondary' data-naics-example='research'>Research</button></div><div id='naics-results'>${naicsResults()}</div></section><div><section id='naics-selection' class='panel'>${naicsSelected()}</section><section id='naics-detail' class='panel'>${naicsDetail()}</section><section class='panel'><h2>Source and version</h2><p>${esc(catalog.metadata.publisher)} · ${esc(catalog.metadata.title)}</p><p class='small'>${catalog.metadata.count.toLocaleString()} entries: 20 sectors, 96 subsectors, 308 industry groups, 689 NAICS industries and 1,012 U.S. industries. Sector ranges such as 31–33 are retained as published.</p><p class='small'>Retrieved ${esc(new Date(catalog.metadata.retrievedAt).toLocaleDateString())}. This is a saved reference copy, not a live solicitation database.</p>${naicsExternal(catalog.metadata.officialSourceUrl,'Download original Census structure XLSX')}</section></div></div></div>`;
  }
  function naicsRenderContent(){const content=document.getElementById('content');if(content&&location.hash.slice(1)==='naics')content.innerHTML=naicsPage();}
  function naicsUpdateResults(){const target=document.getElementById('naics-results');if(target)target.innerHTML=naicsResults();}
  function naicsUpdateSelection(){const target=document.getElementById('naics-selection');if(target)target.innerHTML=naicsSelected();}
  async function naicsSave(){
    if(naicsState.saving)return;if(!naicsState.pursuitId)throw Error('Choose a saved pursuit first.');if(naicsState.selected.size>20)throw Error('Select up to 20 planning codes for one pursuit.');
    const pursuitId=naicsState.pursuitId,selectedCodes=[...naicsState.selected].sort();
    naicsState.saving=true;naicsUpdateSelection();
    try{
      // Read the latest complete record so classification editing preserves assessments and all other pursuit fields.
      const current=await api('/api/workspace'),pursuit=(current.pursuits||[]).find(row=>row.id===pursuitId);
      if(!pursuit)throw Error('That pursuit is no longer available. Reload the workspace.');
      const updated={...pursuit,naicsCodes:selectedCodes},result=await api('/api/workspace',{action:'pursuit',pursuit:updated});
      const saved=result.pursuit;if(!saved||!Array.isArray(saved.naicsCodes)||JSON.stringify([...saved.naicsCodes].sort())!==JSON.stringify(selectedCodes))throw Error('The server did not confirm the saved NAICS codes. Reload the workspace and retry.');cloud.pursuits=[saved,...(current.pursuits||[]).filter(row=>row.id!==saved.id)];
      if(typeof pursuitDraft!=='undefined'&&pursuitDraft?.id===saved.id){pursuitDraft.naicsCodes=[...saved.naicsCodes];if(typeof pursuitRemember==='function')pursuitRemember();}
      toast('NAICS planning codes saved to '+saved.title+'.');
      return saved;
    }finally{naicsState.saving=false;naicsUpdateSelection();}
  }
  Object.assign(names,{naics:'NAICS reference'});
  const naicsPriorRender=render;
  render=function(){
    if(location.hash.slice(1)!=='naics'){naicsPriorRender();return;}
    // Capture the previous editor before this route replaces its form.
    if(view==='workshops'&&typeof workshopReadForm==='function')workshopReadForm();
    if(view==='pursuits'&&typeof pursuitReadForm==='function')pursuitReadForm();
    if(view==='reports'&&typeof rememberReport==='function')rememberReport();
    view='naics';$('#crumb').textContent=names.naics;$('#title').textContent=names.naics;$('#subtitle').textContent='Explore official industry classifications and connect them to your pursuit planning.';
    document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('active',a.dataset.view==='naics'));naicsRenderContent();updateStatus();if(!naicsState.catalog&&!naicsState.loading&&!naicsState.error)void naicsLoad();
  };
  window.removeEventListener('hashchange',naicsPriorRender);window.addEventListener('hashchange',render);
  document.addEventListener('input',event=>{if(event.target.id==='naics-query'){naicsState.query=event.target.value;naicsState.limit=100;naicsUpdateResults();}});
  document.addEventListener('change',event=>{
    const target=event.target;
    if(target.id==='naics-sector'||target.id==='naics-level'){naicsState[target.id==='naics-sector'?'sector':'level']=target.value;naicsState.limit=100;naicsUpdateResults();}
    if(target.id==='naics-pursuit'){naicsState.pursuitId=target.value;const pursuit=naicsPursuits().find(row=>row.id===target.value);naicsState.selected=new Set((pursuit?.naicsCodes||[]).filter(code=>naicsLookup().has(code)));naicsUpdateSelection();naicsUpdateResults();}
    if(target.dataset.naicsSelect){const code=target.dataset.naicsSelect;if(target.checked&&naicsState.selected.size>=20){target.checked=false;toast('Select up to 20 planning codes for one pursuit.');return;}if(target.checked)naicsState.selected.add(code);else naicsState.selected.delete(code);naicsUpdateSelection();}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest?.('button');if(!button||!Object.keys(button.dataset).some(key=>key.startsWith('naics')))return;
    try{
      if(button.hasAttribute('data-naics-retry')){naicsState.error='';naicsRenderContent();void naicsLoad();}
      if(button.hasAttribute('data-naics-more')){naicsState.limit+=100;naicsUpdateResults();}
      if(button.dataset.naicsDetail){naicsState.detail=button.dataset.naicsDetail;const target=document.getElementById('naics-detail');target.innerHTML=naicsDetail();target.scrollIntoView({behavior:'smooth',block:'nearest'});}
      if(button.dataset.naicsRemove){naicsState.selected.delete(button.dataset.naicsRemove);naicsUpdateSelection();naicsUpdateResults();}
      if(button.hasAttribute('data-naics-clear')){naicsState.selected.clear();naicsUpdateSelection();naicsUpdateResults();}
      if(button.dataset.naicsExample||button.dataset.naicsBrowse){const branch=naicsLookup().get(button.dataset.naicsBrowse);naicsState.query=branch?.level===2?'':button.dataset.naicsExample||button.dataset.naicsBrowse;naicsState.sector=branch?.level===2?branch.code:'';naicsState.level='';naicsState.limit=100;naicsRenderContent();document.getElementById('naics-query')?.focus();}
      if(button.hasAttribute('data-naics-save'))await naicsSave();
    }catch(error){toast(error.message||'Unable to update the NAICS selection.');}
  });
  render();
})();
