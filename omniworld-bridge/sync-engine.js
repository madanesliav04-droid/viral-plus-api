"use strict";
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Durable cursor and intent: an ambiguous POST is reconciled, never blindly repeated.
function createSync({directory,chat,forum,request,client,group,upload,clock=Date.now}){
 const file=path.join(directory,'telegram-sync.json');
 let state={v:1,chat,forum,cursor:0,posts:{},pending:null},running=false,ready=false;
 let retryAfter=0;
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
 async function commit(id,post){for(const key of state.pending?.ids||[id])state.posts[key]=post;if(state.pending?.mode==='live')state.liveCursor=id;else state.cursor=id;state.pending=null;await save();info.cursor=id;info.count=Object.keys(state.posts).length;}
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
 async function publish(messages,mode='history'){
  const m=messages[0]; const id=Number(messages.at(-1).id);if(id<=(mode==='live'?state.liveCursor:state.cursor))return;
  // Service messages (joined/left, pins) do not contain user content.
  if(m.action){if(mode==='live')state.liveCursor=id;else state.cursor=id;await save();return;}
  const attachments=[];
  const media=m.media;
  for(const item of messages)if(item.media && ['MessageMediaPhoto','MessageMediaDocument'].includes(item.media.className))attachments.push({id:await upload(item)});
  let text=messages.map(x=>String(x.message||x.text||'')).filter(Boolean).join('\n\n');
  if(media && !['MessageMediaPhoto','MessageMediaDocument','MessageMediaWebPage','MessageMediaEmpty'].includes(media.className)){
   throw Error('Type Telegram à traiter : '+media.className+' (message '+id+'). Import arrêté sans ignorer ce message.');
  }
  if(!text&&!attachments.length){if(mode==='live')state.liveCursor=id;else state.cursor=id;await save();return;}
  const date=new Date(Number(m.date)*1000).toISOString();
  const content=text+'\n\n---\nTelegram · '+date+'\nSource Telegram : '+messages.map(x=>source(x.id)).join('\n');
  const payload={experience_id:forum,title:('OMNIWORLD — '+(text||'Pièce jointe').replace(/\s+/g,' ')).slice(0,100),content,attachments,is_mention:false};
  const parent=m.replyTo?.replyToMsgId;
  if(parent&&state.posts[parent])payload.parent_id=state.posts[parent];
  state.pending={id,ids:messages.map(x=>Number(x.id)),mode,contentHash:hash(content),parent:payload.parent_id||null,started:clock()};await save();
  let p;try{p=await request('forum_posts','POST',payload);}catch(e){if(e.status>=400&&e.status<500){state.pending=null;await save();}throw e;}
  if(!p.id)throw Error('Publication sans identifiant.');
  await commit(id,p.id);
 }
 async function* batches(options){
  let batch=[];
  for await(const m of client.iterMessages(group,options)){
   if(batch.length && (!m.groupedId || String(m.groupedId)!==String(batch[0].groupedId) || batch.length>=10)){yield batch;batch=[];}
   batch.push(m);
  }
  if(batch.length)yield batch;
 }
 async function drainLive(){
  for await(const batch of batches({reverse:true,minId:state.liveCursor})){if(Number(batch.at(-1).date)*1000>Date.now()-2500)return;await publish(batch,'live');}
 }
 async function run(){
  if(running||clock()<retryAfter)return;running=true;
  try{
   await init();await reconcile();info.phase='importing';info.error='';
   if(state.boundary===undefined){
    const latest=await client.getMessages(group,{limit:1});
    state.boundary=Number(latest[0]?.id||0);state.liveCursor=state.boundary;await save();
   }
   await drainLive();let checked=clock();
   for await(const batch of batches({reverse:true,minId:state.cursor,maxId:state.boundary+1})){
    await publish(batch);await pause(350);
    if(clock()-checked>=3000){await drainLive();checked=clock();}
   }
   await drainLive();info.phase='listening';
  }catch(e){info.phase='blocked';info.error=String(e.message).slice(0,220);retryAfter=clock()+60000;console.error('[sync]',info.error);}
  finally{running=false;}
 }
 return {run,status:()=>({...info}),init};
}
module.exports={createSync};
