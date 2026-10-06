const GOOGLE_BASE = 'https://generativelanguage.googleapis.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function apiKey() {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('Missing env GEMINI_API_KEY');
  return key;
}

async function withTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal:controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

async function googleError(res, prefix) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || '';
  } catch {
    detail = await res.text().catch(() => '');
  }
  const error = new Error(`${prefix}${detail ? `: ${detail}` : ''}`);
  error.status = res.status;
  return error;
}

export async function uploadVideoStream(stream, {size, mimeType, displayName}) {
  const key = apiKey();
  const start = await withTimeout(`${GOOGLE_BASE}/upload/v1beta/files`, {
    method:'POST',
    headers:{
      'x-goog-api-key':key,
      'X-Goog-Upload-Protocol':'resumable',
      'X-Goog-Upload-Command':'start',
      'X-Goog-Upload-Header-Content-Length':String(size),
      'X-Goog-Upload-Header-Content-Type':mimeType,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({file:{display_name:displayName}})
  }, 30000);
  if (!start.ok) throw await googleError(start, 'Gemini upload init failed');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini upload URL missing');

  const uploadedRes = await withTimeout(uploadUrl, {
    method:'POST',
    headers:{
      'Content-Type':mimeType,
      'Content-Length':String(size),
      'X-Goog-Upload-Offset':'0',
      'X-Goog-Upload-Command':'upload, finalize'
    },
    body:stream,
    duplex:'half'
  }, 10 * 60 * 1000);
  if (!uploadedRes.ok) throw await googleError(uploadedRes, 'Gemini video upload failed');
  const payload = await uploadedRes.json();
  const file = payload?.file;
  if (!file?.name || !file?.uri) throw new Error('Gemini upload response incomplete');
  return file;
}

export async function waitForActiveFile(name) {
  const key = apiKey();
  for (let attempt = 0; attempt < 72; attempt++) {
    const res = await withTimeout(`${GOOGLE_BASE}/v1beta/${name}`, {headers:{'x-goog-api-key':key}}, 20000);
    if (!res.ok) throw await googleError(res, 'Gemini file status failed');
    const file = await res.json();
    const state = String(file.state || '').toUpperCase();
    if (state === 'ACTIVE') return file;
    if (state === 'FAILED') throw new Error('Gemini failed to process video');
    await sleep(2500);
  }
  throw new Error('Gemini file processing timeout');
}

function parseJsonText(text) {
  let value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) value = value.slice(start, end + 1);
  return JSON.parse(value);
}

function validate(result) {
  if (!result || typeof result !== 'object') throw new Error('Invalid analysis JSON');
  const requiredScores = ['hook','scroll_stop','clarity','rhythm','retention','structure','text_captions','visual','audio','cta','originality'];
  if (!result.scores || requiredScores.some(key => !Number.isFinite(Number(result.scores[key])))) throw new Error('Incomplete score set');
  if (!Array.isArray(result.timeline) || result.timeline.length < 3) throw new Error('Incomplete timeline');
  if (!Array.isArray(result.action_items) || result.action_items.length < 3) throw new Error('Incomplete action items');
  return result;
}

async function generate(model, file, prompt) {
  const key = apiKey();
  const generationConfig = {responseMimeType:'application/json'};
  if (/gemini-3\.8-flash$/i.test(model)) generationConfig.thinkingConfig = {thinkingLevel:'low'};
  const res = await withTimeout(`${GOOGLE_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method:'POST',
    headers:{'x-goog-api-key':key, 'Content-Type':'application/json'},
    body:JSON.stringify({
      contents:[{role:'user',parts:[
        {file_data:{mime_type:file.mimeType || file.mime_type || 'video/mp4', file_uri:file.uri}},
        {text:prompt}
      ]}],
      generationConfig
    })
  }, 4 * 60 * 1000);
  if (!res.ok) throw await googleError(res, `Gemini ${model} analysis failed`);
  const payload = await res.json();
  const text = (payload?.candidates || []).flatMap(c => c?.content?.parts || []).map(p => p?.text || '').join('').trim();
  if (!text) throw new Error(`Gemini ${model} returned no analysis`);
  return validate(parseJsonText(text));
}

const transient = error => [408,409,429,500,502,503,504].includes(Number(error?.status)) || /temporar|overload|unavailable|resource exhausted|deadline|timeout/i.test(String(error?.message || ''));

export async function analyzeVideo(file, prompt) {
  const models = [...new Set([
    process.env.MODEL || 'gemini-3.8-flash',
    process.env.FALLBACK_MODEL || 'gemini-3.5-flash-lite'
  ])];
  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const analysis = await generate(model, file, prompt);
        analysis.model_used = model;
        return analysis;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && transient(error)) await sleep(1500);
        else break;
      }
    }
  }
  throw lastError || new Error('Gemini analysis unavailable');
}

export async function deleteFile(name) {
  if (!name) return;
  const key = apiKey();
  const res = await withTimeout(`${GOOGLE_BASE}/v1beta/${name}`, {method:'DELETE', headers:{'x-goog-api-key':key}}, 20000);
  if (!res.ok && res.status !== 404) throw await googleError(res, 'Gemini cleanup failed');
}
