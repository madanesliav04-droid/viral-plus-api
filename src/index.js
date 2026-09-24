const GOOGLE_BASE = 'https://generativelanguage.googleapis.com';
const MAX_BYTES = 95 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      const health = { ok: true, service: 'Viral+ API', model: env.MODEL || 'gemini-3.8-flash' };
      if (url.searchParams.get('deep') !== '1') return json(health, 200, cors);
      if (!env.GEMINI_API_KEY) {
        return json({ ...health, ok: false, gemini_auth_ok: false, reason: 'missing_key' }, 503, cors);
      }
      try {
        // Verify authentication without generating content or exposing credentials.
        const response = await fetch(`${GOOGLE_BASE}/v1beta/models?pageSize=1`, {
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          return json({ ...health, ok: false, gemini_auth_ok: false, gemini_status: response.status }, 503, cors);
        }
        const payload = await response.json();
        const valid = Array.isArray(payload.models) && payload.models.length > 0;
        return json({ ...health, ok: valid, gemini_auth_ok: valid }, valid ? 200 : 503, cors);
      } catch {
        return json({ ...health, ok: false, gemini_auth_ok: false, reason: 'verification_unavailable' }, 503, cors);
      }
    }

    if (url.pathname !== '/analyze' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404, cors);
    }

    if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Origin non autorisée.' }, 403, cors);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: 'Le secret GEMINI_API_KEY n’est pas configuré sur Cloudflare.' }, 500, cors);
    }

    const mimeType = (request.headers.get('content-type') || '').split(';')[0].trim();
    const rawSize = request.headers.get('x-file-size') || request.headers.get('content-length') || '0';
    const size = Number(rawSize);
    const encodedName = request.headers.get('x-file-name') || 'video.mp4';
    const displayName = safeName(decodeURIComponentSafe(encodedName));

    if (!mimeType.startsWith('video/')) {
      return json({ error: 'Viral+ accepte uniquement les fichiers vidéo.' }, 400, cors);
    }
    if (!Number.isFinite(size) || size <= 0) {
      return json({ error: 'Taille de vidéo invalide.' }, 400, cors);
    }
    if (size > MAX_BYTES) {
      return json({ error: `Vidéo trop lourde : ${(size / 1048576).toFixed(1)} Mo. Maximum Viral+ : 95 Mo.` }, 413, cors);
    }

    let geminiFileName = null;
    try {
      const rules = await loadRulebook(env.RULEBOOK_URL);
      const uploaded = await uploadToGemini(request.body, {
        apiKey: env.GEMINI_API_KEY,
        size,
        mimeType,
        displayName,
      });

      geminiFileName = uploaded.name;
      const activeFile = await waitForFile(uploaded.name, env.GEMINI_API_KEY);
      const prompt = buildPrompt(rules);
      const analysis = await generateAnalysis({
        apiKey: env.GEMINI_API_KEY,
        model: env.MODEL || 'gemini-3.8-flash',
        fileUri: activeFile.uri,
        mimeType: activeFile.mimeType || activeFile.mime_type || mimeType,
        prompt,
      });

      analysis.rulebook_version = analysis.rulebook_version || rules.version || 'unknown';
      return json(analysis, 200, cors);
    } catch (err) {
      console.error('Viral+ analysis error', err);
      return json({ error: friendlyError(err) }, err?.status || 500, cors);
    } finally {
      if (geminiFileName) {
        try { await deleteGeminiFile(geminiFileName, env.GEMINI_API_KEY); } catch (e) { console.warn('Gemini cleanup failed', e); }
      }
    }
  }
};

function corsHeaders(origin, allowedOrigin) {
  const allowed = origin && allowedOrigin && origin === allowedOrigin ? origin : (allowedOrigin || '*');
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-File-Name,X-File-Size',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function safeName(value) {
  return String(value || 'video.mp4').replace(/[\r\n]/g, '').slice(0, 120);
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function loadRulebook(url) {
  if (!url) return fallbackRules();
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(`Rulebook ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('Rulebook fallback', e);
    return fallbackRules();
  }
}

function fallbackRules() {
  return {
    version: 'fallback',
    methodology: 'Distinguer les informations officiellement documentées par Meta des heuristiques Viral+. Ne jamais prétendre connaître les poids privés de classement.',
    principles: [],
  };
}

async function uploadToGemini(body, { apiKey, size, mimeType, displayName }) {
  const start = await fetch(`${GOOGLE_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) throw await googleError(start, 'Impossible de préparer l’upload Gemini.');

  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini n’a pas renvoyé d’URL d’upload.');

  const uploadedRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body,
  });
  if (!uploadedRes.ok) throw await googleError(uploadedRes, 'Échec de l’upload vidéo vers Gemini.');

  const uploaded = await uploadedRes.json();
  if (!uploaded?.file?.name || !uploaded?.file?.uri) throw new Error('Réponse d’upload Gemini incomplète.');
  return uploaded.file;
}

