const GOOGLE_BASE = 'https://generativelanguage.googleapis.com';
const MAX_BYTES = 95 * 1024 * 1024;
const W = {retention:.24,shareability:.16,originality:.15,audience_relevance:.12,spoken_hook:.11,visual_hook:.08,clarity:.05,value_emotion:.04,title:.03,rhythm:.02,cta:0};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok:true,
        service:'Viral+ API',
        provider:'gemini-files',
        model:env.MODEL || 'gemini-3.8-flash',
        fallback_model:env.FALLBACK_MODEL || 'gemini-3.5-flash-lite',
        gemini_secret_configured:Boolean(env.GEMINI_API_KEY),
        supabase_configured:Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY)
      },200,cors);
    }

    if (url.pathname !== '/analyze' || request.method !== 'POST') return json({error:'Not found'},404,cors);
    if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return json({error:'Origin non autorisée.'},403,cors);
    if (!env.GEMINI_API_KEY) return json({error:'Le moteur d’analyse n’est pas configuré.'},500,cors);
    if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return json({error:'Le backend Viral+ n’est pas configuré.'},500,cors);

    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) return json({error:'Connecte-toi pour analyser une vidéo.',code:'AUTH_REQUIRED'},401,cors);

    let user;
    try { user = await supabaseUser(env, auth); }
    catch { return json({error:'Session expirée. Reconnecte-toi.',code:'AUTH_REQUIRED'},401,cors); }

    let body;
    try { body = await request.json(); } catch { return json({error:'Requête d’analyse invalide.'},400,cors); }

    const storageUrl = String(body?.storage_url || '');
    if (!storageUrl || !storageUrl.startsWith(env.SUPABASE_URL + '/storage/')) {
      return json({error:'URL de stockage vidéo invalide.'},400,cors);
    }
    if (!storageBelongsToUser(storageUrl, user.id)) {
      return json({error:'Cette vidéo n’appartient pas à ce compte.',code:'VIDEO_ACCESS_DENIED'},403,cors);
    }

    const mimeType = String(request.headers.get('X-Video-Mime-Type') || body?.mime_type || 'video/mp4').split(';')[0].trim();
    const size = Number(request.headers.get('X-File-Size') || body?.size || 0);
    const fileName = safeName(decodeURIComponentSafe(request.headers.get('X-File-Name') || body?.file_name || 'video.mp4'));
    const isReanalysis = request.headers.get('X-Reanalysis') === '1';
    const baselineId = safeUuid(request.headers.get('X-Baseline-Analysis-Id'));

    if (!mimeType.startsWith('video/')) return json({error:'Viral+ accepte uniquement les fichiers vidéo.'},400,cors);
    if (!Number.isFinite(size) || size <= 0) return json({error:'Taille de vidéo invalide.'},400,cors);
    if (size > MAX_BYTES) return json({error:'Vidéo trop lourde : 95 Mo maximum.'},413,cors);

    let credit;
    try {
      const entRaw = await rpc(env,auth,'viralplus_get_entitlement',{});
      const ent = Array.isArray(entRaw) ? entRaw[0] : entRaw;
      if (!ent) return json({error:'Impossible de vérifier ton offre Viral+.'},500,cors);
      if (isReanalysis && ent.plan !== 'creator') return json({error:'Le re-score avant/après est inclus dans Viral+ Creator.',code:'CREATOR_REQUIRED',plan:ent.plan},402,cors);
      const creditRaw = await rpc(env,auth,'viralplus_consume_credit',{});
      credit = Array.isArray(creditRaw) ? creditRaw[0] : creditRaw;
      if (!credit?.allowed) return json({error:'Tu as utilisé toutes tes analyses disponibles.',code:'QUOTA_EXHAUSTED',entitlement:credit||ent},402,cors);
    } catch (err) {
      console.error('Quota check failed', err);
      return json({error:'Impossible de vérifier ton quota Viral+. Réessaie dans quelques instants.'},500,cors);
    }

    let geminiFileName = null;
    try {
      const rules = await loadRulebook(env.RULEBOOK_URL);
      const stored = await fetch(storageUrl);
      if (!stored.ok || !stored.body) throw new Error('Impossible de récupérer la vidéo depuis le stockage.');

      const uploaded = await uploadToGemini(stored.body,{apiKey:String(env.GEMINI_API_KEY).trim(),size,mimeType,displayName:fileName});
      geminiFileName = uploaded.name;
      const activeFile = await waitForFile(uploaded.name,String(env.GEMINI_API_KEY).trim());
      const analysis = await generateAnalysisWithFallback({
        apiKey:String(env.GEMINI_API_KEY).trim(),
        primaryModel:env.MODEL || 'gemini-3.8-flash',
        fallbackModel:env.FALLBACK_MODEL || 'gemini-3.5-flash-lite',
        fileUri:activeFile.uri,
        mimeType:activeFile.mimeType || activeFile.mime_type || mimeType,
        prompt:buildPrompt(rules)
      });

      analysis.rulebook_version = analysis.rulebook_version || rules.version || 'unknown';
      analysis.model_used = analysis.model_used || env.MODEL || 'gemini-3.8-flash';

      const finalScore = scoreFinal(analysis.scores || {});
      const rulebookVersion = analysis.rulebook_version;
      const scoreVersion = `${rulebookVersion}|vp-score-1`;
      const status = finalScore >= 78 ? 'ready' : finalScore >= 60 ? 'almost' : 'rework';
      const filtered = filterForPlan(analysis,credit.plan || 'free');
      filtered.final_score = finalScore;
      filtered.score_version = scoreVersion;
      filtered.status = status;
      filtered.plan = credit.plan || 'free';
      filtered.entitlement = {
        plan:credit.plan,
        used:credit.used,
        limit:credit.analysis_limit,
        remaining:credit.remaining,
        period_start:credit.period_start
      };

      const hotspot = firstHotspot(filtered.timeline || []);
      const row = {
        user_id:user.id,
        video_name:fileName,
        final_score:finalScore,
        score_version:scoreVersion,
        model_used:analysis.model_used || null,
        rulebook_version:rulebookVersion,
        is_reanalysis:isReanalysis,
        baseline_analysis_id:baselineId,
        status,
        main_problem:filtered.main_problem || null,
        why:filtered.why || null,
        detected_spoken_hook:filtered.detected_spoken_hook || null,
        recommended_hook:filtered.recommended_hook || null,
        hotspot_time:hotspot.time || null,
        hotspot_reason:hotspot.reason || hotspot.label || null,
        scores:filtered.scores || {},
        action_items:filtered.action_items || [],
        result_json:filtered
      };
      const inserted = await restInsert(env,auth,'viralplus_analyses',row);
      const saved = Array.isArray(inserted) ? inserted[0] : inserted;
      filtered.analysis_id = saved?.id || null;
      filtered.baseline_analysis_id = baselineId;
      return json(filtered,200,cors);
    } catch (err) {
      console.error('Viral+ analysis error',err);
      await safeRefund(env,auth);
      return json({error:friendlyError(err)},Number(err?.status)||500,cors);
    } finally {
      if (geminiFileName) {
        try { await deleteGeminiFile(geminiFileName,String(env.GEMINI_API_KEY).trim()); } catch (e) { console.warn('Gemini cleanup failed',e); }
      }
    }
  }
};

