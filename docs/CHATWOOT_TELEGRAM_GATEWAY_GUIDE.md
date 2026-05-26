# Chatwoot Telegram Mini App 验证网关部署说明

目标：不修改 Chatwoot 源码，让 Telegram 用户在消息进入 Chatwoot 前先通过本机器人的 Mini App 人机验证。未验证消息不会转发给 Chatwoot，不会在 Chatwoot 里创建联系人、会话或消息。

**验证入口只有 Mini App 一个。** 没有网页验证、没有备用入口、没有降级路径。如果 `BOT_USERNAME` 或 `BOT_MINIAPP_SHORT_NAME` 缺失，网关会直接返回 503，不会启用任何替代方案。

## 前置条件

按顺序确认：

1. **本机器人已经跑起来**。先按 [../BOT_SETUP_GUIDE.md](../BOT_SETUP_GUIDE.md) 或 [../DOCKER_DEPLOY.md](../DOCKER_DEPLOY.md) 把本项目部署完，能正常处理群组验证、Mini App 能打开，再来配 Chatwoot 网关。
2. **HTTPS 域名**。`BOT_WEBHOOK_DOMAIN` 必须是公网可达的 HTTPS 域名（Telegram 不接受自签或 HTTP）。
3. **可用的 Chatwoot 实例**。能正常创建 Telegram Inbox。
4. **两个独立的 Telegram bot**（详见下面"两个机器人"小节）：客服机器人 + 验证机器人。

## 核心流程

```text
用户私聊客服机器人
  -> Telegram 把消息发到本项目 /chatwoot/telegram-webhook
  -> 本项目检查该用户是否已验证
  -> 未验证：客服机器人发送 Mini App 验证按钮，本次消息丢弃
  -> 已验证：本项目原样转发 Telegram update 到 Chatwoot 原生 webhook
  -> Chatwoot 创建联系人、会话、消息
```

## 两个机器人

### 客服机器人

客户实际私聊的 bot，例如 `@YourSupportBot`。它的 token 既要填到 Chatwoot 的 Telegram Inbox，也要填到本项目的网关配置里（`CHATWOOT_GATEWAY_TELEGRAM_BOT_TOKEN`）。

### 验证机器人

运行本项目 `sufegroup_bot` 的 bot，例如 `@YourVerifyBot`。它负责 Mini App、人机验证、网关转发、群管理。它的 token 填到 `BOT_TOKEN`。

## Chatwoot 后台配置

正常创建 Telegram Inbox，填客服机器人 token：

```text
111111:SUPPORT_BOT_TOKEN
```

Chatwoot 保存后会自动设置一次 Telegram webhook。后面我们会用 Telegram Bot API 把这个 webhook 覆盖到验证网关。

## 验证机器人 Mini App 配置

在 BotFather 给验证机器人创建 Mini App：

```text
验证机器人：@YourVerifyBot
Mini App short name：app
Mini App URL：https://verify.example.com/mini-app
```

最终 Mini App 链接格式：

```text
https://t.me/YourVerifyBot/app?startapp=chatwoot_<sessionId>
```

## 环境变量

验证机器人基础配置（**全部必填**，缺一不可）：

```env
BOT_TOKEN=222222:VERIFY_BOT_TOKEN
BOT_USERNAME=YourVerifyBot
BOT_MINIAPP_SHORT_NAME=app
BOT_WEBHOOK_DOMAIN=https://verify.example.com
BOT_WEBHOOK_SECRET=verify-bot-webhook-secret
```

Chatwoot 网关配置：

```env
CHATWOOT_GATEWAY_BASE_URL=https://chatwoot.example.com
CHATWOOT_GATEWAY_TELEGRAM_BOT_TOKEN=111111:SUPPORT_BOT_TOKEN
CHATWOOT_GATEWAY_WEBHOOK_SECRET=generate_random_webhook_secret
CHATWOOT_GATEWAY_INBOX_ID=chatwoot-support
CHATWOOT_GATEWAY_FORWARD_TIMEOUT_SECONDS=5
```

验证有效期：

```env
CHATWOOT_VERIFICATION_TTL_MINUTES=10
CHATWOOT_VERIFIED_TTL_DAYS=30
CHATWOOT_PROMPT_COOLDOWN_SECONDS=300
```

