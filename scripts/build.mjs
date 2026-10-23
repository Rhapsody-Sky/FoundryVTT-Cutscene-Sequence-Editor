import { build } from 'esbuild';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'module.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.id !== pkg.name || manifest.version !== pkg.version) {
  throw new Error('Package and module identity/version must match.');
}
if (!/^[a-z][a-z0-9-]+$/.test(manifest.id)) throw new Error('Invalid module ID.');
const destination = path.join(root, 'dist', manifest.id);
await mkdir(destination, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/bootstrap/main.ts'],
  outfile: path.join(destination, 'scripts/module.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  sourcesContent: true,
  define: { __MODULE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning'
});
for (const relative of ['module.json', ...manifest.styles, 'styles/editor-elements.css', 'lang/de.json', 'lang/en.json', 'templates/status.hbs', 'templates/editor.hbs']) {
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, relative), target);
}
for (const name of ['grain', 'diagonal', 'honeycomb', 'facets']) {
  const relative = `assets/button-textures/${name}.svg`;
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, relative), target);
}
await build({
  absWorkingDir: root,
  entryPoints: ['styles/editor.css'],
  outfile: path.join(destination, 'styles/editor.css'),
  bundle: true,
  logLevel: 'warning'
});
console.log(`Built ${manifest.id} ${manifest.version} in ${path.relative(root, destination)}.`);
