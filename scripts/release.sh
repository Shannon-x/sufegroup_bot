#!/usr/bin/env bash
#
# 一键发版脚本
#
# 用法:
#   ./scripts/release.sh patch   # 1.0.0 → 1.0.1
#   ./scripts/release.sh minor   # 1.0.0 → 1.1.0
#   ./scripts/release.sh major   # 1.0.0 → 2.0.0
#   ./scripts/release.sh 1.2.3   # 指定版本号
#
# 流程:
#   1. 类型检查
#   2. 更新 VERSION 和 package.json
#   3. 提交并打 tag
#   4. 推送到 GitHub → 自动触发 CI → 构建 Docker → 创建 Release

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 检查是否在 git 仓库中
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo -e "${RED}错误: 不在 git 仓库中${NC}"
  exit 1
fi

# 检查工作目录是否干净
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${YELLOW}警告: 工作目录有未提交的更改${NC}"
  git status --short
  echo ""
  read -p "是否继续? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# 读取当前版本
CURRENT_VERSION=$(cat VERSION 2>/dev/null || echo "0.0.0")
echo -e "当前版本: ${YELLOW}v${CURRENT_VERSION}${NC}"

# 计算新版本
BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP_TYPE"
else
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  case "$BUMP_TYPE" in
    major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    minor) NEW_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
    patch) NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
    *)
      echo -e "${RED}用法: $0 [patch|minor|major|x.y.z]${NC}"
      exit 1
      ;;
  esac
fi

echo -e "新版本:   ${GREEN}v${NEW_VERSION}${NC}"
echo ""

# 类型检查
echo "▸ 运行类型检查..."
npx tsc --noEmit
echo -e "${GREEN}✓ 类型检查通过${NC}"

# 更新版本号
echo "▸ 更新版本号..."
echo "$NEW_VERSION" > VERSION

# 更新 package.json 中的版本
if command -v node &>/dev/null; then
  node -e "
    const pkg = require('./package.json');
    pkg.version = '${NEW_VERSION}';
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
fi

# 提交并打 tag
echo "▸ 提交并打 tag..."
git add VERSION package.json
git commit -m "release: v${NEW_VERSION}"
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

# 推送
echo "▸ 推送到 GitHub..."
git push origin master
git push origin "v${NEW_VERSION}"

echo ""
echo -e "${GREEN}✓ 发版完成!${NC}"
echo ""
echo "  版本: v${NEW_VERSION}"
echo "  GitHub Actions 将自动:"
echo "    1. 运行类型检查"
echo "    2. 构建 Docker 镜像 → ghcr.io/shannon-x/sufegroup_bot:${NEW_VERSION}"
echo "    3. 创建 GitHub Release"
echo ""
echo -e "  查看进度: ${YELLOW}https://github.com/Shannon-x/sufegroup_bot/actions${NC}"
