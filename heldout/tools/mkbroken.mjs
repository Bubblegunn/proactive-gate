// node tools/mkbroken.mjs <srcdir> <destdir> <file-in-project> <exact text to replace> <replacement>
import fs from 'node:fs'; import path from 'node:path';
const [src, dest, file, from, to] = process.argv.slice(2);
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const f = path.join(dest, file); const s = fs.readFileSync(f, 'utf8');
if (!s.includes(from)) { console.error('pattern not found in ' + file + ': ' + from); process.exit(2); }
fs.writeFileSync(f, s.replace(from, () => to));
