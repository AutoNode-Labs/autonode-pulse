/**
 * In-memory job store for async audits.
 *
 * Phase 2 uses a Map for simplicity — no external dependency, survives
 * Redis being absent. Trade-off: jobs are lost on process restart and
 * state is not shared across instances.
 *
 * Phase 3 upgrade path: replace with BullMQ (Redis-backed) by swapping
 * createJob / getJob / updateJob with BullMQ Queue + Worker equivalents.
 *
 * Expired jobs are cleaned up every 5 minutes to prevent unbounded growth.
 */

import { randomUUID } from 'crypto';

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

/** @type {Map<string, object>} */
const jobs = new Map();

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref(); // .unref() so this timer doesn't prevent process exit

export function createJob(targetUrl, webhookUrl = null) {
  const id = randomUUID();
  jobs.set(id, {
    id,
    status:      'queued',   // queued | processing | completed | failed
    targetUrl,
    webhookUrl,
    createdAt:   Date.now(),
    startedAt:   null,
    completedAt: null,
    result:      null,
    error:       null,
  });
  return id;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}
