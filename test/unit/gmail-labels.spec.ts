import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailMail } from "../../src/gmail/mail.js";
import { mapMessage } from "../../src/gmail/message.js";

const email = "labels@example.test";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
const labels = [
  { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 2, messagesUnread: 1 },
  { id: "UNREAD", name: "UNREAD", type: "system", messagesTotal: 1 },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "CHAT", name: "CHAT", type: "system" },
  { id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" },
  { id: "Label_1", name: "Receipts", type: "user", labelListVisibility: "labelHide" },
];

it("lists places mail is filed, not read, star or importance states", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-labels-"));
  const store = new GmailStore(dir, crypto.randomBytes(32));
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = vi.fn(async (resource: string) => {
    if (resource === "profile")
      return { emailAddress: email, historyId: "5", messagesTotal: 2, threadsTotal: 2 };
    if (resource === "labels") return { labels };
    if (resource.startsWith("labels/")) return labels.find((l) => l.id === resource.slice(7));
    throw Error("Unexpected fixture resource " + resource);
  });
  const mail = new GmailMail(email, { get } as any, store);
  const boxes = await mail.mailboxes();
  expect(boxes.map((b) => b.id)).toEqual(["all", "l_INBOX", "l_CATEGORY_SOCIAL", "l_Label_1"]);
  expect(boxes.find((b) => b.id === "l_INBOX")!.name).toBe("Inbox");
  expect(boxes.find((b) => b.id === "l_CATEGORY_SOCIAL")!.name).toBe("Social");
  expect(boxes.find((b) => b.id === "l_Label_1")).toMatchObject({ name: "Receipts", isSubscribed: false });
  expect(boxes.find((b) => b.id === "all")!.unreadEmails).toBe(1);
  const mapped = await mapMessage(
    { id: "m", threadId: "t", internalDate: "0", labelIds: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"] },
    { properties: ["mailboxIds", "keywords"] },
    async () => Buffer.alloc(0),
  );
  expect(mapped.mailboxIds).toEqual({ all: true, l_INBOX: true });
  expect(mapped.keywords).toEqual({ $flagged: true, $important: true });
});
