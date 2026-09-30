// Bundle once, render many stills.  usage: node scripts/stills.mjs HE-verify:120,150 EN-open:60 ...
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = ['/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'].find((p) => fs.existsSync(p));
const serveUrl = await bundle({entryPoint: path.join(root, 'src/index.ts'), publicDir: path.join(root, 'public')});
fs.mkdirSync(path.join(root, 'out/stills'), {recursive: true});
for (const arg of process.argv.slice(2)) {
  const [id, frames] = arg.split(':');
  const comp = await selectComposition({serveUrl, id, browserExecutable: exe});
  for (const f of frames.split(',')) {
    const output = path.join(root, `out/stills/${id}-${String(f).padStart(4, '0')}.png`);
    await renderStill({composition: comp, serveUrl, output, frame: Number(f), browserExecutable: exe});
    console.log('still', output);
  }
}
