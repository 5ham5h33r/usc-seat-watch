import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Documentation preview: real popup assets, fabricated data, no USC requests or worker.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  { id: 'CSCI-587:30306', course: 'CSCI-587', sections: [{ id: '30306', units: '4' }], grade: 'L' },
  { id: 'DSCI-556:32406', course: 'DSCI-556', sections: [{ id: '32406', units: '4' }], grade: 'L' }
];
const courses = [
  { code: 'EE-450', title: 'Introduction to Computer Networks' },
  { code: 'EE-457', title: 'Computer Systems Organization' }
];
const fixture = view => `
(() => {
const view = ${JSON.stringify(view)};
const config = { term: '20271', targets: ['search', 'sections'].includes(view) ? [] : ${JSON.stringify(targets)} };
const state = { phase: view === 'watchlist' ? 'watching' : view === 'recovery' ? 'paused' : 'idle',
  config, tabId: 7, results: {}, targetStates: {},
  message: view === 'watchlist' ? 'Automatic registration is ON. Each available course uses its own checkout.' :
    view === 'recovery' ? 'USC has not confirmed the complete registration. Review the result before another checkout. No automatic retry will occur.' : 'Watchlist ready. Add a course to begin.' };
for (const target of config.targets) {
  state.targetStates[target.id] = { status: 'waiting', message: 'Waiting for seats.' };
  state.results[target.id] = { sections: target.sections.map(s => ({ id: s.id, registered: 75, total: 75, open: false })) };
}
if (view === 'recovery') {
  state.attempt = { id: 'example-attempt', targetId: config.targets[0].id };
  state.journal = { removed: [], added: [] };
  state.targetStates[config.targets[0].id] = { status: 'review', message: 'Verify the registration result in USC before continuing.' };
}
window.chrome = {
  tabs: { query: async () => [{ id: 7, title: 'WebReg: Course Bin' }] },
  runtime: { sendMessage: async message => {
    if (message.type === 'status') return structuredClone(state);
    if (message.type === 'load-config') return structuredClone(config);
    if (message.type === 'search-courses') return { courses: ${JSON.stringify(courses)}, total: 2 };
    if (message.type === 'course-sections') return { term: config.term, code: 'EE-450', title: 'Introduction to Computer Networks', sections: [
      { id: '30500', type: 'Lecture', units: ['4'], instructors: 'Example instructor', days: 'MW', time: '14:00-15:50', location: 'TBA', registered: 75, total: 75, open: false, cancelled: false },
      { id: '30501', type: 'Lecture', units: ['4'], instructors: 'Example instructor', days: 'TTh', time: '10:00-11:50', location: 'TBA', registered: 72, total: 75, open: true, cancelled: false }
    ] };
    throw new Error('Documentation preview only. Registration and account actions are disabled.');
  } }
};
})();
`;
const assets = { '/popup.js': ['popup.js', 'text/javascript'], '/popup.css': ['popup.css', 'text/css'] };
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; frame-ancestors 'none'");
  if (url.pathname === '/') {
    const view = ['watchlist', 'search', 'sections', 'recovery'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'watchlist';
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(readFileSync(join(root, 'extension/popup.html'), 'utf8').replace('<script src="popup.js">', '<script src="/fixture.js?view=' + view + '"></script><script src="popup.js">'));
  } else if (url.pathname === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    const view = url.searchParams.get('view');
    response.end(fixture(['watchlist', 'search', 'sections', 'recovery'].includes(view) ? view : 'watchlist'));
  } else if (assets[url.pathname]) {
    const [file, type] = assets[url.pathname];
    response.setHeader('Content-Type', type + '; charset=utf-8');
    response.end(readFileSync(join(root, 'extension', file)));
  } else { response.writeHead(404); response.end(); }
});
server.listen(4317, '127.0.0.1', () => console.log('Documentation preview: http://127.0.0.1:4317/?view=watchlist (also search, sections, recovery)'));
