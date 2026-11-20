import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (!existsSync('logs/server.pid')) {
  console.log('No running service found');
  process.exit(0);
}
const pid = readFileSync('logs/server.pid', 'utf8').trim();
if (!pid) {
  console.log('Empty PID');
  process.exit(0);
}
try {
  execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
  console.log(`Stopped PID=${pid}`);
} catch {
  console.log('Process not found or already exited');
}
try { unlinkSync('logs/server.pid'); } catch {}
