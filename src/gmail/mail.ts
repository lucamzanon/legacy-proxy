import crypto from "node:crypto";
import { GmailApi } from "./api.js";
import { GmailStore, type GmailProfile, type GmailLabel } from "./store.js";
import { ALL_MAIL, upstreamId, mapMessage, partTree, parseBlob, type GmailMessage, type GmailPart } from "./message.js";
import { gmailFilter } from "./filter.js";
import { JmapError, accountNotFound, invalidArguments, unsupportedSort } from "../jmap/errors.js";
import type { MethodTable } from "../jmap/router.js";

const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0,32);
export const gmailAccountId = (email: string) => "g_" + hash(email.toLowerCase());
const ROLES: Record<string, string> = { INBOX: "inbox", SENT: "sent", DRAFT: "drafts", SPAM: "junk", TRASH: "trash" };
const MAX_GET = 100;
const MAX_QUERY = 100;
const MAX_BLOB = 50_000_000;

export class GmailMail {
  readonly accountId: string;
  private flights = new Map<string, Promise<unknown>>();
  constructor(private email: string, private api: Pick<GmailApi, "get">, private store: GmailStore) {
    this.accountId = gmailAccountId(email);
  }
  private async cached<T>(key: string, ttl: number, fetch: () => Promise<T>): Promise<T> {
    const cached = this.store.cached<T>(this.email, key);
    if (cached !== null) return cached;
    const pending = this.flights.get(key);
    if (pending) return pending as Promise<T>;
    if (this.flights.size >= 100) throw new JmapError("serverUnavailable", "Too many concurrent Gmail reads");
    const task = fetch().then((data) => { this.store.cache(this.email,key,data,ttl); return data; })
      .finally(() => this.flights.delete(key));
    this.flights.set(key, task);
    return task;
  }
  profile(): Promise<GmailProfile> { return this.cached("profile", 30_000, () => this.api.get<GmailProfile>("profile", 1)); }
  async state(): Promise<string> { return "g" + (await this.profile()).historyId; }
  async mailboxState(): Promise<string> { return hash(await this.mailboxes()); }
  async labels(): Promise<GmailLabel[]> {
    const state = await this.state();
    return this.cached("labels:" + state, 60_000, async () => {
      const data = await this.api.get<{ labels?: GmailLabel[] }>("labels",1);
      // API gateway caps concurrency; label detail supplies exact message/thread counts.
      const labels: GmailLabel[] = [];
      for (let offset = 0; offset < (data.labels ?? []).length; offset += 4) {
        labels.push(...await Promise.all(data.labels!.slice(offset,offset+4).map((label) =>
          this.api.get<GmailLabel>(`labels/${encodeURIComponent(label.id)}`,1))));
      }
      return labels;
    });
  }
  private account(args: Record<string, unknown>): void {
    if (args.accountId !== this.accountId) throw accountNotFound();
  }
  private ids(args: Record<string, unknown>): string[] | null {
    if (args.ids == null) return null;
    if (!Array.isArray(args.ids) || args.ids.some((id) => typeof id !== "string")) throw invalidArguments("ids must be an array of strings or null");
    if (args.ids.length > MAX_GET) throw new JmapError("requestTooLarge");
    return args.ids as string[];
  }
  private properties(args: Record<string, unknown>): string[] | null {
    if (args.properties == null) return null;
    if (!Array.isArray(args.properties) || args.properties.some((p) => typeof p !== "string")) throw invalidArguments("properties must be strings");
    return args.properties as string[];
  }
  private project(record: Record<string, unknown>, properties: string[] | null): Record<string, unknown> {
    if (!properties) return record;
    const result: Record<string, unknown> = { id: record.id };
    for (const key of properties) {
      if (!(key in record)) throw invalidArguments(`Unsupported property: ${key}`);
      result[key] = record[key];
    }
    return result;
  }
  async mailboxes(): Promise<Record<string, unknown>[]> {
    const [labels, profile] = await Promise.all([this.labels(), this.profile()]);
    const unread = labels.find((label) => label.id === "UNREAD");
    const all: GmailLabel = { id: ALL_MAIL, name: "All mail", type: "system", messagesTotal: profile.messagesTotal,
      messagesUnread: unread?.messagesTotal ?? 0, threadsTotal: profile.threadsTotal, threadsUnread: unread?.threadsTotal ?? 0 };
    return [all, ...labels].map((label) => ({
      id: label.id === ALL_MAIL ? ALL_MAIL : "l_" + label.id,
      name: label.name, parentId: null, role: label.id === ALL_MAIL ? "all" : ROLES[label.id] ?? null,
      sortOrder: label.id === "INBOX" ? 0 : 10, totalEmails: label.messagesTotal ?? 0, unreadEmails: label.messagesUnread ?? 0,
      totalThreads: label.threadsTotal ?? 0, unreadThreads: label.threadsUnread ?? 0, isSubscribed: true,
      myRights: { mayReadItems: true, mayAddItems: false, mayRemoveItems: false, maySetSeen: false, maySetKeywords: false,
        mayCreateChild: false, mayRename: false, mayDelete: false, maySubmit: false },
    }));
  }
  async message(id: string): Promise<GmailMessage> {
    const state = await this.state();
    return this.cached(`message:${state}:${id}`, 30 * 60_000,
      () => this.api.get<GmailMessage>(`messages/${encodeURIComponent(id)}`,20,{ format: "full" }));
  }
  private async bytes(messageId: string, part: GmailPart): Promise<Buffer> {
    if ((part.body?.size ?? 0) > MAX_BLOB) throw new JmapError("tooLarge", "Gmail part exceeds the download limit");
    if (part.body?.data !== undefined) return Buffer.from(part.body.data,"base64url");
    if (!part.body?.attachmentId) return Buffer.alloc(0);
    const result = await this.cached(`part:${messageId}:${part.body.attachmentId}`, 60 * 60_000,
      () => this.api.get<{ data: string }>(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`,20));
    const bytes = Buffer.from(result.data,"base64url");
    if (bytes.length > MAX_BLOB) throw new JmapError("tooLarge");
    return bytes;
  }
  async download(blob: string): Promise<{ body: Buffer; type: string }> {
    const [id, part] = parseBlob(blob);
    const message = await this.message(id); // proves account ownership / existence even for cached parts.
    if (part === null) {
      if ((message.sizeEstimate ?? 0) > MAX_BLOB) throw new JmapError("tooLarge");
      const raw = await this.cached(`raw:${id}`,60 * 60_000,() => this.api.get<{ raw: string }>(`messages/${encodeURIComponent(id)}`,20,{ format: "raw" }));
      const body = Buffer.from(raw.raw,"base64url");
      if (body.length > MAX_BLOB) throw new JmapError("tooLarge");
      return { body, type: "message/rfc822" };
    }
    const p = partTree(message).parts.get(part);
    if (!p) throw new JmapError("notFound");
    return { body: await this.bytes(id,p), type: p.mimeType ?? "application/octet-stream" };
  }
  private async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.account(args);
    const labels = await this.labels();
    const q = gmailFilter(args.filter,labels);
    const sort = args.sort ?? [{ property: "receivedAt", isAscending: false }];
    if (!Array.isArray(sort) || sort.length > 1 || sort.some((s) => !s || s.property !== "receivedAt" || (s.collation != null))) throw unsupportedSort();
    if (sort.some((s) => s.isAscending !== undefined && typeof s.isAscending !== "boolean")) throw invalidArguments("Invalid sort direction");
    const ascending = sort.length > 0 && sort[0].isAscending !== false;
    const limit = args.limit === undefined ? MAX_GET : args.limit;
    if (!Number.isSafeInteger(limit) || (limit as number) < 0) throw invalidArguments("Invalid limit");
    if (args.collapseThreads !== undefined && typeof args.collapseThreads !== "boolean") throw invalidArguments("Invalid collapseThreads");
    const state = await this.state();
    // Common folder view: use exact label/profile counts and fetch only the
    // requested pages. A large Inbox must not require a full account scan.
    const f = args.filter as Record<string, unknown> | undefined;
    const simple = !f || Object.keys(f).length === 0 ||
      (Object.keys(f).length === 1 && typeof f.inMailbox === "string");
    const pos = args.position ?? 0;
    if (simple && !ascending && !args.collapseThreads && args.anchor === undefined &&
        Number.isSafeInteger(pos) && (pos as number) >= 0) {
      const label = f?.inMailbox && f.inMailbox !== ALL_MAIL
        ? labels.find((l) => "l_" + l.id === f.inMailbox) : undefined;
      const total = label ? label.messagesTotal : (await this.profile()).messagesTotal;
      if (total !== undefined) {
        const count = Math.min(limit as number, MAX_QUERY);
        const wanted = Math.min(total, (pos as number) + count);
        const refs = new Map<string, { id: string; threadId: string }>();
        let token = "";
        const tokens = new Set<string>();
        if (count && (pos as number) < total) do {
          const cursor = token;
          const page = await this.cached<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(
            `page:${state}:${hash(q)}:${hash(cursor)}`, 30 * 60_000,
            () => this.api.get("messages", 5, { q, includeSpamTrash: "true", maxResults: "500", ...(cursor ? { pageToken: cursor } : {}) }));
          for (const reference of page.messages ?? []) refs.set(reference.id, reference);
          token = page.nextPageToken ?? "";
          if (token && tokens.has(token)) throw new JmapError("serverUnavailable", "Gmail repeated a pagination cursor");
          tokens.add(token);
          if (tokens.size > 2000) throw new JmapError("serverUnavailable", "Query exceeds the experimental index limit");
        } while (token && refs.size < wanted);
        return { accountId: this.accountId, queryState: hash([state,q]), canCalculateChanges: false,
          position: pos, ids: [...refs.values()].slice(pos as number,(pos as number)+count).map((r)=>"m_"+r.id),
          ...(args.calculateTotal === true ? { total } : {}), ...((limit as number)>MAX_QUERY ? {limit:MAX_QUERY} : {}) };
      }
    }
    // Enumerate IDs only: exact totals and reverse/anchor pagination without
    // fetching metadata for the entire mailbox. Never expose resultSizeEstimate as total.
    const references = await this.cached<{ id: string; threadId: string }[]>(`query:${state}:${hash(q)}`,30 * 60_000, async () => {
      const result = new Map<string, { id: string; threadId: string }>();
      let pageToken = "";
      const tokens = new Set<string>();
      do {
        const page = await this.api.get<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>("messages",5,
          { q, includeSpamTrash: "true", maxResults: "500", ...(pageToken ? { pageToken } : {}) });
        for (const message of page.messages ?? []) result.set(message.id,message);
        pageToken = page.nextPageToken ?? "";
        if (pageToken && tokens.has(pageToken)) throw new JmapError("serverUnavailable", "Gmail repeated a pagination cursor");
        if (pageToken) tokens.add(pageToken);
        if (tokens.size > 2000) throw new JmapError("serverUnavailable", "Query exceeds the experimental index limit");
      } while (pageToken);
      return [...result.values()];
    });
    const ordered = ascending ? [...references].reverse() : references;
    const seenThreads = new Set<string>();
    const ids = ordered.filter((r) => {
      if (!args.collapseThreads) return true;
      if (seenThreads.has(r.threadId)) return false;
      seenThreads.add(r.threadId); return true;
    }).map((r) => "m_" + r.id);
    let position = args.position ?? 0;
    if (!Number.isSafeInteger(position)) throw invalidArguments("Invalid position");
    if (args.anchor !== undefined) {
      const anchor = ids.indexOf(String(args.anchor));
      if (anchor < 0) throw new JmapError("anchorNotFound");
      const offset = args.anchorOffset ?? 0;
      if (!Number.isSafeInteger(offset)) throw invalidArguments("Invalid anchorOffset");
      position = Math.max(0,anchor+(offset as number));
    } else if ((position as number) < 0) position = Math.max(0, ids.length+(position as number));
    const actualLimit = Math.min(limit as number,MAX_QUERY);
    return { accountId: this.accountId, queryState: hash(ids), canCalculateChanges: false, position,
      ids: ids.slice(position as number,(position as number)+actualLimit),
      ...(args.calculateTotal === true ? { total: ids.length } : {}),
      ...((limit as number) > MAX_QUERY ? { limit: MAX_QUERY } : {}) };
  }
  methods(): MethodTable {
    const changes = async (a: Record<string,unknown>) => {
      this.account(a); const state = await this.state();
      if (a.sinceState !== state) throw new JmapError("cannotCalculateChanges");
      return { accountId:this.accountId, oldState:state,newState:state,hasMoreChanges:false,created:[],updated:[],destroyed:[] };
    };
    const readOnly = async (a: Record<string,unknown>) => { this.account(a); throw new JmapError("accountReadOnly"); };
    return {
      "Core/echo": async (a) => a,
      "Mailbox/get": async (a) => {
        this.account(a); const ids = this.ids(a); const properties = this.properties(a);
        const records = await this.mailboxes();
        const selected = ids ? records.filter((r) => ids.includes(r.id as string)) : records;
        if (selected.length > MAX_GET) throw new JmapError("requestTooLarge");
        return { accountId:this.accountId,state:await this.mailboxState(),list:selected.map((r) => this.project(r,properties)),notFound:(ids??[]).filter((id)=>!records.some((r)=>r.id===id)) };
      },
      "Mailbox/query": async (a) => {
        this.account(a);
        if (a.filter != null || a.sort != null) throw new JmapError("unsupportedFilter", "Mailbox query filters are not supported yet");
        const records = await this.mailboxes(); const position=a.position??0;const limit=a.limit??MAX_GET;
        if (!Number.isSafeInteger(position)||!Number.isSafeInteger(limit)||(position as number)<0||(limit as number)<0) throw invalidArguments("Invalid mailbox pagination");
        return { accountId:this.accountId,queryState:await this.mailboxState(),canCalculateChanges:false,position,ids:records.slice(position as number,(position as number)+Math.min(limit as number,MAX_QUERY)).map((r)=>r.id),...(a.calculateTotal?{total:records.length}:{}) };
      },
      "Email/query": (a) => this.query(a),
      "Email/get": async (a) => {
        this.account(a); this.properties(a); let ids=this.ids(a);
        if (ids===null) {
          if ((await this.profile()).messagesTotal>MAX_GET) throw new JmapError("requestTooLarge");
          ids=(await this.query({ accountId:this.accountId })).ids as string[];
        }
        const list: Record<string,unknown>[]=[];const notFound:string[]=[];
        // Keep the outstanding work bounded even for a large caller-supplied batch.
        for (let i=0;i<ids.length;i+=4) {
          const batch=await Promise.all(ids.slice(i,i+4).map(async (id) => {
            try { const message=await this.message(upstreamId(id,"m_"));return await mapMessage(message,a,(part)=>this.bytes(message.id,part)); }
            catch(error) { if(error instanceof JmapError && (error.type==="notFound" || error.type==="invalidArguments" && !/^m_[A-Za-z0-9_-]{1,128}$/.test(id))) { notFound.push(id);return null; }throw error; }
          }));
          for(const record of batch)if(record)list.push(record);
        }
        return { accountId:this.accountId,state:await this.state(),list,notFound };
      },
      "Thread/get": async (a) => {
        this.account(a); const ids=this.ids(a);const properties=this.properties(a);
        if(ids===null)throw new JmapError("requestTooLarge");
        const list:Record<string,unknown>[]=[];const notFound:string[]=[];const state=await this.state();
        for(const id of ids) {
          try {
            const thread=await this.cached<{ id:string;messages?:GmailMessage[] }>(`thread:${state}:${id}`,30*60_000,
              ()=>this.api.get(`threads/${encodeURIComponent(upstreamId(id,"t_"))}`,40,{format:"full"}));
            for(const message of thread.messages??[])this.store.cache(this.email,`message:${state}:${message.id}`,message,30*60_000);
            const messages=[...(thread.messages??[])].sort((a,b)=>Number(a.internalDate)-Number(b.internalDate));
            list.push(this.project({id, emailIds:messages.map((m)=>"m_"+m.id)},properties));
          } catch(error) { if(error instanceof JmapError && (error.type==="notFound" || error.type==="invalidArguments" && !/^t_[A-Za-z0-9_-]{1,128}$/.test(id)))notFound.push(id);else throw error; }
        }
        return {accountId:this.accountId,state,list,notFound};
      },
      "Email/changes":changes,"Mailbox/changes":async(a)=>{this.account(a);const state=await this.mailboxState();if(a.sinceState!==state)throw new JmapError("cannotCalculateChanges");return {accountId:this.accountId,oldState:state,newState:state,hasMoreChanges:false,created:[],updated:[],destroyed:[]};},"Thread/changes":changes,
      "Email/queryChanges":async(a)=>{this.account(a);throw new JmapError("cannotCalculateChanges");},
      "Mailbox/set":readOnly,"Email/set":readOnly,"Email/import":readOnly,"Email/copy":readOnly,
      "SearchSnippet/get":async(a)=>{this.account(a);return {accountId:this.accountId,list:[],notFound:a.emailIds??[]};},
    };
  }
}
