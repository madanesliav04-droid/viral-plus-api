const GOOGLE_BASE = 'https://generativelanguage.googleapis.com';
const MAX_BYTES = 95 * 1024 * 1024;

// These are Viral+ diagnostic weights, NOT Meta's private ranking weights.
// They are intentionally concentrated on attention/relevance/originality and
// exclude CTA from the distribution score.
const W = {
  retention: .27,
  audience_relevance: .18,
  originality: .17,
  shareability: .14,
  spoken_hook: .09,
  visual_hook: .06,
  clarity: .05,
  value_emotion: .04,
  rhythm: 0
};

const SCORE_VERSION = 'vp-score-2-strict';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const productionOrigin = 'https://madanesliav04-droid.github.io';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN, productionOrigin);

    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok:true,
        service:'Viral+ API',
        provider:'gemini-files',
        model:env.MODEL || 'gemini-3.8-flash',
        fallback_model:env.FALLBACK_MODEL || 'gemini-3.5-flash-lite',
        score_version:SCORE_VERSION,
        gemini_secret_configured:Boolean(env.GEMINI_API_KEY),
        supabase_configured:Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY)
      },200,cors);
    }

    if (url.pathname !== '/analyze' || request.method !== 'POST') return json({error:'Not found'},404,cors);
    if (origin && !isAllowedOrigin(origin, env.ALLOWED_ORIGIN, productionOrigin)) return json({error:'Origin non autorisée.'},403,cors);
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

      const scoreResult = scoreFinal(analysis);
      const rulebookVersion = analysis.rulebook_version;
      const scoreVersion = `${rulebookVersion}|${SCORE_VERSION}`;
      const status = scoreResult.final_score >= 78 ? 'ready' : scoreResult.final_score >= 60 ? 'almost' : 'rework';
      const filtered = filterForPlan(analysis,credit.plan || 'free');

      filtered.final_score = scoreResult.final_score;
      filtered.raw_score = scoreResult.raw_score;
      filtered.score_version = scoreVersion;
      filtered.status = status;
      filtered.score_explanation = scoreResult.explanation;
      filtered.score_guardrails = scoreResult.guardrails;
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
        final_score:scoreResult.final_score,
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

function isAllowedOrigin(origin,allowedOrigin,productionOrigin) {
  if (!origin) return true;
  return [allowedOrigin,productionOrigin].filter(Boolean).includes(origin);
}
function corsHeaders(origin,allowedOrigin,productionOrigin) {
  const allowed = isAllowedOrigin(origin,allowedOrigin,productionOrigin) ? (origin || allowedOrigin || productionOrigin || '*') : (allowedOrigin || productionOrigin || '*');
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
    body:JSON.stringify({contents:[{role:'user',parts:[{file_data:{mime_type:mimeType,file_uri:fileUri}},{text:prompt}]}],generationConfig:{temperature:0,responseMimeType:'application/json'}})
  });
  if(!res.ok) throw await googleError(res,'Gemini n’a pas pu analyser la vidéo.');
  const payload=await res.json();
  const text=(payload?.candidates||[]).flatMap(c=>c?.content?.parts||[]).map(p=>p?.text||'').join('').trim();
  if(!text) throw new Error('Gemini n’a renvoyé aucun diagnostic exploitable.');
  return parseJsonText(text);
}
function isTransientModelError(err){const msg=String(err?.message||err||'');return [408,429,500,502,503,504].includes(Number(err?.status))||/high demand|temporar|overload|unavailable|resource exhausted|try again later/i.test(msg);}

