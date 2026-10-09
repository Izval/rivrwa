import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("simulate", "routes/simulate.ts"),
  route("connect/binance", "routes/connect.tsx"),
  route("connect/binance/status", "routes/connect.status.ts"),
  route("connect/altana", "routes/connect.altana.tsx"),
  route("connect/altana/api", "routes/connect.altana.api.ts"),
  route("mandate", "routes/mandate.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("dashboard/preflight/:asset", "routes/dashboard.preflight.ts"),
  route("history", "routes/history.tsx"),
  route("agent", "routes/agent.tsx"),
  route("logout", "routes/logout.ts"),
  route("telegram/webhook", "routes/telegram.webhook.ts"),
] satisfies RouteConfig;