function corsHeaders(origin,allowedOrigin) {
  const allowed = origin && allowedOrigin && origin === allowedOrigin ? origin : (allowedOrigin || '*');
  return {'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,X-File-Name,X-File-Size,X-Video-Mime-Type,X-Reanalysis,X-Baseline-Analysis-Id','Access-Control-Max-Age':'86400','Vary':'Origin'};
}
function json(data,status=200,extra={}) { return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}}); }
function safeName(value) { return String(value || 'video.mp4').replace(/[\r\n]/g,'').slice(0,120); }
function decodeURIComponentSafe(value) { try{return decodeURIComponent(value)}catch{return value} }
function safeUuid(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||'')) ? String(v) : null; }

function storageBelongsToUser(storageUrl,userId) {
  try {
    const u=new URL(storageUrl);
    const marker='/storage/v1/object/sign/viralplus-videos/';
    const i=u.pathname.indexOf(marker);
    if(i===-1) return false;
    const objectPath=decodeURIComponent(u.pathname.slice(i+marker.length));
    return objectPath.startsWith(String(userId)+'/');
  } catch { return false; }
}
async function supabaseUser(env,auth) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth}});
  if (!r.ok) throw new Error('AUTH_REQUIRED');
  return await r.json();
}
async function rpc(env,auth,fn,body={}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`,{method:'POST',headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (!r.ok) throw new Error(`RPC ${fn} ${r.status}: ${await r.text()}`);
  return await r.json();
}
async function restInsert(env,auth,table,row) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`,{method:'POST',headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:auth,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify(row)});
  if (!r.ok) throw new Error(`Insert ${table} ${r.status}: ${await r.text()}`);
  return await r.json();
}
async function safeRefund(env,auth) { try { await rpc(env,auth,'viralplus_refund_credit',{}); } catch(e) { console.warn('refund failed',e); } }

