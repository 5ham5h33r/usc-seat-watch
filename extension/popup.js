'use strict';
const $ = id => document.getElementById(id);
const activePhases = ['watching', 'preparing', 'refreshing', 'submitted', 'restoring', 'recovering', 'login', 'stopping'];
const gradeLabels = { L: 'Letter Grade', PN: 'Pass/No Pass', V: 'Audit' };
let latestState = { phase: 'idle', message: 'Loading registration status...' };
let config = { term: '20271', targets: [] };
let loaded = false, actionPending = false, refreshPending = false, termDirty = false;
let actionVersion = 0, actionError = '', statusError = '';
let lastTargetCount = null;
let requestVersion = 0, searchTimer = null, searchBusy = false, sectionsBusy = false;
let selectedCourse = null;
let sectionChoices = new Map();
let catalogWasLocked = false;
async function command(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (result?.error) throw new Error(result.error);
  if (!result) throw new Error('The registration helper did not respond. Reopen this popup.');
  return result;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}
function active() { return activePhases.includes(latestState.phase); }
function locked() { return active() || !!latestState.journal || !!latestState.attempt; }
function termLabel(term) {
  const season = { 1: 'Spring', 2: 'Summer', 3: 'Fall' }[term?.slice(-1)];
  return season ? season + ' ' + term.slice(0, 4) : 'Term ' + term;
}
function ensureTermOption(term) {
  if (![...$('term').options].some(option => option.value === term)) {
    const option = node('option', null, termLabel(term)); option.value = term; $('term').append(option);
  }
}
function semesterOptions() {
  const yearNow = new Date().getFullYear();
  for (let year = yearNow - 1; year <= yearNow + 2; year++) for (const season of ['1', '2', '3']) ensureTermOption(String(year) + season);
  $('term').value = config.term;
}
function invalidateCatalogRequests() {
  requestVersion++;
  clearTimeout(searchTimer); searchTimer = null;
  if (searchBusy) $('search-message').textContent = 'Search cancelled. Edit your search to try again.';
  if (sectionsBusy) $('section-message').textContent = 'Loading cancelled. Search for the course again.';
  searchBusy = false; sectionsBusy = false;
}
function clearCourseSearch() {
  invalidateCatalogRequests(); selectedCourse = null; sectionChoices = new Map();
  $('search').value = ''; $('course-results').replaceChildren(); $('section-list').replaceChildren();
  $('selected-course').hidden = true;
  $('search-message').textContent = 'Type at least two characters to search any department.';
  $('section-message').textContent = '';
}
function catalogCurrent(version, term) {
  return version === requestVersion && config.term === term && $('term').value === term && loaded && !locked() && !actionPending;
}
function selectedSections() { return [...sectionChoices.values()].filter(choice => choice.checked); }
function sectionSelectable(section) {
  return !section.cancelled && !!section.units.length && Number.isFinite(section.total) && section.total > 0 &&
    Number.isFinite(section.registered) && section.registered >= 0;
}
function updateCatalogControls() {
  const disabled = !loaded || actionPending || locked() || $('term').value !== config.term;
  $('search').disabled = disabled;
  $('grade').disabled = disabled;
  for (const button of $('course-results').querySelectorAll('button')) button.disabled = disabled;
  for (const control of $('section-list').querySelectorAll('input,select')) control.disabled = disabled || control.dataset.unavailable === 'true';
  const choices = selectedSections();
  $('add-course').disabled = disabled || sectionsBusy || !selectedCourse || !choices.length ||
    choices.some(choice => !choice.units || !choice.section.units.includes(choice.units));
}
function renderCourseSections() {
  $('selected-course').hidden = !selectedCourse;
  $('section-list').replaceChildren();
  if (!selectedCourse) { updateCatalogControls(); return; }
  $('selected-course-name').textContent = selectedCourse.code.replace('-', ' ') + (selectedCourse.title ? ': ' + selectedCourse.title : '');
  for (const section of selectedCourse.sections || []) {
    const choice = sectionChoices.get(section.id);
    const card = node('div', 'section-card');
    const label = node('label', 'section-choice');
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = section.id;
    checkbox.id = 'choose-section-' + section.id; checkbox.checked = choice.checked;
    const unavailable = !sectionSelectable(section);
    checkbox.dataset.unavailable = String(unavailable);
    const info = node('span', 'section-info');
    info.append(node('strong', null, (section.type || 'Section') + ' ' + section.id));
    if (section.instructors) info.append(node('span', 'section-detail', section.instructors));
    const meeting = [section.days, section.time, section.location].filter(Boolean).join(' · ');
    if (meeting) info.append(node('span', 'section-detail', meeting));
    let seatLabel = section.cancelled ? 'Cancelled' : Number.isFinite(section.registered) && Number.isFinite(section.total) && section.total > 0 && section.registered >= 0
      ? section.registered + '/' + section.total + ' filled · ' + (section.open ? 'Open' : 'Closed') : 'Seat data unavailable';
    if (!section.units.length) seatLabel += ' · Units unavailable';
    info.append(node('span', 'section-availability' + (section.open ? ' available' : ''), seatLabel));
    if (section.units.length === 1) info.append(node('span', 'section-detail', section.units[0] + ' units'));
    label.append(checkbox, info); card.append(label);
    const notes = [...new Set([section.notes, section.description].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
    if (notes.length) {
      const details = node('details', 'section-notes');
      details.append(node('summary', null, 'Registration notes'));
      for (const note of notes) details.append(node('p', null, note));
      card.append(details);
    }
    const unitsArea = node('div', 'unit-choice');
    unitsArea.hidden = !choice.checked || section.units.length < 2;
    if (section.units.length > 1) {
      const unitsLabel = node('label', null, 'Units for section ' + section.id), unitsSelect = node('select');
      unitsSelect.id = 'section-units-' + section.id; unitsLabel.htmlFor = unitsSelect.id;
      const placeholder = node('option', null, 'Choose units'); placeholder.value = ''; unitsSelect.append(placeholder);
      for (const value of section.units) { const option = node('option', null, value + ' units'); option.value = value; unitsSelect.append(option); }
      unitsSelect.value = choice.units;
      unitsSelect.addEventListener('change', () => { choice.units = unitsSelect.value; updateCatalogControls(); });
      unitsArea.append(unitsLabel, unitsSelect);
    }
    checkbox.addEventListener('change', () => { choice.checked = checkbox.checked; unitsArea.hidden = !choice.checked || section.units.length < 2; updateCatalogControls(); });
    card.append(unitsArea); $('section-list').append(card);
  }
  updateCatalogControls();
}
async function selectCourse(course) {
  invalidateCatalogRequests();
  const version = requestVersion, term = config.term;
  selectedCourse = { code: course.code, title: course.title, sections: [] }; sectionChoices = new Map(); sectionsBusy = true;
  $('course-results').replaceChildren(); $('search-message').textContent = 'Search above to choose a different course.';
  $('section-message').textContent = 'Loading sections from USC...'; renderCourseSections();
  try {
    const result = await command('course-sections', { term, course: course.code });
    if (!catalogCurrent(version, term)) return;
    if (result.term !== term || result.code !== course.code || !Array.isArray(result.sections)) throw new Error('USC returned unexpected course data. Search again.');
    selectedCourse = result;
    for (const section of result.sections) {
      section.units = Array.isArray(section.units) ? section.units.map(String) : [];
      sectionChoices.set(section.id, { section, checked: result.sections.length === 1 && sectionSelectable(section), units: section.units.length === 1 ? section.units[0] : '' });
    }
    sectionsBusy = false;
    $('section-message').textContent = result.sections.length ? 'Select all sections you need. Closed sections can be watched.' : 'USC has no sections listed for this course in this semester.';
    renderCourseSections();
  } catch (error) {
    if (!catalogCurrent(version, term)) return;
    sectionsBusy = false; $('section-message').textContent = error.message; renderCourseSections();
  }
}
function queueCourseSearch() {
  invalidateCatalogRequests(); selectedCourse = null; sectionChoices = new Map(); renderCourseSections();
  $('course-results').replaceChildren();
  const query = $('search').value.trim(), term = config.term, version = requestVersion;
  if (query.length < 2) { $('search-message').textContent = 'Type at least two characters to search any department.'; return; }
  if (!catalogCurrent(version, term)) return;
  searchBusy = true; $('search-message').textContent = 'Searching USC courses...';
  searchTimer = setTimeout(async () => {
    try {
      const result = await command('search-courses', { term, query });
      if (!catalogCurrent(version, term)) return;
      if (!Array.isArray(result.courses)) throw new Error('USC course results are unavailable. Try your search again.');
      searchBusy = false;
      $('search-message').textContent = !result.courses.length ? 'No courses found. Try a department code or another title.' :
        result.total > result.courses.length ? 'Showing ' + result.courses.length + ' of ' + result.total + ' courses. Refine your search to see more.' : 'Choose a course to see its sections.';
      const fragment = document.createDocumentFragment();
      for (const course of result.courses) {
        const button = node('button', 'course-result'); button.type = 'button';
        button.append(node('strong', null, course.code.replace('-', ' ')), node('span', null, course.title));
        button.addEventListener('click', () => { if (!button.disabled) void selectCourse(course); }); fragment.append(button);
      }
      $('course-results').replaceChildren(fragment); updateCatalogControls();
    } catch (error) {
      if (!catalogCurrent(version, term)) return;
      searchBusy = false; $('search-message').textContent = error.message;
    }
  }, 250);
}
function adoptConfig(value) {
  if (!value || !Array.isArray(value.targets) || typeof value.term !== 'string') throw new Error('The helper returned an invalid watchlist.');
  if (config.term !== value.term) clearCourseSearch();
  config = value; ensureTermOption(config.term);
  if (lastTargetCount === null || (lastTargetCount > 0 && config.targets.length === 0))
    $('editor').open = config.targets.length === 0;
  lastTargetCount = config.targets.length;
  latestState = { ...latestState, config: value };
  if (!termDirty) $('term').value = config.term;
}
function renderTargets() {
  const fragment = document.createDocumentFragment();
  for (const target of config.targets || []) {
    const row = node('article', 'course-row'), top = node('div', 'course-top'), identity = node('div');
    identity.append(node('div', 'course-name', target.course?.replace('-', ' ')));
    identity.append(node('div', 'course-meta', (target.sections || []).map(s => s.id + (s.units != null ? ' / ' + s.units + ' units' : '')).join(' + ')));
    identity.append(node('div', 'course-meta', gradeLabels[target.grade] || target.grade));
    top.append(identity);
    const remove = node('button', 'remove', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove ' + target.course + ' from the watchlist');
    remove.disabled = actionPending || locked();
    remove.addEventListener('click', () => void perform(async version => {
      const updated = await command('save-config', { config: { ...config, targets: config.targets.filter(t => t.id !== target.id) } });
      ensureCurrent(version); adoptConfig(updated);
      const state = await command('status'); ensureCurrent(version); latestState = state;
    }));
    top.append(remove); row.append(top);
    const targetState = latestState.targetStates?.[target.id], status = targetState?.status || 'waiting';
    const labels = { waiting: active() ? 'Waiting for seats' : 'Ready to watch', registered: 'Registered in USC', submitted: 'Submitted - verify in USC', review: 'Review needed', blocked: 'Blocked' };
    row.append(node('div', 'course-state ' + status, labels[status] || status));
    const result = latestState.results?.[target.id];
    if (Array.isArray(result?.sections)) {
      const seats = node('div', 'seats');
      for (const section of result.sections) if (Number.isFinite(section.registered) && Number.isFinite(section.total))
        seats.append(node('span', 'seat' + (section.open ? ' open' : ''), section.id + ': ' + section.registered + '/' + section.total + ' filled'));
      row.append(seats);
    }
    if (targetState?.message) row.append(node('p', 'target-message', targetState.message));
    fragment.append(row);
  }
  $('watchlist').replaceChildren(fragment);
  $('empty-list').hidden = !!config.targets?.length;
  $('course-count').textContent = (config.targets?.length || 0) + (config.targets?.length === 1 ? ' course' : ' courses');
  $('term-label').textContent = termLabel(config.term);
}
function render(state = latestState) {
  latestState = state;
  if (state.config) adoptConfig(state.config);
  const running = active(), termChanged = $('term').value.trim() !== config.term;
  if (locked() && !catalogWasLocked) invalidateCatalogRequests();
  catalogWasLocked = locked();
  $('phase').textContent = running ? 'Automatic registration is ON' : 'Automatic registration is OFF';
  $('phase').classList.toggle('on', running);
  $('message').textContent = state.message || (running ? 'Monitoring your watchlist.' : 'Ready to start.');
  $('checked').textContent = state.checkedAt ? 'Last watchlist check: ' + new Date(state.checkedAt).toLocaleTimeString() : '';
  if (state.tabId != null && running) {
    let selected = [...$('tab').options].find(option => option.value === String(state.tabId));
    if (!selected) { selected = node('option', null, 'Saved registration tab (sign-in or recovery)'); selected.value = String(state.tabId); $('tab').append(selected); }
    $('tab').value = String(state.tabId);
  }
  $('tab').disabled = actionPending || running;
  $('arm').textContent = actionPending ? 'Working...' : running ? 'Automatic registration is ON' : 'Start automatic registration';
  $('arm').disabled = !loaded || actionPending || running || !!state.journal || !!state.attempt || !$('tab').value || !config.targets?.length;
  $('stop').disabled = !loaded || (!running && !actionPending);
  $('review-panel').hidden = !state.attempt;
  $('review').disabled = actionPending || running || !$('tab').value;
  $('cleanup-panel').hidden = !state.journal || !!state.attempt;
  $('cleanup').disabled = actionPending || running || !$('tab').value;
  const editLocked = !loaded || actionPending || locked();
  $('term').disabled = editLocked;
  $('save-term').disabled = editLocked || !termChanged;
  $('save-term').textContent = termChanged && config.targets?.length ? 'Use semester and clear list' : 'Use semester';
  $('term-note').textContent = termChanged ? 'Save this semester before searching. Changing semester clears the current watchlist.' : 'Search USC\'s course list for this semester.';
  $('term-note').classList.toggle('pending', termChanged);
  updateCatalogControls();
  $('editor-lock').hidden = !locked();
  renderTargets();
  const error = actionError || statusError || (loaded && !running && !$('tab').value ? 'Open USC Web Registration in Chrome, then reopen this popup.' : '');
  $('error').textContent = error; $('error').hidden = !error;
}
function ensureCurrent(version) { if (version !== actionVersion) throw new Error('The operation was cancelled.'); }
async function refresh() {
  if (actionPending || refreshPending) return;
  refreshPending = true;
  const version = actionVersion;
  try { const state = await command('status'); if (!actionPending && version === actionVersion) { statusError = ''; render(state); } }
  catch (error) { if (!actionPending && version === actionVersion) { statusError = error.message; render(); } }
  finally { refreshPending = false; }
}
async function perform(work, interrupt = false) {
  if (actionPending && !interrupt) return;
  const version = ++actionVersion;
  invalidateCatalogRequests();
  actionPending = true; actionError = ''; statusError = ''; render();
  try { await work(version); }
  catch (error) { if (version === actionVersion) actionError = error.message; }
  finally { if (version === actionVersion) { actionPending = false; render(); } }
}
function stateCommand(type) {
  return perform(async version => { const state = await command(type, { tabId: Number($('tab').value) }); ensureCurrent(version); latestState = state; }, type === 'stop');
}
$('arm').addEventListener('click', () => { if (!$('arm').disabled) void stateCommand('arm'); });
$('stop').addEventListener('click', () => { void stateCommand('stop'); });
$('cleanup').addEventListener('click', () => { void stateCommand('cleanup'); });
$('review').addEventListener('click', () => { void stateCommand('acknowledge-review'); });
$('tab').addEventListener('change', () => { actionError = ''; statusError = ''; render(); });
$('term').addEventListener('change', () => { termDirty = true; clearCourseSearch(); render(); });
$('search').addEventListener('input', queueCourseSearch);
$('save-term').addEventListener('click', () => void perform(async version => {
  const term = $('term').value.trim();
  if (!/^\d{4}[123]$/.test(term)) throw new Error('Choose a USC semester.');
  const updated = await command('save-config', { config: { term, targets: [] } });
  ensureCurrent(version); termDirty = false; adoptConfig(updated);
  const state = await command('status'); ensureCurrent(version); latestState = state;
}));
$('add-course').addEventListener('click', () => {
  if ($('add-course').disabled) return;
  const course = selectedCourse.code, term = config.term, choices = selectedSections(), grade = $('grade').value;
  void perform(async version => {
    if (!choices.length || choices.some(choice => !choice.units)) throw new Error('Choose all required sections and their units.');
    const args = { term, course, sectionIds: choices.map(choice => choice.section.id), units: choices.map(choice => choice.units), grade };
    const resolved = await command('resolve-target', args); ensureCurrent(version);
    if (config.targets.some(target => target.id === resolved.id)) throw new Error('This course bundle is already on your watchlist.');
    const updated = await command('save-config', { config: { ...config, targets: [...config.targets, resolved] } });
    ensureCurrent(version); adoptConfig(updated);
    clearCourseSearch();
    const state = await command('status'); ensureCurrent(version); latestState = state;
  });
});
semesterOptions();
(async () => {
  try {
    const [tabs, saved, state] = await Promise.all([chrome.tabs.query({ url: 'https://webreg.usc.edu/*' }), command('load-config'), command('status')]);
    for (const tab of tabs) { const option = node('option', null, tab.title || 'USC Web Registration'); option.value = String(tab.id); $('tab').append(option); }
    if (state.tabId != null && tabs.some(tab => tab.id === state.tabId)) $('tab').value = String(state.tabId);
    adoptConfig(saved); loaded = true; render(state);
  } catch (error) { statusError = error.message; render(); }
})();
setInterval(refresh, 1500);
