# 推送更改到 GitHub 指南

## 📦 待推送的提交

您有 2 个本地提交需要推送到 GitHub：

```
f0497d2 Fix: Verification flow - Incorrect bot username configuration
a998943 Fix: Automatic database migration on container startup
```

## 🔐 推送方法

### 方法 1: 使用 GitHub Personal Access Token (推荐)

#### 步骤 1: 创建 GitHub Personal Access Token

1. 登录 GitHub: https://github.com
2. 点击右上角头像 → Settings
3. 左侧菜单最下方 → Developer settings
4. Personal access tokens → Tokens (classic)
5. 点击 "Generate new token" → "Generate new token (classic)"
6. 设置:
   - Note: `sufegroup_bot deployment`
   - Expiration: 90 days (或根据需要)
   - 勾选权限: `repo` (完整的仓库访问权限)
7. 点击 "Generate token"
8. **复制生成的 token**（只显示一次！）

#### 步骤 2: 使用 Token 推送

```bash
# 方式 A: 临时使用（每次都需要输入）
cd /data/sufe/sufegroup_bot
git push https://<YOUR_GITHUB_USERNAME>:<YOUR_TOKEN>@github.com/Shannon-x/sufegroup_bot.git master

# 方式 B: 配置 credential helper（记住凭据）
git config credential.helper store
git push origin master
# 然后输入：
# Username: <YOUR_GITHUB_USERNAME>
# Password: <YOUR_PERSONAL_ACCESS_TOKEN>
```

#### 示例:
```bash
# 如果您的用户名是 Shannon-x，token 是 ghp_xxxxxxxxxxxx
git push https://Shannon-x:ghp_xxxxxxxxxxxx@github.com/Shannon-x/sufegroup_bot.git master
```

### 方法 2: 使用 SSH (更安全，推荐长期使用)

#### 步骤 1: 生成 SSH 密钥

```bash
# 生成新的 SSH 密钥
ssh-keygen -t ed25519 -C "your_email@example.com"
# 按 Enter 使用默认位置
# 可以设置密码或直接按 Enter

# 显示公钥
cat ~/.ssh/id_ed25519.pub
```

#### 步骤 2: 添加 SSH 公钥到 GitHub

1. 复制上面命令输出的公钥（以 `ssh-ed25519` 开头）
2. 登录 GitHub → Settings
3. SSH and GPG keys → New SSH key
4. Title: `SUFE Bot Server`
5. 粘贴公钥到 Key 字段
6. 点击 "Add SSH key"

#### 步骤 3: 更改远程 URL 并推送

```bash
cd /data/sufe/sufegroup_bot
git remote set-url origin git@github.com:Shannon-x/sufegroup_bot.git
git push origin master
```

### 方法 3: 手动操作（如果上述方法都不可行）

您可以：

1. 下载当前代码到本地电脑
   ```bash
   cd /data/sufe/sufegroup_bot
   tar -czf sufegroup_bot_updates.tar.gz \
     DATABASE_FIX.md \
     DEPLOYMENT_READY.md \
     TESTING_GUIDE.md \
     VERIFICATION_FIX.md \
     Dockerfile \
     .env.example \
     src/
   ```

2. 在本地电脑上解压并提交
3. 从本地电脑推送到 GitHub

## ✅ 验证推送成功

推送成功后，执行：

```bash
git log --oneline -3
git status
```

应该看到：
```
Your branch is up to date with 'origin/master'.
```

您也可以在 GitHub 网页上查看：
https://github.com/Shannon-x/sufegroup_bot/commits/master

## 🔒 安全提醒

1. **永远不要** 将 `.env` 文件推送到 GitHub（已在 .gitignore 中）
2. **妥善保管** Personal Access Token，不要分享给他人
3. **定期更换** Token（建议每 90 天）
4. **使用 SSH** 密钥比 HTTPS Token 更安全

## 📋 需要推送的文件

这两个提交包含以下重要更改：

### 提交 1: 数据库自动迁移修复
- `DATABASE_FIX.md` - 数据库问题文档
- `DEPLOYMENT_READY.md` - 部署就绪指南
- `Dockerfile` - 修复迁移文件复制
- `src/main.ts` - 添加自动迁移逻辑
- `src/migrations/1706000000000-InitialSchema.ts` - 修复 enum

### 提交 2: 验证流程修复
- `VERIFICATION_FIX.md` - 验证问题详细说明
- `TESTING_GUIDE.md` - 测试指南
- `.env.example` - 添加 BOT_USERNAME 验证说明

## 💡 推荐操作

最快速的方法是使用 **Personal Access Token**：

```bash
# 1. 创建 token (在 GitHub 网页操作)
# 2. 配置 git 记住凭据
cd /data/sufe/sufegroup_bot
git config credential.helper store

# 3. 推送（会提示输入用户名和密码）
git push origin master
# Username: <你的GitHub用户名>
# Password: <粘贴你的Personal Access Token>

# 4. 之后就不需要再输入了
```

---

如果您需要我帮助执行，请提供：
- 您的 GitHub 用户名
- Personal Access Token (如果您已经创建)

或者告诉我您选择哪种方法，我可以引导您完成。
