// root.tsx — document shell, fonts, the signed-in account for the top bar, and the error page.

import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/root";
import { AppShell } from "./components/AppShell.tsx";
import { getOwner } from "./lib/session.server.ts";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wdth,wght@0,75..100,400..700;1,75..100,400..700&family=JetBrains+Mono:wght@400;500&display=swap",
  },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export async function loader({ request }: Route.LoaderArgs) {
  return { owner: await getOwner(request) };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before paint: hide the hero's parts so its intro can play them in (see .intro in app.css). */}
        <script dangerouslySetInnerHTML={{ __html: `if(!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.classList.add("intro")` }} />
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f7f8fa" />
        <Meta />
        <Links />
      </head>
      <body>
        <AppShell owner={data?.owner ?? null}>{children}</AppShell>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let detail = "River could not load this page. Try again in a moment.";
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : `Error ${error.status}`;
    detail = error.status === 404 ? "That page does not exist." : error.statusText || detail;
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
  }
  return (
    <div className="py-16">
      <h1 className="text-3xl font-semibold tracking-[-0.02em]">{title}</h1>
      <p className="mt-2 text-ink-2">{detail}</p>
      <a href="/" className="mt-6 inline-block font-semibold text-river">Back to River</a>
    </div>
  );
}
