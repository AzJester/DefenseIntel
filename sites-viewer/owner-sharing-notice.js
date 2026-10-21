/* Owner workspace disclosure. The public viewer does not load this script. */
(()=>{
  function showSharingNotice(){
    if(document.getElementById('owner-sharing-notice'))return;
    const main=document.querySelector('main');if(!main)return;
    if(!document.getElementById('owner-sharing-notice-style')){
      const style=document.createElement('style');style.id='owner-sharing-notice-style';
      style.textContent='.owner-sharing-notice{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 20px;padding:13px 17px;border:1px solid #cad5df;border-left:4px solid #c5a04e;border-radius:6px;background:#f1f5f8;color:#0b1f35;font-size:14px;line-height:1.5}.owner-sharing-notice p{margin:0}.owner-sharing-notice a{color:#003e73;font-weight:700;white-space:nowrap}@media(max-width:700px){.owner-sharing-notice{display:block}.owner-sharing-notice a{display:inline-block;margin-top:8px;white-space:normal}}';
      document.head.appendChild(style);
    }
    const notice=document.createElement('aside');notice.id='owner-sharing-notice';notice.className='owner-sharing-notice';notice.setAttribute('role','note');notice.setAttribute('aria-label','Public sharing enabled');
    const message=document.createElement('p');message.textContent='Public sharing is enabled. Saved intelligence, analyst notes, capture plans and team reviews are visible in the public workspace.';
    const link=document.createElement('a');link.href='https://intel.insightfuldefense.com';link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open public workspace ↗';
    notice.append(message,link);main.insertBefore(notice,document.getElementById('content'));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',showSharingNotice,{once:true});else showSharingNotice();
})();
