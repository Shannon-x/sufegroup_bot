#!/bin/bash

# Telegram Group Bot - 交互式部署脚本
# 支持多种部署场景和配置选项

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 函数：打印带颜色的消息
print_message() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# 函数：打印标题
print_header() {
    echo ""
    echo "========================================"
    echo "$1"
    echo "========================================"
    echo ""
}

# 函数：确认操作
confirm() {
    local prompt=$1
    local default=${2:-N}
    
    if [ "$default" = "Y" ]; then
        prompt="$prompt [Y/n]: "
    else
        prompt="$prompt [y/N]: "
    fi
    
    read -p "$prompt" response
    response=${response:-$default}
    
    case "$response" in
        [yY][eE][sS]|[yY]) 
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# 函数：检查命令是否存在
check_command() {
    if ! command -v $1 &> /dev/null; then
        print_message $RED "错误: $1 未安装"
        return 1
    fi
    return 0
}

# 函数：生成随机密钥
generate_secret() {
    openssl rand -hex $1 2>/dev/null || (echo "Error: openssl not found" && exit 1)
}

# 函数：检查端口占用
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

# 主程序开始
clear
print_header "Telegram Group Bot 交互式部署脚本 v1.0"

# 检查必要的工具
print_message $BLUE "检查系统环境..."
missing_tools=()

if ! check_command docker; then
    missing_tools+=("docker")
fi

if ! docker compose version &> /dev/null; then
    if ! check_command docker-compose; then
        missing_tools+=("docker-compose")
    fi
fi

if [ ${#missing_tools[@]} -ne 0 ]; then
    print_message $RED "缺少必要的工具: ${missing_tools[*]}"
    echo "请先安装这些工具后再运行此脚本"
    echo ""
    echo "安装 Docker:"
    echo "  curl -fsSL https://get.docker.com | sh"
    echo "  sudo usermod -aG docker $USER"
    echo ""
    exit 1
fi

print_message $GREEN "✓ 系统环境检查通过"

# 检查是否是首次部署
if [ -f .env ]; then
    print_message $YELLOW "检测到已存在的 .env 文件"
    if confirm "是否要重新配置？这将备份当前配置"; then
        backup_file=".env.backup.$(date +%Y%m%d_%H%M%S)"
        cp .env $backup_file
        print_message $GREEN "✓ 当前配置已备份到: $backup_file"
        first_deploy=false
        reconfigure=true
    else
        first_deploy=false
        reconfigure=false
    fi
else
    if [ ! -f .env.example ]; then
        print_message $RED "错误: 未找到 .env.example 文件"
        exit 1
    fi
    cp .env.example .env
    first_deploy=true
    reconfigure=true
fi

# 配置环境变量
if [ "$reconfigure" = true ]; then
    print_header "配置环境变量"
    
    # Bot Token
    echo "1. Telegram Bot 配置"
    echo "   从 @BotFather 获取 Bot Token"
    read -p "   Bot Token: " bot_token
    while [ -z "$bot_token" ]; do
        print_message $RED "   Bot Token 不能为空"
        read -p "   Bot Token: " bot_token
    done
    
    # Bot Username
    read -p "   Bot 用户名 (不带@): " bot_username
    while [ -z "$bot_username" ]; do
        print_message $RED "   Bot 用户名不能为空"
        read -p "   Bot 用户名 (不带@): " bot_username
    done
    
    # Webhook配置
    echo ""
    echo "2. Webhook ���置 (用于接收 Telegram 消息)"
    read -p "   您的域名 (例如: bot.example.com): " webhook_domain
    if [ ! -z "$webhook_domain" ]; then
        webhook_domain="https://$webhook_domain"
        webhook_secret=$(generate_secret 32)
        print_message $GREEN "   ✓ Webhook Secret 已自动生成"
    fi
    
    # 数据库配置
    echo ""
    echo "3. 数据库配置"
    if confirm "   是否使用内置 PostgreSQL？" Y; then
        use_builtin_db=true
        db_host="postgres"
        db_password=$(generate_secret 16)
        print_message $GREEN "   ✓ 数据库密码已自动生成"
    else
        use_builtin_db=false
        read -p "   数据库主机: " db_host
        read -p "   数据库密码: " db_password
    fi
    
    # Redis配置
    echo ""
    echo "4. Redis 配置"
    if confirm "   是否使用内置 Redis？" Y; then
        use_builtin_redis=true
        redis_host="redis"
        redis_password=$(generate_secret 16)
        print_message $GREEN "   ✓ Redis 密码已自动生成"
    else
        use_builtin_redis=false
        read -p "   Redis 主机: " redis_host
        read -p "   Redis 密码: " redis_password
    fi
    
    # Turnstile配置
    echo ""
    echo "5. Cloudflare Turnstile 配置"
    echo "   从 https://dash.cloudflare.com/ 获取"
    read -p "   Site Key: " turnstile_site_key
    read -p "   Secret Key: " turnstile_secret_key
    
    # 生成其他密钥
    jwt_secret=$(generate_secret 32)
    encryption_key=$(generate_secret 16)
    
    # 写入.env文件
    cat > .env << EOF
# Telegram Group Management Bot Configuration
# Generated at $(date)

## Environment
NODE_ENV=production
LOG_LEVEL=info
LOG_FILE_PATH=./logs/bot.log

## Server Configuration
SERVER_HOST=0.0.0.0
SERVER_PORT=8080

## Telegram Bot Configuration
BOT_TOKEN=$bot_token
BOT_USERNAME=$bot_username
BOT_WEBHOOK_DOMAIN=$webhook_domain
BOT_WEBHOOK_SECRET=$webhook_secret

## Database Configuration
DB_HOST=$db_host
DB_PORT=5432
DB_USERNAME=telegram_bot
DB_PASSWORD=$db_password
DB_DATABASE=telegram_bot

## Redis Configuration
REDIS_HOST=$redis_host
REDIS_PORT=6379
REDIS_PASSWORD=$redis_password

## Security Configuration
JWT_SECRET=$jwt_secret
ENCRYPTION_KEY=$encryption_key

## Cloudflare Turnstile
TURNSTILE_SITE_KEY=$turnstile_site_key
TURNSTILE_SECRET_KEY=$turnstile_secret_key

## Bot Settings
DEFAULT_VERIFY_TTL_MINUTES=10
DEFAULT_AUTO_ACTION=restrict
DEFAULT_RATE_LIMIT_WINDOW_MS=60000
DEFAULT_RATE_LIMIT_MAX_REQUESTS=10
EOF

    print_message $GREEN "✓ 配置文件已生成"
fi

# 选择部署模式
print_header "选择部署模式"

echo "1) 完整部署 - 包含所有服务 (PostgreSQL + Redis + Bot)"
echo "2) 仅机器人 - 使用外部数据库和 Redis"
echo "3) 开发模式 - 用于本地开发测试"
echo "4) 更新部署 - 仅更新机器人代码"
echo ""
read -p "请选择部署模式 [1-4]: " deploy_mode

# 检查端口
print_message $BLUE "检查端口占用..."
port_conflict=false

if ! check_port 8080; then
    print_message $YELLOW "警告: 端口 8080 已被占用"
    port_conflict=true
fi

if [ "$deploy_mode" = "1" ] || [ "$deploy_mode" = "3" ]; then
    if ! check_port 5432; then
        print_message $YELLOW "警告: 端口 5432 (PostgreSQL) 已被占用"
        port_conflict=true
    fi
    if ! check_port 6379; then
        print_message $YELLOW "警告: 端口 6379 (Redis) 已被占用"
        port_conflict=true
    fi
fi

if [ "$port_conflict" = true ]; then
    if ! confirm "检测到端口冲突，是否继续？"; then
        exit 1
    fi
fi

# 执行部署
print_header "开始部署"

case $deploy_mode in
    1)
        print_message $BLUE "执行完整部署..."
        docker compose down 2>/dev/null || true
        docker compose build
        docker compose up -d
        services="bot postgres redis"
        ;;
    2)
        print_message $BLUE "部署机器人服务..."
        docker compose stop bot 2>/dev/null || true
        docker compose rm -f bot 2>/dev/null || true
        docker compose build bot
        docker compose up -d bot
        services="bot"
        ;;
    3)
        print_message $BLUE "启动开发模式..."
        docker compose down 2>/dev/null || true
        docker compose build
        docker compose up
        exit 0
        ;;
    4)
        print_message $BLUE "更新机器人代码..."
        docker compose stop bot
        docker compose build bot
        docker compose up -d bot
        services="bot"
        ;;
    *)
        print_message $RED "无效的选项"
        exit 1
        ;;
