import type { FastifyInstance, FastifyBaseLogger, RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression } from "fastify";
import type { AppConfig } from "../util/config.js";
import { CORE_CAPABILITY, MAIL_CAPABILITY, coreCapabilityProps } from "../jmap/capabilities.js";
import { dispatch, type RequestEnvelope } from "../jmap/router.js";
import { JmapError } from "../jmap/errors.js";
import type { GmailConfig } from "./config.js";
import { GmailStore } from "./store.js";
import { GmailConnection } from "./connection.js";
import { GmailApi } from "./api.js";
import { GmailMail } from "./mail.js";

/** Select Gmail before the legacy handlers, without creating an IMAP account. */
export function registerGmailBackend<L extends FastifyBaseLogger>(app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, L>, cfg: AppConfig, google: GmailConfig,
  store: GmailStore, connection: GmailConnection,
  makeMail = (email: string) => new GmailMail(email, new GmailApi(email, connection, store), store, google.writeEnabled ?? false)): void {
  const accounts = new Map<string, GmailMail>();
  const authenticated = new WeakMap<object, { email: string; mail: GmailMail }>();
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (path !== "/jmap" && !path.startsWith("/jmap/")) return;
    const auth = req.headers.authorization ?? "";
    let username: string | undefined, password = "";
    if (/^Basic /i.test(auth)) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon > 0) { username = decoded.slice(0, colon).toLowerCase(); password = decoded.slice(colon + 1); }
    } else if (/^Bearer /i.test(auth)) password = auth.slice(7).trim();
    if (!password.startsWith("gmap_") && !(username && google.allowedEmails.has(username))) return;
    const email = store.authenticate(password, username);
    if (!email || !google.allowedEmails.has(email) || !store.hasConnection(email)) {
      return reply.header("WWW-Authenticate", 'Basic realm="gmail-bridge"').code(401).send({ error: "unauthorized" });
    }
    let mail = accounts.get(email);
    if (!mail) { mail = makeMail(email); accounts.set(email, mail); }
    authenticated.set(req, { email, mail });
    reply.header("Cache-Control", "no-store");
    if (path.startsWith("/jmap/upload/")) return reply.code(403).send({ type: "accountReadOnly" });
  });
  app.addHook("preHandler", async (req, reply) => {
    const selected = authenticated.get(req);
    if (!selected) return;
    const { email, mail } = selected;
    const path = req.url.split("?")[0]!;
    const writable=await mail.writable();
    const sessionState = writable ? "gmail-manage-v1" : "gmail-readonly-v1";
    if (req.method === "GET" && path === "/jmap/session") {
      const mailProps = { maxMailboxesPerEmail: null, maxMailboxDepth: 1, maxSizeMailboxName: 1000,
        maxSizeAttachmentsPerEmail: 50_000_000, emailQuerySortOptions: ["receivedAt"], mayCreateTopLevelMailbox: writable };
      return reply.send({ capabilities: { [CORE_CAPABILITY]: { ...coreCapabilityProps(cfg), maxObjectsInGet: 100, maxObjectsInSet: 20 }, [MAIL_CAPABILITY]: {} },
        accounts: { [mail.accountId]: { name: email, isPersonal: true, isReadOnly: !writable, accountCapabilities: { [MAIL_CAPABILITY]: mailProps } } },
        primaryAccounts: { [MAIL_CAPABILITY]: mail.accountId }, username: email,
        apiUrl: `${cfg.publicUrl}/jmap`, downloadUrl: `${cfg.publicUrl}/jmap/download/{accountId}/{blobId}/{type}/{name}`,
        uploadUrl: `${cfg.publicUrl}/jmap/upload/{accountId}`, state: sessionState });
    }
    if (req.method === "POST" && path === "/jmap") {
      const env = req.body as RequestEnvelope;
      if (!env || !Array.isArray(env.using) || !Array.isArray(env.methodCalls) ||
          env.methodCalls.some((c) => !Array.isArray(c) || c.length !== 3 || typeof c[0] !== "string" ||
            !c[1] || typeof c[1] !== "object" || Array.isArray(c[1]) || typeof c[2] !== "string")) {
        return reply.code(400).send({ error: "malformed JMAP request" });
      }
      if (env.using.some((c) => c !== CORE_CAPABILITY && c !== MAIL_CAPABILITY))
        return reply.code(400).send({ type: "urn:ietf:params:jmap:error:unknownCapability", status: 400 });
      if (env.methodCalls.length > cfg.limits.maxCallsInRequest)
        return reply.code(400).send({ type: "urn:ietf:params:jmap:error:limit", limit: "maxCallsInRequest", status: 400 });
      return reply.send(await dispatch(env, { methods: mail.methods(), maxCallsInRequest: cfg.limits.maxCallsInRequest, sessionState }));
    }
    if (req.method === "GET" && path.startsWith("/jmap/download/")) {
      const p = req.params as { accountId: string; blobId: string; type: string; name: string };
      if (p.accountId !== mail.accountId) return reply.code(404).send({ error: "not found" });
      try {
        const result = await mail.download(p.blobId);
        const type = /^[\w.+-]+\/[\w.+-]+$/.test(p.type) ? p.type : result.type;
        return reply.header("Content-Type", type).header("X-Content-Type-Options", "nosniff")
          .header("Content-Disposition", `attachment; filename="${encodeURIComponent(p.name)}"`).send(result.body);
      } catch (error) {
        const status = error instanceof JmapError && error.type === "notFound" ? 404 : 502;
        return reply.code(status).send({ error: "download unavailable" });
      }
    }
    return reply.code(404).send({ error: "not found" });
  });
}
