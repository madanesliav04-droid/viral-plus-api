'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createNotifications}=require('./channel-notifications');
test('bootstrap skips history, one notification per album, cursor survives restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'notify-test-'));let messages=[],sent=[];
 const env={WHOP_OAUTH_DATA_DIR:dir,WHOP_CHANNEL_EXPERIENCE_ID:'exp_test',CHANNEL_NOTIFICATIONS_ENABLED:'true',WHOP_NOTIFICATION_TEST_USER:'user_owner'};
 const client={getMessages:async(_,args)=>args.limit===1?[{id:100}]:messages.filter(m=>m.id>args.minId)};
 const options={env,client,group:{},now:()=>100000,request:async(_,method,payload)=>{assert.equal(method,'POST');sent.push(payload);return {success:true};}};
 try{
  const worker=createNotifications(options);await worker.tick();assert.equal(sent.length,1);assert.deepEqual(sent[0].user_ids,['user_owner']);
  messages=[{id:101,date:1,groupedId:'a',media:{}},{id:102,date:1,groupedId:'a',message:'Album caption',media:{}},{id:103,date:1,message:'Next'}];
  await worker.tick();assert.equal(sent.length,3);assert.equal(sent[1].content,'Album caption');assert.equal(sent[1].experience_id,'exp_test');assert.equal(sent[1].user_ids,undefined);
  await createNotifications(options).tick();assert.equal(sent.length,3);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('permission rejection stops broadcasts and retains cursor',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'notify-test-'));
 try{
 const env={WHOP_OAUTH_DATA_DIR:dir,WHOP_CHANNEL_EXPERIENCE_ID:'exp_test',CHANNEL_NOTIFICATIONS_ENABLED:'true',WHOP_NOTIFICATION_TEST_USER:'user_owner'};let calls=0;
 const worker=createNotifications({env,group:{},client:{getMessages:async()=>[{id:100}]},request:async()=>{calls++;throw Object.assign(Error('Forbidden'),{status:403});}});
 await worker.tick();await worker.tick();assert.equal(calls,1);const state=JSON.parse(await fs.readFile(path.join(dir,'channel-notifications.json')));assert.equal(state.cursor,100);assert.equal(state.verified,false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