async function waitForFile(name, apiKey) {
  for (let i = 0; i < 36; i++) {
    const res = await fetch(`${GOOGLE_BASE}/v1beta/${name}`, { headers: { 'x-goog-api-key': apiKey } });
    if (!res.ok) throw await googleError(res, 'Impossible de vérifier la vidéo Gemini.');
    const file = await res.json();
    const state = String(file.state || '').toUpperCase();
    if (state === 'ACTIVE') return file;
    if (state === 'FAILED') throw new Error('Gemini n’a pas réussi à traiter cette vidéo.');
    await sleep(2500);
  }
  throw new Error('Le traitement vidéo Gemini a dépassé le délai prévu. Réessaie avec une vidéo plus courte.');
}

async function generateAnalysis({ apiKey, model, fileUri, mimeType, prompt }) {
  const res = await fetch(`${GOOGLE_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { file_data: { mime_type: mimeType, file_uri: fileUri } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) throw await googleError(res, 'Gemini n’a pas pu analyser la vidéo.');
  const payload = await res.json();
  const text = (payload?.candidates || []).flatMap(c => c?.content?.parts || []).map(p => p?.text || '').join('').trim();
  if (!text) throw new Error('Gemini n’a renvoyé aucun diagnostic exploitable.');
  return parseJsonText(text);
}

function buildPrompt(rules) {
  const principles = (rules?.principles || []).map(p => `- ${p.id || 'signal'}: ${p.rule || ''} | preuve: ${p.evidence || ''}`).join('\n');
  return `Tu es le moteur d’analyse de Viral+. Analyse CETTE VIDÉO RÉELLE destinée à Instagram Reels. Tu n’as pas accès à l’algorithme privé de Meta. Ne prétends jamais connaître ses poids secrets et ne promets jamais qu’une vidéo sera virale. Évalue uniquement son potentiel de recommandation/distribution à partir de la vidéo et du référentiel fourni.\n\nRÉFÉRENTIEL VIRAL+ / META ${rules?.version || 'unknown'}\n${rules?.methodology || ''}\n${principles}\n\nDistingue toujours : (A) éléments cohérents avec des informations officielles Meta/Instagram, (B) heuristiques créatives Viral+. Analyse réellement ce qui est visible ET audible. Si un élément n’est pas détectable, écris INDETECTABLE au lieu de l’inventer.\n\nAttribue des scores de 0 à 100 pour : retention, shareability, originality, audience_relevance, spoken_hook, visual_hook, clarity, value_emotion, title, rhythm et cta. Le CTA mesure la conversion et ne doit pas être présenté comme un signal Meta de distribution.\n\nRéponds UNIQUEMENT en JSON valide avec exactement cette structure :\n{"detected_spoken_hook":"...","detected_visual_hook":"...","detected_title_text":"...","detected_cta":"...","scores":{"retention":0,"shareability":0,"originality":0,"audience_relevance":0,"spoken_hook":0,"visual_hook":0,"clarity":0,"value_emotion":0,"title":0,"rhythm":0,"cta":0},"verdict":"...","main_problem":"...","why":"...","meta_alignment":"...","recommended_hook":"...","alternative_hooks":["...","...","..."],"recommended_title":"...","recommended_cta":"...","timeline":[{"time":"0:00","status":"red","label":"Ouverture","reason":"..."}],"action_items":["..."],"confidence":{"audio":0,"visual":0,"text":0,"meta_evidence":0},"rulebook_version":"${rules?.version || 'unknown'}"}`;
}

function parseJsonText(text) {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

async function deleteGeminiFile(name, apiKey) {
  await fetch(`${GOOGLE_BASE}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': apiKey } });
}

async function googleError(response, fallback) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || '';
  } catch {}
  const err = new Error(detail ? `${fallback} ${detail}` : fallback);
  err.status = response.status >= 400 && response.status < 600 ? response.status : 500;
  return err;
}

function friendlyError(err) {
  const msg = String(err?.message || err || 'Erreur inconnue');
  if (/quota|resource exhausted|429/i.test(msg)) return 'Quota Gemini temporairement atteint. Réessaie dans quelques minutes.';
  if (/api key|permission|unauth|401|403/i.test(msg)) return 'La clé Gemini du backend doit être vérifiée.';
  return msg;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
