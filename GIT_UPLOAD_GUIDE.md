# Git 初始化和 GitHub 上传指南

## 1. 初始化 Git 仓库

```bash
# 进入项目目录
cd /data/sufe/tgbot

# 初始化 Git
git init

# 配置用户信息（如果需要）
git config user.name "Your Name"
git config user.email "your.email@example.com"

# 添加所有文件
git add .

# 创建初始提交
git commit -m "Initial commit: Telegram Group Management Bot"
```

## 2. 创建 GitHub 仓库

1. 登录 [GitHub](https://github.com)
2. 点击右上角的 "+" → "New repository"
3. 填写仓库信息：
   - Repository name: `telegram-group-bot`
   - Description: "Telegram 群组管理机器人，具有新成员验证和管理功能"
   - 选择 "Private" 或 "Public"
   - 不要初始化 README、.gitignore 或 LICENSE（我们已经有了）

## 3. 推送到 GitHub

```bash
# 添加远程仓库（替换为你的仓库地址）
git remote add origin https://github.com/YOUR_USERNAME/telegram-group-bot.git

# 推送到 main 分支
git branch -M main
git push -u origin main
```

## 4. 验证上传

检查以下内容：
- [ ] `.env` 文件没有被上传
- [ ] `logs/` 目录没有被上传
- [ ] `node_modules/` 没有被上传
- [ ] `dist/` 没有被上传
- [ ] 所有源代码都已上传
- [ ] README.md 正确显示

## 5. 设置仓库保护（可选）

如果是私有仓库用于生产环境：
1. Settings → Branches
2. Add rule → Branch name pattern: `main`
3. 启用保护选项：
   - Require pull request reviews
   - Dismiss stale pull request approvals
   - Include administrators

## 6. 添加协作者（如果需要）

1. Settings → Manage access
2. Invite a collaborator
3. 输入协作者的 GitHub 用户名

## 7. 后续更新

```bash
# 查看状态
git status

# 添加修改
git add .

# 提交更改
git commit -m "描述你的更改"

# 推送到 GitHub
git push
```

## 注意事项

1. **永远不要** 提交敏感信息
2. 如果不小心提交了 `.env` 文件：
   ```bash
   git rm --cached .env
   git commit -m "Remove .env file"
   git push
   ```
3. 定期备份你的 `.env` 文件到安全的地方
4. 使用有意义的提交信息

## 在新服务器上部署

```bash
# 克隆仓库
git clone https://github.com/YOUR_USERNAME/telegram-group-bot.git
cd telegram-group-bot

# 运行交互式部署脚本
./deploy.sh

# 脚本会引导你：
# 1. 配置环境变量
# 2. 选择部署模式
# 3. 自动启动服务
# 4. 进行健康检查
```