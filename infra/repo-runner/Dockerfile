FROM node:24-bookworm
RUN npm install -g pnpm@10.33.4 --ignore-scripts
RUN npx --yes playwright@1.58.2 install-deps
RUN apt-get update && apt-get install -y --no-install-recommends xauth && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /workspace
