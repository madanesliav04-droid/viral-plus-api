import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const PUBLISHABLE_KEY = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const DEFAULT_ORIGINS = ['https://madanesliav04-droid.github.io'];

function allowedOrigins() {
  return [...DEFAULT_ORIGINS, ...(Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(x => x.trim()).filter(Boolean)];
}
function cors(origin: string) {
  const allowed = allowedOrigins();
  const value = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(data: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
}
async function parse(res: Response) {
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : (data?.message || data?.error || `Supabase ${res.status}`));
  return data;
}
function adminHeaders(extra: Record<string,string> = {}) {
  return {apikey:SERVICE_ROLE_KEY, Authorization:`Bearer ${SERVICE_ROLE_KEY}`, ...extra};
}
async function userFromToken(auth: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {headers:{apikey:PUBLISHABLE_KEY, Authorization:auth}});
  if (!r.ok) throw new Error('AUTH_REQUIRED');
  return await r.json();
}
async function userRpc(auth: string, fn: string, body: unknown = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method:'POST',
    headers:{apikey:PUBLISHABLE_KEY,Authorization:auth,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  return parse(r);
}
async function adminInsert(table: string, row: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:'POST',
    headers:adminHeaders({'Content-Type':'application/json',Prefer:'return=representation'}),
    body:JSON.stringify(row)
  });
  const rows = await parse(r);
  return Array.isArray(rows) ? rows[0] : rows;
}
async function adminSelectOne(table: string, query: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {headers:adminHeaders({Accept:'application/json'})});
  const rows = await parse(r);
  return Array.isArray(rows) ? rows[0] || null : null;
}
const safeName = (value: unknown) => String(value || 'video.mp4').replace(/[\r\n]/g,'').slice(0,160);
const safeSha = (value: unknown) => /^[0-9a-f]{64}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
const safeUuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')) ? String(value) : null;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin') || '';
  const corsHeaders = cors(origin);
  if (req.method === 'OPTIONS') return new Response(null, {status:204, headers:corsHeaders});
  if (req.method !== 'POST') return json({error:'Method not allowed'},405,corsHeaders);
  if (origin && !allowedOrigins().includes(origin)) return json({error:'Origin non autorisée.'},403,corsHeaders);
  if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SERVICE_ROLE_KEY) return json({error:'Backend non configuré.'},500,corsHeaders);

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({error:'Authentification requise.',code:'AUTH_REQUIRED'},401,corsHeaders);

  let user: any;
  try { user = await userFromToken(auth); }
  catch { return json({error:'Session expirée.',code:'AUTH_REQUIRED'},401,corsHeaders); }

  let body: any;
  try { body = await req.json(); }
  catch { return json({error:'Payload invalide.'},400,corsHeaders); }

  const storagePath = String(body?.storage_path || '');
  const mimeType = String(body?.mime_type || '').split(';')[0].trim();
  const sizeBytes = Number(body?.size_bytes || 0);
  const originalName = safeName(body?.file_name);
  const sha256 = safeSha(body?.sha256);
  const baselineId = safeUuid(body?.baseline_analysis_id);
  const isReanalysis = Boolean(body?.is_reanalysis);
  const idempotencyKey = String(body?.idempotency_key || `analysis:${storagePath}`).slice(0,200);

  if (!storagePath.startsWith(`${user.id}/`)) return json({error:'Chemin vidéo interdit.'},403,corsHeaders);
  if (!mimeType.startsWith('video/')) return json({error:'Format vidéo invalide.'},400,corsHeaders);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 500 * 1024 * 1024) return json({error:'Taille vidéo invalide.'},400,corsHeaders);

  const existingJob = await adminSelectOne('processing_jobs', `user_id=eq.${encodeURIComponent(user.id)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,video_id,status,progress&limit=1`);
  if (existingJob) return json({job:existingJob, reused:true},200,corsHeaders);

  let creditConsumed = false;
  try {
    const creditRaw = await userRpc(auth,'viralplus_consume_credit',{});
    const credit = Array.isArray(creditRaw) ? creditRaw[0] : creditRaw;
    if (!credit?.allowed) return json({error:'Quota Viral+ épuisé.',code:'QUOTA_EXHAUSTED',entitlement:credit},402,corsHeaders);
    creditConsumed = true;

    let media = await adminSelectOne('media_assets', `storage_bucket=eq.viralplus-videos&storage_path=eq.${encodeURIComponent(storagePath)}&select=*&limit=1`);
    if (!media) {
      media = await adminInsert('media_assets', {
        user_id:user.id,
        module:'viralplus',
        kind:'source',
        storage_bucket:'viralplus-videos',
        storage_path:storagePath,
        original_name:originalName,
        mime_type:mimeType,
        size_bytes:sizeBytes,
        sha256,
        status:'uploaded',
        metadata:{client:'web'}
      });
    }

    const job = await adminInsert('processing_jobs', {
      user_id:user.id,
      kind:'viral_analysis',
      video_id:media.id,
      status:'queued',
      progress:0,
      stage:'queued',
      idempotency_key:idempotencyKey,
      credit_consumed:true,
      payload:{is_reanalysis:isReanalysis, baseline_analysis_id:baselineId}
    });

    await adminInsert('job_events', {
      job_id:job.id,
      user_id:user.id,
      status:'queued',
      progress:0,
      message:'Analyse ajoutée à la file',
      details:{}
    });

    return json({job:{id:job.id,video_id:media.id,status:job.status,progress:job.progress},entitlement:credit},202,corsHeaders);
  } catch (error) {
    if (creditConsumed) {
      try { await userRpc(auth,'viralplus_refund_credit',{}); } catch {}
    }
    console.error('viralplus_enqueue_error', error);
    return json({error:'Impossible de préparer l’analyse. Réessaie.',detail:String(error?.message || error).slice(0,300)},500,corsHeaders);
  }
});
