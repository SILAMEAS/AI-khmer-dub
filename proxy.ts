import { NextResponse, type NextRequest } from "next/server";
import { forbidden } from "./lib/guard";

// Only the app's own page may use the API (see lib/guard.ts).
export function proxy(req: NextRequest) {
  return forbidden(req) ?? NextResponse.next();
}

// Every API path except the upload routes (lib/guard.ts UPLOAD_ROUTES - they check for themselves): Next.js keeps
// the whole body of a request that passes through here in memory and cuts it at 10 MB, which would break every
// video upload. (The matcher has to be a literal: Next.js reads it from the source.)
export const config = {
  matcher: "/api/((?!jobs$|branding/clips$|branding/music$|branding/logo$|branding/fonts$|branding/stickers$).*)",
};
