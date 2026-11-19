import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, validate } from './validate.mjs';

const manifest = validate();
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain', '--untracked-files=normal']))
  throw new Error('Commit or resolve pending changes before packaging. Release ZIPs must match the committed tree.');
const revision = git(['rev-parse', 'HEAD']);
const dir = join(root, 'dist');
const filename = 'usc-seat-watch-v' + manifest.version + '.zip';
mkdirSync(dir, { recursive: true });
const archive = join(dir, filename);
// Archive only the committed runtime tree and the checked-in license.
git(['archive', '--format=zip', '--prefix=usc-seat-watch/', '--output=' + archive, '--add-file=LICENSE', 'HEAD:extension']);
const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(archive + '.sha256', hash + '  ' + filename + '\n');
console.log('Packaged ' + filename + ' from ' + revision);
console.log('SHA-256: ' + hash);
