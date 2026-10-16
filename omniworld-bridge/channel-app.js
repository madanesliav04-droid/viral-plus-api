'use strict';
const feed=document.getElementById('feed'),older=document.getElementById('older'),error=document.getElementById('error'),viewer=document.getElementById('viewer');
const posts=new Map();let before=null,loading=false,initialized=false,followLatest=true;
const latest=element('button','latest','↓ Dernier message');latest.type='button';latest.hidden=true;document.body.append(latest);
function atBottom(){return document.documentElement.scrollHeight-window.innerHeight-window.scrollY<140;}
function goLatest(){followLatest=true;latest.hidden=true;latest.textContent='↓ Dernier message';window.scrollTo(0,document.documentElement.scrollHeight);}
latest.onclick=goLatest;
window.addEventListener('scroll',()=>{followLatest=atBottom();latest.hidden=followLatest;},{passive:true});
new ResizeObserver(()=>{if(initialized&&followLatest)goLatest();}).observe(feed);
const date=new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long',year:'numeric'}),time=new Intl.DateTimeFormat('fr-FR',{hour:'2-digit',minute:'2-digit'});
function element(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;}
function mediaURL(id){return '/channel/media/'+encodeURIComponent(id);}
function render(){
  feed.replaceChildren();let day='';
  for(const p of [...posts.values()].sort((a,b)=>a.id-b.id)){
    const dt=new Date(p.date*1000),label=date.format(dt);
    if(day!==label){const d=element('div','date');d.append(element('span','',label));feed.append(d);day=label;}
    const card=element('article','post');card.id='post-'+p.id;card.append(element('div','byline','OMNIWORLD'));
    const pictures=p.media.filter(m=>m.type==='image');
    if(pictures.length){const album=element('div','album'+(pictures.length===1?' single':''));
      for(const m of pictures){const b=element('button');b.type='button';b.setAttribute('aria-label','Agrandir la photo');const img=element('img');img.alt='Photo OMNIWORLD';img.loading='lazy';img.src=mediaURL(m.id);let retries=0;img.onerror=()=>{if(retries++<3)setTimeout(()=>{img.src=mediaURL(m.id)+'?retry='+retries;},2000*retries);else{img.alt='Photo indisponible — actualise la page';}};b.append(img);b.onclick=()=>{viewer.querySelector('img').src=img.src;viewer.showModal();};album.append(b);}card.append(album);}
    for(const m of p.media.filter(m=>m.type!=='image')){
      if(m.type==='video'||m.type==='audio'){const v=element(m.type);v.controls=true;v.preload='none';v.src=mediaURL(m.id);card.append(v);}
      const a=element('a','file');a.href=mediaURL(m.id);a.setAttribute('download',m.name);a.append(element('span','','↓'));const label=element('span','',m.name);label.append(element('small','',m.size?Math.ceil(m.size/1024)+' Ko · Télécharger':'Télécharger'));a.append(label);card.append(a);
    }
    const caption=element('div','caption');caption.innerHTML=p.html;card.append(caption);card.append(element('div','time',time.format(dt)));feed.append(card);
  }
  if(!posts.size)feed.append(element('p','status','Aucune annonce pour le moment.'));
}
async function load(previous=false){
  if(loading)return;loading=true;older.disabled=true;
  try{const r=await fetch('/channel/api/feed'+(previous&&before?'?before='+before:''),{cache:'no-store'});if(!r.ok)throw Error(r.status===401||r.status===403?'Ouvre le canal depuis ton espace Whop ou reconnecte-toi.':'Chargement interrompu. Réessaie.');const d=await r.json();
    const changed=d.posts.some(p=>JSON.stringify(posts.get(p.id))!==JSON.stringify(p));const height=document.documentElement.scrollHeight;
    const oldMax=Math.max(0,...posts.keys()),hasNew=d.posts.some(p=>p.id>oldMax);
    const stick=!previous&&(!initialized||followLatest);
    const anchor=[...feed.querySelectorAll('.post')].find(p=>p.getBoundingClientRect().bottom>90);
    const anchorId=anchor?.id,anchorTop=anchor?.getBoundingClientRect().top;
    if(previous)followLatest=false;
    d.posts.forEach(p=>posts.set(p.id,p));if(previous||before===null)before=d.before;
    document.getElementById('notice').hidden=!d.preview;older.hidden=!before||before<=1;
    error.replaceChildren();
    if(changed||!posts.size)render();
    initialized=true;
    if(stick)goLatest();
    else if(anchorId&&document.getElementById(anchorId))window.scrollBy(0,document.getElementById(anchorId).getBoundingClientRect().top-anchorTop);
    else if(previous)window.scrollBy(0,document.documentElement.scrollHeight-height);
    if(!stick){latest.hidden=false;if(hasNew&&!previous)latest.textContent='↓ Nouveaux messages';}
  }catch(e){error.textContent=e.message;const b=element('button','retry','Réessayer');b.onclick=()=>load(previous);error.append(document.createElement('br'),b);}
  finally{loading=false;older.disabled=false;}
}
older.onclick=()=>load(true);viewer.querySelector('button').onclick=()=>viewer.close();viewer.onclick=e=>{if(e.target===viewer)viewer.close();};load();setInterval(()=>{if(!document.hidden)load();},10000);
