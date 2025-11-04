# 验证流程测试指南

## ✅ 问题已修复

机器人用户名配置错误已修复。现在验证按钮应该正确跳转到 `@sufeadmin_bot` 而不是其他账号。

## 🧪 如何测试验证流程

### 准备工作

1. **确认机器人配置**
   ```bash
   # 检查容器环境变量
   docker exec telegram-group-bot sh -c 'echo $BOT_USERNAME'
   # 应该输出: sufeadmin_bot
   ```

2. **确认机器人在群组中有管理员权限**
   - 删除消息
   - 限制成员
   - 邀请用户

### 测试步骤

#### 第1步：邀请测试用户
1. 使用另一个 Telegram 账号（或创建测试账号）
2. 通过邀请链接或直接添加加入群组
3. **预期结果**：
   - 机器人立即检测到新成员
   - 机器人发送欢迎消息
   - 消息包含 "点击验证" 按钮

#### 第2步：点击群组中的验证按钮
1. 新用户点击欢迎消息中的 "点击验证" 按钮
2. **预期结果**：
   - Telegram 打开与 `@sufeadmin_bot` 的私聊对话
   - 机器人自动发送消息
   - 消息内容类似：
     ```
     您好！请点击下方按钮完成 **sufe.pro超新美国家宽🚗群** 群组的验证。

     ⏱ 验证有效时间：10 分钟

     ⚠️ 请注意：验证链接仅供您个人使用，请勿分享给他人。

     [🔐 开始验证]
     ```

#### 第3步：点击开始验证按钮
1. 点击消息中的 "🔐 开始验证" 按钮
2. **预期结果**：
   - 打开浏览器
   - 显示验证页面 `https://sufebot.848999.xyz/verify?token=...`
   - 页面显示：
     - 群组名称
     - 用户名
     - Cloudflare Turnstile 验证框
     - 剩余时间

#### 第4步：完成人机验证
1. Cloudflare Turnstile 通常会自动验证
2. 如果需要，点击验证框完成挑战
3. 点击 "提交验证" 按钮
4. **预期结果**：
   - 页面显示 "验证成功！"
   - 机器人发送私聊消息："✅ 验证成功！您已成功完成验证..."
   - 群组中显示："✅ @username 已成功通过验证，欢迎加入群组！"
   - 欢迎消息和成功消息在30秒后自动删除

#### 第5步：验证权限
1. 在群组中尝试发送消息
2. **预期结果**：
   - 可以正常发送消息
   - 可以发送图片、视频等媒体
   - 可以回复其他消息
   - 拥有正常成员的所有权限

## 📊 日志监控

在测试期间，可以实时监控日志：

```bash
# 实时查看日志
docker compose logs bot -f

# 或只查看验证相关日志
docker compose logs bot -f | grep -E "verify|Verification|welcome"
```

### 正常日志序列

```
# 1. 新成员加入
info: Processing new member {"userId":7076504650,"chatId":-1002684741025}
info: Created verification session for user 7076504650
info: Sending welcome message
info: Creating verification button {
  "botUsername": "sufeadmin_bot",  # <-- 必须是这个
  "verifyStartUrl": "https://t.me/sufeadmin_bot?start=verify_..."
}

# 2. 用户点击验证按钮（可能需要几秒钟）
info: Webhook received {"type":"message"}
info: User started bot with verification payload {
  "userId": 7076504650,
  "sessionId": "xxx-xxx-xxx"
}

# 3. 用户完成网页验证
info: Verification request received
info: User verified and changed to member status
info: Sent verification success notification
info: Deleted welcome message from group
```

## 🔍 故障排查

### 问题1: 点击验证按钮后跳转到错误的账号

**症状**: 点击验证按钮后，打开的不是 `@sufeadmin_bot`

**解决方案**:
```bash
# 1. 检查环境变量
docker exec telegram-group-bot sh -c 'echo $BOT_USERNAME'

# 2. 如果输出不是 sufeadmin_bot，更新 .env 文件
nano .env
# 修改: BOT_USERNAME=sufeadmin_bot

# 3. 重新创建容器
docker compose down
docker compose up -d

# 4. 再次验证
docker exec telegram-group-bot sh -c 'echo $BOT_USERNAME'
```

### 问题2: 机器人没有回复 /start 命令

