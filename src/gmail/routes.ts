import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GmailConfig } from "./config.js";

interface Connection {
  authorization(state: string): Promise<{ url: string; verifier: string }>;
  connect(code: string, verifier: string): Promise<string | void>;
}
interface Flow { browser: string; verifier: string; expiresAt: number; issue: boolean }
interface Issued { email: string; password: string; expiresAt: number }
const RESULT_TTL = 2 * 60_000;
const RESULT_COOKIE = "gmail_result";
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const TTL = 10 * 60_000;
const COOKIE = "gmail_oauth";

function page(content: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gmail bridge</title><body><main><h1>Gmail bridge</h1>${content}</main></body></html>`;
}

/** Browser-bound, single-use OAuth flows. No tokens or account data reach the browser. */
export async function registerGmailRoutes(app: FastifyInstance, options: {
  config: GmailConfig; connection: Connection; now?: () => number;
  /** When present, the consent page can issue the Bulwark bridge password itself (self-service onboarding). */
  store?: { issuePassword(email: string): string };
}): Promise<void> {
  const { config, connection, store } = options;
  const issued = new Map<string, Issued>();
  const now = options.now ?? Date.now;
  const flows = new Map<string, Flow>();
  const prune = () => { for (const [state, flow] of flows) if (flow.expiresAt <= now()) flows.delete(state); for (const [k, r] of issued) if (r.expiresAt <= now()) issued.delete(k); };
  const timer = setInterval(prune, TTL).unref();
  app.addHook("onClose", async () => { clearInterval(timer); flows.clear(); issued.clear(); });
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
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    // no-referrer makes browsers send Origin: null on native form POSTs.
    // Keep the origin on this form page; callbacks retain no-referrer above.
    scope.get("/auth/google/start", { logLevel: "silent" }, async (_req, reply) => reply.header("Referrer-Policy", "same-origin").type("text/html").send(page(
      `<p>${config.writeEnabled ? 'Authorize reading and organizing mail: read/unread, stars, archive, trash and labels. Sending is available only when composition is enabled by the operator; permanent mail deletion is not available.' : 'Connect your Gmail account with read-only access.'} Only accounts enabled by the operator can connect.</p><form method="post" action="/auth/google/start">${store ? '<p><label><input type="checkbox" name="issue" value="1" checked> Issue a bridge password for Bulwark (shown once; replaces any previous bridge password for this account)</label></p>' : ''}<button type="submit">Connect Gmail</button></form>`,
    )));
    scope.post("/auth/google/start", { logLevel: "silent" }, async (req, reply) => {
      if (req.headers.origin !== config.origin) return reply.code(403).send({ error: "Invalid origin" });
      prune();
      if (flows.size >= 100) return reply.code(503).send({ error: "Please try again later" });
      const state = crypto.randomBytes(32).toString("base64url");
      const browser = crypto.randomBytes(32).toString("base64url");
      const issue = !!store && (req.body as Record<string, unknown> | undefined)?.issue === "1";
      flows.set(state, { browser, verifier: "", expiresAt: now() + TTL, issue });
      try {
        const { url, verifier } = await connection.authorization(state);
        flows.set(state, { browser, verifier, expiresAt: now() + TTL, issue });
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
        const email = await connection.connect(query.code, flow.verifier);
        if (flow.issue && store && typeof email === "string") {
          // One-time handoff bound to this browser: the secret lives in memory for two minutes and is shown exactly once.
          const key = crypto.randomBytes(32).toString("base64url");
          issued.set(key, { email, password: store.issuePassword(email), expiresAt: now() + RESULT_TTL });
          reply.header("Set-Cookie", [cookie("", 0), `${RESULT_COOKIE}=${key}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${RESULT_TTL / 1000}${config.secureCookies ? "; Secure" : ""}`]);
        }
        return reply.code(303).redirect("/auth/google/result?status=connected");
      } catch {
        // Gaxios errors can include client secrets and tokens: do not log them.
        return reply.code(303).redirect("/auth/google/result?status=failed");
      }
    });
    scope.get("/auth/google/result", { logLevel: "silent" }, async (req, reply) => {
      const status = (req.query as Record<string, unknown>).status;
      const key = (req.headers.cookie ?? "").split(";").map((v) => v.trim()).find((v) => v.startsWith(`${RESULT_COOKIE}=`))?.slice(RESULT_COOKIE.length + 1);
      const result = key ? issued.get(key) : undefined;
      if (key) { issued.delete(key); reply.header("Set-Cookie", `${RESULT_COOKIE}=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? "; Secure" : ""}`); }
      if (status === "connected" && result && result.expiresAt > now()) {
        return reply.type("text/html").send(page(`<p>Gmail connected. Add the account in Bulwark with these credentials. The password is shown only once: copy it now.</p><dl><dt>Server</dt><dd><code>${escape(config.origin)}</code></dd><dt>Username</dt><dd><code>${escape(result.email)}</code></dd><dt>Password</dt><dd><code>${escape(result.password)}</code></dd></dl><p>Any previous bridge password for this account no longer works.</p>`));
      }
      const message = status === "connected"
        ? "Gmail connected. Return to Bulwark and reload the page. Your existing bridge password still works."
        : status === "cancelled" ? "Google authorization was cancelled."
        : "Connection failed. Check that you selected an allowed test account, granted the requested access, and enabled Gmail API, then try again.";
      return reply.type("text/html").send(page(`<p>${message}</p><a href="/auth/google/start">Connect Gmail</a>`));
    });
  });
}