async function loadRulebook(url) {
  if (!url) return fallbackRules();
  try {
    const res = await fetch(url,{headers:{Accept:'application/json'},cf:{cacheTtl:300,cacheEverything:true}});
    if (!res.ok) throw new Error(`Rulebook ${res.status}`);
    return await res.json();
  } catch { return fallbackRules(); }
}
function fallbackRules() {
  return {version:'fallback',methodology:'Distinguer les informations officiellement documentées par Meta des heuristiques Viral+. Ne jamais prétendre connaître les poids privés de classement.',principles:[]};
}

async function uploadToGemini(body,{apiKey,size,mimeType,displayName}) {
  const start = await fetch(`${GOOGLE_BASE}/upload/v1beta/files`,{
    method:'POST',
    headers:{'x-goog-api-key':apiKey,'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(size),'X-Goog-Upload-Header-Content-Type':mimeType,'Content-Type':'application/json'},
    body:JSON.stringify({file:{display_name:displayName}})
  });
  if (!start.ok) throw await googleError(start,'Impossible de préparer l’upload Gemini.');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini n’a pas renvoyé d’URL d’upload.');
  const uploadedRes = await fetch(uploadUrl,{method:'POST',headers:{'Content-Type':mimeType,'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize'},body});
  if (!uploadedRes.ok) throw await googleError(uploadedRes,'Échec de l’upload vidéo vers Gemini.');
  const uploaded = await uploadedRes.json();
  if (!uploaded?.file?.name || !uploaded?.file?.uri) throw new Error('Réponse d’upload Gemini incomplète.');
  return uploaded.file;
}
async function waitForFile(name,apiKey) {
  for(let i=0;i<36;i++){
    const res=await fetch(`${GOOGLE_BASE}/v1beta/${name}`,{headers:{'x-goog-api-key':apiKey}});
    if(!res.ok) throw await googleError(res,'Impossible de vérifier la vidéo Gemini.');
    const file=await res.json();
    const state=String(file.state||'').toUpperCase();
    if(state==='ACTIVE') return file;
    if(state==='FAILED') throw new Error('Gemini n’a pas réussi à traiter cette vidéo.');
    await sleep(2500);
  }
  throw new Error('Le traitement vidéo Gemini a dépassé le délai prévu. Réessaie avec une vidéo plus courte.');
}
async function generateAnalysisWithFallback({apiKey,primaryModel,fallbackModel,fileUri,mimeType,prompt}) {
  const models=[...new Set([primaryModel,fallbackModel].filter(Boolean))];
  let lastError=null;
  for(const model of models){
    for(let attempt=0;attempt<2;attempt++){
      try{
        const analysis=await generateAnalysis({apiKey,model,fileUri,mimeType,prompt});
        analysis.model_used=model;
        return analysis;
      }catch(err){
        lastError=err;
        if(!isTransientModelError(err)) throw err;
        if(attempt===0) await sleep(1500);
      }
    }
  }
  throw lastError || new Error('Tous les modèles Gemini sont temporairement indisponibles.');
}
async function generateAnalysis({apiKey,model,fileUri,mimeType,prompt}) {
  const res=await fetch(`${GOOGLE_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
    method:'POST',headers:{'x-goog-api-key':apiKey,'Content-Type':'application/json'},
    body:JSON.stringify({contents:[{role:'user',parts:[{file_data:{mime_type:mimeType,file_uri:fileUri}},{text:prompt}]}],generationConfig:{temperature:0.2,responseMimeType:'application/json'}})
  });
  if(!res.ok) throw await googleError(res,'Gemini n’a pas pu analyser la vidéo.');
  const payload=await res.json();
  const text=(payload?.candidates||[]).flatMap(c=>c?.content?.parts||[]).map(p=>p?.text||'').join('').trim();
  if(!text) throw new Error('Gemini n’a renvoyé aucun diagnostic exploitable.');
  return parseJsonText(text);
}
function isTransientModelError(err){const msg=String(err?.message||err||'');return [408,429,500,502,503,504].includes(Number(err?.status))||/high demand|temporar|overload|unavailable|resource exhausted|try again later/i.test(msg);}
function buildPrompt(rules) {
  const principles=(rules?.principles||[]).map(p=>`- ${p.id||'signal'}: ${p.rule||''} | preuve: ${p.evidence||''}`).join('\\n');
  return `Tu es le moteur d’analyse de Viral+. Analyse CETTE VIDÉO RÉELLE destinée à Instagram Reels. Tu n’as pas accès à l’algorithme privé de Meta. Ne prétends jamais connaître ses poids secrets et ne promets jamais qu’une vidéo sera virale. Évalue uniquement son potentiel de recommandation/distribution à partir de la vidéo et du référentiel fourni.\\n\\nRÉFÉRENTIEL VIRAL+ / META ${rules?.version||'unknown'}\\n${rules?.methodology||''}\\n${principles}\\n\\nDistingue toujours : (A) éléments cohérents avec des informations officielles Meta/Instagram, (B) heuristiques créatives Viral+. Analyse réellement ce qui est visible ET audible. Si un élément n’est pas détectable, écris INDETECTABLE au lieu de l’inventer.\\n\\nAttribue des scores de 0 à 100 pour : retention, shareability, originality, audience_relevance, spoken_hook, visual_hook, clarity, value_emotion, title, rhythm et cta. Le CTA mesure la conversion et ne doit pas être présenté comme un signal Meta de distribution.\\n\\nRéponds UNIQUEMENT en JSON valide avec exactement cette structure :\\n{"detected_spoken_hook":"...","detected_visual_hook":"...","detected_title_text":"...","detected_cta":"...","scores":{"retention":0,"shareability":0,"originality":0,"audience_relevance":0,"spoken_hook":0,"visual_hook":0,"clarity":0,"value_emotion":0,"title":0,"rhythm":0,"cta":0},"verdict":"...","main_problem":"...","why":"...","meta_alignment":"...","recommended_hook":"...","alternative_hooks":["...","...","..."],"recommended_title":"...","recommended_cta":"...","timeline":[{"time":"0:00","status":"red","label":"Ouverture","reason":"..."}],"action_items":["..."],"confidence":{"audio":0,"visual":0,"text":0,"meta_evidence":0},"rulebook_version":"${rules?.version||'unknown'}"} `;
}
function parseJsonText(text){let cleaned=text.trim().replace(/^\`\`\`(?:json)?\\s*/i,'').replace(/\\s*\`\`\`$/i,'');const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');if(start>=0&&end>start)cleaned=cleaned.slice(start,end+1);return JSON.parse(cleaned);}
async function deleteGeminiFile(name,apiKey){await fetch(`${GOOGLE_BASE}/v1beta/${name}`,{method:'DELETE',headers:{'x-goog-api-key':apiKey}});}
async function googleError(response,fallback){let detail='',reason='';try{const body=await response.json();detail=body?.error?.message||body?.message||'';reason=body?.error?.status||body?.error?.details?.[0]?.reason||'';}catch{}const err=new Error(detail?`${fallback} ${detail}`:fallback);err.status=response.status>=400&&response.status<600?response.status:500;err.googleReason=reason;return err;}
function friendlyError(err){const msg=String(err?.message||err||'Erreur inconnue');if(/high demand|temporar|overload|unavailable|try again later/i.test(msg))return'Les modèles Gemini sont momentanément saturés. Viral+ a déjà essayé le modèle de secours ; réessaie dans quelques minutes.';if(/quota|resource exhausted|429/i.test(msg))return'Quota Gemini temporairement atteint. Réessaie dans quelques minutes.';if(/reported as leaked|leaked/i.test(msg))return'La clé Gemini a été bloquée par Google car elle est considérée comme exposée. Crée une nouvelle clé Auth dans Google AI Studio puis remplace GEMINI_API_KEY dans Cloudflare.';if(/project has been denied access|denied access/i.test(msg))return'Google refuse actuellement l’accès Gemini à ce projet. Crée ou sélectionne un autre projet dans Google AI Studio puis génère une nouvelle clé Auth.';if(/api key not valid|invalid api key|API_KEY_INVALID|access_token_type_unsupported/i.test(msg))return'La clé Gemini est invalide, incomplète ou obsolète. Crée une nouvelle clé Auth dans Google AI Studio et remplace GEMINI_API_KEY dans Cloudflare.';if(/api key|permission|unauth|401|403/i.test(msg))return'Gemini refuse la clé du backend. Vérifie la clé Auth Gemini dans Cloudflare.';return msg;}
function scoreFinal(scores){let total=0,sum=0;for(const[k,w]of Object.entries(W)){total+=w;sum+=(Number(scores?.[k])||0)*w}return Math.round(Math.max(0,Math.min(100,total?sum/total:0)));}
function firstHotspot(timeline){return timeline.find(x=>/red|orange|weak|bad/i.test(String(x?.status||'')))||timeline[0]||{};}
function filterForPlan(analysis,plan){const c=JSON.parse(JSON.stringify(analysis||{}));if(plan==='creator'){c.locked=[];return c}c.action_items=(c.action_items||[]).slice(0,2);c.alternative_hooks=[];delete c.recommended_title;delete c.recommended_cta;c.locked=['full_corrections','alternative_hooks','recommended_title','recommended_cta','rescore','history_insights'];return c;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
