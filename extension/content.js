(() => {
  'use strict';
  const { text } = SeatDOM;
  function loginError() { const error = new Error('USC sign-in is required.'); error.auth = true; return error; }
  async function read(path, parser) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(12000) });
    if (response.type === 'opaqueredirect' || response.status === 401) throw loginError();
    if (!response.ok) throw new Error('USC returned HTTP ' + response.status + ' for ' + path + '.');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (!doc.getElementById('activeTermTab')) throw loginError();
    return parser(doc);
  }
  const readBin = () => read('/CourseBin', SeatDOM.bin);
  async function claim(message, phases) {
    const { state } = await chrome.storage.local.get('state');
    if (!state || !phases.includes(state.phase) || state.run !== message.run || state.tabId !== message.tabId)
      throw new Error('This operation was cancelled.');
    return state;
  }
  async function mutate(message) {
    let state = await claim(message, ['preparing', 'restoring', 'stopping']);
    const operation = state.pendingMutation;
    if (!operation || operation.id !== message.operationId) throw new Error('The saved course-change claim is missing.');
    const { kind, section, course } = operation;
    if (!/^\d{5}$/.test(section)) throw new Error('Invalid section identity.');
    const bin = await readBin();
    SeatGuard.assertBin(bin, state.config.term);
    const current = bin.rows.find(row => row.section === section);
    if (current && current.course !== course) throw new Error('The course identity changed.');
    if (current?.registered) throw new Error('Registered sections cannot be changed by the helper.');
    const wanted = kind === 'schedule';
    if (kind !== 'add' && current?.scheduled === wanted) return { confirmed: true, unchanged: true };
    if (kind === 'add' && current) return { confirmed: true, unchanged: true };
    let control;
    if (kind === 'add') {
      if (location.pathname !== '/Courses' || SeatGuard.normalizeCourse(new URL(location.href).searchParams.get('Course')) !== course)
        return { stale: true };
      const row = document.getElementById('section_' + section);
      if (row?.closest('[id^="courseBin_"]')?.id.toUpperCase() !== 'COURSEBIN_' + course) throw new Error('The target course was not found.');
      const forms = [...row.querySelectorAll('form')].filter(form => form.method === 'post' &&
        form.getAttribute('data-ajax-url') === '/api/section/' + state.config.term + '/' + section + '/add');
      const buttons = forms.length === 1 ? [...forms[0].querySelectorAll('button')].filter(button =>
        button.id === 'submit-add-' + section && !button.classList.contains('notify') &&
        ['Add to myCourseBin', 'Add'].includes(text(button))) : [];
      if (buttons.length !== 1 || buttons[0].disabled) throw new Error('The Add to Course Bin control is unavailable.');
      control = buttons[0];
    } else if (kind === 'schedule' || kind === 'unschedule') {
      if (location.pathname !== '/CourseBin' || !current) return { stale: true };
      const live = SeatDOM.bin(document);
      SeatGuard.assertBin(live, state.config.term);
      const row = live.rows.find(item => item.section === section);
      if (!row || row.registered || row.scheduled !== current.scheduled || row.course !== course) return { stale: true };
      const action = kind === 'schedule' ? 'schedule' : 'un-schedule';
      const group = document.getElementById('sched' + (current.scheduled ? 'Y' : 'N') + '_regN_' + section);
      const links = [...(group?.querySelectorAll('a') || [])].filter(link =>
        link.getAttribute('data-ajax-method')?.toLowerCase() === 'post' &&
        link.getAttribute('data-ajax-url')?.toLowerCase() === '/api/section/' + state.config.term + '/' + section + '/' + action &&
        text(link) === (wanted ? 'Schedule' : 'Unschedule'));
      if (links.length !== 1) throw new Error('The expected ' + kind + ' control is unavailable.');
      control = links[0];
    } else throw new Error('Unrecognized section operation.');
    state = await claim(message, ['preparing', 'restoring', 'stopping']);
    if (state.pendingMutation?.id !== operation.id) throw new Error('The section operation was cancelled.');
    control.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await claim(message, ['preparing', 'restoring', 'stopping']);
      const updated = await readBin();
      SeatGuard.assertBin(updated, state.config.term);
      const row = updated.rows.find(item => item.section === section);
      if (row && row.course === course && !row.registered && (kind === 'add' || row.scheduled === wanted))
        return { confirmed: true };
      if (row?.registered) throw new Error('USC registration changed during section preparation; review the result.');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('USC did not confirm the section change. It will not be repeated automatically.');
  }
  async function submit(message) {
    let dispatched = false;
    try {
    const state = await claim(message, ['submitted']);
    if (!state.attempt || state.attempt.id !== message.attemptId || state.attempt.targetId !== state.activeTarget)
      throw new Error('The saved submission claim is missing.');
    const target = state.config.targets.find(item => item.id === state.activeTarget);
    if (!target) throw new Error('The selected target is unavailable.');
    const error = SeatGuard.validateCheckout(SeatDOM.checkout(document, location.pathname, true), target, state.config.term, true);
    if (error) throw new Error(error);
    const fresh = await read('/Checkout', SeatDOM.checkout);
    const freshError = SeatGuard.validateCheckout(fresh, target, state.config.term, true);
    if (freshError) throw new Error(freshError);
    const latest = await claim(message, ['submitted']);
    if (latest.attempt?.id !== message.attemptId) throw new Error('Submission was cancelled.');
    const lastError = SeatGuard.validateCheckout(SeatDOM.checkout(document, location.pathname, true), target, state.config.term, true);
    if (lastError) throw new Error(lastError);
    dispatched = true;
    document.getElementById('SubmitButton').click();
    return { clicked: true };
    } catch (error) { error.notSubmitted = !dispatched; throw error; }
  }
  async function recoverTerm(message) {
    const state = await claim(message, ['recovering', 'login']);
    if (location.pathname !== '/Terms') throw new Error('Not on USC term selection.');
    const links = [...document.querySelectorAll('a[href]')].filter(link => {
      const url = new URL(link.href);
      return url.origin === 'https://webreg.usc.edu' && url.pathname === '/Terms' &&
        url.searchParams.get('term') === state.config.term && url.searchParams.get('handler') === 'TermSelect' &&
        text(link) === SeatGuard.termLabel(state.config.term).replace(/ Classes$/, '');
    });
    if (links.length !== 1) throw new Error('The requested USC term was not uniquely identified.');
    await claim(message, ['recovering', 'login']);
    links[0].click();
    return { selected: true };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    (async () => {
      if (message.type === 'read-bin') return readBin();
      if (message.type === 'read-checkout') return read('/Checkout', SeatDOM.checkout);
      if (message.type === 'live-checkout') return SeatDOM.checkout(document, location.pathname, true);
      if (message.type === 'page-info') return { path: location.pathname, term: text(document.getElementById('activeTermTab')) };
      if (message.type === 'mutate') return mutate(message);
      if (message.type === 'submit') return submit(message);
      if (message.type === 'recover-term') return recoverTerm(message);
      throw new Error('Unknown content command. Reload the USC tab after updating the extension.');
    })().then(reply, error => reply({ error: error.message, auth: !!error.auth, notSubmitted: !!error.notSubmitted }));
    return true;
  });
})();
