import type { GoogleClient } from "./connection.js";
import { GmailConnection } from "./connection.js";
import { GmailStore } from "./store.js";
import { GMAIL_MODIFY } from "./config.js";
import { JmapError } from "../jmap/errors.js";

/** A write Google never received or explicitly refused: nothing changed upstream, so it is safe to retry. */
export class GmailNotSent extends JmapError {}

/** Shared per-account quota/concurrency budget, including concurrent JMAP envelopes. */
export class GmailApi {
  private client?: GoogleClient;
  private refreshToken?: string;
  private scopeKey?: string;
  private nextSlot = 0;
  private active = 0;
  private blockedUntil = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private email: string,
    private connection: GmailConnection,
    private store: GmailStore,
  ) {}
  async get<T>(resource: string, cost: number, params: Record<string, string> = {}): Promise<T> {
    return this.request<T>(resource, cost, params);
  }
  async mutate<T>(
    resource: string,
    cost: number,
    method: "POST" | "PATCH" | "DELETE",
    data?: unknown,
  ): Promise<T> {
    const allowed =
      (method === "POST" &&
        (resource === "labels" ||
          resource === "watch" ||
          resource === "stop" ||
          /^messages\/[A-Za-z0-9_-]+\/modify$/.test(resource))) ||
      ((method === "PATCH" || method === "DELETE") && /^labels\/[A-Za-z0-9_-]+$/.test(resource));
    const compose =
      this.connection.config?.composeEnabled &&
      ((method === "POST" && (resource === "drafts" || resource === "drafts/send")) ||
        (method === "DELETE" && /^drafts\/[A-Za-z0-9_-]+$/.test(resource)));
    if (!allowed && !compose) throw new GmailNotSent("forbidden", "Unsupported Gmail write operation");
    return this.request<T>(resource, cost, {}, method, data);
  }
  private async request<T>(
    resource: string,
    cost: number,
    params: Record<string, string>,
    method?: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<T> {
    if (this.waiting.length >= 200)
      throw new (method ? GmailNotSent : JmapError)("serverUnavailable", "Gmail request queue is full");
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    // Set right before a write reaches the network: failures before that point never changed Gmail.
    let dispatched = false;
    try {
      const saved = await this.store.load(this.email);
      if (!saved) throw new JmapError("accountNotFound");
      if (
        method &&
        (!this.connection.config.writeEnabled || !saved.credentials.scopes?.includes(GMAIL_MODIFY))
      )
        throw new JmapError("accountReadOnly");
      if (
        !this.client ||
        this.refreshToken !== saved.credentials.refreshToken ||
        this.scopeKey !== (saved.credentials.scopes ?? []).join(" ")
      ) {
        this.client = this.connection.createClient();
        this.client.setCredentials({
          access_token: saved.credentials.accessToken,
          refresh_token: saved.credentials.refreshToken,
          expiry_date: saved.credentials.expiresAt,
        });
        this.refreshToken = saved.credentials.refreshToken;
        this.scopeKey = (saved.credentials.scopes ?? []).join(" ");
      }
      const client = this.client;
      await client.getAccessToken();
      await this.store.updateCredentials(
        this.email,
        {
          mech: "XOAUTH2",
          username: this.email,
          accessToken: client.credentials.access_token ?? undefined,
          refreshToken: client.credentials.refresh_token ?? this.refreshToken,
          expiresAt: client.credentials.expiry_date ?? undefined,
          scopes: saved.credentials.scopes,
        },
        this.refreshToken,
      );
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${resource}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      for (let attempt = 0; ; attempt++) {
        const slot = Math.max(Date.now(), this.nextSlot);
        this.nextSlot = slot + (cost * 1000) / 80; // 4,800 units/min, including retries.
        if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));
        // A sibling request can extend the cooldown while this one is waiting.
        while (this.blockedUntil > Date.now()) {
          const wait = this.blockedUntil - Date.now();
          if (wait > 10_000) throw new JmapError("serverUnavailable", "Google rate limit; retry later");
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        try {
          dispatched = true;
          const { data } = await client.request<T>({
            url: url.href,
            timeout: 15_000,
            retry: false,
            ...(method ? { method, ...(body === undefined ? {} : { data: body }) } : {}),
          });
          return data;
        } catch (error) {
          const response = (
            error as {
              response?: {
                status?: number;
                data?: { error?: { errors?: { reason?: string }[] } };
                headers?: { get?: (key: string) => string | null };
              };
            }
          ).response;
          const status = response?.status;
          const reason = response?.data?.error?.errors?.[0]?.reason;
          const rateLimited =
            status === 429 ||
            (status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"));
          const code =
            (error as { code?: string; cause?: { code?: string } }).code ??
            (error as { cause?: { code?: string } }).cause?.code;
          const networkFailure =
            code !== undefined &&
            ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"].includes(code);
          const temporary =
            networkFailure || rateLimited || (status !== undefined && [500, 502, 503, 504].includes(status));
          if (method) {
            // A 4xx answer means Google refused the write; timeouts, resets and 5xx leave the outcome unknown.
            if (status === 404) throw new GmailNotSent("notFound");
            if (status === 400) throw new GmailNotSent("invalidProperties", "Google rejected the update");
            if (status === 409) throw new GmailNotSent("alreadyExists");
            if (rateLimited) throw new GmailNotSent("serverUnavailable", "Google rate limit; retry later");
            if (status === 401)
              throw new GmailNotSent(
                "serverUnavailable",
                "Google authorization expired or was revoked. Reconnect the Google account; the saved draft is retained.",
              );
            if (status !== undefined && status >= 400 && status < 500)
              throw new GmailNotSent("forbidden", "Google refused the update; verify account permissions");
            throw new JmapError("serverFail", "Google update failed; refresh before retrying");
          }
          if (!temporary) {
            if (status === 403)
              throw new JmapError(
                "serverUnavailable",
                reason === "dailyLimitExceeded"
                  ? "Google daily quota exceeded"
                  : "Google denied access; verify account permissions",
              );
            throw error;
          }
          const retryAfter = response?.headers?.get?.("retry-after");
          const requestedDelay = retryAfter
            ? /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now()
            : 0;
          const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(requestedDelay) ? requestedDelay : 0);
          this.blockedUntil = Math.max(this.blockedUntil, Date.now() + delay);
          if (attempt >= 2 || delay > 10_000)
            throw new JmapError(
              "serverUnavailable",
              rateLimited ? "Google rate limit; retry later" : "Google temporarily unavailable; retry later",
            );
        }
      }
    } catch (error) {
      const mapped = sanitize(error);
      if (method && !dispatched && !(mapped instanceof GmailNotSent))
        throw new GmailNotSent(mapped.type, mapped.message);
      throw mapped;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Library errors may contain Authorization headers: never pass them to the dispatcher. */
function sanitize(error: unknown): JmapError {
  if (error instanceof JmapError) return error;
  const status = (error as { response?: { status?: number } }).response?.status;
  if (status === 404) return new JmapError("notFound");
  const reason = (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
  if (status === 401 || reason === "invalid_grant")
    return new JmapError(
      "serverUnavailable",
      "Google authorization expired or was revoked. Reconnect the Google account; the saved draft is retained.",
    );
  return new JmapError("serverUnavailable", "Gmail request failed; reconnect if authorization expired");
}