- `CHATWOOT_VERIFICATION_TTL_MINUTES`：Mini App 验证入口（pending session）有效时间，过期需重新发消息触发新 session。
- `CHATWOOT_VERIFIED_TTL_DAYS`：验证通过后，同一 inbox 下保持可信的天数。期间用户消息全部直接转发，不再要求验证。
- `CHATWOOT_PROMPT_COOLDOWN_SECONDS`：冷却时间。**冷却期内未验证消息照样拦截、不转发**，只是不重复给用户发"完成人机验证"按钮，避免一直刷消息时按钮刷屏。
- `CHATWOOT_GATEWAY_INBOX_ID`：本项目内部用于隔离验证状态的 key，存在 `chatwoot_verification_sessions` 表的 `inboxId` 字段里。**修改这个值等于让所有用户重新验证**，因为旧记录在新 key 下查不到。一个 Chatwoot Telegram inbox 用一个固定值即可。

生成 webhook secret：

```bash
openssl rand -hex 32
```

## 数据库迁移

`chatwoot_verification_sessions` 表由 TypeORM 迁移自动创建。启动本服务时 `AppDataSource.runMigrations()` 会自动应用 `1760000000000-AddChatwootVerificationSessions`，**不需要手动跑 SQL**。

验证迁移已应用：

```bash
psql -h $DB_HOST -U $DB_USERNAME -d $DB_DATABASE \
  -c "\dt chatwoot_verification_sessions"
```

启动日志里也会出现 `Database migrations completed successfully`。如果显示 `Migration error`，先排查迁移再设置 webhook，否则首条消息进来会写库失败。

## 设置客服机器人的 Telegram webhook

这一步通过 Telegram Bot API 完成，不是在 Chatwoot 后台。使用**客服机器人** token：

```bash
curl -X POST "https://api.telegram.org/bot111111:SUPPORT_BOT_TOKEN/setWebhook" \
  -d "url=https://verify.example.com/chatwoot/telegram-webhook" \
  -d "secret_token=generate_random_webhook_secret"
```

- URL 是本项目的域名，不是 Chatwoot 域名。
- token 是客服机器人 token。
- `secret_token` 必须等于 `CHATWOOT_GATEWAY_WEBHOOK_SECRET`。

校验 webhook：

```bash
curl "https://api.telegram.org/bot111111:SUPPORT_BOT_TOKEN/getWebhookInfo"
```

`url` 字段应为 `https://verify.example.com/chatwoot/telegram-webhook`。若仍指向 Chatwoot（`/webhooks/telegram/...`），说明 webhook 没被覆盖，重跑上面的 `setWebhook`。

## 测试流程

1. 未验证 Telegram 账号私聊 `@YourSupportBot`，发送一条消息。
2. Chatwoot 中不应出现这条消息。
3. 客服机器人回复一个"完成人机验证"按钮。
4. 点击按钮，验证机器人 Mini App 打开，标题"客服消息验证"。
5. 完成 Turnstile / hCaptcha 验证。
6. 返回客服聊天，重新发送消息。
7. 新消息进入 Chatwoot。

## 日志与排错

服务运行时关键日志（结构化，搜 logger name 即可定位）：

| 现象 | 日志关键字 | 含义 |
|------|-----------|------|
| 未验证用户被拦 | `Blocked unverified Chatwoot Telegram message` | 正常拦截，附带 `inboxId`、`userId`、`status` |
| Chatwoot 接收失败 | `Chatwoot Telegram webhook returned non-success` | 转发到 Chatwoot 收到非 2xx，附带 `status` |
| Chatwoot 不可达 | `Failed to forward Telegram update to Chatwoot` | 网络错误或超时（受 `CHATWOOT_GATEWAY_FORWARD_TIMEOUT_SECONDS` 限制） |
| 用户验证成功 | `Chatwoot Telegram user verified` | 写库完成，附带 `sessionId` |
| 网关未配置 | HTTP 503 `Chatwoot Telegram gateway is not configured` | `CHATWOOT_GATEWAY_*` 或 `BOT_USERNAME` / `BOT_MINIAPP_SHORT_NAME` 缺失 |
| Telegram 签名失败 | HTTP 404 `Not found` | `secret_token` 与 `CHATWOOT_GATEWAY_WEBHOOK_SECRET` 不一致 |

