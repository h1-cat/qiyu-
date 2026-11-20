# 验收记录（2026-10-23）

环境：Windows 10/11，Node v22.11.0，Edge 155，夸克（Chromium）。

## 已验证

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | 规则单测（高危/中危/低危/上下文升级/解析/冷却） | ✅ 10/10 通过 | `node --test test/rules.test.mjs` |
| 2 | 服务启动与健康接口 | ✅ | `GET /api/health` 返回 stats/extensionOnline |
| 3 | 模拟高危消息 → 规则分析 → 飞书卡片 | ✅ | `POST /api/simulate {"preset":"high"}` → level=high，score=92，notify=dry_run |
| 4 | 七鱼风格原始帧 → 标准化 → 告警 | ✅ | `POST /api/ingest` frames[{transport:"ws",data:"{...}"}] → sessionId=9001，visitor 消息，high |
| 5 | 飞书卡片 JSON / dry-run | ✅ | 服务日志输出 interactive 卡片；`POST /api/test-feishu` 返回卡片 |
| 6 | SSE 风险流 | ✅ | `/api/events` 返回 hello + 历史告警；监控台实时渲染 |
| 7 | 监控台 UI | ✅ | 截图 `data/ui-monitor.png`：双栏、统计、风险卡片、等级标签、原文、建议 |
| 8 | iframe 嵌入七鱼工作台 | ✅ | 截图 `data/ui-monitor.png`：iframe 内加载七鱼工作台（夸克已登录），证明无 X-Frame-Options 限制 |
| 9 | 扩展加载与心跳 | ✅ | 独立 Edge 实例 `--load-extension`；`/api/health` extensionOnline=true |
| 10 | 扩展真实页面注入 | ✅ | `/api/raw` 捕获七鱼登录页真实 XHR 帧（sdk/setting、remoteStorage） |
| 11 | 账号互踢提示 | ⚠️ 已复现 | iframe 与原生标签同账号登录时，iframe 显示“你的帐号已在别处登录” |

## 待用户配合验证

| # | 项目 | 前置条件 |
|---|---|---|
| A | 真实访客/客服消息进入风险流 | 在已加载扩展的浏览器里登录七鱼工作台，收发一条消息 |
| B | 中高风险飞书真实卡片 | 提供飞书群自定义机器人 webhook，填入 `.env` |
| C | 客服端零影响 | 客服侧不装扩展、不打开监控台 |

## 关键结论

- **采集 = 扩展**；iframe 不参与采集，只作为展示与采集宿主。隐藏 iframe 后由独立标签页继续采集。
- 规则引擎已可独立工作；LLM 接口预留，填 Key 后启用。
- 飞书通道当前为 dry-run，配置 webhook 后即时生效。

## 2026-10-23 晚 · 七鱼部分完成

| 项目 | 结果 |
|---|---|
| 全量在线会话 | ✅ `/api/sessions` 565 个，按 `fromStaffOrGroup` 分组：AI客服组 386、VIP客服组 68、普通客服组 31 等 |
| 访客/客服区分 | ✅ 按 `fromUser`（0=客服，1=访客），告警 evidence 中 direction 正确 |
| 重点会话消息采集 | ✅ 只读轮询 `/api/monitor/overview` + `/chat/api/message/list/new/msg`，20 秒/轮、每轮最多 8 个重点会话；不发送消息、不改会话状态 |
| 误报修复 | ✅ 欢迎语/安全提醒跳过；隐私规则要求索取动作；投诉升级去掉“退款”；图片/表情消息过滤 |
| 真实高危样例 | ✅ 访客“已拨打上海12345…骗了好多钱” → high，groupName=AI客服组，direction=visitor，notify=dry_run |
| iframe | ⚠️ `/onsite/monitor` 可加载，但 SSO 在 iframe 内登录受限；改用独立标签 + 监控台风险流 |
| 飞书 | ⏸ 本期暂缓（按用户要求），保留 dry-run |
