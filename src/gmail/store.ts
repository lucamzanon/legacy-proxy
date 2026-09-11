import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openCredentials, sealCredentials, type Credentials } from "../auth/credentials.js";

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}
export interface GmailLabel { id: string; name: string; type: string }
export interface GmailSnapshot { profile: GmailProfile; labels: GmailLabel[] }

/** Separate from legacy IMAP account rows until Gmail JMAP methods are available. */
export class GmailStore {
  private readonly db: Database.Database;
  constructor(dataDir: string, private readonly vaultKey: Buffer) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "gmail.sqlite3");
    // Set permissions before SQLite opens WAL/SHM sidecars.
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new Database(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gmail_connection (
        email TEXT PRIMARY KEY,
        vault BLOB NOT NULL,
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }
  async save(email: string, credentials: Credentials, snapshot: GmailSnapshot): Promise<void> {
    const vault = await sealCredentials(this.vaultKey, credentials);
    this.db.prepare(`INSERT INTO gmail_connection (email, vault, snapshot, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET
      vault=excluded.vault, snapshot=excluded.snapshot, updated_at=excluded.updated_at`)
      .run(email, vault, JSON.stringify(snapshot), Date.now());
  }
  async load(email: string): Promise<{ credentials: Credentials; snapshot: GmailSnapshot } | null> {
    const row = this.db.prepare("SELECT vault, snapshot FROM gmail_connection WHERE email=?").get(email) as
      { vault: Buffer; snapshot: string } | undefined;
    if (!row) return null;
    return { credentials: await openCredentials(this.vaultKey, row.vault), snapshot: JSON.parse(row.snapshot) };
  }
  close(): void { this.db.close(); }
}
