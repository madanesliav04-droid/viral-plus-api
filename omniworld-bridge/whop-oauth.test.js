"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {createWhopOAuth} = require("./whop-oauth");

async function fixture(t, user="user_Lcgrt81hIa1TM") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omni-oauth-test-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const env = {WHOP_CLIENT_SECRET:"test-client-secret", WHOP_OAUTH_DATA_DIR:directory, WHOP_OAUTH_ENCRYPTION_KEY:"test-encryption-key-32-characters-long"};
  let now = 1000000, count = 0;
  const calls=[];
  const request=async(url,options)=>{
    const body = options.body && JSON.parse(options.body);
    calls.push({url,body});
    if(url.endsWith("userinfo"))return {ok:true,json:async()=>({sub:user})};
    count++;
    return {ok:true,json:async()=>({access_token:"test-access-"+count,refresh_token:"test-refresh-"+count,expires_in:3600,token_type:"Bearer"})};
  };
  const config={env,request,clock:()=>now};
  const oauth=createWhopOAuth(config);
  return {oauth,config,directory,calls,advance:()=>{now+=3600000;}};
}
async function authorize(oauth) {
  const flow=await oauth.start();
  const params=new URL(flow.url).searchParams;
  await oauth.callback({state:params.get("state"),code:"test-code",browser:flow.browser});
  return {flow,params};
}
test("PKCE, owner identity and encrypted restart persistence",async t=>{
  const f=await fixture(t);
  const {flow,params}=await authorize(f.oauth);
  assert.equal(params.has("company_id"),false);
  assert.equal(params.get("scope"),"openid profile forum:read forum:post:create");
  assert.match(params.get("nonce"),/^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(params.get("nonce"),params.get("state"));
  const body=f.calls[0].body;
  assert.equal(body.company_id,undefined);
  assert.equal(body.client_secret,"test-client-secret");
  assert.equal(crypto.createHash("sha256").update(body.code_verifier).digest("base64url"),params.get("code_challenge"));
  assert.equal(await f.oauth.accessToken(),"test-access-1");
  const disk=await fs.readFile(path.join(f.directory,"whop-oauth.enc"),"utf8");
  assert.equal(disk.includes("test-access"),false);
  assert.equal(disk.includes("test-refresh"),false);
  const restored=createWhopOAuth(f.config);
  assert.equal(await restored.accessToken(),"test-access-1");
  await assert.rejects(f.oauth.callback({state:params.get("state"),code:"test-code",browser:flow.browser}),/expirée/);
  assert.equal(JSON.stringify(f.oauth.status()).includes("test-access"),false);
  const next=await f.oauth.start();
  assert.notEqual(new URL(next.url).searchParams.get("nonce"),params.get("nonce"));
});
test("callback rejects mismatched cookie, expired flow and wrong Whop owner",async t=>{
  const f=await fixture(t,"user_wrong");
  const flow=await f.oauth.start(),state=new URL(flow.url).searchParams.get("state");
  await assert.rejects(f.oauth.callback({state,code:"code",browser:"wrong"}),/expirée/);
  assert.equal(f.calls.length,0);
  await assert.rejects(f.oauth.callback({state,code:"code",browser:flow.browser}),/Mauvais compte/);
  assert.equal(f.oauth.status().connected,false);
  await assert.rejects(fs.access(path.join(f.directory,"whop-oauth.enc")));
  const next=await f.oauth.start();
  f.advance();
  await assert.rejects(f.oauth.callback({state:new URL(next.url).searchParams.get("state"),code:"code",browser:next.browser}),/expirée/);
});
test("concurrent refresh runs once and persists rotated refresh token",async t=>{
  const f=await fixture(t);
  await authorize(f.oauth);
  f.advance();
  assert.deepEqual(await Promise.all([f.oauth.accessToken(),f.oauth.accessToken(),f.oauth.accessToken()]),["test-access-2","test-access-2","test-access-2"]);
  const refresh=f.calls.filter(c=>c.body?.grant_type==="refresh_token");
  assert.equal(refresh.length,1);
  assert.equal(refresh[0].body.refresh_token,"test-refresh-1");
  assert.equal(refresh[0].body.company_id,undefined);
  const restored=createWhopOAuth(f.config);
  assert.equal(await restored.accessToken(),"test-access-2");
  f.advance();
  await restored.accessToken();
  assert.equal(f.calls.at(-1).body.refresh_token,"test-refresh-2");
});
test("refresh failure fails closed without leaking provider secret",async t=>{
  const f=await fixture(t);
  await authorize(f.oauth);
  const broken=createWhopOAuth({...f.config,request:async()=>({ok:false,status:400,json:async()=>({error_description:"SECRET"})})});
  await broken.ready;
  f.advance();
  await assert.rejects(broken.accessToken(),/Renouvellement Whop interrompu/);
  assert.equal(broken.status().connected,false);
  assert.equal(JSON.stringify(broken.status()).includes("SECRET"),false);
  await assert.rejects(fs.access(path.join(f.directory,"whop-oauth.enc")));
});
test("no credentials or unavailable durable storage cannot start",async t=>{
  await assert.rejects(createWhopOAuth({env:{}}).start(),/incomplète/);
  const f=await fixture(t);
  await fs.rm(f.directory,{recursive:true});
  await assert.rejects(f.oauth.start(),/indisponible/);
});
