FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs viewer.html ./
USER pwuser
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
