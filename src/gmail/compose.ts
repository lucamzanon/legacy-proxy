import crypto from "node:crypto";
import {simpleParser} from "mailparser";
import {buildRfc822, type JmapEmailCreate, type BodyStructurePart} from "../mapping/buildMime.js";
import {JmapError} from "../jmap/errors.js";
import {SIDE_RESPONSES, type MethodTable} from "../jmap/router.js";
import type {GmailApi} from "./api.js";
import {GmailStore} from "./store.js";
import {upstreamId, type GmailMessage} from "./message.js";

const MAX_RAW=25_000_000;
const fail=(type:string,description:string):never=>{throw new JmapError(type,description);};
const obj=(x:unknown):Record<string,unknown>=>x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:fail("invalidProperties","Expected an object");
const line=(x:unknown):string=>typeof x==="string"&&!/[\r\n\x00]/.test(x)?x:fail("invalidProperties","Invalid header value");
const address=(x:unknown):string=>{const s=line(x);if(!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(s))fail("invalidProperties","Invalid email address");return s;};
interface Draft {id:string;message:GmailMessage & {raw?:string}}
interface ComposeContext {
 email:string;accountId:string;api:Pick<GmailApi,"get"|"mutate">;store:GmailStore;
 enabled:()=>Promise<boolean>;state:()=>Promise<string>;
 download:(id:string)=>Promise<{body:Buffer;type:string}>;
 exclusive:<T>(work:()=>Promise<T>)=>Promise<T>;
}
/** Native Gmail drafts preserve Bcc and make an ambiguous send non-replayable. */
export class GmailCompose {
 constructor(private c:ComposeContext){}
 private async check(a?:Record<string,unknown>){if(a&&a.accountId!==this.c.accountId)fail("accountNotFound","Wrong account");if(!await this.c.enabled())fail("accountReadOnly","Composition disabled");}
 private async mutate<T>(resource:string,cost:number,method:"POST"|"DELETE",data?:unknown):Promise<T>{
  this.c.store.invalidate(this.c.email);
  try{return await this.c.api.mutate<T>(resource,cost,method,data);}finally{this.c.store.invalidate(this.c.email);}
 }
 private placement(input:Record<string,unknown>){
  const boxes=obj(input.mailboxIds??{l_DRAFT:true});
  if(!boxes.l_DRAFT||Object.entries(boxes).some(([k,v])=>v!==true||!['l_DRAFT','all'].includes(k)))fail("invalidProperties","New mail must be a draft");
  const keywords=obj(input.keywords??{$draft:true});
  if(keywords.$draft!==true||Object.entries(keywords).some(([k,v])=>v!==true||!['$draft','$seen'].includes(k)))fail("invalidProperties","Unsupported draft keywords");
 }
 private async rawFromCreate(input:Record<string,unknown>):Promise<Buffer>{
  const permitted=new Set(['mailboxIds','keywords','from','sender','to','cc','bcc','replyTo','subject','messageId','inReplyTo','references','sentAt','bodyValues','textBody','htmlBody','attachments','bodyStructure','header:Disposition-Notification-To:asText']);
  for(const k of Object.keys(input))if(!permitted.has(k))fail("invalidProperties","Unsupported draft property");
  for(const key of ['from','sender','to','cc','bcc','replyTo'])if(input[key]!=null){
   if(!Array.isArray(input[key])||(input[key] as unknown[]).length>500)fail("invalidProperties","Invalid address list");
   for(const v of input[key] as unknown[]){const a=obj(v);address(a.email);if(a.name!=null)line(a.name);}
  }
  const from=input.from as {email:string}[]|undefined;
  if(!from||from.length!==1||from[0]!.email.toLowerCase()!==this.c.email)fail("invalidProperties","From must match the account identity");
  if(input.sender!=null){const sender=input.sender as {email:string}[];if(sender.length!==1||sender[0]!.email.toLowerCase()!==this.c.email)fail("invalidProperties","Sender must match the account");}
  if(input.subject!=null)line(input.subject);
  for(const key of ['messageId','inReplyTo','references'])if(input[key]!=null){
   if(!Array.isArray(input[key]))fail("invalidProperties","Invalid message IDs");
   for(const id of input[key] as unknown[])if(!/^[^<>\s]+$/.test(line(id)))fail("invalidProperties","Invalid message ID");
  }
  if(input.sentAt!=null&&!Number.isFinite(Date.parse(line(input.sentAt))))fail("invalidProperties","Invalid sentAt");
  const values=obj(input.bodyValues??{});for(const v of Object.values(values))if(typeof obj(v).value!=="string")fail("invalidProperties","Invalid body value");
  const create={...input} as JmapEmailCreate;
  const receipt=input['header:Disposition-Notification-To:asText'];if(receipt!=null)create.headers=[{name:'Disposition-Notification-To',value:address(receipt)}];
  const list=(value:unknown):BodyStructurePart[]=>{if(value==null)return [];if(!Array.isArray(value))fail("invalidProperties","Invalid body parts");return value as BodyStructurePart[];};
  if(input.bodyStructure&&(input.textBody||input.htmlBody||input.attachments))fail("invalidProperties","Overlapping body structure forms");
  if(!input.bodyStructure){
   const text=list(input.textBody).map(p=>({...p,type:p.type??'text/plain'}));
   const html=list(input.htmlBody).map(p=>({...p,type:p.type??'text/html'}));
   const content=[...text,...html];
   const body:BodyStructurePart=content.length>1?{type:'multipart/alternative',subParts:content}:content[0]??{type:'text/plain',partId:'__empty'};
   if(!content.length)values.__empty={value:''};
   const attachments=list(input.attachments);
   create.bodyStructure=attachments.length?{type:'multipart/mixed',subParts:[body,...attachments]}:body;
  }
  create.bodyValues=values as JmapEmailCreate['bodyValues'];
  const blobs=new Map<string,{body:Buffer;ctype:string}>();let parts=0,total=0;
  const visit=async(p:BodyStructurePart,depth:number):Promise<void>=>{
   obj(p);if(++parts>100||depth>15)fail("invalidProperties","Body structure too complex");
   for(const key of ['type','name','cid','charset','disposition'] as const)if(p[key]!=null)line(p[key]);
   if(p.subParts){for(const child of list(p.subParts))await visit(child,depth+1);return;}
   if(p.partId && values[p.partId]){const v=values[p.partId];if(typeof obj(v).value!=='string')fail("invalidProperties","Missing body value");total+=Buffer.byteLength(obj(v).value as string);}
   else if(p.blobId){
    if(!blobs.has(p.blobId)){let data;try{data=await this.c.download(p.blobId);}catch(e){if(e instanceof JmapError&&e.type!=="notFound")throw e;fail("blobNotFound","Attachment is unavailable; reattach the file. The previous draft is retained.");}blobs.set(p.blobId,{body:data!.body,ctype:data!.type});}
    total+=blobs.get(p.blobId)!.body.length;
   }else fail("invalidProperties","Body part has no content");
   if(total>MAX_RAW)fail("tooLarge","Message exceeds the compose limit");
  };
  await visit(create.bodyStructure!,0);
  const raw=await buildRfc822(create,this.c.email.split('@')[1]!,id=>blobs.get(id)??null,true);
  if(raw.length>MAX_RAW)fail("tooLarge","Message exceeds the 25 MB encoded size limit. Reduce attachments (18 MB total recommended) or shorten the body. The previous draft is retained.");return raw;
 }
 async create(input:Record<string,unknown>):Promise<Record<string,unknown>>{
  await this.check();this.placement(input);return this.createRaw(await this.rawFromCreate(input),input);
 }
 private async createRaw(raw:Buffer,input?:Record<string,unknown>):Promise<Record<string,unknown>>{
  let threadId:string|undefined;
  const parent=(input?.inReplyTo as string[]|undefined)?.at(-1);
  if(parent){
   const q='in:anywhere rfc822msgid:"'+parent.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
   const found=await this.c.api.get<{messages?:{id:string;threadId:string}[]}>('messages',5,{q,maxResults:'2',includeSpamTrash:'true'});
   const candidate=found.messages?.[0];
   if(candidate){
    const original=await this.c.api.get<GmailMessage>('messages/'+encodeURIComponent(candidate.id),20,{format:'metadata'});
    const header=(name:string)=>original.payload?.headers?.find(h=>h.name?.toLowerCase()===name)?.value??'';
    const subject=(value:string)=>value.replace(/^(?:re:\s*)+/i,'').trim();
    if(header('message-id').replace(/^<|>$/g,'')===parent&&subject(header('subject'))===subject(String(input?.subject??'')))threadId=candidate.threadId;
   }
  }
  const draft=await this.mutate<Draft>('drafts',10,'POST',{message:{raw:raw.toString('base64url'),...(threadId?{threadId}:{})}});
  this.c.store.rememberDraft(this.c.email,draft.message.id,draft.id);
  return {id:'m_'+draft.message.id,threadId:'t_'+draft.message.threadId,size:raw.length,mailboxIds:{all:true,l_DRAFT:true},keywords:{$draft:true,$seen:true}};
 }
 private async findDraft(original:string):Promise<string>{
  const known=this.c.store.draft(this.c.email,original);
  if(known)return known.draft;
  let pageToken='';const tokens=new Set<string>();
  do{
   const page=await this.c.api.get<{drafts?:Draft[];nextPageToken?:string}>('drafts',5,{maxResults:'500',...(pageToken?{pageToken}:{})});
   const found=page.drafts?.find(d=>d.message.id===original);
   if(found){this.c.store.rememberDraft(this.c.email,original,found.id);return found.id;}
   pageToken=page.nextPageToken??'';if(tokens.has(pageToken)||tokens.size>200)fail("serverUnavailable","Draft listing failed");tokens.add(pageToken);
  }while(pageToken);
  return fail("notFound","Draft not found");
 }
 private async checkedDraft(original:string,format='minimal'):Promise<Draft>{
  const draft=await this.c.api.get<Draft>('drafts/'+encodeURIComponent(await this.findDraft(original)),20,{format});
  if(draft.message.id!==original||!draft.message.labelIds?.includes('DRAFT'))fail("notFound","Draft has changed; refresh before continuing");
  return draft;
 }
 async destroy(id:string):Promise<void>{
  await this.check();const original=upstreamId(id,'m_');
  if(this.c.store.submission(this.c.email,original))fail("forbidden","Submitted or uncertain drafts cannot be deleted through this operation");
  const m=await this.c.api.get<GmailMessage>('messages/'+encodeURIComponent(this.c.store.upstreamId(this.c.email,original)),20,{format:'minimal'});
  if(!m.labelIds?.includes('DRAFT'))fail("forbidden","Permanent mail deletion is disabled");
  const draft=await this.checkedDraft(original);await this.mutate('drafts/'+encodeURIComponent(draft.id),10,'DELETE');
 }
 private async recipients(raw:Buffer){
  const parsed=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true});
  const collect=(v:typeof parsed.to)=>!v?[]:(Array.isArray(v)?v:[v]).flatMap(x=>x.value.map(a=>address(a.address)));
  const from=collect(parsed.from);if(from.length!==1||from[0]!.toLowerCase()!==this.c.email)fail("invalidEmail","Draft sender does not match identity");
  return {mailFrom:{email:this.c.email},rcptTo:[...new Set([...collect(parsed.to),...collect(parsed.cc),...collect(parsed.bcc)])].map(email=>({email}))};
 }
 private async submitOne(input:unknown):Promise<Record<string,unknown>>{
  const p=obj(input);for(const k of Object.keys(p))if(!['emailId','identityId','envelope'].includes(k))fail('invalidProperties','Unsupported submission property');
  if(p.identityId!=='gi_'+this.c.accountId)fail('invalidProperties','Unknown identity');
  const original=upstreamId(p.emailId,'m_');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
  const previous=this.c.store.submission(this.c.email,original);
  if(previous){if(previous.fingerprint!==fingerprint)fail('invalidProperties','Draft already submitted with different options');if(previous.result)return JSON.parse(previous.result);return fail('serverFail','Send outcome is uncertain; check Sent before attempting another send');}
  const draft=await this.checkedDraft(original,'raw');
  const raw=Buffer.from(draft.message.raw??'','base64url');if(!raw.length||raw.length>MAX_RAW)fail('invalidEmail','Invalid draft MIME');
  const envelope=await this.recipients(raw);if(!envelope.rcptTo.length)fail('noRecipients','No recipients');if(envelope.rcptTo.length>500)fail('tooManyRecipients','Too many recipients');
  if(p.envelope!=null){
   const e=obj(p.envelope),from=obj(e.mailFrom);const rcpts=Array.isArray(e.rcptTo)?e.rcptTo.map(obj):fail('invalidProperties','Invalid envelope');
   if(from.email!==this.c.email||Object.keys(obj(from.parameters??{})).length||rcpts.some(r=>Object.keys(obj(r.parameters??{})).length))fail('invalidProperties','Custom SMTP envelopes and extensions are unsupported');
   const actual=rcpts.map(r=>address(r.email).toLowerCase()).sort();const expected=envelope.rcptTo.map(r=>r.email.toLowerCase()).sort();if(JSON.stringify(actual)!==JSON.stringify(expected))fail('invalidProperties','Envelope must match draft recipients');
  }
  if(!this.c.store.beginSubmission(this.c.email,original,fingerprint))fail('serverFail','Submission already in progress');
  // Persist the intent before crossing the network. An unknown outcome is never replayed.
  const sent=await this.mutate<GmailMessage>('drafts/send',100,'POST',{id:draft.id}).catch(()=>fail('serverFail','Send outcome is uncertain. Check Sent before sending again; the bridge will not automatically retry this draft.'));
  const result={id:this.c.store.submission(this.c.email,original)!.id,emailId:'m_'+original,identityId:p.identityId,threadId:'t_'+sent.threadId,envelope,sendAt:new Date().toISOString(),undoStatus:'final',deliveryStatus:null,dsnBlobIds:[],mdnBlobIds:[]};
  this.c.store.finishSubmission(this.c.email,original,result,sent.id);return result;
 }
 private async submit(a:Record<string,unknown>):Promise<unknown>{
  await this.check(a);const create=obj(a.create??{});if(Object.keys(create).length>20)fail('requestTooLarge','Too many submissions');
  if(a.ifInState!=null)fail('stateMismatch','Conditional submissions are unsupported');
  if(Object.keys(obj(a.update??{})).length||(Array.isArray(a.destroy)?a.destroy.length:a.destroy!=null))fail('forbidden','Submission cancellation/deletion is unsupported');
  if(a.onSuccessDestroyEmail!=null&&( !Array.isArray(a.onSuccessDestroyEmail)||a.onSuccessDestroyEmail.length))fail('invalidProperties','Gmail already files sent drafts; destruction is unsupported');
  const patches=obj(a.onSuccessUpdateEmail??{});
  for(const patch of Object.values(patches)){
   const p=obj(patch);if(Object.keys(p).some(k=>!['mailboxIds','keywords/$draft'].includes(k))||p['keywords/$draft']!==null||JSON.stringify(obj(p.mailboxIds))!==JSON.stringify({l_SENT:true}))fail('invalidProperties','Only Gmail native Sent filing is supported');
  }
  const oldState=String(this.c.store.revision(this.c.email));const created:Record<string,unknown>=Object.create(null),notCreated:Record<string,unknown>=Object.create(null),updated:Record<string,unknown>=Object.create(null);
  for(const [key,input]of Object.entries(create)){
   try{const result=await this.submitOne(input);created[key]=result;
    if(patches['#'+key]||patches[result.id as string])updated[result.emailId as string]={mailboxIds:{all:true,l_SENT:true},keywords:{$seen:true}};
   }catch(e){notCreated[key]=e instanceof JmapError?e.toMethodError():{type:'serverFail',description:'Submission failed; verify Sent before retrying'};}
  }
  const result:Record<string|symbol,unknown>={accountId:this.c.accountId,oldState,newState:String(this.c.store.revision(this.c.email)),created:Object.keys(created).length?created:null,notCreated:Object.keys(notCreated).length?notCreated:null,updated:null,notUpdated:null,destroyed:null,notDestroyed:null};
  if(Object.keys(updated).length)result[SIDE_RESPONSES]=[['Email/set',{accountId:this.c.accountId,oldState:null,newState:await this.c.state().catch(()=>`w${this.c.store.revision(this.c.email)}`),updated,notUpdated:null},'']];
  return result;
 }
 private async importDrafts(a:Record<string,unknown>):Promise<unknown>{
  await this.check(a);const emails=obj(a.emails);if(Object.keys(emails).length>20)fail('requestTooLarge','Too many imports');
  const oldState=await this.c.state();if(a.ifInState!=null&&a.ifInState!==oldState)fail('stateMismatch','Email state changed');
  const created:Record<string,unknown>=Object.create(null),notCreated:Record<string,unknown>=Object.create(null);
  for(const [key,value]of Object.entries(emails))try{
   const p=obj(value);this.placement(p);
   for(const k of Object.keys(p))if(!['blobId','mailboxIds','keywords','receivedAt'].includes(k))fail('invalidProperties','Unsupported import property');
   if(typeof p.blobId!=='string')fail('blobNotFound','Missing MIME blob');
   const data=await this.c.download(p.blobId as string);if(!data.body.length||data.body.length>MAX_RAW)fail('tooLarge','MIME import exceeds limit');
   await this.recipients(data.body);created[key]=await this.createRaw(data.body);
  }catch(e){notCreated[key]=e instanceof JmapError?e.toMethodError():{type:'invalidEmail'};}
  return {accountId:this.c.accountId,oldState,newState:await this.c.state().catch(()=>`w${this.c.store.revision(this.c.email)}`),created:Object.keys(created).length?created:null,notCreated:Object.keys(notCreated).length?notCreated:null};
 }
 methods():MethodTable{return {
  'Email/import':a=>this.c.exclusive(()=>this.importDrafts(a)),
  'Identity/get':async a=>{await this.check(a);const record={id:'gi_'+this.c.accountId,name:this.c.email,email:this.c.email,replyTo:null,bcc:null,textSignature:'',htmlSignature:'',mayDelete:false};const ids=a.ids as string[]|null|undefined;return {accountId:this.c.accountId,state:'identity-v1',list:!ids||ids.includes(record.id)?[record]:[],notFound:(ids??[]).filter(id=>id!==record.id)};},
  'Identity/set':async a=>{await this.check(a);throw new JmapError('forbidden','Configure identities in Gmail');},
  'EmailSubmission/set':a=>this.c.exclusive(()=>this.submit(a)),
  'EmailSubmission/get':async a=>{await this.check(a);const all=this.c.store.submissionResults(this.c.email);const ids=a.ids as string[]|null|undefined;return {accountId:this.c.accountId,state:String(this.c.store.revision(this.c.email)),list:ids?all.filter(x=>ids.includes(x.id as string)):all,notFound:(ids??[]).filter(id=>!all.some(x=>x.id===id))};},
 };}
}
