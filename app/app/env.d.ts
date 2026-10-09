// env.d.ts — secrets are not in wrangler.jsonc, so `wrangler types` cannot see them; declare them here.

declare namespace Cloudflare {
  interface Env {
    INTERNAL_KEY: string;
    SESSION_SECRET: string;
  }
}
