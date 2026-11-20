import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', resolve);
  });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  console.log('');
  console.log('========================================');
  console.log('          七鱼会话监控中心');
  console.log('========================================');
  console.log('');
  console.log('  [1] 启动监控（后台服务 + 七鱼监控端）');
  console.log('  [2] 打开监控台');
  console.log('  [3] 停止监控');
  console.log('  [4] 打开项目文件夹');
  console.log('  [0] 退出');
  console.log('');
  const answer = (await rl.question('请输入数字并回车：')).trim();
  if (answer === '0') break;
  if (answer === '1') {
    await run(process.execPath, ['start.js']);
    spawn('cmd.exe', ['/c', 'start', '', path.join(root, 'open-qiyu.cmd')], { detached: true, stdio: 'ignore' }).unref();
    await rl.question('启动完成，按回车返回菜单');
  } else if (answer === '2') {
    spawn('cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:8787'], { detached: true, stdio: 'ignore' }).unref();
  } else if (answer === '3') {
    await run(process.execPath, ['stop.js']);
    await rl.question('已停止，按回车返回菜单');
  } else if (answer === '4') {
    spawn('explorer.exe', [root], { detached: true, stdio: 'ignore' }).unref();
  }
}
rl.close();
