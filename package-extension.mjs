// 打包扩展：把服务器地址写进 env.js，别人装上就能用，不用手动填。
// 用法：node package-extension.mjs http://YOUR_SERVER:8787
import { writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
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

// 源码里的 env.js 是本机私有的，不要带进发布包
cpSync(src, out, {
  recursive: true,
  filter: (from) => {
    const name = path.basename(from);
    return name !== 'env.js' && name !== 'env.example.js';
  },
});

writeFileSync(
  path.join(out, 'env.js'),
  `// 打包生成，请勿手改。\nexport const SERVER_BASE = '${endpoint}';\n`,
  'utf8'
);

console.log('已生成：', out);
console.log('服务地址：', endpoint);
console.log('在浏览器里加载 dist/extension 即可，选项页不再需要填地址。');
