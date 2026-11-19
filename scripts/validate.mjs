import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function validate() {
  const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const manifest = json('extension/manifest.json');
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version, 'Package and manifest versions must match');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'notifications', 'power', 'storage']);
  assert.deepEqual([...manifest.host_permissions].sort(), ['https://classes.usc.edu/*', 'https://webreg.usc.edu/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://webreg.usc.edu/*']);
  const expected = ['catalog.js', 'content.js', 'dom.js', 'guard.js', 'icon.png', 'manifest.json', 'popup.css', 'popup.html', 'popup.js', 'worker.js'];
  assert.deepEqual(readdirSync(join(root, 'extension')).sort(), expected, 'Keep the extension directory limited to runtime files');
  const resources = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(script => script.js)];
  for (const path of resources) assert.ok(expected.includes(path), 'Missing manifest resource: ' + path);
  const html = readFileSync(join(root, 'extension/popup.html'), 'utf8');
  for (const [, path] of html.matchAll(/(?:src|href)="([^"]+)"/g))
    assert.ok(expected.includes(path), 'Popup resources must be bundled: ' + path);
  const png = readFileSync(join(root, 'extension/icon.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  for (const dir of ['extension', 'scripts', 'tests']) {
    for (const name of readdirSync(join(root, dir)).filter(name => /\.(?:js|mjs|cjs)$/.test(name)))
      execFileSync(process.execPath, ['--check', join(root, dir, name)], { stdio: 'pipe' });
  }
  console.log('Manifest, permissions, bundled assets, versions, and JavaScript syntax verified.');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validate();
