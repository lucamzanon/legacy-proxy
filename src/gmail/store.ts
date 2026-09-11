import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { openCredentials, sealCredentials, type Credentials } from "../auth/credentials.js";

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}
export interface GmailLabel {
  id: string; name: string; type: string;
  messagesTotal?: number; messagesUnread?: number; threadsTotal?: number; threadsUnread?: number;
}
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
      CREATE TABLE IF NOT EXISTS gmail_upload (email TEXT NOT NULL,id TEXT NOT NULL,body BLOB NOT NULL,type TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(email,id));
      CREATE TABLE IF NOT EXISTS gmail_draft (email TEXT NOT NULL,original TEXT NOT NULL,current TEXT NOT NULL,draft TEXT NOT NULL,PRIMARY KEY(email,original));
      CREATE INDEX IF NOT EXISTS gmail_draft_current ON gmail_draft(email,current);
      CREATE TABLE IF NOT EXISTS gmail_submission (email TEXT NOT NULL,original TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT,PRIMARY KEY(email,original));
      CREATE TABLE IF NOT EXISTS gmail_revision (email TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gmail_password (email TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS gmail_cache (
        email TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        expires INTEGER NOT NULL, touched INTEGER NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY(email, key)
      );
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
  hasConnection(email: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM gmail_connection WHERE email=?").get(email);
  }
  issuePassword(email: string): string {
    if (!this.hasConnection(email)) throw new Error("Account is not connected");
    const password = "gmap_" + crypto.randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO gmail_password(email,hash) VALUES (?,?) ON CONFLICT(email) DO UPDATE SET hash=excluded.hash")
      .run(email, crypto.createHash("sha256").update(password).digest("hex"));
    return password;
  }
  authenticate(password: string, username?: string): string | null {
    if (!/^gmap_[A-Za-z0-9_-]{43}$/.test(password)) return null;
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const row = this.db.prepare("SELECT email FROM gmail_password WHERE hash=?").get(hash) as { email: string } | undefined;
    return row && (!username || row.email === username.toLowerCase()) ? row.email : null;
  }
  async updateCredentials(email: string, credentials: Credentials, expectedRefreshToken?: string, snapshot?: GmailSnapshot): Promise<void> {
    const row = this.db.prepare("SELECT vault FROM gmail_connection WHERE email=?").get(email) as { vault: Buffer } | undefined;
    if (!row) return;
    const old = await openCredentials(this.vaultKey, row.vault);
    if (old.refreshToken !== expectedRefreshToken ||
        (snapshot === undefined && old.accessToken === credentials.accessToken && old.expiresAt === credentials.expiresAt)) return;
    const vault = await sealCredentials(this.vaultKey, {...credentials,scopes:old.scopes});
    this.db.prepare("UPDATE gmail_connection SET vault=?,snapshot=COALESCE(?,snapshot) WHERE email=? AND vault=?").run(vault, snapshot ? JSON.stringify(snapshot) : null, email, row.vault);
  }
  revision(email: string): number {
    return (this.db.prepare("SELECT revision FROM gmail_revision WHERE email=?").get(email) as {revision:number}|undefined)?.revision ?? 0;
  }
  invalidate(email: string): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO gmail_revision(email,revision) VALUES(?,1) ON CONFLICT(email) DO UPDATE SET revision=revision+1").run(email);
      this.db.prepare("DELETE FROM gmail_cache WHERE email=?").run(email);
    })();
  }
  cached<T>(email: string, key: string): T | null {
    const row = this.db.prepare("SELECT value FROM gmail_cache WHERE email=? AND key=? AND expires>?")
      .get(email, key, Date.now()) as { value: string } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE gmail_cache SET touched=? WHERE email=? AND key=?").run(Date.now(), email, key);
    return JSON.parse(row.value) as T;
  }
  cache(email: string, key: string, data: unknown, ttl: number): void {
    const value = JSON.stringify(data);
    const size = Buffer.byteLength(value);
    if (size > 16 * 1024 * 1024) return;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM gmail_cache WHERE expires<=?").run(Date.now());
      this.db.prepare(`INSERT INTO gmail_cache(email,key,value,expires,touched,size) VALUES(?,?,?,?,?,?)
        ON CONFLICT(email,key) DO UPDATE SET value=excluded.value,expires=excluded.expires,touched=excluded.touched,size=excluded.size`)
        .run(email, key, value, Date.now()+ttl, Date.now(), size);
      let total = (this.db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM gmail_cache WHERE email=?").get(email) as { n: number }).n;
      const rows = this.db.prepare("SELECT key,size FROM gmail_cache WHERE email=? ORDER BY touched").all(email) as { key: string; size: number }[];
      for (const row of rows) {
        if (total <= 256 * 1024 * 1024) break;
        this.db.prepare("DELETE FROM gmail_cache WHERE email=? AND key=?").run(email, row.key);
        total -= row.size;
      }
    })();
  }
  upload(email:string,body:Buffer,type:string):string {
    const id="gu_"+crypto.randomBytes(24).toString("base64url");
    this.db.transaction(()=>{
      this.db.prepare("DELETE FROM gmail_upload WHERE expires<=?").run(Date.now());
      const total=(this.db.prepare("SELECT COALESCE(SUM(length(body)),0) AS n FROM gmail_upload WHERE email=?").get(email) as {n:number}).n;
      if(body.length>25_000_000 || total+body.length>100_000_000)throw new Error("Upload quota exceeded");
      this.db.prepare("INSERT INTO gmail_upload VALUES(?,?,?,?,?)").run(email,id,body,type,Date.now()+24*60*60_000);
    })();return id;
  }
  uploaded(email:string,id:string):{body:Buffer;type:string}|null {
    return this.db.prepare("SELECT body,type FROM gmail_upload WHERE email=? AND id=? AND expires>?").get(email,id,Date.now()) as {body:Buffer;type:string}|undefined ?? null;
  }
  rememberDraft(email:string,original:string,draft:string,current=original):void {
    this.db.prepare("INSERT INTO gmail_draft VALUES(?,?,?,?) ON CONFLICT(email,original) DO UPDATE SET current=excluded.current,draft=excluded.draft").run(email,original,current,draft);
  }
  draft(email:string,original:string):{current:string;draft:string}|null {
    return this.db.prepare("SELECT current,draft FROM gmail_draft WHERE email=? AND original=?").get(email,original) as {current:string;draft:string}|undefined ?? null;
  }
  originalId(email:string,current:string):string {
    return (this.db.prepare("SELECT original FROM gmail_draft WHERE email=? AND current=?").get(email,current) as {original:string}|undefined)?.original ?? current;
  }
  upstreamId(email:string,original:string):string {return this.draft(email,original)?.current ?? original;}
  beginSubmission(email:string,original:string,fingerprint:string):boolean {
    return this.db.prepare("INSERT OR IGNORE INTO gmail_submission(email,original,id,fingerprint) VALUES(?,?,?,?)").run(email,original,"gs_"+crypto.randomBytes(16).toString("hex"),fingerprint).changes===1;
  }
  submission(email:string,original:string):{id:string;fingerprint:string;result:string|null}|null {
    return this.db.prepare("SELECT id,fingerprint,result FROM gmail_submission WHERE email=? AND original=?").get(email,original) as {id:string;fingerprint:string;result:string|null}|undefined ?? null;
  }
  finishSubmission(email:string,original:string,result:unknown,current:string):void {
    this.db.transaction(()=>{
      this.db.prepare("UPDATE gmail_submission SET result=? WHERE email=? AND original=?").run(JSON.stringify(result),email,original);
      this.db.prepare("UPDATE gmail_draft SET current=? WHERE email=? AND original=?").run(current,email,original);
    })();
  }
  submissionResults(email:string):Record<string,unknown>[] {
    return (this.db.prepare("SELECT result FROM gmail_submission WHERE email=? AND result IS NOT NULL ORDER BY rowid DESC LIMIT 100").all(email) as {result:string}[]).map(r=>JSON.parse(r.result));
  }
  close(): void { this.db.close(); }
}
