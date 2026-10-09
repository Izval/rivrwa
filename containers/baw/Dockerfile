# River's baw runner: the Binance Agentic Wallet CLI behind a tiny HTTP server, for the agent Worker.
# No libsecret on purpose: without it baw keeps the whole session in $BINANCE_BAW_DIR/session.json, which the
# Worker stores encrypted in D1 and hands back on every call. Nothing persists in this container.
FROM node:24-bookworm-slim
RUN npm install -g @binance/agentic-wallet@1.10.0 && npm cache clean --force
WORKDIR /app
COPY server.ts .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.ts"]
