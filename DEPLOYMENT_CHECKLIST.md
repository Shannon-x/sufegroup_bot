# 部署检查清单

在将项目上传到 GitHub 之前，请确保完成以下步骤：

## 安全检查

- [ ] 确保 `.env` 文件未被提交（已在 .gitignore 中）
- [ ] 检查代码中没有硬编码的密钥或敏感信息
- [ ] 所有密码字段在 `.env.example` 中都是占位符
- [ ] 数据库备份文件未被提交
- [ ] 日志文件未被提交（logs/ 已在 .gitignore 中）

## 文件准备

- [ ] `.gitignore` 文件已创建并包含所有敏感文件
- [ ] `.env.example` 包含所有必需的环境变量示例
- [ ] `README.md` 包含完整的部署说明
- [ ] `LICENSE` 文件已创建
- [ ] `docker-compose.yml` 和 `docker-compose.prod.yml` 已准备
- [ ] 清理了所有临时测试文件

## 代码检查

- [ ] 所有 TypeScript 代码可以正常编译
- [ ] 数据库迁移文件完整
- [ ] Dockerfile 可以正常构建
- [ ] 包含所有必需的依赖在 package.json 中

## 文档检查

- [ ] README 包含清晰的部署步骤
- [ ] 环境变量说明完整
- [ ] 故障排除指南完整
- [ ] 包含 Nginx 配置示例

## GitHub 准备

1. 创建新的 GitHub 仓库
2. 初始化 Git（如果还没有）：
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```

3. 添加远程仓库：
   ```bash
   git remote add origin https://github.com/yourusername/telegram-group-bot.git
   git branch -M main
   git push -u origin main
   ```

## 部署到新服务器

在新服务器上部署时：

1. 克隆仓库
2. 复制 `.env.example` 到 `.env` 并填写配置
3. 使用 Docker Compose 启动服务
4. 配置 Nginx（如果需要）
5. 测试机器人功能

## 重要提醒

- **永远不要** 提交 `.env` 文件到版本控制
- **定期更新** 依赖包和 Docker 镜像
- **备份数据** 在更新前备份数据库
- **监控日志** 部署后监控错误日志