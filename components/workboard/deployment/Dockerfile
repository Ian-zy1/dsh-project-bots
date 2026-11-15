ARG NODE_IMAGE=node:24.18.0-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --chown=1000:1000 server/ ./server/
COPY --chown=1000:1000 dist/ ./dist/
ENV NODE_ENV=production WORKBOARD_HOST=0.0.0.0 WORKBOARD_PORT=4180 WORKBOARD_DB=/data/workboard.sqlite
USER 1000:1000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4180/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/start.mjs"]
