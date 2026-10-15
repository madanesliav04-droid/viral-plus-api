"use strict";
const express = require("express");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const QRCode = require("qrcode");
const crypto = require("node:crypto");
const ENV = process.env;
const whopOAuth = require("./whop-oauth").createWhopOAuth({env:ENV});
const API_ID = Number(ENV.TELEGRAM_API_ID || 0);
const API_HASH = ENV.TELEGRAM_API_HASH || "";
const TG_CHAT = ENV.TELEGRAM_CHAT_ID || "";
const WHOP_KEY = ENV.WHOP_API_KEY || "";
const WHOP_FORUM = ENV.WHOP_CHAT_ID || "";
const WHOP_ACCOUNT = ENV.WHOP_COMPANY_ID || "";
const ADMIN_PASSWORD = ENV.BRIDGE_ADMIN_PASSWORD || "";
const INITIAL_ID = Number(ENV.TELEGRAM_START_ID || 4386);
const ENABLED = ENV.SYNC_ENABLED === "true";
const configured = Boolean(API_ID && API_HASH && TG_CHAT && WHOP_KEY && WHOP_FORUM && WHOP_ACCOUNT);
let client = null, sessionValue = "", qrImage = "", loginBusy = false;
let status = "not_connected", error = "", twoFactorResolve = null;
let group = null, lastPosted = INITIAL_ID, processed = 0, queue = Promise.resolve();

function briefError(e) {
  const message = String(e && (e.message || e) || "Erreur inconnue");
  return message.replace(/(password|token|session)\s*[:=]\s*\S+/gi, "$1=[hidden]").slice(0,220);
}
function canAdmin(req) {
  const header = req.headers.authorization || "";
  const expected = "Basic " + Buffer.from("admin:" + ADMIN_PASSWORD).toString("base64");
  if (ADMIN_PASSWORD.length < 20) return false;
  const a=Buffer.from(header),b=Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}
