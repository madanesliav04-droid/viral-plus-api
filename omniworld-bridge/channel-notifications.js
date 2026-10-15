'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
function createNotifications({env,client,group,request,now=()=>Date.now()}){
  const experience=env.WHOP_CHANNEL_EXPERIENCE_ID;
  const file=path.join(env.WHOP_OAUTH_DATA_DIR,'channel-notifications.json');
  let state,busy=false,pausedUntil=0;
  const save=async()=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(state),{mode:0o600});await fs.rename(file+'.tmp',file);};
  const send=payload=>request('notifications','POST',{experience_id:experience,title:'OMNIWORLD',...payload},env.WHOP_NOTIFICATION_API_KEY||env.WHOP_API_KEY);
  async function tick(){
    if(busy||now()<pausedUntil||env.CHANNEL_NOTIFICATIONS_ENABLED!=='true')return;
    busy=true;
    try{
      if(!state){
        try{state=JSON.parse(await fs.readFile(file,'utf8'));if(state.experience!==experience||!Number.isSafeInteger(state.cursor))throw Error('Invalid notification state');}
        catch(e){if(e.code!=='ENOENT')throw e;const latest=await client.getMessages(group,{limit:1});state={experience,cursor:latest[0]?.id||0,verified:false};await save();}
      }
      if(!state.verified){
        // One private setup notification; no historical broadcast.
        if(!env.WHOP_NOTIFICATION_TEST_USER)throw Error('Missing notification test recipient');
        const result=await send({content:'Les notifications OMNIWORLD sont prêtes pour les nouveaux messages.',user_ids:[env.WHOP_NOTIFICATION_TEST_USER]});
        if(result.success!==true)throw Error('Notification test not accepted');
        state.verified=true;await save();console.info('[channel-notifications] ready');
      }
      const messages=await client.getMessages(group,{minId:state.cursor,limit:100,reverse:true});
      const sorted=[...messages].filter(m=>m.id>state.cursor).sort((a,b)=>a.id-b.id);
      for(let i=0;i<sorted.length;){
        const first=sorted[i],album=[first];i++;
        if(first.groupedId){while(i<sorted.length&&String(sorted[i].groupedId)===String(first.groupedId))album.push(sorted[i++]);}
        // Wait until an album is complete; next poll will fetch its remaining items.
        if(album.some(m=>Number(m.date)*1000>now()-10000)||first.groupedId&&i===sorted.length&&sorted.length===100)break;
        const end=Math.max(...album.map(m=>m.id));
        if(first.action||!album.some(m=>m.message||m.media)){state.cursor=end;await save();continue;}
        const content=album.map(m=>m.message||'').filter(Boolean).join('\n').trim().slice(0,180)|| (album.length>1?'Nouvel album photo dans OMNIWORLD.':'Nouveau média dans OMNIWORLD.');
        // Persist before POST: an ambiguous timeout/restart must not duplicate alerts.
        const previous=state.cursor;state.cursor=end;state.pending=end;await save();
        try{
          const result=await send({content});
          if(result.success!==true)throw Error('Notification not accepted');
          delete state.pending;await save();console.info('[channel-notifications] sent',end);
        }catch(e){
          if([400,401,403,404,429].includes(e.status)){state.cursor=previous;delete state.pending;await save();}
          throw e;
        }
      }
    }catch(e){pausedUntil=now()+60000;console.error('[channel-notifications] blocked',e.status||'delivery_or_storage_error');}
    finally{busy=false;}
  }
  return {tick};
}
module.exports={createNotifications};
