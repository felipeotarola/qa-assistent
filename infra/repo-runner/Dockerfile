FROM node:22-bookworm AS node22
FROM eclipse-temurin:21-jdk-jammy AS java21
FROM node:24-bookworm
COPY --from=node22 /usr/local/ /opt/node22/
COPY --from=java21 /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH
RUN npm install -g pnpm@10.33.4 --ignore-scripts
RUN npx --yes playwright@1.58.2 install-deps
RUN apt-get update && apt-get install -y --no-install-recommends xauth python3 python3-venv maven && rm -rf /var/lib/apt/lists/*
COPY process.cjs /opt/qa/process.cjs
USER node
WORKDIR /workspace
