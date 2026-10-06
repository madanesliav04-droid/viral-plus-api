import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreAnalysis, WEIGHTS} from '../src/scoring.mjs';

test('weights sum to one', () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('strong evidenced analysis scores high', () => {
  const scores = Object.fromEntries(Object.keys(WEIGHTS).map(k => [k, 82]));
  const score_evidence = Object.fromEntries(Object.keys(WEIGHTS).map(k => [k, 'Preuve observable suffisamment précise dans la vidéo pour justifier cette note.']));
  const result = scoreAnalysis({scores, score_evidence});
  assert.equal(result.final_score, 82);
});

test('missing evidence is penalized deterministically', () => {
  const scores = Object.fromEntries(Object.keys(WEIGHTS).map(k => [k, 80]));
  const result = scoreAnalysis({scores, score_evidence:{}});
  assert.ok(result.final_score < 80);
  assert.equal(result.guardrails.length, Object.keys(WEIGHTS).length);
});
