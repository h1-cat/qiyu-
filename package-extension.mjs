// 打包扩展：把服务器地址写进默认值，别人装上就能用，不用手动填。
// 用法：node package-extension.mjs http://YOUR_SERVER:8787
import { readFileSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const endpoint = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (!endpoint || !/^https?:\/\//.test(endpoint)) {
  console.error('用法: node package-extension.mjs http://服务器地址:8787');
  process.exit(1);
}

const src = path.join(root, 'extension');
const out = path.join(root, 'dist', 'extension');
if (existsSync(path.join(root, 'dist'))) rmSync(path.join(root, 'dist'), { recursive: true, force: true });
cpSync(src, out, { recursive: true });

function patch(file, replacements) {
  const p = path.join(out, file);
  let text = readFileSync(p, 'utf8');
  for (const [from, to] of replacements) {
    if (!text.includes(from)) {
      console.warn('[warn] 未找到待替换内容，可能已改过：', file, from.slice(0, 40));
      continue;
    }
    text = text.split(from).join(to);
  }
  writeFileSync(p, text, 'utf8');
}

patch('background.js', [["const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';", `const DEFAULT_ENDPOINT = '${endpoint}';`]]);
patch('options.js', [["const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';", `const DEFAULT_ENDPOINT = '${endpoint}';`]]);
patch('options.html', [
  ['placeholder="http://127.0.0.1:8787"', `placeholder="${endpoint}"`]
]);

console.log('已生成：', out);
console.log('服务地址：', endpoint);
