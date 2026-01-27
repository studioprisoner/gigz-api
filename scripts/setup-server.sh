#!/bin/bash

# Gigz API Server Setup Script
# Run this once on a fresh Ubuntu/Debian server

set -e

echo "🚀 Starting Gigz API server setup..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

# Get domain name from user
read -p "Enter your domain name (e.g., api.gigz.app): " DOMAIN
if [ -z "$DOMAIN" ]; then
    echo -e "${RED}Domain name is required${NC}"
    exit 1
fi

# Update system
echo -e "${YELLOW}Updating system packages...${NC}"
apt-get update
apt-get upgrade -y

# Install essential packages
echo -e "${YELLOW}Installing essential packages...${NC}"
apt-get install -y \
    curl \
    wget \
    git \
    vim \
    htop \
    ufw \
    fail2ban \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    gnupg \
    lsb-release

# Install Docker
echo -e "${YELLOW}Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
    echo -e "${GREEN}Docker already installed${NC}"
fi

# Create deploy user
echo -e "${YELLOW}Creating deploy user...${NC}"
if ! id -u deploy &>/dev/null; then
    useradd -m -s /bin/bash deploy
    usermod -aG docker deploy
    usermod -aG sudo deploy

    # Create SSH directory for deploy user
    mkdir -p /home/deploy/.ssh
    chmod 700 /home/deploy/.ssh
    touch /home/deploy/.ssh/authorized_keys
    chmod 600 /home/deploy/.ssh/authorized_keys
    chown -R deploy:deploy /home/deploy/.ssh

    echo -e "${GREEN}Deploy user created. Add your SSH key to /home/deploy/.ssh/authorized_keys${NC}"
else
    echo -e "${GREEN}Deploy user already exists${NC}"
fi

# Setup application directory
echo -e "${YELLOW}Setting up application directory...${NC}"
mkdir -p /opt/gigz-api
chown -R deploy:deploy /opt/gigz-api

# Install Caddy for SSL
echo -e "${YELLOW}Installing Caddy for SSL...${NC}"
if ! command -v caddy &> /dev/null; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
else
    echo -e "${GREEN}Caddy already installed${NC}"
fi

# Configure Caddy
echo -e "${YELLOW}Configuring Caddy...${NC}"
cat > /etc/caddy/Caddyfile << EOF
$DOMAIN {
    reverse_proxy localhost:3000

    # Optional: Add rate limiting
    rate_limit {
        zone dynamic 10r/s
    }

    # Optional: Add security headers
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        X-XSS-Protection "1; mode=block"
        Referrer-Policy no-referrer-when-downgrade
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    }

    # Health check endpoint (no rate limiting)
    handle /health {
        reverse_proxy localhost:3000
    }

    # Logs
    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 10
        }
    }
}
EOF

# Create log directory for Caddy
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# Reload Caddy
systemctl reload caddy
systemctl enable caddy

# Configure UFW firewall
echo -e "${YELLOW}Configuring firewall...${NC}"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
# Allow Docker networking
ufw allow 2376/tcp
ufw allow 2377/tcp
ufw allow 7946/tcp
ufw allow 7946/udp
ufw allow 4789/udp
ufw --force enable

# Configure fail2ban
echo -e "${YELLOW}Configuring fail2ban...${NC}"
cat > /etc/fail2ban/jail.local << EOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
EOF

systemctl restart fail2ban
systemctl enable fail2ban

# Setup log rotation for Docker
echo -e "${YELLOW}Setting up Docker log rotation...${NC}"
cat > /etc/docker/daemon.json << EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF

systemctl restart docker

# Create deployment script placeholder
echo -e "${YELLOW}Creating deployment script...${NC}"
cat > /opt/gigz-api/deploy.sh << 'EOF'
#!/bin/bash
# This will be replaced by the actual deploy.sh from the repository
echo "Deploy script placeholder - will be replaced during deployment"
EOF
chmod +x /opt/gigz-api/deploy.sh
chown deploy:deploy /opt/gigz-api/deploy.sh

# Setup systemd service for Docker Compose (optional)
echo -e "${YELLOW}Setting up systemd service...${NC}"
cat > /etc/systemd/system/gigz-api.service << EOF
[Unit]
Description=Gigz API Docker Service
Requires=docker.service
After=docker.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/gigz-api
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# Create GitHub Container Registry login helper
echo -e "${YELLOW}Setting up GitHub Container Registry access...${NC}"
cat > /opt/gigz-api/docker-login.sh << 'EOF'
#!/bin/bash
# Use this to login to GitHub Container Registry
# Usage: ./docker-login.sh <github-username> <github-personal-access-token>

if [ $# -ne 2 ]; then
    echo "Usage: $0 <github-username> <github-personal-access-token>"
    exit 1
fi

echo $2 | docker login ghcr.io -u $1 --password-stdin
EOF
chmod +x /opt/gigz-api/docker-login.sh
chown deploy:deploy /opt/gigz-api/docker-login.sh

# Print summary
echo -e "${GREEN}✅ Server setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Add your SSH public key to: /home/deploy/.ssh/authorized_keys"
echo "2. Login to GitHub Container Registry: cd /opt/gigz-api && ./docker-login.sh <username> <token>"
echo "3. Create .env file in /opt/gigz-api/ with your production secrets"
echo "4. Test Caddy configuration: caddy validate --config /etc/caddy/Caddyfile"
echo "5. Your domain $DOMAIN should now have automatic SSL via Caddy"
echo ""
echo "Security notes:"
echo "- Firewall is configured (UFW)"
echo "- Fail2ban is protecting SSH"
echo "- Caddy will auto-provision SSL certificates"
echo "- Docker logs are configured with rotation"
echo ""
echo "To deploy your app:"
echo "- Push to main branch on GitHub"
echo "- GitHub Actions will handle the deployment"
echo ""
echo -e "${YELLOW}Remember to configure GitHub Secrets for deployment!${NC}"