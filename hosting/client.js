/* First-party session/CSRF bridge. No intelligence is stored here. */
(()=>{
  const original=window.fetch.bind(window);
  const session=original('/auth/session',{credentials:'same-origin',cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('Session expired');return response.json();});
  window.fetch=async(input,options)=>{
    const request=new Request(input,options),url=new URL(request.url),local=url.origin===window.location.origin;
    if(local&&!['GET','HEAD','OPTIONS'].includes(request.method.toUpperCase())){
      const info=await session,headers=new Headers(request.headers);headers.set('X-CSRF-Token',info.csrf);
      const response=await original(new Request(request,{headers,credentials:'same-origin'}));
      if(response.status===401)window.location.assign('/auth/login');return response;
    }
    const response=await original(request);if(local&&response.status===401)window.location.assign('/auth/login');return response;
  };
  session.catch(()=>window.location.assign('/auth/login'));
  document.addEventListener('DOMContentLoaded',()=>{
    const container=document.querySelector('.header-right');if(!container)return;
    const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Sign out';
    button.addEventListener('click',async()=>{button.disabled=true;try{await window.fetch('/auth/logout',{method:'POST'});window.location.assign('/auth/login');}catch{button.disabled=false;}});
    container.append(button);
  });
})();