健康检查：

```bash
curl https://verify.example.com/health
```

应返回 `{"status":"ok",...}`。

## 运维：查询某用户的验证状态

直接查 `chatwoot_verification_sessions` 表：

```sql
SELECT id, "userId", username, status, "verifiedUntil", "expiresAt"
FROM chatwoot_verification_sessions
WHERE "inboxId" = 'chatwoot-support'
  AND "userId" = '123456789'
ORDER BY "createdAt" DESC
LIMIT 5;
```

- `status = 'verified'` 且 `"verifiedUntil" > now()` ：当前可信，消息会被转发。
- `status = 'pending'` ：等待验证，`expiresAt` 是 Mini App 链接失效时间。
- `status = 'expired'` / `'failed'` ：作废，下次消息会创建新 session。

强制让某用户重新验证：

```sql
UPDATE chatwoot_verification_sessions
SET status = 'expired'
WHERE "inboxId" = 'chatwoot-support' AND "userId" = '123456789';
```

## 回退：临时停用网关

把客服机器人的 Telegram webhook 改回 Chatwoot 即可，**不需要改本项目配置**：

```bash
curl -X POST "https://api.telegram.org/bot111111:SUPPORT_BOT_TOKEN/setWebhook" \
  -d "url=https://chatwoot.example.com/webhooks/telegram/111111:SUPPORT_BOT_TOKEN"
```

之后所有消息直连 Chatwoot，跳过验证。要恢复网关时，按"设置客服机器人的 Telegram webhook"那节再 `setWebhook` 回本项目即可。`chatwoot_verification_sessions` 表里的验证状态在回退期间会原样保留，恢复后继续生效。

## 为什么不是 Chatwoot Agent Bot

Chatwoot Agent Bot / Automation 是消息**入库后**才触发，可以回复、打标签、关闭会话，但无法阻止联系人、会话、消息创建。

如果要求是"未验证消息不能进入 Chatwoot、不能在系统中留存"，就必须在 Chatwoot 前面拦截，也就是本项目的 Telegram webhook 网关。

## 常见问题

### Chatwoot 里填哪个 token？

客服机器人 token：`111111:SUPPORT_BOT_TOKEN`。

### 本项目 `BOT_TOKEN` 填哪个？

验证机器人 token：`222222:VERIFY_BOT_TOKEN`。

### `CHATWOOT_GATEWAY_TELEGRAM_BOT_TOKEN` 填哪个？

客服机器人 token：`111111:SUPPORT_BOT_TOKEN`。网关用它给未验证用户发送 Mini App 验证按钮，并把已验证消息转发到 Chatwoot 原生 webhook。

### 验证为什么没有网页版？

刻意去掉的。两个入口（Mini App + 网页）会出现界面、状态、消息文案不一致的问题，运维和文档负担也加倍。Mini App 已经覆盖所有 Telegram 客户端（移动端、桌面端、Web），没有保留兜底的必要。

### Chatwoot 后台重新保存 Telegram Inbox 后失效？

Chatwoot 可能会把客服机器人的 webhook 改回 Chatwoot。重跑：

```bash
curl -X POST "https://api.telegram.org/bot111111:SUPPORT_BOT_TOKEN/setWebhook" \
  -d "url=https://verify.example.com/chatwoot/telegram-webhook" \
  -d "secret_token=generate_random_webhook_secret"
```

### 可以只用一个机器人吗？

不建议。两个机器人职责更清楚：客服机器人是客户私聊入口、Chatwoot inbox token；验证机器人负责 Mini App、验证、网关、群管。

### 多个 Chatwoot Telegram inbox 怎么办？

每个客服机器人 token 对应一个 Telegram webhook。最简单做法是部署多个网关实例，分别配置不同的 `CHATWOOT_GATEWAY_TELEGRAM_BOT_TOKEN` / `CHATWOOT_GATEWAY_INBOX_ID` / `CHATWOOT_GATEWAY_WEBHOOK_SECRET`。如果要一个实例支持多个客服机器人，需要扩展多 token 路由表。
