import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// A deliberately small, sequential probe. This does not discover a rate limit.
const endpoint = 'https://classes.usc.edu/api/Courses/Course?termCode=20271&courseCode=CSCI-587';
const sampleCount = Number(process.argv[2] || 6);
const intervalMs = 30_000;
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10) {
  throw new Error('Provide a sample count from 1 to 10.');
}
const report = {
  endpoint, sampleCount, intervalMs, timeoutMs: 12_000,
  startedAt: new Date().toISOString(),
  description: 'Sequential public requests with credentials omitted; no retries or concurrency.',
  limitation: 'A short successful sample cannot establish USC rate limits or guarantee long-term availability.',
  samples: []
};
const started = performance.now();
for (let index = 0; index < sampleCount; index++) {
  const waitMs = started + index * intervalMs - performance.now();
  if (waitMs > 0) await delay(waitMs);
  const requestStart = performance.now();
  const sample = { index: index + 1, at: new Date().toISOString() };
  try {
    const response = await fetch(endpoint, {
      credentials: 'omit', cache: 'no-store', headers: { 'X-CSRF': '1' },
      signal: AbortSignal.timeout(report.timeoutMs)
    });
    sample.status = response.status;
    sample.retryAfter = response.headers.get('retry-after');
    sample.cacheControl = response.headers.get('cache-control');
    sample.age = response.headers.get('age');
    if (response.ok) {
      const data = await response.json();
      const section = data.sections?.find(value => String(value.sisSectionId) === '30306');
      sample.course = data.scheduledCourseCode?.courseHyphen;
      sample.term = data.termCode;
      sample.section = section?.sisSectionId;
      sample.registeredSeats = section?.registeredSeats;
      sample.totalSeats = section?.totalSeats;
      sample.isFull = section?.isFull;
      sample.isCancelled = section?.isCancelled;
      sample.validTarget = sample.course === 'CSCI-587' && String(sample.term) === '20271' && String(sample.section) === '30306';
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    sample.error = { name: error.name, message: error.message };
  }
  sample.latencyMs = Math.round(performance.now() - requestStart);
  report.samples.push(sample);
  report.updatedAt = new Date().toISOString();
  await writeFile(new URL('../docs/research/api-check-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(sample));
  // Honor a server rejection: do not keep probing after throttling or service trouble.
  if (sample.status === 429 || sample.status >= 500) {
    report.stoppedEarly = 'Stopped after throttling or server failure.';
    break;
  }
}
report.completedAt = new Date().toISOString();
report.summary = {
  completedSamples: report.samples.length,
  http200: report.samples.filter(s => s.status === 200).length,
  timeouts: report.samples.filter(s => s.error?.name === 'TimeoutError').length,
  throttled: report.samples.filter(s => s.status === 429).length,
  maxLatencyMs: Math.max(...report.samples.map(s => s.latencyMs))
};
await writeFile(new URL('../docs/research/api-check-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
