'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {generateKeyPair,SignJWT}=require('jose');
const {pack,richText,verifyIdentity,mountChannel}=require('./channel');
const express=require('express');
test('album is grouped in source order and malicious captions/links stay inert',()=>{
 const posts=pack([{id:4372,date:1,groupedId:'a',media:{className:'MessageMediaPhoto'}},{id:4371,date:1,groupedId:'a',message:'<script>x</script> Salut',entities:[{className:'MessageEntityTextUrl',offset:0,length:8,url:'javascript:alert(1)'}],media:{className:'MessageMediaPhoto'}}]);
 assert.equal(posts.length,1);assert.deepEqual(posts[0].ids,[4371,4372]);assert.equal(posts[0].media.length,2);assert.ok(!posts[0].html.includes('<script>'));assert.ok(!posts[0].html.includes('javascript:'));
 assert.equal(richText('😀 gras',[{className:'MessageEntityBold',offset:3,length:4}]),'😀 <strong>gras</strong>');
});
test('Whop identities require correct signature, audience, issuer and expiry',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('ES256');
 const mint=(aud='app_test',exp='2m',issuer='urn:whopcom:exp-proxy')=>new SignJWT({}).setProtectedHeader({alg:'ES256'}).setSubject('user_test').setAudience(aud).setIssuer(issuer).setIssuedAt().setExpirationTime(exp).sign(privateKey);
 assert.equal(await verifyIdentity(await mint(),'app_test',publicKey),'user_test');
 await assert.rejects(verifyIdentity(await mint('app_other'),'app_test',publicKey));
 await assert.rejects(verifyIdentity(await mint('app_test','-1m'),'app_test',publicKey));
 await assert.rejects(verifyIdentity(await mint('app_test','2m','wrong'),'app_test',publicKey));
 await assert.rejects(verifyIdentity('forged','app_test',publicKey));
});
test('private media and feed deny anonymous users; preview fetches only selected album',async()=>{
 const app=express();let ids;
 mountChannel(app,{env:{WHOP_OAUTH_DATA_DIR:'/tmp/omni-channel-test',WHOP_CHAT_ID:'exp_private'},sessionValid:req=>req.headers.authorization==='test-admin',telegram:()=>({group:{},client:{getMessages:async(_,args)=>{ids=args.ids;return [{id:4371,date:1,message:'caption'}];}}}),request:async()=>{throw Error('Unexpected request');}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(url+'/channel/api/feed')).status,401);
  assert.equal((await fetch(url+'/channel/media/4371')).status,401);
  assert.equal((await fetch(url+'/channel/api/feed',{headers:{'x-whop-user-token':'forged'}})).status,401);
  const r=await fetch(url+'/channel/api/feed',{headers:{authorization:'test-admin'}});assert.equal(r.status,200);assert.equal((await r.json()).preview,true);assert.deepEqual(ids,[4371,4372]);
  assert.equal((await fetch(url+'/channel/media/5',{headers:{authorization:'test-admin'}})).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
