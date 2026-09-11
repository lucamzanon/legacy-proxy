import type { GoogleClient } from "./connection.js";
import { GmailConnection } from "./connection.js";
import { GmailStore } from "./store.js";
import { JmapError } from "../jmap/errors.js";

/** Shared per-account quota/concurrency budget, including concurrent JMAP envelopes. */
export class GmailApi {
  private client?: GoogleClient;
  private refreshToken?: string;
  private nextSlot = 0;
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private email: string, private connection: GmailConnection, private store: GmailStore) {}
  async get<T>(resource: string, cost: number, params: Record<string, string> = {}): Promise<T> {
    if (this.waiting.length >= 200) throw new JmapError("serverUnavailable", "Gmail request queue is full");
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const slot = Math.max(Date.now(), this.nextSlot);
      this.nextSlot = slot + cost * 1000 / 80; // 4,800 units/min, below the 6,000 default quota.
      if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));
      const saved = await this.store.load(this.email);
      if (!saved) throw new JmapError("accountNotFound");
      if (!this.client || this.refreshToken !== saved.credentials.refreshToken) {
        this.client = this.connection.createClient();
        this.client.setCredentials({ access_token: saved.credentials.accessToken,
          refresh_token: saved.credentials.refreshToken, expiry_date: saved.credentials.expiresAt });
        this.refreshToken = saved.credentials.refreshToken;
      }
      const client = this.client;
      await client.getAccessToken();
      await this.store.updateCredentials(this.email, {
        mech: "XOAUTH2", username: this.email, accessToken: client.credentials.access_token ?? undefined,
        refreshToken: client.credentials.refresh_token ?? this.refreshToken,
        expiresAt: client.credentials.expiry_date ?? undefined,
      }, this.refreshToken);
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${resource}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const { data } = await client.request<T>({ url: url.href, timeout: 15_000, retry: false });
      return data;
    } catch (error) {
      if (error instanceof JmapError) throw error;
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 404) throw new JmapError("notFound");
      if (status === 429 || status === 403) {
        this.nextSlot = Math.max(this.nextSlot, Date.now() + 5000);
        throw new JmapError("serverUnavailable", "Google rate limit or permission error; retry later");
      }
      // Library errors may contain Authorization headers: never pass them to the dispatcher.
      throw new JmapError("serverUnavailable", "Gmail request failed; reconnect if authorization expired");
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
