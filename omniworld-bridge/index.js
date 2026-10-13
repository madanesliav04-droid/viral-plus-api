"use strict";
const express = require("express");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const QRCode = require("qrcode");
const crypto = require("node:crypto");
const ENV = process.env;
const API_ID = Number(ENV.TELEGRAM_API_ID || 0);
const API_HASH = ENV.TELEGRAM_API_HASH || "";
const TG_CHAT = ENV.TELEGRAM_CHAT_ID || "";
const WHOP_KEY = ENV.WHOP_API_KEY || "";
const WHOP_FORUM = ENV.WHOP_FORUM_ID || "";
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
async function whopRequest(path, method, payload) {
  const r = await fetch("https://api.whop.com/api/v1/" + path, {
    method, headers: {"Authorization":"Bearer " + WHOP_KEY,"Content-Type":"application/json"},
    body:payload ? JSON.stringify(payload) : undefined, signal:AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error("API Whop " + r.status + " : " + (await r.text()).slice(0,150));
  return r.json();
}
async function postToWhop(text,title) {
  return whopRequest("forum_posts","POST",{
    experience_id:WHOP_FORUM, account_id:WHOP_ACCOUNT, content:text,
    title:title.slice(0,100), pinned:false, is_mention:false
  });
}
async function whopLastId() {
  const r=await whopRequest("forum_posts?experience_id="+encodeURIComponent(WHOP_FORUM)+"&first=100","GET");
  const list = Array.isArray(r.data) ? r.data : [];
  let latest=INITIAL_ID;
  for(const item of list){
    const s=String(item.content||"");
    const matches=[...s.matchAll(/https:\/\/t\.me\/c\/\d+\/(\d+)/g)];
    for (const match of matches) latest=Math.max(latest,Number(match[1]));
  }
  return latest;
}
async function publish(m){
  const id=Number(m && m.id || 0);
  if(!ENABLED || !id || id<=lastPosted) return;
  let text=String(m.message||m.text||"").trim();
  if(!text) text=m.media?"[Média publié sur Telegram — voir le message original]":"[Publication Telegram]";
  const title="OMNI WORLD — "+text.replace(/\s+/g," ").slice(0,82);
  await postToWhop(text.slice(0,12000)+"\n\n---\nSource Telegram : "+tgSource(id),title);
  lastPosted=id;
  processed++;
}
function enqueue(m){
  queue=queue.catch(()=>{}).then(()=>publish(m)).catch(e=>{error=briefError(e);console.error("Sync error: ",error);});
}
async function attach(c){
  client=c;
  status="connected";
  qrImage="";
  error="";
  const dialogs=await c.getDialogs({limit:500});
  const match=dialogs.find(d=>String(d.id)===TG_CHAT || String(d.entity && d.entity.id)===TG_CHAT.replace(/^-100/,""));
  if(!match){status="group_not_found";error="Le compte connecté ne voit pas le groupe Telegram cible.";return;}
  group=match.entity;
  if(ENABLED){
    lastPosted=await whopLastId();
    const messages=await c.getMessages(group,{limit:100});
    for(const m of [...messages].sort((a,b)=>Number(a.id)-Number(b.id))) enqueue(m);
  }
  c.addEventHandler(e=>{if(String(e.chatId)===TG_CHAT)enqueue(e.message);},new NewMessage({}));
  status="connected_listening";
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
  loginBusy=true;qrImage="";sessionValue="";status="generating_qr";error="";
  (async()=>{
    const c=new TelegramClient(new StringSession(""),API_ID,API_HASH,{connectionRetries:5});
    try{
      await c.connect();
      await c.signInUserWithQrCode({apiId:API_ID,apiHash:API_HASH},{
        qrCode:async obj=>{
          qrImage=await QRCode.toDataURL("tg://login?token="+obj.token.toString("base64url"),{margin:2,width:270});
          status="waiting_for_scan";
        },
        password:async()=>{
          status="two_factor_required";
          return new Promise(resolve=>{twoFactorResolve=resolve;});
        },
        onError:async e=>{error=briefError(e);return true;}
      });
      sessionValue=String(c.session.save());
      status="authorized_copy_session";
      // Ne pas publier maintenant ; la session doit être enregistrée dans Railway.
      try{await c.disconnect();}catch{}
    }catch(e){status="login_error";error=briefError(e);try{await c.disconnect();}catch{}}
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
"<body><section><h2>OMNIWORLD — Telegram vers Whop</h2><p>Ton frère doit autoriser l'accès sur son téléphone : <strong>Telegram → Paramètres → Appareils → Connecter un appareil</strong>.</p>",
"<button id='start'>Afficher le QR Telegram</button><p id='state'>État…</p><div id='qr'></div>",
"<div id='two' style='display:none'><p>Mot de passe Telegram en deux étapes :</p><input type='password' id='pwd'><button id='submit'>Valider</button></div>",
"<div id='saved' style='display:none'><p><strong>Session autorisée.</strong> Copie cette valeur dans Railway, variable <code>TELEGRAM_SESSION</code>. Ne la partage jamais en message.</p><textarea id='session' readonly></textarea><button id='copy'>Copier la session</button></div>",
"<p>Après enregistrement dans Railway, je pourrai tester la synchronisation. Aucune publication automatique avant activation.</p></section>",
"<script>const el=id=>document.getElementById(id);",
"async function refresh(){try{const d=await(await fetch('/api/status',{cache:'no-store'})).json();",
"el('state').textContent=d.status+(d.error?' — '+d.error:'')+(d.enabled?' — Synchronisation active':' — Synchronisation en attente');",
"el('qr').innerHTML=d.qr?'<img alt=\"QR Telegram\" src=\"'+d.qr+'\">':'';",
"el('two').style.display=d.twoFactor?'block':'none';",
"el('saved').style.display=d.session?'block':'none';el('session').value=d.session||'';",
"}catch(e){el('state').textContent='Connexion momentanément indisponible';}}",
"el('start').onclick=async()=>{const r=await fetch('/api/login',{method:'POST'});if(!r.ok)alert((await r.json()).error);refresh();};",
"el('submit').onclick=async()=>{const v=el('pwd').value;el('pwd').value='';await fetch('/api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:v})});refresh();};",
"el('copy').onclick=()=>{navigator.clipboard.writeText(el('session').value);el('copy').textContent='Copié';};",
"refresh();setInterval(refresh,3000);</script></body></html>"
].join("");
app.get("/",(_,res)=>res.redirect("/setup"));
app.get("/setup",(_,res)=>res.type("html").send(html));
app.get("/api/status",(_,res)=>res.json({status,error,qr:qrImage,twoFactor:Boolean(twoFactorResolve),session:sessionValue,enabled:ENABLED,groupFound:Boolean(group),processed}));
app.post("/api/login",async(_,res)=>{try{await startLogin();res.json({ok:true});}catch(e){res.status(400).json({error:briefError(e)});}});
app.post("/api/password",(req,res)=>{
  if(!twoFactorResolve || typeof req.body.password!=="string")return res.status(400).json({error:"Aucun mot de passe demandé."});
  const resolve=twoFactorResolve;twoFactorResolve=null;resolve(req.body.password);res.json({ok:true});
});
app.post("/api/test",async(_,res)=>{
  try{await postToWhop("Test technique — accès à OMNIWORLD confirmé.","OMNIWORLD — Test API");res.json({ok:true});}
  catch(e){res.status(500).json({error:briefError(e)});}
});
app.listen(Number(ENV.PORT||3000),"0.0.0.0",()=>console.log("OMNIWORLD bridge listening; sync enabled:",ENABLED));
restore();
