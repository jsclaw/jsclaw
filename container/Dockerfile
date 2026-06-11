FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium env for puppeteer/playwright
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create workspace structure
RUN mkdir -p /workspace/group /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /app

# Copy agent runner and MCP server
COPY agent-runner.js /app/agent-runner.js
COPY mcp-server.js /app/mcp-server.js

# Install container-side dependencies
WORKDIR /app
RUN cat > package.json <<'PKG' && npm install --production
{
  "name": "jsclaw-agent",
  "version": "0.0.1",
  "type": "module",
  "dependencies": {
    "@anthropic-ai/claude-code": "latest",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "cron-parser": "^5.0.0"
  }
}
PKG

WORKDIR /workspace/group

ENTRYPOINT ["node", "/app/agent-runner.js"]
