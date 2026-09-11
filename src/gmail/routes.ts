import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GmailConfig } from "./config.js";

interface Connection {
  authorization(state: string): Promise<{ url: string; verifier: string }>;
  connect(code: string, verifier: string): Promise<void>;
}
interface Flow { browser: string; verifier: string; expiresAt: number }
const TTL = 10 * 60_000;
const COOKIE = "gmail_oauth";

function page(content: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gmail bridge</title><body><main><h1>Gmail bridge</h1>${content}</main></body></html>`;
}

/** Browser-bound, single-use OAuth flows. No tokens or account data reach the browser. */
export async function registerGmailRoutes(app: FastifyInstance, options: {
  config: GmailConfig; connection: Connection; now?: () => number;
}): Promise<void> {
  const { config, connection } = options;
  const now = options.now ?? Date.now;
  const flows = new Map<string, Flow>();
  const prune = () => { for (const [state, flow] of flows) if (flow.expiresAt <= now()) flows.delete(state); };
  const timer = setInterval(prune, TTL).unref();
  app.addHook("onClose", async () => { clearInterval(timer); flows.clear(); });
  const cookie = (value: string, age: number) =>
    `${COOKIE}=${value}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${age}${config.secureCookies ? "; Secure" : ""}`;
  // Encapsulation confines security headers to these routes. Logs must never
  // capture Google's authorization code in the callback query string.
  await app.register(async (scope) => {
    scope.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Content-Security-Policy", `default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`);
      reply.header("X-Content-Type-Options", "nosniff");
    });
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, _body, done) => done(null, {}));
    // no-referrer makes browsers send Origin: null on native form POSTs.
    // Keep the origin on this form page; callbacks retain no-referrer above.
    scope.get("/auth/google/start", { logLevel: "silent" }, async (_req, reply) => reply.header("Referrer-Policy", "same-origin").type("text/html").send(page(
      '<p>Connect your Gmail account with read-only access. Only accounts enabled by the operator can connect.</p><form method="post" action="/auth/google/start"><button type="submit">Connect Gmail</button></form>',
    )));
    scope.post("/auth/google/start", { logLevel: "silent" }, async (req, reply) => {
      if (req.headers.origin !== config.origin) return reply.code(403).send({ error: "Invalid origin" });
      prune();
      if (flows.size >= 100) return reply.code(503).send({ error: "Please try again later" });
      const state = crypto.randomBytes(32).toString("base64url");
      const browser = crypto.randomBytes(32).toString("base64url");
      flows.set(state, { browser, verifier: "", expiresAt: now() + TTL });
      try {
        const { url, verifier } = await connection.authorization(state);
        flows.set(state, { browser, verifier, expiresAt: now() + TTL });
        reply.header("Set-Cookie", cookie(browser, TTL / 1000));
        return reply.code(303).redirect(url);
      } catch {
        flows.delete(state);
        return reply.code(503).send({ error: "Unable to start Google authorization" });
      }
    });
    scope.get("/auth/google/callback", { logLevel: "silent" }, async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const state = typeof query.state === "string" ? query.state : "";
      const flow = flows.get(state);
      const browser = (req.headers.cookie ?? "").split(";").map((v) => v.trim())
        .find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (!flow || flow.expiresAt <= now() || browser !== flow.browser) {
        return reply.code(400).type("text/html").send(page('<p>Authorization expired or belongs to another browser.</p><a href="/auth/google/start">Try again</a>'));
      }
      flows.delete(state); // Consume before the first await: replay cannot exchange a code twice.
      reply.header("Set-Cookie", cookie("", 0));
      if (query.error || typeof query.code !== "string" || !query.code) {
        return reply.code(303).redirect("/auth/google/result?status=cancelled");
      }
      try {
        await connection.connect(query.code, flow.verifier);
        return reply.code(303).redirect("/auth/google/result?status=connected");
      } catch {
        // Gaxios errors can include client secrets and tokens: do not log them.
        return reply.code(303).redirect("/auth/google/result?status=failed");
      }
    });
    scope.get("/auth/google/result", { logLevel: "silent" }, async (req, reply) => {
      const status = (req.query as Record<string, unknown>).status;
      const message = status === "connected"
        ? "Gmail connected. Credentials and the initial label list have been saved. Mail browsing in Bulwark is not available yet."
        : status === "cancelled" ? "Google authorization was cancelled."
        : "Connection failed. Check that you selected an allowed test account, granted read access, and enabled Gmail API, then try again.";
      return reply.type("text/html").send(page(`<p>${message}</p><a href="/auth/google/start">Connect Gmail</a>`));
    });
  });
}
