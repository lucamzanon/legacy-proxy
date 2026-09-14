import fs from "node:fs";

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

export interface GmailConfig {
  writeEnabled?: boolean;
  composeEnabled?: boolean;
  aliasesEnabled?: boolean;
  /** Delayed send queue (FUTURERELEASE). Absent = immediate sends only. */
  schedule?: { maxDelayedSend: number; lateTolerance: number };
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  origin: string;
  allowedEmails: ReadonlySet<string>;
  secureCookies: boolean;
}

const positive = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Gmail schedule settings must be positive integers (seconds)");
  return n;
};

/** Opt-in: absent credentials leave every existing legacy deployment unchanged. */
export function loadGmailConfig(publicUrl: string): GmailConfig | null {
  const file = process.env.GMAIL_OAUTH_CLIENT_FILE;
  if (!file) return null;
  const { web } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof web?.client_id !== "string" || !web.client_id ||
      typeof web?.client_secret !== "string" || !web.client_secret) {
    throw new Error("GMAIL_OAUTH_CLIENT_FILE must contain a Google Web OAuth client");
  }
  const base = new URL(publicUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new Error("Gmail PUBLIC_URL must be an HTTPS origin (HTTP loopback is allowed for development)");
  }
  const allowedEmails = new Set((process.env.GMAIL_ALLOWED_EMAILS ?? "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (!allowedEmails.size) throw new Error("GMAIL_ALLOWED_EMAILS must name the accounts allowed to connect");
  return {
    writeEnabled: process.env.GMAIL_WRITE_ENABLED === "true",
    composeEnabled: process.env.GMAIL_COMPOSE_ENABLED === "true",
    aliasesEnabled: process.env.GMAIL_ALIASES_ENABLED === "true",
    ...(process.env.GMAIL_SCHEDULE_ENABLED === "true" ? { schedule: {
      maxDelayedSend: positive(process.env.GMAIL_MAX_DELAYED_SEND, 30 * 86400),
      lateTolerance: positive(process.env.GMAIL_SCHEDULE_LATE_TOLERANCE, 900) } } : {}),
    clientId: web.client_id, clientSecret: web.client_secret,
    origin: base.origin, redirectUri: `${base.origin}/auth/google/callback`,
    allowedEmails, secureCookies: base.protocol === "https:",
  };
}
