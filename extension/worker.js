importScripts('guard.js', 'catalog.js');
'use strict';
const ALARM = 'seat-check';
const ACTIVE = ['watching', 'preparing', 'refreshing', 'submitted', 'restoring', 'stopping', 'recovering', 'login'];
const DEFAULT_CONFIG = { term: '20271', targets: [] };
let generation = 0;
let writes = Promise.resolve();
let commands = Promise.resolve();
let apiQueue = Promise.resolve();
const catalogs = new Map();
let driving = false;
let rerun = false;
// Session storage survives worker suspension, but never grants permission after Chrome restarts.
let enabledRun = null;
let lifecycleDisabled = false;
const clone = value => structuredClone(value);
const canonical = (config, empty = false) => empty && config?.targets?.length === 0
  ? (SeatGuard.termLabel(config.term), { term: String(config.term), targets: [] }) : SeatGuard.normalizeConfig(config);
const active = state => ACTIVE.includes(state.phase);
const getState = async () => (await chrome.storage.local.get('state')).state;
const getConfig = async () => (await chrome.storage.local.get('config')).config || canonical(DEFAULT_CONFIG, true);
async function write(state, version) {
  const task = writes.then(async () => {
    if (version !== generation) return false;
    await chrome.storage.local.set({ state: { ...state, schema: 2 } });
    if (version !== generation) return false;
    await chrome.action.setBadgeText({ text: ({ watching: 'ON', preparing: 'PREP', refreshing: 'OPEN', submitted: 'CHECK', restoring: 'RESET', stopping: 'STOP', recovering: 'SSO', login: 'LOGIN', paused: '!', complete: 'DONE' })[state.phase] || '' });
    await chrome.action.setBadgeBackgroundColor({ color: state.phase === 'watching' ? '#16634b' : '#993333' });
    return true;
  });
  writes = task.catch(() => {});
  return task;
}
async function current(state, version) {
  if (version !== generation) return false;
  const now = await getState();
  return version === generation && now.run === state.run && now.phase === state.phase;
}
async function notify(message, state, version) {
  if (version !== generation || enabledRun !== state.run || lifecycleDisabled) return;
  await chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'USC Seat Watch', message }).catch(() => {});
}
async function release() { await chrome.alarms.clear(ALARM); chrome.power.releaseKeepAwake(); }
async function pause(state, message, version) {
  if (!await current(state, version)) return;
  if (!await write({ ...state, phase: 'paused', message }, version)) return;
  await release();
  await notify(message, state, version);
}
async function send(state, type, extra = {}) {
  const result = await chrome.tabs.sendMessage(state.tabId, { type, run: state.run, tabId: state.tabId, ...extra });
  if (!result) throw new Error('USC tab did not respond. Reload it after updating this extension.');
  if (result.error) { const error = new Error(result.error); error.auth = !!result.auth; error.notSubmitted = !!result.notSubmitted; throw error; }
  return result;
}
async function readBin(state) {
  const bin = await send(state, 'read-bin');
  SeatGuard.assertBin(bin, state.config.term);
  return bin;
}
async function page(state, url, version, reload = false) {
  const tab = await chrome.tabs.get(state.tabId);
  if (tab.status === 'loading') return false;
  if (!await current(state, version)) return false;
  if (tab.url === url && !reload) return true;
  if (tab.url === url) await chrome.tabs.reload(state.tabId, { bypassCache: true });
  else await chrome.tabs.update(state.tabId, { url });
  return false;
}
function status(state, id, value, message = '') {
  return { ...state.targetStates, [id]: { status: value, message } };
}
function courseURL(course, term) {
  return 'https://classes.usc.edu/api/Courses/Course?' + new URLSearchParams({ termCode: term, courseCode: course });
}
function courseData(course, term) {
  return publicData(term + ':' + course, courseURL(course, term), data => {
    if (String(data?.termCode) !== term || SeatGuard.normalizeCourse(data?.scheduledCourseCode?.courseHyphen) !== course || !Array.isArray(data.sections))
      throw new Error('USC returned the wrong course or semester.');
    return data;
  });
}
function publicData(key, url, validate) {
  const request = apiQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(['apiCooldownUntil', 'apiBackoff']);
    const previous = stored.apiBackoff?.[key];
    const until = Math.max(stored.apiCooldownUntil || 0, previous?.until || 0);
    if (until > Date.now()) { const error = new Error('Next lookup after ' + new Date(until).toLocaleTimeString() + '.'); error.cooldown = true; throw error; }
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', headers: { 'X-CSRF': '1' }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) {
        const error = new Error('USC course lookup returned HTTP ' + response.status + '.');
        error.status = response.status;
        error.retryAfterMs = SeatGuard.retryAfterMs(response.headers.get('Retry-After'));
        await response.body?.cancel();
        throw error;
      }
      if (response.status === 204) throw new Error('USC has not published course data for this selection yet.');
      const data = validate(await response.json());
      const backoff = { ...(await chrome.storage.local.get('apiBackoff')).apiBackoff };
      delete backoff[key];
      await chrome.storage.local.set({ apiBackoff: backoff });
      return data;
    } catch (error) {
      const failures = (previous?.failures || 0) + 1;
      const delay = Math.max(Math.min(30000 * 2 ** Math.min(failures, 5), 900000), error.retryAfterMs || 0);
      const next = Date.now() + delay;
      const backoff = { ...(await chrome.storage.local.get('apiBackoff')).apiBackoff, [key]: { failures, until: next } };
      const values = { apiBackoff: backoff };
      if (error.status === 429 || error.retryAfterMs) values.apiCooldownUntil = next;
      await chrome.storage.local.set(values);
      throw error;
    }
  });
  apiQueue = request.catch(() => {});
  return request;
}
async function courseCatalog(term) {
  SeatGuard.termLabel(term);
  const lifetime = 8 * 60 * 60 * 1000;
  const cached = catalogs.get(term);
  if (cached && Date.now() - cached.loadedAt < lifetime) return cached.promise;
  const entry = { loadedAt: Date.now() };
  entry.promise = (async () => {
    const stored = await chrome.storage.session?.get('catalogCache').catch(() => ({}));
    const available = stored?.catalogCache?.[term];
    if (available && Array.isArray(available.courses) && Date.now() - available.loadedAt < lifetime) {
      entry.loadedAt = available.loadedAt;
      return available.courses;
    }
    const url = 'https://classes.usc.edu/api/Search/Autocomplete?' + new URLSearchParams({ termCode: term });
    const courses = await publicData('catalog:' + term, url, data => {
      if (String(data?.termCode) !== term) throw new Error('USC returned a catalog for the wrong semester.');
      return SeatCatalog.normalizeCourses(data);
    });
    if (chrome.storage.session) {
      const cache = { ...stored?.catalogCache, [term]: { loadedAt: Date.now(), courses } };
      const recent = Object.entries(cache).sort((a, b) => b[1].loadedAt - a[1].loadedAt).slice(0, 3);
      await chrome.storage.session.set({ catalogCache: Object.fromEntries(recent) }).catch(() => {});
    }
    return courses;
  })();
  catalogs.set(term, entry);
  if (catalogs.size > 3) catalogs.delete(catalogs.keys().next().value);
  try { return await entry.promise; }
  catch (error) { if (catalogs.get(term) === entry) catalogs.delete(term); throw error; }
}
async function resolveTarget(message) {
  const term = String(message.term);
  SeatGuard.termLabel(term);
  const course = SeatGuard.normalizeCourse(message.course);
  const ids = message.sectionIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 6 || ids.some(id => !/^\d{5}$/.test(String(id))) || new Set(ids).size !== ids.length)
    throw new Error('Enter one to six unique five-digit section IDs.');
  if (message.units !== undefined && (!Array.isArray(message.units) || message.units.length !== ids.length))
    throw new Error('Enter one unit value per section, or leave units blank for fixed-unit courses.');
  const data = await courseData(course, term);
  const sections = ids.map((id, index) => {
    const matches = data.sections.filter(section => String(section.sisSectionId) === String(id));
    if (matches.length !== 1) throw new Error('Section ' + id + ' does not uniquely belong to ' + course + ' in this semester.');
    const allowed = [...new Set((matches[0].units || []).map(value => String(Number(value))))];
    let units = message.units?.[index];
    if (units === undefined || String(units).trim() === '') {
      if (allowed.length !== 1) throw new Error('Section ' + id + ' has variable units. Enter units for each component.');
      units = allowed[0];
    }
    if (!allowed.includes(String(Number(units)))) throw new Error('USC does not list that unit value for section ' + id + '.');
    return { id: String(id), units: String(units) };
  });
  const target = SeatGuard.normalizeConfig({ term, targets: [{ course, sections, grade: message.grade || 'L' }] }).targets[0];
  SeatGuard.availability(data, target, term);
  return target;
}
async function poll(state, version) {
  if (Date.now() - (state.checkedAt || 0) < 30000) return state;
  const results = { ...state.results };
  const targetStates = { ...state.targetStates };
  const cache = new Map();
  for (const target of state.config.targets) {
    if (['registered', 'review', 'blocked'].includes(targetStates[target.id]?.status)) continue;
    if (!await current(state, version)) return null;
    try {
      if (!cache.has(target.course)) cache.set(target.course, courseData(target.course, state.config.term));
      results[target.id] = { ...SeatGuard.availability(await cache.get(target.course), target, state.config.term), checkedAt: Date.now() };
      targetStates[target.id] = { status: 'waiting', message: results[target.id].open ? 'All selected components have seats.' : 'Waiting for seats.' };
    } catch (error) {
      results[target.id] = { open: false, error: error.message, checkedAt: Date.now() };
      targetStates[target.id] = { status: 'waiting', message: error.message + ' Lookup will retry with backoff.' };
    }
  }
  if (!await current(state, version)) return null;
  state = { ...state, results, targetStates, checkedAt: Date.now() };
  return await write(state, version) ? state : null;
}
async function beginLogin(state, version) {
  const next = { ...state, phase: 'recovering', resumePhase: state.phase, loginAt: Date.now(), termSelected: false,
    message: 'Renewing the USC session through normal sign-in redirects.' };
  if (!await write(next, version)) return;
  await page(next, 'https://webreg.usc.edu/Checkout', version, true);
}
async function loginStep(state, version) {
  const tab = await chrome.tabs.get(state.tabId);
  if (tab.status === 'loading') return false;
  if (tab.url?.startsWith('https://webreg.usc.edu/')) {
    const info = await send(state, 'page-info');
    if (info.path === '/Terms' && !state.termSelected) {
      state = { ...state, termSelected: true };
      if (!await write(state, version) || !await current(state, version)) return false;
      await send(state, 'recover-term');
      return false;
    }
    if (info.term === SeatGuard.termLabel(state.config.term)) {
      await readBin(state);
      const resume = state.resumePhase || 'watching';
      const next = { ...state, phase: resume, sessionCheckedAt: Date.now(), message: 'USC session restored.' };
      return await write(next, version);
    }
  }
  if (state.phase === 'recovering' && Date.now() - state.loginAt > 15000) {
    state = { ...state, phase: 'login', message: 'Complete USC sign-in, passkey or Duo in the selected tab. The watchlist resumes afterward.' };
    if (!await write(state, version)) return false;
    await notify(state.message, state, version);
  }
  await poll(state, version);
  return false;
}
async function runMutation(state, kind, row, version, wasMissing = false) {
  let journal = clone(state.journal);
  if (state.phase === 'preparing') {
    const key = kind === 'unschedule' ? 'removed' : 'added';
    if (!journal[key].some(entry => entry.section === row.section)) journal[key].push({ section: row.section, course: row.course, ...(wasMissing ? { wasMissing: true } : {}) });
  }
  const operation = { id: crypto.randomUUID(), kind, section: row.section, course: row.course };
  state = { ...state, journal, pendingMutation: operation };
  if (!await write(state, version) || !await current(state, version)) return false;
  const result = await send(state, 'mutate', { operationId: operation.id });
  if (!await current(state, version)) return false;
  if (result.stale) {
    // No click occurred; re-render the canonical page before a fresh attempt.
    state = { ...state, pendingMutation: null };
    if (!await write(state, version)) return false;
    const destination = kind === 'add' ? 'https://webreg.usc.edu/Courses?Course=' + encodeURIComponent(row.course) : 'https://webreg.usc.edu/CourseBin';
    await page(state, destination, version, true);
    return false;
  }
  if (!result.confirmed) throw new Error('USC did not confirm the section operation.');
  state = { ...state, pendingMutation: null };
  if (!await write(state, version)) return false;
  await page(state, 'https://webreg.usc.edu/CourseBin', version, true);
  return false;
}
async function startRestore(state, version, afterRestore = 'watching', message = 'Restoring the original scheduled selections.') {
  if (state.attempt) throw new Error('Review the uncertain registration result before restoring selections.');
  const results = state.activeTarget ? { ...state.results, [state.activeTarget]: { ...state.results[state.activeTarget], open: false } } : state.results;
  return write({ ...state, results, phase: 'restoring', afterRestore, pendingMutation: null, message }, version);
}
async function preparing(state, version) {
  if (state.pendingMutation) throw new Error('A previous section change has an uncertain result. Review Course Bin, then restore selections.');
  if (Date.now() - state.preparingAt > 180000) throw new Error('Checkout preparation timed out. Restore the saved selections before restarting.');
  const target = state.config.targets.find(item => item.id === state.activeTarget);
  if (!target) throw new Error('The active watchlist target is missing.');
  const bin = await readBin(state);
  let plan;
  try { plan = SeatGuard.isolationPlan(bin, target, state.config.term); }
  catch (error) {
    return startRestore({ ...state, targetStates: status(state, target.id, 'blocked', error.message) }, version);
  }
  if (plan.registered) {
    return startRestore({ ...state, targetStates: status(state, target.id, 'registered', 'Confirmed registered in USC.') }, version);
  }
  if (plan.unschedule.length) {
    if (!await page(state, 'https://webreg.usc.edu/CourseBin', version)) return false;
    return runMutation(state, 'unschedule', bin.rows.find(row => row.section === plan.unschedule[0]), version);
  }
  if (plan.missing.length) {
    if (!await page(state, 'https://webreg.usc.edu/Courses?Course=' + encodeURIComponent(target.course), version)) return false;
    return runMutation(state, 'add', { section: plan.missing[0], course: target.course }, version, true);
  }
  if (plan.schedule.length) {
    if (!await page(state, 'https://webreg.usc.edu/CourseBin', version)) return false;
    return runMutation(state, 'schedule', bin.rows.find(row => row.section === plan.schedule[0]), version);
  }
  const next = { ...state, phase: 'refreshing', openedAt: Date.now(), message: 'Only ' + target.course + ' is scheduled for this checkout. Validating availability.' };
  if (!await write(next, version)) return false;
  await page(next, 'https://webreg.usc.edu/Checkout', version, true);
  return false;
}
async function refreshCheckout(state, version) {
  if (!await page(state, 'https://webreg.usc.edu/Checkout', version)) return false;
  if (Date.now() - state.openedAt > 90000) return startRestore(state, version, 'watching', 'Checkout freshness expired. Restoring selections before trying again.');
  const target = state.config.targets.find(item => item.id === state.activeTarget);
  const fresh = await send(state, 'read-checkout');
  const live = await send(state, 'live-checkout');
  const error = SeatGuard.validateCheckout(fresh, target, state.config.term, true) || SeatGuard.validateCheckout(live, target, state.config.term, true);
  if (error === 'closed') return startRestore(state, version, 'watching', 'A component filled again. Restoring other selections.');
  if (error) {
    return startRestore({ ...state, targetStates: status(state, target.id, 'blocked', error) }, version);
  }
  let available;
  try { available = SeatGuard.availability(await courseData(target.course, state.config.term), target, state.config.term); }
  catch (error) { return startRestore(state, version, 'watching', 'Seat lookup delayed. Restoring selections: ' + error.message); }
  if (!available.open) return startRestore(state, version, 'watching', 'The seat filled again. Restoring other selections.');
  if (!await current(state, version)) return false;
  const attempt = { id: crypto.randomUUID(), targetId: target.id, submittedAt: Date.now() };
  const next = { ...state, phase: 'submitted', attempt, targetStates: status(state, target.id, 'submitted', 'Submission requested; waiting for USC confirmation.'), message: 'Submitting only ' + target.course + '. No other course is included.' };
  if (!await write(next, version) || !await current(next, version)) return false;
  try {
    const result = await send(next, 'submit', { attemptId: attempt.id });
    if (!result.clicked) throw new Error('Submission was not acknowledged.');
  } catch (error) {
    if (!await current(next, version)) return false;
    if (error.notSubmitted) return startRestore({ ...next, attempt: null, targetStates: status(next, target.id, 'blocked', error.message) }, version);
    // A closed message port may mean successful navigation. Keep the durable claim and inspect USC.
  }
  return true;
}
async function verifySubmission(state, version) {
  const target = state.config.targets.find(item => item.id === state.attempt?.targetId);
  if (!target) throw new Error('A previous submission requires manual review.');
  const bin = await readBin(state);
  const rows = target.sections.map(section => bin.rows.find(row => row.section === section.id));
  if (rows.every(row => row && row.course === target.course && row.registered)) {
    const next = { ...state, attempt: null, targetStates: status(state, target.id, 'registered', 'Confirmed registered in USC.') };
    await notify(target.course + ': USC confirms registration for sections ' + target.sections.map(section => section.id).join(', ') + '.', state, version);
    return startRestore(next, version);
  }
  if (Date.now() - state.attempt.submittedAt > 45000 || rows.some(row => row?.registered)) {
    const next = { ...state, targetStates: status(state, target.id, 'review', 'Verify the registration result in USC before continuing.') };
    await pause(next, 'USC has not confirmed the complete registration. Review the result before another checkout. No automatic retry will occur.', version);
  }
  return false;
}
async function restoring(state, version) {
  if (state.attempt) throw new Error('Review the prior submission before restoring scheduled selections.');
  if (!state.journal) {
    const next = { ...state, phase: state.afterRestore === 'idle' || state.phase === 'stopping' ? 'idle' : 'watching', activeTarget: null, pendingMutation: null };
    if (!await write(next, version)) return false;
    if (!active(next)) await release();
    return active(next);
  }
  if (state.pendingMutation) throw new Error('A restoration change is uncertain. Check Course Bin and use Restore scheduled selections.');
  if (!await page(state, 'https://webreg.usc.edu/CourseBin', version)) return false;
  const bin = await readBin(state);
  const plan = SeatGuard.restorePlan(bin, state.journal, state.config.term);
  const kind = plan.unschedule.length ? 'unschedule' : 'schedule';
  const section = plan[kind][0];
  if (section) return runMutation(state, kind, bin.rows.find(row => row.section === section), version);
  const finished = { ...state, journal: null, activeTarget: null, pendingMutation: null, phase: state.afterRestore === 'idle' || state.phase === 'stopping' ? 'idle' : 'watching',
    message: state.afterRestore === 'idle' || state.phase === 'stopping' ? 'Stopped. Original scheduled selections restored.' : 'Original selections restored. Monitoring the remaining watchlist.' };
  if (!await write(finished, version)) return false;
  if (!active(finished)) await release();
  return active(finished);
}
async function advance(state, version) {
  if (!active(state)) return false;
  if (['recovering', 'login'].includes(state.phase)) return loginStep(state, version);
  const tab = await chrome.tabs.get(state.tabId);
  if (tab.status === 'loading') return false;
  if (!tab.url?.startsWith('https://webreg.usc.edu/')) { await beginLogin(state, version); return false; }
  if (state.phase === 'preparing') return preparing(state, version);
  if (state.phase === 'refreshing') return refreshCheckout(state, version);
  if (state.phase === 'submitted') return verifySubmission(state, version);
  if (state.phase === 'restoring' || state.phase === 'stopping') return restoring(state, version);
  if (!state.sessionCheckedAt || Date.now() - state.sessionCheckedAt > 300000) {
    const bin = await readBin(state);
    const targetStates = { ...state.targetStates };
    for (const target of state.config.targets) {
      const rows = target.sections.map(section => bin.rows.find(row => row.section === section.id));
      if (rows.every(row => row && row.course === target.course && row.registered)) targetStates[target.id] = { status: 'registered', message: 'Confirmed registered in USC.' };
    }
    state = { ...state, targetStates, sessionCheckedAt: Date.now() };
    if (!await write(state, version)) return false;
  }
  if (state.config.targets.every(target => ['registered', 'blocked', 'review'].includes(state.targetStates[target.id]?.status))) {
    const complete = state.config.targets.every(target => state.targetStates[target.id]?.status === 'registered');
    if (complete) { await write({ ...state, phase: 'complete', message: 'USC confirms every watchlist target is registered.' }, version); await release(); }
    else await pause(state, 'Remaining targets need review. Check their messages before restarting.', version);
    return false;
  }
  state = await poll(state, version);
  if (!state) return false;
  const target = state.config.targets.find(item => state.targetStates[item.id]?.status === 'waiting' && state.results[item.id]?.open);
  if (!target) return false;
  const next = { ...state, phase: 'preparing', activeTarget: target.id, preparingAt: Date.now(), pendingMutation: null,
    journal: { targetId: target.id, removed: [], added: [], createdAt: Date.now() }, message: 'Preparing an isolated checkout for ' + target.course + '.' };
  return write(next, version);
}
async function drive() {
  await ready;
  if (driving) { rerun = true; return; }
  driving = true;
  const version = generation;
  try {
    for (let steps = 0; steps < 30; steps++) {
      rerun = false;
      const state = await getState();
      if (version !== generation) { rerun = true; break; }
      try {
        const again = await advance(state, version);
        if (!again && !rerun) break;
      } catch (error) {
        const latest = await getState();
        if (latest.run !== state.run || version !== generation) break;
        if (error.auth && !latest.pendingMutation) await beginLogin(latest, version);
        else await pause(latest, error.message + (latest.journal ? ' Scheduled selections are saved for restoration.' : ''), version);
        break;
      }
    }
  } finally {
    driving = false;
    if (rerun) { rerun = false; void drive(); }
  }
}
async function handle(message, receiptVersion) {
  await ready;
  if (message.type === 'status') return { ...await getState(), config: await getConfig() };
  if (message.type === 'load-config') return getConfig();
  if (message.type === 'resolve-target') return resolveTarget(message);
  if (message.type === 'search-courses') {
    const term = String(message.term);
    SeatGuard.termLabel(term);
    const query = String(message.query || '').trim();
    if (query.length > 100) throw new Error('Use a shorter course search.');
    if (query.length < 2) return { courses: [], total: 0 };
    return SeatCatalog.search(await courseCatalog(term), query, 20);
  }
  if (message.type === 'course-sections') {
    const term = String(message.term), course = SeatGuard.normalizeCourse(message.course);
    SeatGuard.termLabel(term);
    return SeatCatalog.normalizeSections(await courseData(course, term), term, course);
  }
  if (message.type !== 'stop' && receiptVersion !== generation) throw new Error('This command was cancelled by a newer action.');
  let state = await getState();
  if (message.type === 'stop') {
    const version = receiptVersion;
    await chrome.storage.session.set({ enabledRun: null });
    if (state.attempt || state.pendingMutation) {
      await write({ ...state, phase: 'paused', message: state.attempt
        ? 'Stopped. A prior submission needs review before selections can be restored.'
        : 'Stopped during a section change. Review Course Bin, then restore the saved selections.' }, version);
      await release();
    } else {
      const next = { ...state, phase: state.journal ? 'stopping' : 'idle', pendingMutation: null, afterRestore: 'idle', message: state.journal ? 'Stopping submissions and restoring original selections.' : 'Stopped by you.' };
      await write(next, version);
      if (next.journal) { await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); void drive(); }
      else await release();
    }
    return getState();
  }
  if (message.type === 'save-config') {
    if (active(state) || state.journal || state.attempt) throw new Error('Stop and finish checkout recovery before editing the watchlist.');
    const config = canonical(message.config, true);
    await chrome.storage.local.set({ config });
    await write({ ...state, config, targetStates: {}, results: {}, message: 'Watchlist saved.' }, generation);
    return config;
  }
  if (message.type === 'cleanup' || message.type === 'acknowledge-review') {
    if (active(state)) throw new Error('Stop the active watch before manual recovery.');
    if (state.attempt && message.type !== 'acknowledge-review') throw new Error('Review the USC submission result first.');
    const version = ++generation;
    state = { ...state, tabId: Number(message.tabId), pendingMutation: null };
    if (message.type === 'acknowledge-review') {
      await readBin(state);
      state = { ...state, attempt: null };
    }
    const next = { ...state, run: crypto.randomUUID(), phase: state.journal ? 'restoring' : 'idle', afterRestore: 'idle', message: 'Restoring scheduled selections. No registration will be submitted.' };
    if (!await write(next, version)) throw new Error('Recovery was cancelled.');
    if (next.journal) { chrome.power.requestKeepAwake('system'); await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); void drive(); }
    return next;
  }
  if (message.type === 'arm') {
    if (active(state)) throw new Error('Automatic registration is already running.');
    if (state.journal || state.attempt || state.pendingMutation) throw new Error('Finish the saved checkout recovery before starting another watch.');
    const version = ++generation;
    const config = canonical(await getConfig());
    const next = { schema: 2, phase: 'watching', run: crypto.randomUUID(), tabId: Number(message.tabId), config,
      targetStates: Object.fromEntries(config.targets.map(target => [target.id, { status: 'waiting', message: 'Waiting for the next seat check.' }])), results: {}, message: 'Automatic registration is ON. Each available course uses its own checkout.' };
    const tab = await chrome.tabs.get(next.tabId);
    if (!tab.url?.startsWith('https://webreg.usc.edu/')) throw new Error('Choose a signed-in USC Web Registration tab.');
    await readBin(next);
    if (version !== generation || !await write(next, version)) throw new Error('Starting was cancelled.');
    await chrome.storage.session.set({ enabledRun: next.run });
    if (version !== generation) throw new Error('Starting was cancelled.');
    lifecycleDisabled = false;
    enabledRun = next.run;
    chrome.power.requestKeepAwake('system');
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    void drive();
    return next;
  }
  throw new Error('Unknown popup command.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'stop') enabledRun = null;
  const version = message.type === 'stop' ? ++generation : generation;
  const readonly = ['status', 'load-config', 'resolve-target', 'search-courses', 'course-sections'].includes(message.type);
  const task = readonly ? handle(message, version) : commands.catch(() => {}).then(() => handle(message, version));
  if (!readonly) commands = task.catch(() => {});
  task.then(reply, error => reply({ error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void drive(); });
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  await ready;
  if (change.status === 'complete' && (await getState()).tabId === tabId) void drive();
});
chrome.tabs.onRemoved.addListener(async tabId => {
  await ready;
  const state = await getState();
  if (state.tabId === tabId && active(state)) await pause(state, 'The registration tab closed. Reopen USC and restore any saved selections before restarting.', generation);
});
async function initialize() {
  const stored = await chrome.storage.local.get(['state', 'config']);
  let config;
  try { config = canonical(stored.config || DEFAULT_CONFIG, true); } catch { config = canonical(DEFAULT_CONFIG, true); }
  await chrome.storage.local.set({ config });
  let state = stored.state;
  const session = await chrome.storage.session.get('enabledRun');
  enabledRun = lifecycleDisabled ? null : session.enabledRun || null;
  if (state?.schema !== 2) state = { schema: 2, config, phase: 'idle', results: {}, targetStates: {}, message: 'Watchlist ready. Reload the USC tab after updating, then Start.' };
  else if (state.pendingMutation || state.attempt) state = { ...state, phase: 'paused', message: 'An interrupted checkout needs review. No operation will be replayed.' };
  else if (active(state) && enabledRun !== state.run) state = { ...state, phase: state.journal ? 'paused' : 'idle', message: 'Automatic registration is OFF. Open the popup and Start when ready.' };
  await write(state, generation);
  if (active(state)) {
    chrome.power.requestKeepAwake('system');
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  } else await release();
}
const ready = initialize();
async function restart(message) {
  lifecycleDisabled = true;
  enabledRun = null;
  await ready;
  const version = ++generation;
  const state = await getState();
  await chrome.storage.session.set({ enabledRun: null });
  await write({ ...state, phase: state.journal || state.attempt ? 'paused' : 'idle', message }, version);
  await release();
}
chrome.runtime.onStartup.addListener(() => { void restart('Chrome restarted. Review saved checkout recovery, then Start again.'); });
chrome.runtime.onInstalled.addListener(() => { void restart('Extension updated. Reload the USC tab; restore saved selections if needed, then Start.'); });
