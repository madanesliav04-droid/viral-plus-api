import {buildPrompt} from './prompt.mjs';
import {scoreAnalysis} from './scoring.mjs';
import {analyzeVideo, deleteFile, uploadVideoStream, waitForActiveFile} from './gemini.mjs';
import {addJobEvent, heartbeat, insertOne, selectOne, storageDownload, updateJob} from './supabase.mjs';

const safeName = value => String(value || 'video.mp4').replace(/[\r\n]/g, '').slice(0, 160);

async function rulebook() {
  const url = process.env.RULEBOOK_URL;
  if (!url) return {version:'viralplus-core'};
  try {
    const res = await fetch(url, {headers:{Accept:'application/json'}, signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error(`rulebook ${res.status}`);
    return await res.json();
  } catch (error) {
    console.warn('rulebook_fallback', error.message);
    return {version:'viralplus-core'};
  }
}

export async function processViralAnalysis(job) {
  const asset = await selectOne('media_assets', `id=eq.${encodeURIComponent(job.video_id)}&user_id=eq.${encodeURIComponent(job.user_id)}&select=*`);
  if (!asset) throw new Error('Source media asset not found');
  if (!String(asset.mime_type || '').startsWith('video/')) throw new Error('Source media is not a video');
  if (!asset.size_bytes || asset.size_bytes <= 0) throw new Error('Source media size invalid');

  await heartbeat(job, 'processing', 8, 'storage_fetch', 'Récupération sécurisée de la vidéo');
  const stored = await storageDownload(asset);

  await heartbeat(job, 'analyzing', 18, 'gemini_upload', 'Transfert de la vidéo vers Gemini Files');
  let geminiFile = null;
  try {
    geminiFile = await uploadVideoStream(stored.body, {
      size:Number(asset.size_bytes),
      mimeType:asset.mime_type,
      displayName:safeName(asset.original_name)
    });

    await heartbeat(job, 'analyzing', 32, 'gemini_processing', 'Préparation multimodale de la vidéo');
    const active = await waitForActiveFile(geminiFile.name);

    await heartbeat(job, 'analyzing', 48, 'multimodal_analysis', 'Analyse du hook, rythme, structure, visuel et audio');
    const rules = await rulebook();
    const analysis = await analyzeVideo(active, buildPrompt(rules));

    await heartbeat(job, 'generating_report', 84, 'score_and_report', 'Normalisation du score et du rapport');
    const score = scoreAnalysis(analysis);
    const hotspot = analysis.timeline.find(item => /red|orange|weak|bad/i.test(String(item?.status || ''))) || analysis.timeline[0] || {};
    const status = score.final_score >= 78 ? 'ready' : score.final_score >= 60 ? 'almost' : 'rework';
    const result = {
      ...analysis,
      final_score:score.final_score,
      score_version:`${rules.version || 'viralplus-core'}|${score.score_version}`,
      score_explanation:score.explanation,
      score_guardrails:score.guardrails,
      rulebook_version:rules.version || 'viralplus-core',
      status
    };

    const saved = await insertOne('viralplus_analyses', {
      user_id:job.user_id,
      video_id:asset.id,
      job_id:job.id,
      video_name:safeName(asset.original_name),
      video_sha256:asset.sha256 || null,
      final_score:result.final_score,
      score_version:result.score_version,
      model_used:result.model_used || null,
      rulebook_version:result.rulebook_version,
      is_reanalysis:Boolean(job.payload?.is_reanalysis),
      baseline_analysis_id:job.payload?.baseline_analysis_id || null,
      status,
      main_problem:result.main_problem || null,
      why:result.why || null,
      detected_spoken_hook:result.detected_spoken_hook || null,
      recommended_hook:result.recommended_hook || null,
      hotspot_time:(hotspot.start != null && hotspot.end != null) ? `${hotspot.start}s → ${hotspot.end}s` : (hotspot.time || null),
      hotspot_reason:hotspot.reason || hotspot.label || null,
      scores:result.scores || {},
      action_items:result.action_items || [],
      result_json:result
    });

    result.analysis_id = saved?.id || null;
    await updateJob(job.id, {
      status:'completed',
      progress:100,
      stage:'completed',
      result:{analysis_id:result.analysis_id, final_score:result.final_score, score_version:result.score_version},
      completed_at:new Date().toISOString(),
      heartbeat_at:new Date().toISOString(),
      locked_at:null,
      locked_by:null
    });
    await addJobEvent(job, 'completed', 100, 'Analyse terminée', {analysis_id:result.analysis_id, final_score:result.final_score});
    return result;
  } finally {
    if (geminiFile?.name) {
      try { await deleteFile(geminiFile.name); }
      catch (error) { console.warn('gemini_cleanup_failed', error.message); }
    }
  }
}
