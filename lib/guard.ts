// The app listens on 127.0.0.1 only, but the browser runs pages of every website the user opens. Without this,
// any web page could call the API (set a download proxy, start jobs, replace the logo), and with "DNS rebinding"
// (its own name pointed at 127.0.0.1) even read the projects. Only the app's own page may use the API.
//
// proxy.ts applies it to the API, except the upload routes: Next.js keeps the whole body of a request that passes
// through proxy.ts in memory (and cuts it at 10 MB), so those call it themselves before streaming to disk.
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A 403 for a request that does not come from the app's own page; null when it does. */
export function forbidden(req: Request): Response | null {
  const no = () => Response.json({ detail: "Forbidden" }, { status: 403 });
  const host = req.headers.get("host") ?? "";
  if (!LOCAL.has(host.replace(/:\d+$/, "").toLowerCase())) return no();
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    try { if (new URL(origin).host.toLowerCase() === host.toLowerCase()) return null; } catch { /* not a URL */ }
    return no();
  }
  if (origin === "null" || req.headers.get("sec-fetch-site") === "cross-site") return no();
  return null;
}

