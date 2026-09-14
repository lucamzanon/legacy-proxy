import { invalidArguments, unsupportedFilter } from "../jmap/errors.js";
import { ALL_MAIL, upstreamId } from "./message.js";
import type { GmailLabel } from "./store.js";

const SYSTEM: Record<string, string> = {
  INBOX: "in:inbox",
  SENT: "in:sent",
  DRAFT: "in:drafts",
  SPAM: "in:spam",
  TRASH: "in:trash",
  UNREAD: "is:unread",
  STARRED: "is:starred",
  IMPORTANT: "is:important",
  CHAT: "is:chat",
};
const keyword = (value: unknown) => {
  if (value === "$seen") return "-is:unread";
  if (value === "$flagged") return "is:starred";
  if (value === "$draft") return "in:drafts";
  if (value === "$important") return "is:important";
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 255 || /[\x00-\x20\x7f]/.test(value))
    throw invalidArguments("Invalid keyword");
  // Gmail has no arbitrary JMAP keywords: absent keywords match no messages.
  return "in:anywhere -in:anywhere";
};
function phrase(value: unknown): string {
  if (typeof value !== "string" || !value || /[\r\n\x00]/.test(value))
    throw invalidArguments("Expected a search string");
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
/** Gmail search is token based. Unknown JMAP conditions are explicitly rejected. */
export function gmailFilter(filter: unknown, labels: GmailLabel[], depth = 0): string {
  if (filter == null) return "";
  if (depth > 10 || typeof filter !== "object" || Array.isArray(filter))
    throw invalidArguments("Invalid filter");
  const f = filter as Record<string, unknown>;
  const mailbox = (id: unknown): string => {
    if (id === ALL_MAIL) return "";
    const raw = upstreamId(id, "l_");
    const label = labels.find((label) => label.id === raw);
    if (!label) throw invalidArguments("Unknown mailbox");
    if (SYSTEM[raw]) return SYSTEM[raw];
    if (raw.startsWith("CATEGORY_")) return "category:" + raw.slice(9).toLowerCase();
    return "label:" + phrase(label.name);
  };
  if (f.operator !== undefined) {
    if (
      !["AND", "OR", "NOT"].includes(String(f.operator)) ||
      !Array.isArray(f.conditions) ||
      !f.conditions.length ||
      Object.keys(f).some((k) => !["operator", "conditions"].includes(k))
    )
      throw invalidArguments("Invalid filter operator");
    const clauses = f.conditions.map((c) => gmailFilter(c, labels, depth + 1));
    // Gmail has no literal true/false. Convert these to universal/impossible searches.
    const expressions = clauses.map((c) => c || "{in:anywhere -in:anywhere}");
    if (f.operator === "OR") return "{" + expressions.map((c) => `(${c})`).join(" ") + "}";
    if (f.operator === "NOT") return expressions.map((c) => `-(${c})`).join(" ");
    return clauses
      .filter(Boolean)
      .map((c) => `(${c})`)
      .join(" ");
  }
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(f)) {
    if (key === "inMailbox") clauses.push(mailbox(value));
    else if (key === "hasKeyword") clauses.push(keyword(value));
    else if (key === "notKeyword") clauses.push(`-(${keyword(value)})`);
    else if (["from", "to", "cc", "bcc", "subject"].includes(key)) clauses.push(`${key}:${phrase(value)}`);
    else if (key === "text") clauses.push(phrase(value));
    else if (key === "hasAttachment" && typeof value === "boolean")
      clauses.push(value ? "has:attachment" : "-has:attachment");
    else if (key === "after" || key === "before") {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
        throw invalidArguments("Invalid date filter");
      clauses.push(`${key}:${Math.floor(Date.parse(value) / 1000)}`);
    } else if (key === "minSize" || key === "maxSize") {
      if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw invalidArguments("Invalid size filter");
      clauses.push(
        `${key === "minSize" ? "larger" : "smaller"}:${key === "minSize" ? Math.max(0, (value as number) - 1) : value}`,
      );
    } else throw unsupportedFilter(`Unsupported Gmail filter: ${key}`);
  }
  return clauses.filter(Boolean).join(" ");
}
