# 运维手册 - Telegram 群组管理机器人

## 目录

1. [系统架构](#系统架构)
2. [部署流程](#部署流程)
3. [日常运维](#日常运维)
4. [监控告警](#监控告警)
5. [故障处理](#故障处理)
6. [性能调优](#性能调优)
7. [安全加固](#安全加固)
8. [备份恢复](#备份恢复)

## 系统架构

### 技术栈
- **后端**: Node.js + TypeScript + Fastify
- **机器人框架**: grammY
- **数据库**: PostgreSQL 16
- **缓存**: Redis 7
- **容器化**: Docker + Docker Compose
- **反向代理**: Nginx
- **SSL**: Let's Encrypt

### 服务架构
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Telegram  │────▶│    Nginx    │────▶│   Bot App   │
│   Servers   │     │  (Reverse)  │     │  (Fastify)  │
└─────────────┘     └─────────────┘     └─────────────┘
                                               │
                                    ┌──────────┴──────────┐
                                    ▼                     ▼
                            ┌─────────────┐      ┌─────────────┐
                            │ PostgreSQL  │      │    Redis    │
                            │ (Database)  │      │   (Cache)   │
                            └─────────────┘      └─────────────┘
```

## 部署流程

### 首次部署

1. **服务器准备**
   ```bash
   # 更新系统
   sudo apt update && sudo apt upgrade -y
   
   # 安装 Docker
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   
   # 安装 Docker Compose
   sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
   sudo chmod +x /usr/local/bin/docker-compose
   ```

2. **域名配置**
   - 将域名 A 记录指向服务器 IP
   - 配置 Cloudflare（如使用）

3. **部署应用**
   ```bash
   # 克隆代码
   git clone https://github.com/yourusername/telegram-group-bot.git
   cd telegram-group-bot
   
   # 配置环境变量
   cp .env.example .env
   nano .env  # 编辑配置
   
   # 部署
   ./deploy.sh
   ```

4. **SSL 证书配置**
   ```bash
   # 初始化 Certbot
   docker-compose run --rm certbot certonly --webroot --webroot-path=/var/www/certbot -d your-domain.com
   
   # 更新 nginx 配置
   nano nginx/conf.d/bot.conf  # 更新 server_name
   docker-compose restart nginx
   ```

### 更新部署

```bash
# 拉取最新代码
git pull origin main

# 备份数据库
./backup.sh

# 重新构建和部署
docker-compose build bot
docker-compose up -d bot

# 运行新的数据库迁移（如有）
docker-compose exec bot npm run migration:run
```

## 日常运维

### 服务管理

```bash
# 查看服务状态
docker-compose ps

# 启动/停止服务
docker-compose start [service]
docker-compose stop [service]
docker-compose restart [service]

# 查看日志
docker-compose logs -f bot           # 实时查看bot日志
docker-compose logs --tail=100 bot  # 查看最近100行
docker-compose logs postgres         # 查看数据库日志
```

### 健康检查

```bash
# API健康检查
curl http://localhost:3000/health

# 容器健康状态
docker-compose ps | grep healthy

# 资源使用情况
docker stats
```

### 定时任务

使用 crontab 设置定时任务：

```bash
# 编辑定时任务
crontab -e

# 每天凌晨2点备份
0 2 * * * /path/to/telegram-group-bot/backup.sh >> /var/log/bot-backup.log 2>&1

# 每周日凌晨3点清理日志
0 3 * * 0 find /path/to/telegram-group-bot/logs -name "*.log" -mtime +30 -delete
```

## 监控告警

### 基础监控

1. **系统资源监控**
   ```bash
   # CPU和内存
   htop
   
   # 磁盘空间
   df -h
   
   # 网络连接
   netstat -tulpn | grep -E '3000|5432|6379'
   ```

2. **应用监控**
   ```bash
   # 检查进程
   docker-compose ps
   
   # 检查端口
   sudo lsof -i :3000
   ```

### 告警配置

创建监控脚本 `monitor.sh`：

```bash
#!/bin/bash

# 检查服务健康状态
if ! curl -f http://localhost:3000/health > /dev/null 2>&1; then
    echo "Bot service is down!" | mail -s "Bot Alert" admin@example.com
fi

# 检查磁盘空间
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ $DISK_USAGE -gt 80 ]; then
    echo "Disk usage is at ${DISK_USAGE}%" | mail -s "Disk Alert" admin@example.com
fi
```

## 故障处理

### 常见问题

1. **Bot 无响应**
   ```bash
   # 检查容器状态
   docker-compose ps
   
   # 查看错误日志
   docker-compose logs bot | grep ERROR
   
   # 重启服务
   docker-compose restart bot
   ```

2. **数据库连接失败**
   ```bash
   # 检查PostgreSQL状态
   docker-compose ps postgres
   
   # 查看数据库日志
   docker-compose logs postgres
   
   # 测试连接
   docker-compose exec postgres pg_isready -U postgres
   ```

3. **验证页面502错误**
   ```bash
   # 检查应用服务
   docker-compose ps bot
   
   # 检查nginx错误日志
   docker-compose logs nginx
   
   # 重启相关服务
   docker-compose restart bot nginx
   ```

### 紧急恢复

```bash
# 1. 停止所有服务
docker-compose down

# 2. 恢复最近的备份
./restore.sh backups/postgres/latest_backup.sql.gz

# 3. 重启服务
docker-compose up -d

# 4. 检查服务状态
docker-compose ps
```

## 性能调优

### PostgreSQL 优化

编辑 `docker-compose.prod.yml`，添加PostgreSQL配置：

```yaml
postgres:
  command: >
    postgres
    -c shared_buffers=256MB
    -c effective_cache_size=1GB
    -c maintenance_work_mem=64MB
    -c work_mem=4MB
    -c max_connections=100
```

### Redis 优化

```yaml
redis:
  command: >
    redis-server
    --maxmemory 256mb
    --maxmemory-policy allkeys-lru
    --save 900 1
    --save 300 10
```

### 应用优化

1. **并发配置**
   - 调整 Node.js 进程数
   - 优化数据库连接池

2. **缓存策略**
   - 增加 Redis 缓存时间
   - 实现查询结果缓存

## 安全加固

### 1. 系统安全

```bash
# 配置防火墙
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable

# 禁用root登录
sudo nano /etc/ssh/sshd_config
# 设置 PermitRootLogin no
sudo systemctl restart sshd
```

### 2. Docker安全

```bash
# 限制容器资源
docker-compose -f docker-compose.prod.yml up -d

# 定期更新镜像
docker-compose pull
docker-compose up -d
```

### 3. 应用安全

- 定期更新依赖：`npm audit fix`
- 使用强密码和密钥
- 启用所有安全中间件
- 限制API访问频率

## 备份恢复

### 自动备份

1. **本地备份**
   ```bash
   # 设置定时备份
   0 2 * * * /path/to/backup.sh
   ```

2. **远程备份**
   ```bash
   # 同步到远程服务器
   rsync -avz backups/ user@backup-server:/backups/telegram-bot/
   ```

### 恢复流程

1. **计划内恢复**
   ```bash
   # 1. 通知用户维护
   # 2. 停止bot服务
   docker-compose stop bot
   # 3. 恢复数据
   ./restore.sh backups/postgres/backup_file.sql.gz
   # 4. 启动服务
   docker-compose start bot
   ```

2. **灾难恢复**
   - 在新服务器部署
   - 恢复最新备份
   - 更新DNS记录
   - 验证服务正常

## 维护计划

### 日常维护
- 检查服务状态
- 查看错误日志
- 监控资源使用

### 周维护
- 备份验证
- 安全更新检查
- 性能分析

### 月维护
- 依赖更新
- 日志清理
- 容量规划

## 联系方式

- 技术支持：tech@example.com
- 紧急联系：+86 xxx xxxx xxxx
- 文档更新：https://github.com/yourusername/telegram-group-bot/wiki

---

最后更新：2024-01-01