esac

# 等待服务启动
print_message $BLUE "等待服务启动..."
sleep 10

# 检查服务状态
print_header "服务状态检查"
docker compose ps

# 健康检查
print_message $BLUE "执行健康检查..."
sleep 5

health_check_passed=true
max_retries=3
retry=0

while [ $retry -lt $max_retries ]; do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health | grep -q "200"; then
        print_message $GREEN "✓ 健康检查通过"
        break
    else
        retry=$((retry + 1))
        if [ $retry -lt $max_retries ]; then
            print_message $YELLOW "健康检查失败，重试 $retry/$max_retries..."
            sleep 5
        else
            print_message $RED "✗ 健康检查失败"
            health_check_passed=false
        fi
    fi
done

# 显示日志
if [ "$health_check_passed" = false ]; then
    print_message $YELLOW "显示错误日志..."
    docker compose logs --tail=50 bot
fi

# 部署后配置
print_header "部署后配置"

if [ "$first_deploy" = true ] || confirm "是否要配置 Nginx 反向代理？"; then
    echo ""
    echo "Nginx 配置示例已生成到: nginx-config-example.conf"
    cat > nginx-config-example.conf << 'EOF'
server {
    listen 443 ssl http2;
    server_name YOUR_DOMAIN;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /telegram-webhook {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Telegram-Bot-Api-Secret-Token $http_x_telegram_bot_api_secret_token;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
fi

# 显示部署信息
print_header "部署完成！"

print_message $GREEN "服务已成功启动："
echo "  - Bot 服务: http://localhost:8080"
if [ "$deploy_mode" = "1" ]; then
    echo "  - PostgreSQL: localhost:5432"
    echo "  - Redis: localhost:6379"
fi

echo ""
print_message $BLUE "常用命令："
echo "  查看日志:     docker compose logs -f bot"
echo "  停止服务:     docker compose stop"
echo "  启动服务:     docker compose start"
echo "  重启服务:     docker compose restart"
echo "  删除服务:     docker compose down"
echo "  查看状态:     docker compose ps"

echo ""
print_message $BLUE "下一步操作："
echo "1. 配置 Nginx 反向代理（如需要）"
echo "2. 将机器人添加到群组并设置为管理员"
echo "3. 使用 /help 查看可用命令"

if [ ! -z "$webhook_domain" ]; then
    echo ""
    print_message $YELLOW "重要: 请确保您的域名 $webhook_domain 已正确解析并配置了 SSL 证书"
fi

echo ""
print_message $GREEN "部署脚本执行完成！"