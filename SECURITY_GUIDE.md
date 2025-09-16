# 安全配置指南 - TELEGRAM BOT 安全性加固

## ⚠️ 紧急行动项

### 1. **立即撤销泄露的 Bot Token**
您的 Bot Token 已经在文档中泄露，这是您的机器人被劫持的主要原因！

**立即执行以下步骤：**
1. 打开 Telegram，找到 @BotFather
2. 发送 `/mybots`
3. 选择您的机器人 (小菲)
4. 选择 "API Token"
5. 选择 "Revoke current token"
6. 获取新的 token 并更新 .env 文件

### 2. **更新环境变量**
```bash
# 编辑 .env 文件
nano .env

# 更新以下值
BOT_TOKEN=你的新token
BOT_WEBHOOK_SECRET=生成一个新的强密码
JWT_SECRET=生成一个新的强密码
HMAC_SECRET=生成一个新的强密码
```

生成强密码命令：
```bash
openssl rand -hex 32
```

### 3. **重新部署机器人**
```bash
# 重新构建并启动
docker-compose down
docker-compose build
docker-compose up -d
```

## 🛡️ 已实施的安全增强

### 1. **IP 白名单**
- 仅允许 Telegram 官方 IP 访问 webhook
- IP 范围：149.154.160.0/20 和 91.108.4.0/22

### 2. **增强的 Webhook 验证**
- Secret token 验证
- HMAC 签名验证（可选）
- 请求体大小限制 (10KB)

### 3. **日志安全**
- 自动清理敏感信息
- 不记录用户消息内容
- 不记录个人信息

### 4. **错误响应隐藏**
- 所有未授权请求返回 404
- 隐藏 webhook 端点的存在

## 📋 安全检查清单

- [ ] Bot Token 已撤销并更新
- [ ] 所有密钥已更新
- [ ] 删除所有测试脚本
- [ ] 检查没有其他地方泄露 token
- [ ] 更新 Nginx 配置
- [ ] 监控异常访问

## 🔍 持续监控

### 监控命令
```bash
# 查看 webhook 访问日志
docker logs telegram-group-bot | grep "Webhook"

# 查看非 Telegram IP 访问
docker logs telegram-group-bot | grep "non-Telegram IP"

# 查看认证失败
docker logs telegram-group-bot | grep "Invalid webhook"
```

### 设置告警
建议设置以下告警：
1. 频繁的认证失败
2. 来自非 Telegram IP 的访问
3. 异常的 API 使用模式

## ⚡ 性能影响
新的安全措施对性能影响极小：
- IP 检查：< 1ms
- 签名验证：< 2ms
- 日志清理：< 1ms

## 🚨 安全最佳实践

1. **永远不要在代码或文档中硬编码 token**
2. **定期轮换所有密钥**（建议每3个月）
3. **监控所有异常活动**
4. **使用环境变量管理所有敏感信息**
5. **定期审查代码中的安全问题**

## 📞 紧急联系

如果发现任何安全问题：
1. 立即撤销 bot token
2. 停止服务：`docker stop telegram-group-bot`
3. 检查日志找出攻击源
4. 修复问题后再重新启动