function tgSource(id) {
  return "https://t.me/c/" + TG_CHAT.replace(/^-100/,"") + "/" + id;
}
async function whopRequest(path, method, payload, credential) {
  credential = credential || await whopOAuth.accessToken();
  const r = await fetch("https://api.whop.com/api/v1/" + path, {
    method, headers: {"Authorization":"Bearer " + credential,"Content-Type":"application/json"},
    body:payload ? JSON.stringify(payload) : undefined, signal:AbortSignal.timeout(15000)
  });
  if (!r.ok) {const e=new Error("API Whop [" + method + " " + path.split("?")[0] + "] " + r.status + " : " + (await r.text()).slice(0,150));e.status=r.status;throw e;}
  return r.json();
}
async function postToWhop(text,title) {
  return whopRequest("messages","POST",{
    channel_id:WHOP_FORUM, content:text, auto_detect_links:true
  });
}
async function verifyChat(){
  const f=await whopRequest("chat_channels/"+encodeURIComponent(WHOP_FORUM),"GET");
  if(f.experience?.id!==WHOP_FORUM || f.who_can_post!=="admins" || f.ban_media || f.ban_urls)
    throw Error("Le Chat doit réserver les messages aux admins et autoriser médias et liens.");
  console.info("[chat-access]",JSON.stringify({id:f.id,experience:f.experience.id,who_can_post:f.who_can_post,ban_media:f.ban_media,ban_urls:f.ban_urls}));
}
let syncEngine=null, mediaClient=null, notificationTimer=null;
async function attach(c){
  client=c;status="connected";qrImage="";error="";
  const dialogs=await c.getDialogs({limit:500});
  const match=dialogs.find(d=>String(d.id)===TG_CHAT || String(d.entity?.id)===TG_CHAT.replace(/^-100/,""));
  if(!match){status="group_not_found";error="Le compte connecté ne voit pas le groupe Telegram cible.";return;}
  group=match.entity;
  if(notificationTimer)clearInterval(notificationTimer);
  if(ENV.CHANNEL_NOTIFICATIONS_ENABLED==='true'){
    const notifier=require('./channel-notifications').createNotifications({env:ENV,client:c,group,request:whopRequest});
    await notifier.tick();
    notificationTimer=setInterval(()=>notifier.tick(),10000);notificationTimer.unref();
  }
  mediaClient=require("./whop-media").createMedia({request:whopRequest,client:c});
  syncEngine=require("./sync-engine").createSync({directory:ENV.WHOP_OAUTH_DATA_DIR,chat:TG_CHAT,forum:WHOP_FORUM,request:whopRequest,client:c,group,upload:mediaClient.upload,verify:verifyChat});
  await syncEngine.init();
  const kick=()=>{if(ENABLED)syncEngine.run();};
  c.addEventHandler(e=>{if(String(e.chatId)===TG_CHAT)kick();},new NewMessage({}));
  setInterval(kick,10000).unref();
  setInterval(()=>{if(ENABLED)console.info("[sync-progress]",JSON.stringify(syncEngine.status()));},30000).unref();
  status="connected_listening";
  channel.warm().catch(()=>console.error("[channel-ready] preview unavailable"));
  if(ENV.MEDIA_PREFLIGHT==="true"){
    try{
      await verifyChat();
      const existing=await whopRequest("messages?channel_id="+encodeURIComponent(WHOP_FORUM)+"&first=100","GET");
      const previous=existing.data?.find(p=>p.content==="Test technique du transfert de médias. Référence : omniworld-media-test-v2");
      if(previous){console.info("[media-test] existing; visual verification required",previous.id);}else{
      const fileId=await mediaClient.test();
      const post=await whopRequest("messages","POST",{channel_id:WHOP_FORUM,content:"Test technique du transfert de médias. Référence : omniworld-media-test-v2",attachments:[{id:fileId}],auto_detect_links:true});
      const check=await whopRequest("messages/"+encodeURIComponent(post.id),"GET");
      if(!check.attachments?.some(a=>a.id===fileId)){console.info("[media-test] awaiting visual verification",JSON.stringify({postId:post.id,fileId,responseFields:Object.keys(check)}));}else
      console.info("[media-test] verified",post.id);}
    }catch(e){console.error("[media-test] failed",briefError(e));}
  }
  if(ENV.SINGLE_POST_TEST==="4371" && !ENABLED){
    try{
      await verifyChat();
      const fs=require("node:fs/promises");
      const marker=require("node:path").join(ENV.WHOP_OAUTH_DATA_DIR,"chat-test-4371-v1.json");
      let exists=false;try{await fs.access(marker);exists=true;}catch(e){if(e.code!=="ENOENT")throw e;}
      if(exists){console.info("[single-test] already attempted; no duplicate");}
      else{
        const selected=(await c.getMessages(group,{ids:[4371]}))[0];
        if(!selected || selected.id!==4371)throw Error("Post Telegram 4371 introuvable.");
        let album=[selected];
        if(selected.groupedId){
          const nearby=await c.getMessages(group,{ids:Array.from({length:41},(_,i)=>4351+i)});
          album=nearby.filter(m=>m && m.groupedId && String(m.groupedId)===String(selected.groupedId)).sort((a,b)=>a.id-b.id);
        }
        if(!album.length || album.length>10)throw Error("Album Telegram inattendu.");
        const attachments=[];
        for(const m of album){
          if(m.media && ["MessageMediaPhoto","MessageMediaDocument"].includes(m.media.className))attachments.push({id:await mediaClient.upload(m)});
          else if(m.media && m.media.className!=="MessageMediaWebPage")throw Error("Type de média non pris en charge.");
        }
        const content=album.map(m=>String(m.message||"")).filter(Boolean).join("\n\n");
        if(!content && !attachments.length)throw Error("Post vide.");
        const lock=await fs.open(marker,"wx",0o600);
        try{await lock.writeFile(JSON.stringify({status:"pending",sourceIds:album.map(m=>m.id)}));await lock.sync();}finally{await lock.close();}
        const post=await whopRequest("messages","POST",{channel_id:WHOP_FORUM,content,attachments,auto_detect_links:false});
        if(!post.id)throw Error("Réponse sans identifiant.");
        await fs.writeFile(marker,JSON.stringify({status:"posted",postId:post.id,sourceIds:album.map(m=>m.id)}),{mode:0o600});
        const check=await whopRequest("messages/"+encodeURIComponent(post.id),"GET");
        if(check.content!==content)throw Error("Texte publié non confirmé.");
        console.info("[single-test] verified",JSON.stringify({postId:post.id,sourceIds:album.map(m=>m.id),attachmentCount:attachments.length,textLength:content.length,previews:false}));
      }
    }catch(e){console.error("[single-test] failed",briefError(e));}
  }
  // Read-only inventory: no message content, names, media URLs or credentials in logs.
  if(ENV.SYNC_INVENTORY==="true"){
    try{
      const types={};let count=0,min=null,max=0,large=0;
      for await(const m of c.iterMessages(group,{})){
        if(m.action)continue;count++;min=m.id;max=Math.max(max,m.id);
        const type=m.media?.className||"text";types[type]=(types[type]||0)+1;
        if(Number(m.media?.document?.size||0)>100*1024*1024)large++;
      }
      console.info("[sync-inventory]",JSON.stringify({count,min,max,types,filesOver100MB:large}));
    }catch(e){console.error("[sync-inventory] failed",briefError(e));}
  }
  try{await verifyChat();}catch(e){console.error("[chat-access] failed",briefError(e));}
  kick();
}
async function restore(){
  if(!configured || !ENV.TELEGRAM_SESSION)return;
  try{
    status="connecting_telegram";
    const c=new TelegramClient(new StringSession(ENV.TELEGRAM_SESSION),API_ID,API_HASH,{connectionRetries:5});
    await c.connect();
    if(!await c.checkAuthorization()){status="invalid_session";await c.disconnect();return;}
    await attach(c);
  }catch(e){status="restore_failed";error=briefError(e);console.error("Telegram restore failed:",error);}
}
async function startLogin() {
  if(loginBusy || status.startsWith("connected")) return;
  if(!configured)throw new Error("Variables Telegram / Whop manquantes dans Railway.");
  loginBusy=true;qrImage="";sessionValue="";status="connecting_to_telegram";error="";
  console.info("[telegram-auth] QR request received");
  (async()=>{
    const c=new TelegramClient(new StringSession(""),API_ID,API_HASH,{connectionRetries:5});
    try{
      await c.connect();
      status="requesting_qr_token";
      console.info("[telegram-auth] Connected to Telegram; requesting QR token");
      await c.signInUserWithQrCode({apiId:API_ID,apiHash:API_HASH},{
        qrCode:async obj=>{
          qrImage=await QRCode.toDataURL("tg://login?token="+obj.token.toString("base64url"),{margin:2,width:270});
          status="waiting_for_scan";
          console.info("[telegram-auth] QR image generated");
        },
        password:async()=>{
          status="two_factor_required";
          return new Promise(resolve=>{twoFactorResolve=resolve;});
        },
        onError:async e=>{error=briefError(e);console.error("[telegram-auth] Auth callback error:",error);return true;}
      });
      sessionValue=String(c.session.save());
      status="authorized_copy_session";
      console.info("[telegram-auth] Telegram login authorized");
      // Ne pas publier maintenant ; la session doit être enregistrée dans Railway.
      try{await c.disconnect();}catch{}
    }catch(e){status="login_error";error=briefError(e);console.error("[telegram-auth] QR login failed:",error);try{await c.disconnect();}catch{}}
    finally{loginBusy=false;qrImage="";}
  })();
}
const app=express();
app.disable("x-powered-by");
app.use(express.json({limit:"5kb"}));
app.use(express.urlencoded({extended:false,limit:"2kb"}));
app.get("/health",(_,res)=>res.json({ok:true,configured,telegramConnected:status.startsWith("connected"),groupFound:Boolean(group),syncEnabled:ENABLED}));
const signCookie=ts=>crypto.createHmac("sha256",ADMIN_PASSWORD).update("omniworld:"+ts).digest("hex");
const passwordIsValid=s=>{
  if(!ADMIN_PASSWORD || ADMIN_PASSWORD.length<20 || typeof s!=="string")return false;
  const a=Buffer.from(s),b=Buffer.from(ADMIN_PASSWORD);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
};
function sessionValid(req){
  const token=String(req.headers.cookie||"").split(";").map(s=>s.trim()).find(s=>s.startsWith("omni_auth="))?.slice(10);
  if(!token)return false;
  const [ts,sig]=token.split(".");
  if(!/^[0-9]{10}$/.test(ts||"") || !/^[a-f0-9]{64}$/.test(sig||""))return false;
  const age=Math.floor(Date.now()/1000)-Number(ts);
  if(age<0 || age>24*60*60)return false;
  const expected=Buffer.from(signCookie(ts)),received=Buffer.from(sig);
  return received.length===expected.length && crypto.timingSafeEqual(expected,received);
}
const channel=require("./channel").mountChannel(app,{env:ENV,sessionValid,telegram:()=>({client,group}),request:whopRequest});
const loginPage=errorMessage=>[
"<!doctype html><html lang='fr'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
"<title>Connexion — OMNIWORLD Sync</title><style>body{font:16px system-ui;background:#111822;color:#fff;max-width:430px;margin:50px auto;padding:20px}main{border:1px solid #405169;padding:24px;border-radius:14px}label{display:block;margin-top:20px}input{box-sizing:border-box;width:100%;padding:12px;font-size:16px;border-radius:8px;border:1px solid #9facbc}button{display:block;margin-top:22px;width:100%;padding:14px;border:0;border-radius:8px;background:#dae9ff;font-weight:700;cursor:pointer}.error{color:#ffb0b0}</style>",
"<main><h2>OMNIWORLD Sync</h2><p>Connecte-toi avec le mot de passe enregistré dans les variables Railway.</p>",
errorMessage?"<p class='error'>Identifiant ou mot de passe incorrect. Vérifie BRIDGE_ADMIN_PASSWORD dans Railway.</p>":"",
"<form method='POST' action='/auth/login'><label>Identifiant</label><input name='username' value='admin' required autocomplete='username'><label>Mot de passe</label><input type='password' name='password' required autocomplete='current-password'><button type='submit'>Se connecter</button></form>",
"</main></html>"
].join("");
let failedLogins=0,blockUntil=0;
app.get("/auth/login",(req,res)=>sessionValid(req)?res.redirect("/setup"):res.type("html").send(loginPage(false)));
app.post("/auth/login",(req,res)=>{
  res.set("Cache-Control","no-store");
  if(Date.now()<blockUntil)return res.status(429).type("html").send(loginPage(true));
  if(req.body?.username!=="admin" || !passwordIsValid(req.body?.password)){
    if(++failedLogins>=12){blockUntil=Date.now()+5*60*1000;failedLogins=0;}
    return res.status(200).type("html").send(loginPage(true));
  }
  failedLogins=0;
  const ts=String(Math.floor(Date.now()/1000));
  res.cookie("omni_auth",ts+"."+signCookie(ts),{httpOnly:true,secure:true,sameSite:"strict",maxAge:86400000,path:"/"});
  res.redirect(303,"/setup");
});
// OAuth callback is cross-site: validate its own one-use state and Lax cookie.
app.get("/oauth/whop/callback",async(req,res)=>{
  res.set("Cache-Control","no-store");
  res.set("Referrer-Policy","no-referrer");
  res.set("X-Frame-Options","DENY");
  const browser=String(req.headers.cookie||"").split(";").map(s=>s.trim()).find(s=>s.startsWith("omni_whop_flow="))?.slice(15);
  res.clearCookie("omni_whop_flow",{httpOnly:true,secure:true,sameSite:"lax",path:"/oauth/whop/callback"});
  try{
    await whopOAuth.callback({state:req.query.state,code:req.query.code,browser,denied:Boolean(req.query.error)});
    res.type("html").send("<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><h2>Compte Whop connecté</h2><p>La synchronisation reste en attente. Tu peux maintenant lancer le test.</p><a href='/setup'>Revenir au connecteur</a>");
  }catch(e){
    // These messages are generated locally and never include provider responses.
    const message=String(e.message).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    res.status(400).type("html").send("<!doctype html><meta charset='utf-8'><p>"+message+"</p><a href='/setup'>Revenir au connecteur</a>");
  }
});
app.use((req,res,next)=>{
  if(!sessionValid(req))return req.method==="GET"?res.redirect("/auth/login"):res.status(403).json({error:"Connexion expirée. Recharge la page."});
  if(req.method!=="GET" && req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)return res.status(403).send("Origine non autorisée");
  res.set("Cache-Control","no-store");
  res.set("X-Frame-Options","DENY");
  next();
});
const html=[
"<!doctype html><html lang='fr'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>",
"<title>OMNIWORLD Sync</title><style>body{max-width:560px;margin:30px auto;padding:16px;font:16px system-ui;background:#101720;color:white}button{padding:12px;background:#e0ecff;border:0;border-radius:8px;cursor:pointer}textarea{width:100%;height:90px}img{display:block;max-width:100%;margin:15px auto}section{padding:20px;border:1px solid #526070;border-radius:15px}</style></head>",
"<body><section><h2>OMNIWORLD — Telegram vers Whop</h2><p>Le titulaire du compte doit autoriser l'accès sur son téléphone : <strong>Telegram → Paramètres → Appareils → Connecter un appareil</strong>.</p>",
"<button id='start'>Afficher le QR Telegram</button><p id='state'>État…</p><div id='qr'></div>",
"<div id='two' style='display:none'><p>Mot de passe Telegram en deux étapes :</p><input type='password' id='pwd'><button id='submit'>Valider</button></div>",
"<div id='saved' style='display:none'><p><strong>Session autorisée.</strong> Copie cette valeur dans Railway, variable <code>TELEGRAM_SESSION</code>. Ne la partage jamais en message.</p><textarea id='session' readonly></textarea><button id='copy'>Copier la session</button></div>",
"<p>Le QR peut mettre 10 à 30 secondes à apparaître. Si une erreur apparaît, envoie seulement son texte.</p><p>Après enregistrement dans Railway, je pourrai tester la synchronisation. Aucune publication automatique avant activation.</p></section>",
"<section><h3>Connexion Whop</h3><p>Autorise le compte propriétaire urfavceo75 pour publier dans OMNIWORLD.</p><button id='connectWhop'>Connecter Whop</button><p id='whopState' role='status'></p></section>",
"<section><h3>Nouveau canal OMNIWORLD</h3><p>Photos groupées, légende sous l’album et lecture réservée aux membres.</p><a href='/channel/preview' style='color:#aee9dc'>Ouvrir le nouveau canal</a></section>",
"<section><h3>Test Whop</h3><p>Ce bouton publie un message technique dans le Chat OMNIWORLD, puis vérifie sa lecture. Il ne lance pas la synchronisation Telegram.</p><button id='testWhop'>Tester Whop</button><p id='testResult' role='status'></p></section>",
"<script>const el=id=>document.getElementById(id);",
"async function refresh(){try{const d=await(await fetch('/api/status',{cache:'no-store'})).json();",
"el('whopState').textContent=d.whop.error||(d.whop.connected?'Compte Whop connecté':d.whop.configured?'Connexion Whop requise':'Configuration OAuth en attente');",
"el('state').textContent=(d.sync?.error||d.status)+(d.error?' — '+d.error:'')+(d.enabled?' — Synchronisation active':' — Synchronisation en attente');",
"el('qr').innerHTML=d.qr?'<img alt=\"QR Telegram\" src=\"'+d.qr+'\">':'';",
"el('two').style.display=d.twoFactor?'block':'none';",
"el('saved').style.display=d.session?'block':'none';el('session').value=d.session||'';",
"}catch(e){el('state').textContent='Connexion momentanément indisponible';}}",
"el('start').onclick=async()=>{const r=await fetch('/api/login',{method:'POST'});if(!r.ok)alert((await r.json()).error);refresh();};",
"el('submit').onclick=async()=>{const v=el('pwd').value;el('pwd').value='';await fetch('/api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:v})});refresh();};",
"el('copy').onclick=()=>{navigator.clipboard.writeText(el('session').value);el('copy').textContent='Copié';};",
"el('connectWhop').onclick=async()=>{el('connectWhop').disabled=true;try{const r=await fetch('/api/whop/connect',{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.error);location.assign(d.url);}catch(e){el('whopState').textContent=e.message;el('connectWhop').disabled=false;}};",
"el('testWhop').onclick=async()=>{el('testWhop').disabled=true;el('testResult').textContent='Test en cours…';try{const r=await fetch('/api/test',{method:'POST'});const d=await r.json();el('testResult').textContent=r.ok?'Test réussi : publication retrouvée dans Whop.':d.error||'Test échoué';}catch(e){el('testResult').textContent='Connexion interrompue. Vérifie le Chat avant de réessayer.';}finally{el('testWhop').disabled=false;}};",
"refresh();setInterval(refresh,3000);</script></body></html>"
].join("");
app.get("/",(_,res)=>res.redirect("/setup"));
app.get("/setup",(_,res)=>res.type("html").send(html));
app.get("/api/status",(_,res)=>res.json({status,error,qr:qrImage,twoFactor:Boolean(twoFactorResolve),session:sessionValue,enabled:ENABLED,groupFound:Boolean(group),processed,sync:syncEngine?.status(),whop:whopOAuth.status()}));
app.post("/api/whop/connect",async(_,res)=>{
  try{
    const flow=await whopOAuth.start();
    res.cookie("omni_whop_flow",flow.browser,{httpOnly:true,secure:true,sameSite:"lax",maxAge:600000,path:"/oauth/whop/callback"});
    res.json({url:flow.url});
  }catch(e){res.status(400).json({error:briefError(e)});}
});
app.post("/api/login",async(_,res)=>{try{await startLogin();res.json({ok:true});}catch(e){res.status(400).json({error:briefError(e)});}});
app.post("/api/password",(req,res)=>{
  if(!twoFactorResolve || typeof req.body.password!=="string")return res.status(400).json({error:"Aucun mot de passe demandé."});
  const resolve=twoFactorResolve;twoFactorResolve=null;resolve(req.body.password);res.json({ok:true});
});
let whopTestBusy=false;
app.post("/api/test",async(_,res)=>{
  if(whopTestBusy)return res.status(409).json({error:"Un test est déjà en cours."});
  whopTestBusy=true;
  const title="OMNIWORLD — Test API";
  const content="Test technique OMNIWORLD : texte, accents et lien https://telegram.org\nRéférence : omniworld-bridge-test-v1";
  try{
    await verifyChat();
    const existing=await whopRequest("messages?channel_id="+encodeURIComponent(WHOP_FORUM)+"&first=100","GET");
    if(!Array.isArray(existing.data))throw new Error("Réponse Whop inattendue : liste absente.");
    let post=existing.data.find(p=>p.content===content);
    if(!post)post=await postToWhop(content,title);
    if(!post.id)throw new Error("Whop n’a pas renvoyé un identifiant de publication.");
    const verified=await whopRequest("messages/"+encodeURIComponent(post.id),"GET");
    if(verified.content!==content)throw new Error("Publication créée, mais contenu non confirmé. Vérifier le Chat avant de réessayer.");
    console.info("[whop-test] verified",post.id,"chat",WHOP_FORUM);
    res.json({ok:true,postId:post.id});
  }catch(e){
    const message=briefError(e);
    console.error("[whop-test] failed",message);
    res.status(500).json({error:message});
  }finally{whopTestBusy=false;}
});
app.listen(Number(ENV.PORT||3000),"0.0.0.0",()=>console.log("OMNIWORLD bridge listening; sync enabled:",ENABLED));
restore();

