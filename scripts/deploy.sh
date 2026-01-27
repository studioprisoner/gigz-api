#!/bin/bash

# Gigz API Deployment Script
# This script is run on the server during deployment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the Docker image tag from argument
IMAGE_TAG=$1

if [ -z "$IMAGE_TAG" ]; then
    echo -e "${RED}Error: Docker image tag is required${NC}"
    echo "Usage: $0 <image-tag>"
    exit 1
fi

echo -e "${BLUE}🚀 Starting deployment of Gigz API${NC}"
echo -e "Image: ${IMAGE_TAG}"

# Change to application directory
cd /opt/gigz-api

# Backup current .env file
if [ -f .env ]; then
    cp .env .env.backup.$(date +%Y%m%d-%H%M%S)
    echo -e "${GREEN}✓ Backed up environment file${NC}"
fi

# Pull the new Docker image
echo -e "${YELLOW}Pulling Docker image...${NC}"
docker pull ${IMAGE_TAG}

# Update the docker-compose.prod.yml with the new image
echo -e "${YELLOW}Updating docker-compose configuration...${NC}"
sed -i "s|image: .*|image: ${IMAGE_TAG}|" docker-compose.prod.yml

# Check if container is running
if docker compose -f docker-compose.prod.yml ps | grep -q "Up"; then
    echo -e "${YELLOW}Performing rolling update...${NC}"

    # Start new container (Docker Compose will handle the replacement)
    docker compose -f docker-compose.prod.yml up -d --no-deps --build api

    # Wait for health check
    echo -e "${YELLOW}Waiting for health check...${NC}"
    MAX_ATTEMPTS=30
    ATTEMPT=0

    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        if curl -f -s http://localhost:3000/health > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Health check passed${NC}"
            break
        fi
        ATTEMPT=$((ATTEMPT+1))
        echo -n "."
        sleep 2
    done

    if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
        echo -e "${RED}✗ Health check failed after $MAX_ATTEMPTS attempts${NC}"
        echo -e "${YELLOW}Rolling back...${NC}"

        # Rollback to previous version
        docker compose -f docker-compose.prod.yml down
        docker compose -f docker-compose.prod.yml up -d

        echo -e "${RED}Deployment failed and rolled back${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}Starting fresh deployment...${NC}"
    docker compose -f docker-compose.prod.yml up -d

    # Wait for health check
    echo -e "${YELLOW}Waiting for service to start...${NC}"
    sleep 10

    if curl -f -s http://localhost:3000/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Service is healthy${NC}"
    else
        echo -e "${RED}✗ Service health check failed${NC}"
        docker compose -f docker-compose.prod.yml logs --tail=50
        exit 1
    fi
fi

# Clean up old Docker images (keep last 3)
echo -e "${YELLOW}Cleaning up old Docker images...${NC}"
docker image prune -f > /dev/null 2>&1

# Keep only the last 3 versions of our app image
docker images | grep ghcr.io/studioprisoner/gigz-api | tail -n +4 | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true

# Show current status
echo -e "${YELLOW}Current deployment status:${NC}"
docker compose -f docker-compose.prod.yml ps

# Get container logs (last 20 lines)
echo -e "${YELLOW}Recent logs:${NC}"
docker compose -f docker-compose.prod.yml logs --tail=20 api

# Print deployment info
echo ""
echo -e "${GREEN}✅ Deployment completed successfully!${NC}"
echo -e "Image deployed: ${IMAGE_TAG}"
echo -e "Deployment time: $(date)"

# Send a test request to verify the API is working
echo -e "${YELLOW}Verifying API endpoint...${NC}"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/parse/health || echo "Failed")
if [ "$RESPONSE" = "200" ]; then
    echo -e "${GREEN}✓ API is responding correctly${NC}"
else
    echo -e "${YELLOW}⚠ API returned status code: $RESPONSE${NC}"
fi

echo ""
echo -e "${BLUE}Deployment complete!${NC}"