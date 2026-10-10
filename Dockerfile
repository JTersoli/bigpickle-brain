# bigpickle-brain: the web interface and the agents, as one small image.
# Node 24 runs the TypeScript sources directly, so there is no build step.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY data.example ./data.example
COPY LICENSE README.md ./

# The notes and the traces live outside the image: mount them (see compose.yaml).
RUN mkdir -p /data/knowledge /data/clients /data/reports /data/proposals /data/reviews /app/runs \
	&& chown -R node:node /data /app/runs
VOLUME ["/data", "/app/runs"]

ENV BRAIN_DATA_DIR=/data \
	BRAIN_RUNS_DIR=/app/runs \
	BRAIN_HOST=0.0.0.0 \
	BRAIN_PORT=8787

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
	CMD node -e "fetch('http://127.0.0.1:8787/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Listening on 0.0.0.0 inside the container requires BRAIN_SERVER_TOKEN: the server refuses to start without it.
CMD ["node", "src/cli.ts", "serve"]
