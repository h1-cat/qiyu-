# 七鱼客服会话 AI 风险监控

> 日常操作（监控者/客服/账号/飞书）请看 **[使用手册](使用手册.md)**。

监控七鱼在线客服会话中的**访客消息**与**客服消息**，用语义规则判断风险等级，中高风险通过**飞书群卡片**通知监控者。

- 监控台用 **iframe 嵌入七鱼工作台**：一屏内左侧看会话、右侧看风险流；
- **采集完全由浏览器扩展完成**（跨域 iframe 无法直接读 DOM，扩展是唯一稳妥通道）；
- iframe 只是“展示 + 采集宿主”：扩展在 iframe 或独立标签页里都能采集，隐藏 iframe 不影响监控；
- 默认使用**规则引擎**（无需 API Key）；预留 OpenAI 兼容 LLM 接口，填 Key 即可启用；
- 全部本机运行，数据只落本机 `data/` 目录。

## 1. 目录结构

```
七鱼会话监控/
  server/
    index.mjs            # HTTP/SSE 服务、/api/ingest、静态页面
    normalize.mjs        # 七鱼原始帧 -> 标准消息
    rules.mjs            # 风险规则引擎
    analyzer.mjs         # 规则 + LLM（可选）
    store.mjs            # 会话窗口、去重、冷却、JSONL 落盘
    notify/feishu.mjs    # 飞书互动卡片 + 签名 + dry-run
  web/                   # 监控台页面（原生 JS，无构建）
  extension/             # Chrome/Edge MV3 扩展（只读采集）
  test/rules.test.mjs    # 单元测试
  start.ps1 / stop.ps1   # 本机启动/停止
  data/                  # 运行时数据（messages/alerts/raw JSONL）
```

## 2. 快速开始

前置：Node.js >= 20（本机已装 v22）。

- 双击 **`start.cmd`**（推荐：自动绕过 PowerShell 脚本执行策略、启动服务并打开监控台）；
- 停止服务双击 **`stop.cmd`**；
- 也可以手动运行：

```powershell
cd D:\deepseek工作区\七鱼会话监控
Copy-Item .env.example .env        # 首次
node server/index.mjs
```

打开 <http://127.0.0.1:8787>。

**首次登录**：七鱼登录页允许被 iframe 嵌入，可直接在监控台左侧 iframe 里登录；如果 iframe 登录失败（第三方 Cookie 限制），点右上角“新标签打开”登录，扩展在独立标签页同样采集，右侧风险流不受影响。

第一次没配置飞书时，通知为 **dry-run**：卡片 JSON 打印在服务日志里，不真正发送，方便先验证链路。

## 3. 安装扩展（关键）

v0.3.0 起扩展只做**只读采集**：抓到的七鱼会话帧全部上报服务器，分析、客服组过滤、LLM 复核、飞书推送都在服务器完成。以后改规则只重启服务器，**不用更新扩展**。

### Edge / Chrome
1. 地址栏打开 `edge://extensions`（Chrome 为 `chrome://extensions`）；
2. 打开右上角 **开发者模式**；
3. 点 **加载解压缩的扩展**，选择 `七鱼会话监控扩展` 文件夹（或解压 `七鱼会话监控扩展.zip` 后选解压目录）；
4. 列表中确认“七鱼会话风险采集”已启用，版本 `0.3.0`；
5. 点扩展的「详情」→「扩展程序选项」，把服务地址改成你的服务器地址（例如 `http://YOUR_SERVER_IP:8787`），点「测试连接」应显示成功。

### 夸克
夸克 PC 版基于 Chromium，入口为 `quark://extensions`（若版本不支持加载解压扩展，请改用 Edge）。

安装后打开/刷新七鱼工作台页面，监控台右上角状态会变为 **采集在线**。

> 监控者（即使用监控台的同事）不需要安装扩展；扩展只装在负责采集的那台机器上。
>
> 告警组选择、飞书/LLM 配置都在服务器：`.env` 或监控台右上角「告警组」按钮。

## 4. 配置（.env）

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | 8787 |
| `HOST` | 监听地址；同网段访问设为 `0.0.0.0` | 127.0.0.1 |
| `QIYU_WORKSPACE_URL` | 七鱼工作台地址（iframe src） | 公司七鱼工作台 |
| `FEISHU_WEBHOOK` | 飞书群自定义机器人 webhook | 空（dry-run） |
| `FEISHU_SECRET` | 机器人签名密钥（开启了签名才填） | 空 |
| `ALERT_MIN_LEVEL` | 通知阈值：low/medium/high | medium |
| `ALERT_COOLDOWN_MIN` | 同会话同等级冷却分钟 | 10 |
| `LLM_ENABLED` | 是否启用 LLM 语义分析 | false |
| `LLM_BASE_URL` | OpenAI 兼容地址 | https://api.deepseek.com |
| `LLM_API_KEY` | 模型 Key | 空 |
| `LLM_MODEL` | 模型名 | deepseek-chat |

