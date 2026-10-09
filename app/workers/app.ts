// app.ts — the Worker entry: every request goes to React Router's server build. Bindings are read in loaders
// through `import { env } from "cloudflare:workers"`, so no load context is passed.

import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "www.rivrwa.com") {
      url.hostname = "rivrwa.com";
      return Response.redirect(url.toString(), 301);
    }
    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
