FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY browser/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY browser/server.mjs browser/policy.mjs browser/redaction.mjs browser/viewer.html browser/frame-hub.mjs ./
COPY execution /execution
USER pwuser
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
