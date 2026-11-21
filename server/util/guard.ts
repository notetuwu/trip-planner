// The API can spend money (API keys) and change files, so it only answers this machine's own pages: requests from
// other websites (which a browser would send with their Origin) and DNS-rebinding tricks (a foreign Host) are refused.
import type { Req } from "./http";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Why the request is refused, or null when it's fine. */
export function refuse(req: Req): string | null {
  if (!LOCAL_HOST.test(req.headers.host || "")) return "This server only answers on localhost.";
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin) && !(origin === "null" && req.method === "GET")) return "Requests from other sites are not allowed.";
  return null;
}