### 飞书机器人创建
飞书群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人** → 复制 webhook。
如勾选“签名校验”，把密钥填到 `FEISHU_SECRET`。

配置后重启服务，访问 `POST /api/test-feishu` 验证卡片：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/test-feishu -ContentType 'application/json' -Body '{}'
```

## 5. 使用

- **监控台**：左侧 iframe 七鱼工作台；右侧风险流、今日统计、等级筛选；
- **七鱼账号**：顶部“七鱼账号”标签由扩展从七鱼页面读取并随心跳上报（localStorage/DOM/标题），登录后自动显示；未装扩展时显示“未识别”；
- **全屏工作台**：顶部按钮可隐藏右侧风险流、让七鱼工作台占满宽度，便于查看七鱼自身的账号头像/菜单；再点“恢复双栏”回来；
- **飞书**：中高风险自动发群卡片，含等级、会话 ID、访客/客服、命中规则、原文摘录、建议、跳转按钮；
- **采集在线**：扩展每 20 秒心跳；离线时监控台状态点变红；
- **暂停监控**：只暂停前端渲染，服务端仍在记录。

### 账号建议
- iframe 用的是“打开监控台那台电脑浏览器里的七鱼登录态”，**不强制独立账号**；
- 要覆盖全组会话，采集机需要登录**主管/质检/管理员**账号（客服账号只能看到自己的会话）；
- 采集机不要同时开原生七鱼工作台，避免同账号多处登录互踢；
- 客服侧不装扩展、不打开监控台，接待流程不变。

## 6. 自测

```powershell
# 单元测试
node --test test/rules.test.mjs

# 模拟一条高危访客消息（会触发规则 + 飞书 dry-run/真实通知）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/simulate -ContentType 'application/json' -Body '{"preset":"high"}'

# 模拟扩展上报原始七鱼帧
# body: {"source":"extension","frames":[{"transport":"ws","data":"{...}"}]}
```

## 7. 探针与协议适配（首次接入七鱼必看）

七鱼前端协议可能随版本变化，所以项目内置“原始帧探针”：

1. 装好扩展、打开七鱼工作台，随便收发几条消息；
2. 打开 <http://127.0.0.1:8787/api/raw> 查看最近原始帧；
3. 如果风险流没有新消息，说明 `server/normalize.mjs` 还没适配该版本字段：
   - 把 `/api/raw` 里的样本文本发给我，或
   - 直接在 `normalize.mjs` 的 `TEXT_KEYS / SESSION_KEYS / ID_KEYS` 里补字段名；
4. 原始帧同时落盘在 `data/raw-YYYYMMDD.jsonl`，便于离线分析。

> 说明：七鱼消息可能是 WebSocket 帧、也可能是接口轮询。扩展同时 hook 了 WebSocket / fetch / XHR，三者都会上报。

## 8. 风险规则

内置规则可在 `server/rules.mjs` 调整：

- **高危**：人身威胁/约架、12315/监管/媒体曝光/起诉、诈骗退款勒索、索要验证码/身份证/银行卡、色情违法、客服辱骂或私自承诺赔偿；
- **中危**：投诉升级、要求领导/上级、律师/差评威胁、强烈不满、客服态度问题、10 分钟内负面累计 ≥3 条；
- **低危**：普通咨询与正常售后。

同会话同等级默认 10 分钟冷却，避免飞书轰炸。

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| 监控台“采集离线” | 扩展未装/未启用；或页面不是 `*.qiyukf.com`；刷新七鱼页面 |
| iframe 显示登录页 | 第三方 Cookie 限制；点“新标签打开工作台”登录，扩展在独立标签同样采集 |
| 风险流没有消息 | 看 `/api/raw` 是否有帧；有帧说明需适配字段，无帧说明扩展没注入 |
| 飞书没收到 | 检查 webhook/签名；看服务日志里 dry-run 或 failed 原因 |
| 端口被占用 | 改 `.env` 的 `PORT` |
| 同账号被踢 | 采集机专用账号；不要同时开原生工作台 |

## 10. 已知限制

- 七鱼前端协议未公开，首次接入需要一次“探针 + 字段适配”；
- iframe 登录态受浏览器第三方 Cookie 策略影响，兜底是独立标签页采集；
- 规则引擎会有误报/漏报，接入 LLM 后可显著改善；
- 仅用于本企业客服会话的质量与风险监控，请遵守隐私与合规要求。
