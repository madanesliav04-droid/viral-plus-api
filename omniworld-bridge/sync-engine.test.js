const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {createSync}=require('./sync-engine');
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sync-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
test('history starts at zero, includes attachments and replies, persists cursor across restart',async t=>{
 const directory=await fixture(t);let calls=[],min=[];
 const messages=[{id:1,message:'old',date:1},{id:2,message:'photo',date:2,media:{className:'MessageMediaPhoto'},replyTo:{replyToMsgId:1}}];
 const opts={directory,chat:'-100123',forum:'exp',group:{},client:{async *iterMessages(g,o){min.push(o.minId);for(const m of messages)if(m.id>o.minId)yield m;}},upload:async()=> 'file_1',request:async(p,m,b)=>{calls.push(b);return {id:'post_'+calls.length};}};
 await createSync(opts).run();assert.equal(calls.length,2);assert.equal(calls[1].parent_id,'post_1');assert.deepEqual(calls[1].attachments,[{id:'file_1'}]);
 await createSync(opts).run();assert.equal(calls.length,2);assert.deepEqual(min,[0,2]);
});
test('ambiguous remote success is reconciled after restart, next message is not lost',async t=>{
 const directory=await fixture(t);let posted=[],failed=false;
 const opts={directory,chat:'-100123',forum:'exp',group:{},client:{async *iterMessages(g,o){for(let id=o.minId+1;id<=2;id++)yield {id,message:'m'+id,date:1};}},upload:async()=>{},request:async(p,m,b)=>{
  if(m==='GET')return {data:posted,page_info:{has_next_page:false}};
  const r={id:'p'+(posted.length+1),...b};posted.push(r);if(!failed){failed=true;throw Error('timeout');}return r;
 }};
 const first=createSync(opts);await first.run();assert.equal(first.status().phase,'blocked');assert.equal(posted.length,1);
 const state=await fs.readFile(path.join(directory,'telegram-sync.json'),'utf8');assert.ok(!state.includes('Source Telegram'));
 const second=createSync(opts);await second.run();assert.equal(posted.length,2);assert.equal(second.status().cursor,2);
});
test('media failure does not advance cursor or publish later messages',async t=>{
 const directory=await fixture(t);let posts=0;
 const s=createSync({directory,chat:'c',forum:'f',group:{},client:{async *iterMessages(){yield {id:1,date:1,media:{className:'MessageMediaPhoto'}};yield{id:2,date:1,message:'later'};}},upload:async()=>{throw Error('upload failed');},request:async()=>{posts++;}});
 await s.run();assert.equal(s.status().cursor,0);assert.equal(posts,0);
});
