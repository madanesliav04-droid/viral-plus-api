"use strict";
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Durable cursor and intent: an ambiguous POST is reconciled, never blindly repeated.
function createSync({directory,chat,forum,request,client,group,upload,clock=Date.now}){
 const file=path.join(directory,'telegram-sync.json');
 let state={v:1,chat,forum,cursor:0,posts:{},pending:null},running=false,ready=false;
 let info={phase:'paused',cursor:0,count:0,error:''};
 async function save(){
  const tmp=file+'.'+crypto.randomBytes(8).toString('hex');const h=await fs.open(tmp,'wx',0o600);
  try{await h.writeFile(JSON.stringify(state));await h.sync();}finally{await h.close();}
  await fs.rename(tmp,file);const d=await fs.open(directory,'r');try{await d.sync();}finally{await d.close();}
 }
 async function init(){
  if(ready)return;
  try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;await save();}
  if(state.v!==1||state.chat!==chat||state.forum!==forum)throw Error('État de synchronisation incompatible.');
  ready=true; info.cursor=state.cursor;info.count=Object.keys(state.posts).length;
 }
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const source=id=>'https://t.me/c/'+chat.replace(/^-100/,'')+'/'+id;
 async function commit(id,post){state.posts[id]=post;state.cursor=id;state.pending=null;await save();info.cursor=id;info.count=Object.keys(state.posts).length;}
 async function reconcile(){
  if(!state.pending)return;
  let after='';const seen=new Set();
  do{
   const r=await request('forum_posts?experience_id='+encodeURIComponent(forum)+'&first=100'+(state.pending.parent?'&parent_id='+encodeURIComponent(state.pending.parent):'')+(after?'&after='+encodeURIComponent(after):''),'GET');
   if(!Array.isArray(r.data))throw Error('Liste Whop invalide.');
   const hit=r.data.find(p=>hash(String(p.content||''))===state.pending.contentHash);
   if(hit){await commit(state.pending.id,hit.id);return;}
   if(!r.page_info?.has_next_page)break;
   after=r.page_info.end_cursor;
   if(!after||seen.has(after))throw Error('Pagination Whop invalide.');seen.add(after);
  }while(true);
  throw Error('Publication incertaine du message '+state.pending.id+'. Vérification manuelle requise pour éviter un doublon.');
 }
 async function publish(m){
  const id=Number(m.id);if(id<=state.cursor)return;
  // Service messages (joined/left, pins) do not contain user content.
  if(m.action){state.cursor=id;await save();return;}
  const attachments=[];
  const media=m.media;
  if(media && ['MessageMediaPhoto','MessageMediaDocument'].includes(media.className))attachments.push({id:await upload(m)});
  let text=String(m.message||m.text||'');
  if(media && !['MessageMediaPhoto','MessageMediaDocument','MessageMediaWebPage','MessageMediaEmpty'].includes(media.className)){
   throw Error('Type Telegram à traiter : '+media.className+' (message '+id+'). Import arrêté sans ignorer ce message.');
  }
  if(!text&&!attachments.length){state.cursor=id;await save();return;}
  const date=new Date(Number(m.date)*1000).toISOString();
  const content=text+'\n\n---\nTelegram · '+date+'\nSource Telegram : '+source(id);
  const payload={experience_id:forum,title:('OMNIWORLD — '+(text||'Pièce jointe').replace(/\s+/g,' ')).slice(0,100),content,attachments,is_mention:false};
  const parent=m.replyTo?.replyToMsgId;
  if(parent&&state.posts[parent])payload.parent_id=state.posts[parent];
  state.pending={id,contentHash:hash(content),parent:payload.parent_id||null,started:clock()};await save();
  const p=await request('forum_posts','POST',payload);
  if(!p.id)throw Error('Publication sans identifiant.');
  await commit(id,p.id);
 }
 async function run(){
  if(running)return;running=true;
  try{
   await init();await reconcile();info.phase='importing';info.error='';
   // Telegram is the persistent queue. Reverse iterator paginates from oldest to newest.
   for await(const m of client.iterMessages(group,{reverse:true,minId:state.cursor})){
    await publish(m);await pause(350);
   }
   info.phase='listening';
  }catch(e){info.phase='blocked';info.error=String(e.message).slice(0,220);console.error('[sync]',info.error);}
  finally{running=false;}
 }
 return {run,status:()=>({...info}),init};
}
module.exports={createSync};
