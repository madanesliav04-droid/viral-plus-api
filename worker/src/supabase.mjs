function getConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url) throw new Error('Missing env SUPABASE_URL');
  if (!serviceKey) throw new Error('Missing env SUPABASE_SERVICE_ROLE_KEY');
  return {url, serviceKey};
}

export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function headers(extra = {}) {
  const {serviceKey} = getConfig();
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extra
  };
}

async function parse(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const error = new Error(typeof data === 'string' ? data : (data?.message || data?.error || `Supabase ${res.status}`));
    error.status = res.status;
    throw error;
  }
  return data;
}

export async function rpc(name, body = {}) {
  const {url} = getConfig();
  const res = await fetch(`${url}/rest/v1/rpc/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: headers({'Content-Type':'application/json'}),
    body: JSON.stringify(body)
  });
  return parse(res);
}

export async function selectOne(table, query) {
  const {url} = getConfig();
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {headers: headers({Accept:'application/json'})});
  const rows = await parse(res);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function insertOne(table, row) {
  const {url} = getConfig();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({'Content-Type':'application/json', Prefer:'return=representation'}),
    body: JSON.stringify(row)
  });
  const rows = await parse(res);
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function patch(table, query, row) {
  const {url} = getConfig();
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: headers({'Content-Type':'application/json', Prefer:'return=representation'}),
    body: JSON.stringify(row)
  });
  return parse(res);
}

export async function claimJob(workerId) {
  const rows = await rpc('claim_processing_job', {p_worker_id: workerId});
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function updateJob(jobId, values) {
  return patch('processing_jobs', `id=eq.${encodeURIComponent(jobId)}`, {...values, updated_at:new Date().toISOString()});
}

export async function addJobEvent(job, status, progress, message, details = {}) {
  return insertOne('job_events', {
    job_id: job.id,
    user_id: job.user_id,
    status,
    progress,
    message,
    details
  });
}

export async function heartbeat(job, status, progress, stage, message) {
  await updateJob(job.id, {
    status,
    progress,
    stage,
    heartbeat_at:new Date().toISOString()
  });
  await addJobEvent(job, status, progress, message || stage);
}

export async function storageDownload(asset) {
  const {url} = getConfig();
  const bucket = encodeURIComponent(asset.storage_bucket);
  const objectPath = asset.storage_path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
    headers: headers()
  });
  if (!res.ok || !res.body) throw new Error(`Storage download failed (${res.status})`);
  return res;
}

export async function refundJobCredit(jobId) {
  try { return await rpc('refund_job_credit', {p_job_id: jobId}); }
  catch (error) { console.error('credit_refund_failed', jobId, error.message); return false; }
}
