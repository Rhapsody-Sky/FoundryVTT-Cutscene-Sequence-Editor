import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.ts')).sort();
if (!files.length) throw new Error('No tests found.');
const output = path.join(root, '.test-build');
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: files.map(name => `tests/${name}`),
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'inline',
  logLevel: 'warning'
});
const outputs = files.map(name => path.join(output, name.replace(/\.ts$/, '.mjs')));
const processHandle = spawn(process.execPath, ['--test', ...outputs], { cwd: root, stdio: 'inherit' });
processHandle.on('error', error => { console.error(error); process.exitCode = 1; });
processHandle.on('exit', code => { process.exitCode = code ?? 1; });
