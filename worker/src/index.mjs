import http from 'node:http';
import crypto from 'node:crypto';
import {claimJob, refundJobCredit, updateJob, addJobEvent, isSupabaseConfigured} from './supabase.mjs';
import {processViralAnalysis} from './viral-analysis.mjs';

const workerId = process.env.WORKER_ID || `railway-${crypto.randomUUID().slice(0, 8)}`;
const pollMs = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 2500));
const port = Number(process.env.PORT || 8080);
let shuttingDown = false;
let activeJobId = null;
let lastError = null;
let processed = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = error => [408,409,429,500,502,503,504].includes(Number(error?.status)) || /temporar|timeout|network|fetch|unavailable|overload|resource exhausted/i.test(String(error?.message || ''));

async function failJob(job, error) {
  const retries = Number(job.retry_count || 0) + 1;
  const canRetry = retryable(error) && retries <= Number(job.max_retries || 3);
  const delaySeconds = Math.min(300, Math.pow(2, Math.max(0, retries - 1)) * 10);
  const now = Date.now();

  await updateJob(job.id, {
    status:'failed',
    progress:Math.max(1, Number(job.progress || 1)),
    stage:canRetry ? 'retry_wait' : 'failed',
    retry_count:retries,
    next_attempt_at:new Date(now + (canRetry ? delaySeconds * 1000 : 365 * 24 * 60 * 60 * 1000)).toISOString(),
    error_code:canRetry ? 'RETRYABLE_PROCESSING_ERROR' : 'PROCESSING_ERROR',
    error:String(error?.message || error).slice(0, 1800),
    heartbeat_at:new Date().toISOString(),
    locked_at:null,
    locked_by:null,
    completed_at:canRetry ? null : new Date().toISOString()
  });

  await addJobEvent(
    job,
    'failed',
    job.progress || 1,
    canRetry ? `Échec temporaire; nouvel essai #${retries}` : 'Échec définitif',
    {error:String(error?.message || error).slice(0, 500)}
  );

  if (!canRetry && job.credit_consumed) await refundJobCredit(job.id);
}

async function processJob(job) {
  activeJobId = job.id;
  try {
    if (job.kind === 'viral_analysis') {
      await processViralAnalysis(job);
    } else if (job.kind === 'edit_render') {
      const error = new Error('EDIT_RENDER_NOT_ENABLED');
      error.status = 501;
      throw error;
    } else {
      throw new Error(`Unknown job kind: ${job.kind}`);
    }
    processed++;
  } catch (error) {
    console.error('job_failed', job.id, error);
    lastError = {at:new Date().toISOString(), job_id:job.id, message:String(error?.message || error)};
    await failJob(job, error);
  } finally {
    activeJobId = null;
  }
}

function runtimeConfig() {
  return {
    supabase_url:Boolean(process.env.SUPABASE_URL),
    supabase_service_role:Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    gemini:Boolean(process.env.GEMINI_API_KEY)
  };
}

function isReady() {
  const cfg=runtimeConfig();
  return isSupabaseConfigured() && cfg.gemini;
}

async function loop() {
  while (!shuttingDown) {
    if (!isReady()) {
      await sleep(Math.max(pollMs, 5000));
      continue;
    }
    try {
      const job = await claimJob(workerId);
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      await processJob(job);
    } catch (error) {
      lastError = {at:new Date().toISOString(), message:String(error?.message || error)};
      console.error('worker_loop_error', error);
      await sleep(Math.max(pollMs, 5000));
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({
      ok:true,
      ready:isReady(),
      configured:runtimeConfig(),
      service:'viral-edit-worker',
      worker_id:workerId,
      active_job_id:activeJobId,
      processed,
      last_error:lastError
    }));
    return;
  }
  res.writeHead(404, {'content-type':'application/json'});
  res.end(JSON.stringify({error:'not_found'}));
});

server.listen(port, '0.0.0.0', () => console.log(`worker_health_listening ${port}`));
loop().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

for (const signal of ['SIGTERM','SIGINT']) {
  process.on(signal, () => {
    shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 30000).unref();
  });
}