function buildPrompt(rules) {
  const principles=(rules?.principles||[]).map(p=>`- ${p.id||'signal'} [${p.status||'unknown'}]: ${p.rule||''} | preuve: ${p.evidence||''}`).join('\\n');
  return `Tu es le moteur d’analyse de Viral+. Tu analyses une vidéo Instagram Reels à partir de ce qui est réellement visible et audible.

RÈGLE ABSOLUE D’HONNÊTETÉ
- Tu n’as PAS accès à l’algorithme privé de Meta.
- Tu ne connais PAS les poids privés de classement.
- Tu ne dois jamais écrire ou suggérer "selon l’algorithme Instagram" comme si tu connaissais sa formule.
- Une vidéo seule ne permet PAS de connaître sa vraie rétention, son watch time, ses envois, ses likes, ni sa performance réelle. Ces métriques doivent être traitées comme NON OBSERVÉES.
- Quand une information n’est pas détectable dans la vidéo, écris INDETECTABLE. Ne l’invente jamais.

OBJECTIF
Produis un diagnostic sévère du potentiel de recommandation, pas une note de "qualité générale". Une vidéo propre, utile ou bien montée peut rester faible si elle ne donne pas une raison forte de continuer à regarder.

RÉFÉRENTIEL ${rules?.version||'unknown'}
${rules?.methodology||''}
${principles}

DISTINCTION OBLIGATOIRE
1. META/OFFICIAL: seulement les éléments explicitement documentés par Meta.
2. VIRAL+/HEURISTIC: inférences créatives destinées à diagnostiquer le contenu.
Ne transforme jamais une heuristique en "facteur officiel Meta".

NOTATION STRICTE
Pour chaque score, utilise 0-100 avec ces ancres:
0-19 = absent / catastrophique
20-39 = très faible
40-59 = faible
60-69 = moyen
70-79 = bon mais avec défauts
80-89 = très fort et clairement démontré
90-100 = exceptionnel, rare, plusieurs preuves convergentes

IMPORTANT: 80+ n’est autorisé que si tu peux citer une preuve concrète observable dans la vidéo. Si la preuve est faible, reste sous 80. Ne donne jamais un score élevé "par défaut".

CRITÈRES
- retention: potentiel de maintien de l’attention à partir de la structure, du rythme et de la progression. C’est une HEURISTIQUE, pas la vraie watch time.
- audience_relevance: clarté du public visé et force de la promesse pour ce public. HEURISTIQUE.
- originality: originalité observable et absence de simple recyclage. META-ALIGNED; ne prétends pas détecter toute réutilisation externe.
- shareability: raison concrète pour laquelle quelqu’un enverrait la vidéo à une autre personne. HEURISTIQUE.
- spoken_hook: force de l’ouverture parlée si elle existe. HEURISTIQUE.
- visual_hook: force de l’ouverture visuelle. HEURISTIQUE.
- clarity: compréhension immédiate du sujet et de la promesse. HEURISTIQUE.
- value_emotion: intérêt/valeur/émotion réellement délivré. HEURISTIQUE.
- rhythm: diagnostic éditorial secondaire; NE PÈSE PAS dans le score final.
- cta: conversion uniquement; NE PÈSE PAS dans le score de recommandation.

RÈGLE DE SÉVÉRITÉ
Si la vidéo est correcte mais remplaçable, générique, lente, prévisible ou peu spécifique, note-la basse.
Ne récompense pas la qualité de production à la place de l’intérêt.
Ne récompense pas la présence d’un CTA.
Ne récompense pas le simple fait que le sujet soit intéressant.
Un hook clair mais banal n’est pas un hook fort.
Une vidéo qui explique bien mais ne crée pas de tension/curiosité peut rester moyenne.
Une vidéo sans données de compte ne peut jamais être décrite comme ayant une rétention "prouvée".

RÉPONSE JSON
Réponds UNIQUEMENT en JSON valide avec exactement:
{
  "detected_spoken_hook":"...",
  "detected_visual_hook":"...",
  "detected_title_text":"...",
  "detected_cta":"...",
  "scores":{
    "retention":0,"shareability":0,"originality":0,"audience_relevance":0,
    "spoken_hook":0,"visual_hook":0,"clarity":0,"value_emotion":0,
    "title":0,"rhythm":0,"cta":0
  },
  "score_evidence":{
    "retention":"preuve observable...",
    "shareability":"preuve observable...",
    "originality":"preuve observable...",
    "audience_relevance":"preuve observable...",
    "spoken_hook":"preuve observable...",
    "visual_hook":"preuve observable...",
    "clarity":"preuve observable...",
    "value_emotion":"preuve observable..."
  },
  "verdict":"...",
  "main_problem":"...",
  "why":"...",
  "meta_alignment":"...",
  "recommended_hook":"...",
  "alternative_hooks":["...","...","..."],
  "recommended_title":"...",
  "recommended_cta":"...",
  "timeline":[{"time":"0:00","status":"red","label":"Ouverture","reason":"..."}],
  "action_items":["..."],
  "confidence":{"audio":0,"visual":0,"text":0,"meta_evidence":0},
  "rulebook_version":"${rules?.version||'unknown'}"
}

Ne mets pas de scores arbitraires pour remplir les champs. Si tu ne peux pas justifier un score, baisse-le et explique pourquoi.`;
}

function parseJsonText(text){let cleaned=text.trim().replace(/^\`\`\`(?:json)?\\s*/i,'').replace(/\\s*\`\`\`$/i,'');const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');if(start>=0&&end>start)cleaned=cleaned.slice(start,end+1);return JSON.parse(cleaned);}

function scoreFinal(analysis){
  const scores=analysis?.scores||{};
  let raw=0,sum=0;
  for(const [k,w] of Object.entries(W)){
    sum+=w;
    raw+=(clampScore(scores[k]))*w;
  }
  raw = Math.round(raw / sum);

  const evidence=analysis?.score_evidence||{};
  const guardrails=[];
  let penalty=0;

  for(const k of Object.keys(W)){
    if (!W[k]) continue;
    const n=clampScore(scores[k]);
    const ev=String(evidence[k]||'').trim();
    if (!ev || /^INDETECTABLE$/i.test(ev)) {
      penalty += W[k] * 6;
      guardrails.push(`${k}: evidence absente`);
    }
    if (n >= 80 && (!ev || ev.length < 25)) {
      penalty += 2;
      guardrails.push(`${k}: score 80+ sans preuve suffisamment détaillée`);
    }
  }

  // A video-only analysis cannot prove real performance metrics.
  // Keep the score explicitly in the "potential" category and prevent
  // unsupported exceptional scores from reaching the UI.
  if (raw >= 85) {
    const strongEvidenceCount = Object.values(evidence).filter(v => String(v||'').trim().length >= 40).length;
    if (strongEvidenceCount < 5) {
      raw = 79;
      guardrails.push('plafond: potentiel exceptionnel non suffisamment démontré par la vidéo seule');
    }
  }

  const finalScore=Math.round(Math.max(0,Math.min(100,raw-penalty)));
  return {
    raw_score:raw,
    final_score:finalScore,
    explanation:`Score calculé par le moteur déterministe ${SCORE_VERSION}. Les poids sont propres à Viral+ et ne sont pas les poids privés de Meta. Les pénalités sanctionnent les scores non étayés.`,
    guardrails
  };
}
function clampScore(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):0;}
function firstHotspot(timeline){return timeline.find(x=>/red|orange|weak|bad/i.test(String(x?.status||'')))||timeline[0]||{};}
function filterForPlan(analysis,plan){const c=JSON.parse(JSON.stringify(analysis||{}));if(plan==='creator'){c.locked=[];return c}c.action_items=(c.action_items||[]).slice(0,2);c.alternative_hooks=[];delete c.recommended_title;delete c.recommended_cta;c.locked=['full_corrections','alternative_hooks','recommended_title','recommended_cta','rescore','history_insights'];return c;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
