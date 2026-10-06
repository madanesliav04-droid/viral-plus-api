import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import pg from 'pg';

const {Pool}=pg;

const required=['DATABASE_URL','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','GEMINI_API_KEY'];
for(const key of required){
  if(!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const DATABASE_URL=process.env.DATABASE_URL;
const SUPABASE_URL=process.env.SUPABASE_URL.replace(/\/$/,'');
const SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY=process.env.GEMINI_API_KEY.trim();
const PRIMARY_MODEL=process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACK_MODEL=process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const RULEBOOK_VERSION=process.env.RULEBOOK_VERSION || 'vp-editorial-2026-10';
const WORKER_ID=process.env.WORKER_ID || `viral-worker-${os.hostname()}-${process.pid}`;
const POLL_MS=Math.max(500,Number(process.env.POLL_MS||2500));
const PORT=Number(process.env.PORT||3000);
const STALE_SECONDS=Math.max(120,Number(process.env.STALE_SECONDS||360));
const GOOGLE_BASE='https://generativelanguage.googleapis.com';

const SCORE_VERSION='vp-score-3-evidence';
const WEIGHTS={
  hook:18,
  scroll_stop:12,
  clarity:8,
  rhythm:8,
  retention:15,
  structure:10,
  text_subtitles:5,
  visual:6,
  audio:4,
  cta:4,
  originality:10
};

const pool=new Pool({
  connectionString:DATABASE_URL,
  max:4,
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000,
  ssl:process.env.DATABASE_SSL==='false' ? false : {rejectUnauthorized:false}
});

let running=true;
let activeJobId=null;
let lastLoopAt=new Date().toISOString();
let lastError=null;

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function clamp(v,min=0,max=100){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):0}
function safeError(error){return String(error?.message||error||'Unknown error').slice(0,1200)}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
function extForMime(mime){if(mime==='video/quicktime'||mime==='video/mov')return '.mov';if(mime==='video/webm')return '.webm';return '.mp4'}

http.createServer((req,res)=>{
  if(req.url==='/health'){
    return json(res,200,{ok:true,service:'viral-edit-worker',worker_id:WORKER_ID,active_job_id:activeJobId,last_loop_at:lastLoopAt,last_error:lastError});
  }
  return json(res,404,{error:'not_found'});
}).listen(PORT,'0.0.0.0');

process.on('SIGTERM',()=>{running=false});
process.on('SIGINT',()=>{running=false});

async function query(text,params=[]){return pool.query(text,params)}

async function appendEvent(jobId,userId,status,progress,message,details={}){
  await query(
    `insert into public.job_events(job_id,user_id,status,progress,message,details)
     values($1,$2,$3,$4,$5,$6::jsonb)`,
    [jobId,userId,status,progress,message,JSON.stringify(details)]
  );
}

async function updateJob(job,status,progress,stage,patch={}){
  await query(
    `update public.processing_jobs
     set status=$2,
         progress=$3,
         stage=$4,
         heartbeat_at=now(),
         started_at=case when started_at is null and $2 not in ('queued','uploaded') then now() else started_at end,
         completed_at=case when $2='completed' then now() else completed_at end,
         error_code=coalesce($5,error_code),
         error=coalesce($6,error),
         result=coalesce($7::jsonb,result),
         updated_at=now()
     where id=$1`,
    [job.id,status,progress,stage,patch.error_code||null,patch.error||null,patch.result?JSON.stringify(patch.result):null]
  );
  await appendEvent(job.id,job.user_id,status,progress,stage,patch.event_details||{});
}

async function requeueStaleJobs(){
  const r=await query(
    `update public.processing_jobs
     set status='queued',
         stage='requeued_after_stale_worker',
         locked_at=null,
         locked_by=null,
         heartbeat_at=null,
         retry_count=retry_count+1,
         next_attempt_at=now()+interval '15 seconds',
         error_code='WORKER_STALE',
         error='Worker heartbeat expired; job was requeued.',
         updated_at=now()
     where kind='viral_analysis'
       and status not in ('completed','failed','cancelled','queued')
       and heartbeat_at < now() - ($1::text || ' seconds')::interval
       and retry_count < max_retries
     returning id,user_id,retry_count`,
    [String(STALE_SECONDS)]
  );
  for(const row of r.rows){
    await appendEvent(row.id,row.user_id,'queued',null,'Job requeued after stale worker heartbeat',{retry_count:row.retry_count});
  }
}

async function claimJob(){
  const client=await pool.connect();
  try{
    await client.query('begin');
    const picked=await client.query(
      `select *
       from public.processing_jobs
       where kind='viral_analysis'
         and status='queued'
         and next_attempt_at<=now()
       order by priority asc,created_at asc
       for update skip locked
       limit 1`
    );
    if(!picked.rows.length){
      await client.query('commit');
      return null;
    }
    const job=picked.rows[0];
    const claimed=await client.query(
      `update public.processing_jobs
       set status='processing',
           progress=1,
           stage='claimed',
           locked_at=now(),
           locked_by=$2,
           heartbeat_at=now(),
           started_at=coalesce(started_at,now()),
           error_code=null,
           error=null,
           updated_at=now()
       where id=$1
       returning *`,
      [job.id,WORKER_ID]
    );
    await client.query('commit');
    await appendEvent(job.id,job.user_id,'processing',1,'Worker claimed job',{worker_id:WORKER_ID});
    return claimed.rows[0];
  }catch(error){
    await client.query('rollback').catch(()=>{});
    throw error;
  }finally{
    client.release();
  }
}

async function failOrRetry(job,error){
  const message=safeError(error);
  const code=String(error?.code||error?.status||'PROCESSING_ERROR').slice(0,120);
  const r=await query('select retry_count,max_retries from public.processing_jobs where id=$1',[job.id]);
  const current=Number(r.rows[0]?.retry_count||0);
  const max=Number(r.rows[0]?.max_retries||3);
  const next=current+1;

  if(next<max){
    const delay=Math.min(900,15*Math.pow(2,current));
    await query(
      `update public.processing_jobs
       set status='queued',
           progress=0,
           stage='retry_scheduled',
           retry_count=$2,
           next_attempt_at=now()+($3::text || ' seconds')::interval,
           locked_at=null,
           locked_by=null,
           heartbeat_at=null,
           error_code=$4,
           error=$5,
           updated_at=now()
       where id=$1`,
      [job.id,next,String(delay),code,message]
    );
    await appendEvent(job.id,job.user_id,'queued',0,'Retry scheduled',{retry_count:next,delay_seconds:delay,error_code:code,error:message});
  }else{
    await query(
      `update public.processing_jobs
       set status='failed',
           stage='failed',
           retry_count=$2,
           completed_at=now(),
           locked_at=null,
           locked_by=null,
           heartbeat_at=null,
           error_code=$3,
           error=$4,
           updated_at=now()
       where id=$1`,
      [job.id,next,code,message]
    );
    await appendEvent(job.id,job.user_id,'failed',null,'Job failed',{retry_count:next,error_code:code,error:message});
  }
}

async function heartbeat(jobId){
  await query(
    `update public.processing_jobs
     set heartbeat_at=now(),updated_at=now()
     where id=$1 and locked_by=$2 and status not in ('completed','failed','cancelled')`,
    [jobId,WORKER_ID]
  );
}

async function withHeartbeat(job,fn){
  const timer=setInterval(()=>heartbeat(job.id).catch(err=>console.error('heartbeat',safeError(err))),15000);
  try{return await fn()}finally{clearInterval(timer)}
}

async function getMedia(job){
  const r=await query(
    `select * from public.media_assets where id=$1 and user_id=$2 and deleted_at is null limit 1`,
    [job.video_id,job.user_id]
  );
  if(!r.rows.length){
    const e=new Error('Source media not found or ownership mismatch');e.code='MEDIA_NOT_FOUND';throw e;
  }
  return r.rows[0];
}

async function signStorageObject(bucket,objectPath,expiresIn=900){
  const encoded=objectPath.split('/').map(encodeURIComponent).join('/');
  const r=await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encoded}`,{
    method:'POST',
    headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'content-type':'application/json'},
    body:JSON.stringify({expiresIn})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.signedURL){
    const e=new Error(data.message||data.error||`Storage sign failed (${r.status})`);e.code='STORAGE_SIGN_FAILED';throw e;
  }
  return data.signedURL.startsWith('http')?data.signedURL:`${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

async function downloadMedia(media,destination){
  const url=await signStorageObject(media.storage_bucket,media.storage_path,1200);
  const r=await fetch(url);
  if(!r.ok||!r.body){
    const e=new Error(`Storage download failed (${r.status})`);e.code='STORAGE_DOWNLOAD_FAILED';throw e;
  }
  await pipeline(Readable.fromWeb(r.body),createWriteStream(destination));
}

function run(cmd,args,{allowFailure=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',d=>{stdout+=d.toString()});
    child.stderr.on('data',d=>{stderr+=d.toString()});
    child.on('error',reject);
    child.on('close',code=>{
      const result={code,stdout,stderr};
      if(code===0||allowFailure)return resolve(result);
      const e=new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`);e.code='MEDIA_TOOL_FAILED';reject(e);
    });
  });
}

function fraction(value){
  if(!value)return 0;
  const [a,b]=String(value).split('/').map(Number);
  return b? a/b : Number(a)||0;
}

async function probeVideo(file){
  const r=await run('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file]);
  const data=JSON.parse(r.stdout||'{}');
  const video=(data.streams||[]).find(s=>s.codec_type==='video')||{};
  const audio=(data.streams||[]).find(s=>s.codec_type==='audio')||null;
  return {
    duration_s:Number(data.format?.duration||video.duration||0),
    width:Number(video.width||0),
    height:Number(video.height||0),
    fps:Number(fraction(video.avg_frame_rate||video.r_frame_rate).toFixed(3)),
    video_codec:video.codec_name||null,
    audio_codec:audio?.codec_name||null,
    has_audio:Boolean(audio),
    sample_rate:audio?.sample_rate?Number(audio.sample_rate):null,
    channels:audio?.channels?Number(audio.channels):null,
    bitrate:data.format?.bit_rate?Number(data.format.bit_rate):null
  };
}

async function detectSilences(file,duration){
  const r=await run('ffmpeg',['-hide_banner','-nostats','-i',file,'-af','silencedetect=noise=-35dB:d=0.25','-f','null','-'],{allowFailure:true});
  const lines=r.stderr.split(/\r?\n/);
  const intervals=[];
  let start=null;
  for(const line of lines){
    const sm=line.match(/silence_start:\s*([0-9.]+)/);
    if(sm)start=Number(sm[1]);
    const em=line.match(/silence_end:\s*([0-9.]+).*silence_duration:\s*([0-9.]+)/);
    if(em){
      const end=Number(em[1]);
      const d=Number(em[2]);
      intervals.push({start_s:start??Math.max(0,end-d),end_s:end,duration_s:d});
      start=null;
    }
  }
  if(start!==null&&duration>start)intervals.push({start_s:start,end_s:duration,duration_s:duration-start});
  const total=intervals.reduce((s,x)=>s+x.duration_s,0);
  const longest=intervals.reduce((m,x)=>Math.max(m,x.duration_s),0);
  const leading=intervals.find(x=>x.start_s<=0.08)?.duration_s||0;
  return {
    intervals:intervals.slice(0,80),
    total_s:Number(total.toFixed(3)),
    longest_s:Number(longest.toFixed(3)),
    leading_s:Number(leading.toFixed(3)),
    ratio:duration>0?Number((total/duration).toFixed(4)):0
  };
}

async function detectScenes(file,duration){
  const r=await run('ffmpeg',['-hide_banner','-nostats','-i',file,'-vf',"select='gt(scene,0.32)',showinfo",'-an','-f','null','-'],{allowFailure:true});
  const times=[];
  for(const match of r.stderr.matchAll(/pts_time:([0-9.]+)/g))times.push(Number(match[1]));
  const unique=[...new Set(times.map(x=>Number(x.toFixed(3))))].slice(0,200);
  return {
    cut_times_s:unique,
    count:unique.length,
    first_3s:unique.filter(t=>t<=3).length,
    per_minute:duration>0?Number((unique.length/(duration/60)).toFixed(2)):0
  };
}

async function detectAudioLevels(file,hasAudio){
  if(!hasAudio)return {mean_db:null,max_db:null};
  const r=await run('ffmpeg',['-hide_banner','-nostats','-i',file,'-af','volumedetect','-f','null','-'],{allowFailure:true});
  const mean=r.stderr.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  const max=r.stderr.match(/max_volume:\s*(-?[0-9.]+) dB/);
  return {mean_db:mean?Number(mean[1]):null,max_db:max?Number(max[1]):null};
}

async function uploadGeminiFile(file,mimeType,displayName){
  const info=await stat(file);
  const start=await fetch(`${GOOGLE_BASE}/upload/v1beta/files`,{
    method:'POST',
    headers:{
      'x-goog-api-key':GEMINI_API_KEY,
      'X-Goog-Upload-Protocol':'resumable',
      'X-Goog-Upload-Command':'start',
      'X-Goog-Upload-Header-Content-Length':String(info.size),
      'X-Goog-Upload-Header-Content-Type':mimeType,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({file:{display_name:displayName}})
  });
  if(!start.ok)throw await googleError(start,'Gemini upload init failed');
  const uploadUrl=start.headers.get('x-goog-upload-url');
  if(!uploadUrl){const e=new Error('Gemini upload URL missing');e.code='GEMINI_UPLOAD_URL_MISSING';throw e}

  const uploaded=await fetch(uploadUrl,{
    method:'POST',
    headers:{
      'Content-Type':mimeType,
      'Content-Length':String(info.size),
      'X-Goog-Upload-Offset':'0',
      'X-Goog-Upload-Command':'upload, finalize'
    },
    body:createReadStream(file),
    duplex:'half'
  });
  if(!uploaded.ok)throw await googleError(uploaded,'Gemini upload failed');
  const payload=await uploaded.json();
  if(!payload?.file?.name||!payload?.file?.uri){
    const e=new Error('Gemini file response incomplete');e.code='GEMINI_FILE_INVALID';throw e;
  }
  return payload.file;
}

async function waitGeminiFile(file){
  for(let i=0;i<60;i++){
    const r=await fetch(`${GOOGLE_BASE}/v1beta/${file.name}`,{headers:{'x-goog-api-key':GEMINI_API_KEY}});
    if(!r.ok)throw await googleError(r,'Gemini file status failed');
    const current=await r.json();
    const state=String(current.state||'').toUpperCase();
    if(state==='ACTIVE')return current;
    if(state==='FAILED'){const e=new Error('Gemini failed to process source video');e.code='GEMINI_FILE_FAILED';throw e}
    await sleep(2000);
  }
  const e=new Error('Gemini file processing timeout');e.code='GEMINI_FILE_TIMEOUT';throw e;
}

async function deleteGeminiFile(name){
  if(!name)return;
  await fetch(`${GOOGLE_BASE}/v1beta/${name}`,{method:'DELETE',headers:{'x-goog-api-key':GEMINI_API_KEY}}).catch(()=>{});
}

async function googleError(response,prefix){
  const body=await response.text().catch(()=>'');
  const e=new Error(`${prefix} (${response.status}): ${body.slice(0,800)}`);
  e.status=response.status;
  e.code=`GEMINI_${response.status}`;
  return e;
}

function parseJson(text){
  let value=String(text||'').trim().replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/i,'');
  const a=value.indexOf('{'),b=value.lastIndexOf('}');
  if(a>=0&&b>a)value=value.slice(a,b+1);
  return JSON.parse(value);
}

function buildPrompt(metrics){
  return `You are Viral+, an evidence-first short-form video analyst.
Analyze the actual uploaded video together with deterministic media measurements supplied below.

ABSOLUTE RULES
- Never claim access to private Instagram/TikTok/YouTube ranking weights.
- Never invent watch time, retention, views, shares, saves or account-level performance.
- Separate observable evidence from editorial inference.
- Use exact timestamps whenever possible.
- If a property cannot be observed, use "INDETECTABLE".
- Be strict: a polished but generic video can score low.
- The final score is computed by code, not by you. You only score individual dimensions and provide evidence.

DETERMINISTIC MEDIA MEASUREMENTS
${JSON.stringify(metrics,null,2)}

SCORE EACH DIMENSION FROM 0 TO 100
- hook: strength of the first spoken/content promise.
- scroll_stop: immediate reason to stop scrolling in the first seconds.
- clarity: how quickly the viewer understands topic + promise.
- rhythm: editorial pacing, density, pauses and momentum.
- retention: predicted ability of structure/progression to maintain attention. This is a heuristic, never actual retention.
- structure: ordering of hook, context, proof/value, payoff and exit.
- text_subtitles: readability, hierarchy, timing and usefulness of visible text/captions.
- visual: framing, visual variation, composition and meaningful pattern interrupts.
- audio: speech intelligibility, audio consistency and useful sound design.
- cta: conversion clarity and fit; do not reward it as proof of virality.
- originality: originality of angle/execution observable in this video.

Also provide secondary metrics for backward compatibility:
- spoken_hook
- visual_hook
- shareability
- audience_relevance
- value_emotion

OUTPUT JSON ONLY
{
  "detected_spoken_hook": "...",
  "detected_visual_hook": "...",
  "detected_title_text": "...",
  "detected_cta": "...",
  "transcript_segments": [{"start_s":0.0,"end_s":1.4,"text":"..."}],
  "visible_text": [{"time_s":0.0,"text":"...","role":"hook|caption|label|cta"}],
  "scores": {
    "hook":0,"scroll_stop":0,"clarity":0,"rhythm":0,"retention":0,
    "structure":0,"text_subtitles":0,"visual":0,"audio":0,"cta":0,"originality":0,
    "spoken_hook":0,"visual_hook":0,"shareability":0,"audience_relevance":0,"value_emotion":0
  },
  "score_evidence": {
    "hook":"...","scroll_stop":"...","clarity":"...","rhythm":"...","retention":"...",
    "structure":"...","text_subtitles":"...","visual":"...","audio":"...","cta":"...","originality":"..."
  },
  "verdict":"...",
  "main_problem":"...",
  "why":"...",
  "recommended_hook":"...",
  "alternative_hooks":["...","...","..."],
  "recommended_title":"...",
  "recommended_cta":"...",
  "timeline":[
    {"time":"0:00–0:02","start_s":0.0,"end_s":2.0,"status":"red|orange|green","label":"...","reason":"...","fix":"..."}
  ],
  "action_items":["...","...","..."],
  "confidence":{"audio":0,"visual":0,"text":0,"semantic":0}
}

REQUIREMENTS
- Timeline: 5–8 entries spanning opening, middle and exit.
- Action items: 3–6 concrete edits, prioritized.
- A correction must say what to cut/move/rewrite/add and where.
- Recommended hook must be a usable replacement line based on the actual content.
- 80+ requires strong observable evidence.
- Treat measured silence/cut/audio data as evidence, not as universal rules. A static shot is not automatically bad.
`;
}

async function callGemini(model,file,mimeType,prompt){
  const r=await fetch(`${GOOGLE_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
    method:'POST',
    headers:{'x-goog-api-key':GEMINI_API_KEY,'content-type':'application/json'},
    body:JSON.stringify({
      contents:[{role:'user',parts:[{file_data:{mime_type:mimeType,file_uri:file.uri}},{text:prompt}]}],
      generationConfig:{responseMimeType:'application/json',temperature:0}
    })
  });
  if(!r.ok)throw await googleError(r,`Gemini ${model} analysis failed`);
  const payload=await r.json();
  const text=(payload?.candidates||[]).flatMap(c=>c?.content?.parts||[]).map(p=>p?.text||'').join('').trim();
  if(!text){const e=new Error('Gemini returned empty analysis');e.code='GEMINI_EMPTY';throw e}
  return parseJson(text);
}

async function analyzeWithGemini(file,mimeType,metrics){
  let last=null;
  for(const model of [...new Set([PRIMARY_MODEL,FALLBACK_MODEL])]){
    try{
      const analysis=await callGemini(model,file,mimeType,buildPrompt(metrics));
      analysis.model_used=model;
      return analysis;
    }catch(error){
      last=error;
      const transient=[408,409,429,500,502,503,504].includes(Number(error?.status));
      if(!transient&&model===PRIMARY_MODEL)console.warn('Primary model failed, trying fallback:',safeError(error));
    }
  }
  throw last||new Error('All Gemini models failed');
}

function wordCount(segments=[]){
  return segments.reduce((n,s)=>n+String(s?.text||'').trim().split(/\s+/).filter(Boolean).length,0);
}

function normalizeAnalysis(analysis,metrics){
  if(!analysis||typeof analysis!=='object'||!analysis.scores)throw new Error('Invalid analysis payload');
  const s=analysis.scores;
  const required=Object.keys(WEIGHTS);
  for(const key of required){
    if(!Number.isFinite(Number(s[key])))throw new Error(`Missing analysis score: ${key}`);
    s[key]=Math.round(clamp(s[key]));
  }

  s.spoken_hook=Math.round(clamp(s.spoken_hook??s.hook));
  s.visual_hook=Math.round(clamp(s.visual_hook??s.visual));
  s.shareability=Math.round(clamp(s.shareability??s.scroll_stop));
  s.audience_relevance=Math.round(clamp(s.audience_relevance??s.clarity));
  s.value_emotion=Math.round(clamp(s.value_emotion??s.retention));

  const guardrails=[];
  if(metrics.silence.leading_s>1.2){
    s.hook=Math.min(s.hook,55);
    s.spoken_hook=Math.min(s.spoken_hook,55);
    s.scroll_stop=Math.min(s.scroll_stop,60);
    guardrails.push('Opening silence > 1.2s capped hook/scroll-stop scores.');
  }else if(metrics.silence.leading_s>0.6){
    s.hook=Math.min(s.hook,70);
    s.spoken_hook=Math.min(s.spoken_hook,70);
    guardrails.push('Opening silence > 0.6s capped hook score.');
  }
  if(metrics.silence.longest_s>2.5){
    s.rhythm=Math.min(s.rhythm,58);
    s.retention=Math.min(s.retention,65);
    guardrails.push('A silence longer than 2.5s capped rhythm/retention unless editorially justified.');
  }else if(metrics.silence.longest_s>1.5){
    s.rhythm=Math.min(s.rhythm,72);
    guardrails.push('A silence longer than 1.5s capped rhythm.');
  }

  const evidence=analysis.score_evidence||{};
  let weighted=0,total=0,missingEvidencePenalty=0;
  for(const [key,weight] of Object.entries(WEIGHTS)){
    weighted+=s[key]*weight;
    total+=weight;
    const ev=String(evidence[key]||'').trim();
    if(!ev||/^INDETECTABLE$/i.test(ev))missingEvidencePenalty+=weight*0.035;
    if(s[key]>=80&&ev.length<28){
      s[key]=Math.min(s[key],79);
      guardrails.push(`${key}: score 80+ reduced because evidence was too weak.`);
    }
  }

  weighted=0;
  for(const [key,weight] of Object.entries(WEIGHTS))weighted+=s[key]*weight;
  const raw=Math.round(weighted/total);
  const finalScore=Math.round(clamp(raw-missingEvidencePenalty));

  const words=wordCount(analysis.transcript_segments);
  const speechWpm=metrics.probe.duration_s>0?Math.round(words/(metrics.probe.duration_s/60)):null;
  metrics.transcript={word_count:words,estimated_words_per_minute:speechWpm};

  analysis.scores=s;
  analysis.media_metrics=metrics;
  analysis.final_score=finalScore;
  analysis.raw_score=raw;
  analysis.score_version=`${RULEBOOK_VERSION}|${SCORE_VERSION}`;
  analysis.rulebook_version=RULEBOOK_VERSION;
  analysis.score_guardrails=guardrails;
  analysis.score_explanation='Final score is computed in code from versioned Viral+ weights and deterministic guardrails. Model outputs provide dimension judgments/evidence, not the final total.';
  return analysis;
}

function firstHotspot(timeline=[]){
  return timeline.find(x=>/red|orange|weak|bad/i.test(String(x?.status||'')))||timeline[0]||{};
}

async function persistAnalysis(job,media,analysis){
  const hotspot=firstHotspot(analysis.timeline||[]);
  const payload=job.payload||{};
  const isReanalysis=Boolean(payload.is_reanalysis);
  const baseline=payload.baseline_analysis_id||null;
  const status=analysis.final_score>=78?'ready':analysis.final_score>=60?'almost':'rework';

  const existing=await query('select id,result_json from public.viralplus_analyses where job_id=$1 limit 1',[job.id]);
  if(existing.rows.length){
    return {analysis_id:existing.rows[0].id,...(existing.rows[0].result_json||analysis)};
  }

  const inserted=await query(
    `insert into public.viralplus_analyses(
      user_id,video_id,job_id,video_name,video_sha256,final_score,score_version,
      model_used,rulebook_version,is_reanalysis,baseline_analysis_id,status,
      main_problem,why,detected_spoken_hook,recommended_hook,hotspot_time,
      hotspot_reason,scores,action_items,result_json
    ) values(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      $19::jsonb,$20::jsonb,$21::jsonb
    ) returning id`,
    [
      job.user_id,media.id,job.id,media.original_name||'video',
      media.sha256||null,analysis.final_score,analysis.score_version,
      analysis.model_used||null,analysis.rulebook_version,isReanalysis,baseline,status,
      analysis.main_problem||null,analysis.why||null,analysis.detected_spoken_hook||null,
      analysis.recommended_hook||null,hotspot.time||null,hotspot.reason||hotspot.label||null,
      JSON.stringify(analysis.scores||{}),JSON.stringify(analysis.action_items||[]),
      JSON.stringify(analysis)
    ]
  );
  const id=inserted.rows[0].id;
  const result={...analysis,analysis_id:id,baseline_analysis_id:baseline,status};
  await query('update public.viralplus_analyses set result_json=$2::jsonb where id=$1',[id,JSON.stringify(result)]);
  return result;
}

async function processAnalysisJob(job){
  const already=await query('select id,result_json from public.viralplus_analyses where job_id=$1 limit 1',[job.id]);
  if(already.rows.length){
    const result={...(already.rows[0].result_json||{}),analysis_id:already.rows[0].id};
    await updateJob(job,'completed',100,'idempotent_result_reused',{result});
    return;
  }

  const media=await getMedia(job);
  const dir=await mkdtemp(path.join(os.tmpdir(),'viralplus-'));
  const source=path.join(dir,'source'+extForMime(media.mime_type));
  let geminiFile=null;

  try{
    await updateJob(job,'processing',5,'downloading_source');
    await downloadMedia(media,source);

    await updateJob(job,'processing',15,'probing_media');
    const probe=await probeVideo(source);
    if(!probe.duration_s||!probe.width||!probe.height){
      const e=new Error('Video metadata is incomplete or unreadable');e.code='INVALID_VIDEO';throw e;
    }

    await updateJob(job,'transcribing',25,'measuring_silences');
    const silence=await detectSilences(source,probe.duration_s);

    await updateJob(job,'analyzing',35,'measuring_scene_changes');
    const [scenes,audio]=await Promise.all([
      detectScenes(source,probe.duration_s),
      detectAudioLevels(source,probe.has_audio)
    ]);

    const metrics={probe,silence,scenes,audio};

    await updateJob(job,'analyzing',45,'uploading_to_gemini');
    geminiFile=await uploadGeminiFile(source,media.mime_type,media.original_name||'viralplus-video');

    await updateJob(job,'analyzing',55,'waiting_for_gemini_video');
    geminiFile=await waitGeminiFile(geminiFile);

    await updateJob(job,'analyzing',70,'semantic_video_analysis');
    const semantic=await analyzeWithGemini(geminiFile,media.mime_type,metrics);

    await updateJob(job,'generating_report',85,'normalizing_evidence');
    const normalized=normalizeAnalysis(semantic,metrics);

    await updateJob(job,'generating_report',95,'persisting_report');
    const result=await persistAnalysis(job,media,normalized);

    await updateJob(job,'completed',100,'completed',{result});
  }finally{
    if(geminiFile?.name)await deleteGeminiFile(geminiFile.name);
    await rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

async function processJob(job){
  if(job.kind!=='viral_analysis'){
    const e=new Error(`Unsupported job kind: ${job.kind}`);e.code='UNSUPPORTED_JOB_KIND';throw e;
  }
  await processAnalysisJob(job);
}

async function main(){
  console.log(JSON.stringify({event:'worker_started',worker_id:WORKER_ID,model:PRIMARY_MODEL,fallback_model:FALLBACK_MODEL,score_version:SCORE_VERSION}));
  while(running){
    lastLoopAt=new Date().toISOString();
    try{
      await requeueStaleJobs();
      const job=await claimJob();
      if(!job){await sleep(POLL_MS);continue}
      activeJobId=job.id;
      lastError=null;
      try{
        await withHeartbeat(job,()=>processJob(job));
      }catch(error){
        lastError=safeError(error);
        console.error(JSON.stringify({event:'job_error',job_id:job.id,error:lastError}));
        await failOrRetry(job,error);
      }finally{
        activeJobId=null;
      }
    }catch(error){
      lastError=safeError(error);
      console.error(JSON.stringify({event:'loop_error',error:lastError}));
      await sleep(Math.max(POLL_MS,5000));
    }
  }
  await pool.end();
  process.exit(0);
}

main().catch(error=>{
  console.error(JSON.stringify({event:'fatal',error:safeError(error)}));
  process.exit(1);
});
