'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {createRemoteJWKSet,jwtVerify}=require('jose');
const jwks=createRemoteJWKSet(new URL('https://api.whop.com/.well-known/jwks.json'));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function richText(text,entities=[]){
  // Telegram entity offsets and JS strings both use UTF-16 code units.
  const boundaries=new Set([0,text.length]);
  const safe=(Array.isArray(entities)?entities:[]).filter(e=>Number.isInteger(e.offset)&&Number.isInteger(e.length)&&e.offset>=0&&e.length>0&&e.offset+e.length<=text.length);
  safe.forEach(e=>{boundaries.add(e.offset);boundaries.add(e.offset+e.length);});
  const points=[...boundaries].sort((a,b)=>a-b);let html='';
  for(let i=0;i<points.length-1;i++){
    const start=points[i],end=points[i+1];let s=esc(text.slice(start,end));
    for(const e of safe.filter(e=>e.offset<=start&&e.offset+e.length>=end)){
      const type=e.className||e.type;
      const tag={MessageEntityBold:'strong',MessageEntityItalic:'em',MessageEntityUnderline:'u',MessageEntityStrike:'s',MessageEntityCode:'code',MessageEntityPre:'code',MessageEntityBlockquote:'blockquote'}[type];
      if(tag)s='<'+tag+'>'+s+'</'+tag+'>';
      if(type==='MessageEntityTextUrl'||type==='MessageEntityUrl'){
        const url=type==='MessageEntityTextUrl'?e.url:text.slice(e.offset,e.offset+e.length);
        if(/^https?:\/\//i.test(url||''))s='<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+s+'</a>';
      }
    }
    html+=s;
  }
  return html;
}
function pack(messages){
  const groups=new Map();
  for(const m of [...messages].sort((a,b)=>a.id-b.id)){
    if(m.action||(!m.message&&!m.media))continue;
    const k=m.groupedId?'album:'+String(m.groupedId):'post:'+m.id;
    if(!groups.has(k))groups.set(k,{id:m.id,date:Number(m.date),ids:[],html:'',media:[]});
    const p=groups.get(k);p.ids.push(m.id);
    if(m.message)p.html+=(p.html?'\n\n':'')+richText(m.message,m.entities);
    if(m.photo||m.media?.className==='MessageMediaPhoto')p.media.push({id:m.id,type:'image',name:'Photo'});
    else if(m.document||m.media?.className==='MessageMediaDocument'){
      const d=m.document||m.media.document,mime=d.mimeType||'application/octet-stream';
      const name=d.attributes?.find(a=>a.className==='DocumentAttributeFilename')?.fileName||'Fichier';
      p.media.push({id:m.id,type:mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':mime.startsWith('image/')&&!mime.includes('svg')?'image':'file',name,size:Number(d.size||0)});
    }
  }
  return [...groups.values()];
}
async function verifyIdentity(token,appId,key=jwks){
  if(!token||!appId)throw Error('Connexion Whop requise.');
  const {payload}=await jwtVerify(token,key,{issuer:'urn:whopcom:exp-proxy',audience:appId,algorithms:['ES256'],requiredClaims:['exp','sub','aud']});
  if(typeof payload.sub!=='string'||!payload.sub.startsWith('user_'))throw Error('Identité invalide.');
  return payload.sub;
}
function mountChannel(app,{env,sessionValid,telegram,request}){
  const root=path.join(env.WHOP_OAUTH_DATA_DIR||os.tmpdir(),'channel');
  let cache=null,busy=null,downloadTail=Promise.resolve(),downloadCount=0;
  const previewIds=[4371,4372];
  const enabled=env.CHANNEL_SYNC_ENABLED==='true';
  const allowedExperience=env.WHOP_CHANNEL_EXPERIENCE_ID || env.WHOP_CHAT_ID;
  const appId=env.WHOP_CLIENT_ID;
  const guard=async(req,res,next)=>{
    res.set('Cache-Control','private, no-store');
    res.set('X-Content-Type-Options','nosniff');
    res.set('Referrer-Policy','no-referrer');
    res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors https://whop.com https://*.whop.com; base-uri 'none'; object-src 'none'");
    if(sessionValid(req))return next();
    try{
      const user=await verifyIdentity(req.headers['x-whop-user-token'],appId);
      const access=await request('users/'+encodeURIComponent(user)+'/access/'+encodeURIComponent(allowedExperience),'GET',undefined,env.WHOP_API_KEY);
      if(access.has_access!==true) return res.status(403).send('Ce canal est réservé aux membres OMNIWORLD autorisés.');
      next();
    }catch{return res.status(401).type('html').send('<meta charset="utf-8"><p>Ouvre ce canal depuis ton espace Whop.</p><p>Administrateur : <a href="/auth/login">se connecter</a>, puis revenir sur cette page.</p>');}
  };
  app.use('/channel',guard);
  app.get(['/channel','/channel/preview','/channel/experiences/:experienceId'],(_,res)=>res.sendFile(path.join(__dirname,'channel.html')));
  app.get('/channel/app.js',(_,res)=>res.type('js').sendFile(path.join(__dirname,'channel-app.js')));
  async function messagesPage(before){
    const {client,group}=telegram();if(!client||!group)throw Error('Connexion Telegram en cours.');
    if(!enabled)return client.getMessages(group,{ids:previewIds});
    let list=await client.getMessages(group,{limit:40,offsetId:before||0});
    // Fetch both edges to avoid splitting an album across pages.
    for(const edge of [list[0],list[list.length-1]])if(edge?.groupedId){
      const nearby=await client.getMessages(group,{ids:Array.from({length:21},(_,i)=>Math.max(1,edge.id-10+i))});
      const seen=new Set(list.map(m=>m.id));
      list.push(...nearby.filter(m=>m?.groupedId&&String(m.groupedId)===String(edge.groupedId)&&!seen.has(m.id)));
    }
    return list;
  }
  async function feed(before=0){
    if(!before&&cache&&Date.now()-cache.at<10000)return cache.data;
    if(!before&&busy)return busy;
    const run=(async()=>{
      const messages=await messagesPage(before);
      const posts=pack(messages);
      const data={name:'OMNIWORLD',preview:!enabled,posts,before:enabled&&messages.length?Math.min(...messages.map(m=>m.id)):null};
      if(!before){cache={at:Date.now(),data};await fs.mkdir(root,{recursive:true,mode:0o700});await fs.writeFile(path.join(root,'preview.json.tmp'),JSON.stringify(data),{mode:0o600});await fs.rename(path.join(root,'preview.json.tmp'),path.join(root,'preview.json'));}
      return data;
    })();
    if(!before)busy=run;
    try{return await run;}finally{if(!before)busy=null;}
  }
  app.get('/channel/api/feed',async(req,res)=>{
    const before=Number(req.query.before||0);
    if(!Number.isSafeInteger(before)||before<0)return res.status(400).json({error:'Page invalide.'});
    try{res.json(await feed(before));}catch{
      if(!before){try{return res.json(JSON.parse(await fs.readFile(path.join(root,'preview.json'),'utf8')));}catch{}}
      res.status(503).json({error:'Le canal est momentanément indisponible. Réessaie dans quelques instants.'});
    }
  });
  app.get('/channel/media/:id',async(req,res)=>{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1||(!enabled&&!previewIds.includes(id)))return res.sendStatus(404);
    const {client,group}=telegram();if(!client||!group)return res.sendStatus(503);
    // Bounded disk use and concurrency; never accumulate the archive's files on the small OAuth volume.
    if(downloadCount>=12)return res.status(503).set('Retry-After','3').send('Chargement en cours, réessaie.');
    downloadCount++;const previous=downloadTail;let release;downloadTail=new Promise(r=>{release=r;});await previous;let dir;
    try{
      const m=(await client.getMessages(group,{ids:[id]}))[0];if(!m?.media)return res.sendStatus(404);
      const doc=m.document||m.media.document;
      const bytes=Number(doc?.size||0);
      const disk=await fs.statfs(os.tmpdir());
      if(bytes>disk.bavail*disk.bsize-128*1024*1024)return res.status(507).send('Fichier trop volumineux pour le stockage disponible.');
      dir=await fs.mkdtemp(path.join(os.tmpdir(),'omni-channel-'));
      const file=path.join(dir,'media');
      await client.downloadMedia(m,{outputFile:file});
      const name=doc?.attributes?.find(a=>a.className==='DocumentAttributeFilename')?.fileName||('OMNIWORLD-'+id+'.jpg');
      const mime=doc?.mimeType||'image/jpeg';
      const inline=/^(image\/(jpeg|png|webp|gif)|video\/mp4|audio\/(mpeg|ogg|mp4|wav))$/.test(mime);
      res.type(inline?mime:'application/octet-stream');
      if(!inline)res.attachment(name);
      await new Promise(resolve=>res.sendFile(file,err=>{if(err&&!res.headersSent)res.sendStatus(503);resolve();}));
    }catch{if(!res.headersSent)res.status(503).send('Fichier temporairement indisponible.');}
    finally{if(dir)await fs.rm(dir,{recursive:true,force:true});downloadCount--;release();}
  });
  // Prime only the requested sample. No new messages are published to the old Whop chat.
  return {warm:async()=>{const data=await feed();console.info('[channel-ready]',JSON.stringify({preview:data.preview,posts:data.posts.length,media:data.posts.reduce((n,p)=>n+p.media.length,0)}));}};
}
module.exports={mountChannel,pack,richText,verifyIdentity};
