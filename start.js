import { existsSync, mkdirSync, copyFileSync, writeFileSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const shouldOpen = process.argv.includes('--open');

function openBrowser() {
  try {
    spawn('cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:8787'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

if (existsSync('logs/server.pid')) {
  try {
    const pid = Number(readFileSync('logs/server.pid', 'utf8').trim());
    if (pid) {
      process.kill(pid, 0);
      console.log(`Service already running PID=${pid}`);
      if (shouldOpen) openBrowser();
      process.exit(0);
    }
  } catch {}
  try { unlinkSync('logs/server.pid'); } catch {}
}

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('.env created');
}
mkdirSync('logs', { recursive: true });

const out = openSync('logs/server.log', 'a');
const err = openSync('logs/server.err.log', 'a');
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', out, err],
  windowsHide: true
});
child.unref();
writeFileSync('logs/server.pid', String(child.pid), 'ascii');
console.log(`Service started PID=${child.pid}`);
console.log('Console (open when needed): http://127.0.0.1:8787');
if (shouldOpen) setTimeout(openBrowser, 1500);