**症状**: 点击验证按钮后，机器人私聊窗口没有自动发送消息

**可能原因**:
- Webhook 配置问题
- 机器人未正确处理 /start 命令

**排查步骤**:
```bash
# 1. 检查webhook状态
curl "https://api.telegram.org/bot$(grep BOT_TOKEN .env | cut -d'=' -f2)/getWebhookInfo"

# 2. 查看日志是否有 /start 命令的记录
docker compose logs bot | grep -i "start"

# 3. 尝试手动发送 /start 命令测试
# 在 Telegram 中直接向机器人发送: /start
```

### 问题3: 验证页面显示 "无效或过期的验证链接"

**可能原因**:
- Session 已过期（默认10分钟）
- Token 加密密钥不匹配
- 系统时间不同步

**解决方案**:
```bash
# 1. 检查系统时间
date

# 2. 检查日志中的过期时间
docker compose logs bot | grep "expiresAt"

# 3. 检查加密密钥配置
grep -E "ENCRYPTION_KEY|JWT_SECRET" .env
```

### 问题4: 验证成功但用户仍然不能发言

**可能原因**:
- 机器人没有"限制成员"管理员权限
- 权限更新失败

**解决方案**:
```bash
# 1. 检查日志中的权限更新错误
docker compose logs bot | grep -E "restrict|promote|error"

# 2. 确认机器人管理员权限
# 在 Telegram 群组中:
# 群组设置 -> 管理员 -> 选择机器人 -> 确认有 "限制成员" 权限

# 3. 手动解除限制（临时方案）
# 在群组中: 右键用户 -> 解除限制
```

### 问题5: Turnstile 验证失败

**症状**: 网页显示 "人机验证失败，请重试"

**可能原因**:
- Turnstile Site Key 或 Secret Key 配置错误
- Cloudflare Turnstile 服务问题
- 网络连接问题

**解决方案**:
```bash
# 1. 验证 Turnstile 配置
grep TURNSTILE .env

# 2. 测试 Turnstile API
curl -X POST "https://challenges.cloudflare.com/turnstile/v0/siteverify" \
  -d "secret=$(grep TURNSTILE_SECRET_KEY .env | cut -d'=' -f2)" \
  -d "response=test_token"

# 3. 查看详细错误日志
docker compose logs bot | grep -i turnstile
```

## 📝 测试检查清单

复制此清单用于每次测试：

- [ ] 容器环境变量 BOT_USERNAME=sufeadmin_bot
- [ ] 机器人有群组管理员权限
- [ ] 新用户加入后收到欢迎消息
- [ ] 欢迎消息有 "点击验证" 按钮
- [ ] 点击按钮跳转到 @sufeadmin_bot
- [ ] 机器人自动回复验证说明
- [ ] 有 "🔐 开始验证" 按钮
- [ ] 验证页面正常加载
- [ ] Turnstile 验证框正常显示
- [ ] 提交验证成功
- [ ] 收到验证成功私聊消息
- [ ] 群组显示验证成功通知
- [ ] 用户可以正常发言
- [ ] 欢迎消息被删除
- [ ] 验证成功消息30秒后被删除

## 🎯 成功标准

测试成功的标志：
1. ✅ 验证链接跳转到正确的机器人 `@sufeadmin_bot`
2. ✅ 整个验证流程无错误完成
3. ✅ 用户最终获得完整群组权限
4. ✅ 日志中没有错误信息
5. ✅ 消息正确发送和删除

## 💡 提示

- 建议使用小号或测试账号进行测试，避免影响真实用户
- 可以重复测试多次以确保稳定性
- 保留测试日志以便后续分析
- 如遇问题，先查看日志再进行故障排查

## 📞 需要帮助？

如果按照此指南仍无法解决问题：

1. 收集相关日志:
   ```bash
   docker compose logs bot --tail=200 > bot-logs.txt
   ```

2. 检查所有配置:
   ```bash
   grep -v "PASSWORD\|SECRET\|TOKEN" .env > config-check.txt
   ```

3. 查看文档:
   - `VERIFICATION_FIX.md` - 验证流程详细说明
   - `DATABASE_FIX.md` - 数据库问题解决
   - `README.md` - 项目总体说明

---
最后更新: 2025-11-04
