// Runs once when the server starts (a Next.js convention).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // behind a proxy, the app's own connections (translation, Khmer voices) have to go through it: lib/net.ts
  const { applyProxy } = await import("./lib/net");
  applyProxy();
}
