import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseApplication } from '../server/supabase-app.js';

const origin='http://localhost:4173';
const options={url:'https://two-hands-test.supabase.co',publishableKey:'sb_publishable_test_key_for_mock_requests_only',origin,appKey:'ab'.repeat(32)};
const jwt=payload=>['e30',Buffer.from(JSON.stringify(payload)).toString('base64url'),'fake_signature'].join('.');

// These tests use only a fake upstream. They do not provision or certify Supabase.
test('Supabase BFF production and public-key configuration fail closed',async()=>{
 for(const patch of [
  {production:true},
  {origin:origin+'/'},
  {origin:origin+'/path'},
  {appKey:''},
  {appKey:'not-a-32-byte-key'},
  {publishableKey:'sb_secret_this_must_never_be_accepted'},
  {publishableKey:jwt({role:'service_role'})},
  {url:'https://example.com/path'},
 ]) {
  let app;
  try {assert.throws(()=>{app=createSupabaseApplication({...options,...patch});},`Must reject configuration ${Object.keys(patch).join(',')}`);}
  finally {if(app)await app.close();}
 }
});

async function withApp(t,upstream,fn,overrides={}){
 const calls=[];
 const app=createSupabaseApplication({...options,...overrides,fetchImpl:async(url,init={})=>{calls.push({url:String(url),init});return upstream(url,init);}});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 try {await fn({base,calls,app});}finally{await app.close();}
}
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const publicState={products:[],stores:[],favorites:[],cart:[],orders:[],bids:{},profile:{name:'guest',shop:'',shopId:null},verification:{status:'none'},user:null};

test('Supabase BFF rejects mutation CSRF and wrong origins before any upstream call',async t=>{
 await withApp(t,()=>response(publicState),async({base,calls})=>{
  const session=await clientSession(base);calls.length=0;
  for(const headers of [{},{Origin:'https://evil.example'},{Origin:origin,'X-CSRF-Token':'forged'},{...session.headers,Origin:'https://evil.example'},{...session.headers,'X-CSRF-Token':'forged'}]){
   const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({email:'test@example.com',password:'long enough password'})});
   assert.equal(r.status,403);assert.equal(calls.length,0);
  }
 });
});

test('Supabase BFF health checks the database and sanitizes upstream failures',async t=>{
 await withApp(t,()=>response({message:'sensitive_db_password_and_stack',details:'private_internal_schema'},503),async({base,calls})=>{
  const r=await fetch(base+'/api/health');const text=await r.text();
  assert.ok(r.status>=500);assert.ok(calls.length>0,'Health must contact Supabase instead of claiming success locally');
  assert.doesNotMatch(text,/sensitive_db_password|private_internal_schema|sb_publishable|Bearer/);
 });
});

async function clientSession(base){
 const r=await fetch(base+'/api/state');assert.equal(r.status,200);
 const state=await r.json();assert.equal(typeof state.csrf,'string');assert.ok(state.csrf.length>=20);
 const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 return {state,cookie,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':state.csrf,'Content-Type':'application/json'}};
}

test('Supabase BFF validates request bodies before authentication upstream and hides auth errors',async t=>{
 await withApp(t,(url)=>String(url).includes('/auth/v1/token')?response({error:'invalid_grant',error_description:'DO_NOT_LEAK auth database internals'},400):response(publicState),async({base,calls})=>{
  const {headers}=await clientSession(base);calls.length=0;
  for(const body of ['{','[]','null']){
   const r=await fetch(base+'/api/auth/login',{method:'POST',headers,body});
   assert.equal(r.status,400);assert.equal(calls.length,0);
  }
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email:'test@example.com',password:'long enough password'})});
  assert.ok([400,401].includes(r.status));const text=await r.text();assert.doesNotMatch(text,/DO_NOT_LEAK|database internals|access_token|refresh_token/);
  // CSRF cookie rotation is allowed; failed authentication must never create a session.
  for(const value of r.headers.getSetCookie())assert.doesNotMatch(value,/session=[^;]+/i);
  assert.ok(calls.some(c=>c.url.includes('/auth/v1/token')));
 });
});

test('Supabase BFF keeps access and refresh tokens encrypted in HttpOnly cookies',async t=>{
 const access=jwt({sub:'11111111-1111-4111-8111-111111111111',exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',aal:'aal1'});
 const refresh='SENSITIVE_REFRESH_TOKEN_do_not_expose';
 const user={id:'11111111-1111-4111-8111-111111111111',email:'test@example.com',email_confirmed_at:new Date().toISOString(),factors:[]};
 await withApp(t,(url)=>{
  if(String(url).includes('/auth/v1/token'))return response({access_token:access,refresh_token:refresh,expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user});
  if(String(url).includes('/auth/v1/user'))return response(user);
  return response({...publicState,user:{id:user.id,email:user.email,name:'Test',role:'user',emailVerified:true,mfaEnabled:false}});
 },async({base})=>{
  const {headers}=await clientSession(base);
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email:user.email,password:'long enough password'})});
  assert.equal(r.status,200);const body=await r.text();
  assert.ok(!body.includes(access)&&!body.includes(refresh));assert.doesNotMatch(body,/access_token|refresh_token|sb_publishable/);
  const cookies=r.headers.getSetCookie();assert.ok(cookies.length>0,'Successful login must establish a cookie');
  assert.ok(cookies.some(c=>/HttpOnly/i.test(c)&&/SameSite=Lax/i.test(c)));
  for(const c of cookies)assert.ok(!c.includes(access)&&!c.includes(refresh),'Tokens must be encrypted, not plaintext or JWT cookies');
 });
});

test('Supabase recovery session cannot act as a signed-in marketplace user',async t=>{
 const user={id:'11111111-1111-4111-8111-111111111111',email:'test@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
 await withApp(t,(url)=>String(url).includes('/auth/v1/verify')?response({access_token:'recovery-access-only',refresh_token:'recovery-refresh',expires_in:3600,user}):String(url).includes('/auth/v1/user')?response(user):response(publicState),async({base,calls})=>{
  const {headers}=await clientSession(base);
  const confirmed=await fetch(base+'/api/auth/confirm',{method:'POST',headers,body:JSON.stringify({type:'recovery',tokenHash:'a-valid-length-recovery-token'})});assert.equal(confirmed.status,200);
  const body=await confirmed.json();assert.equal(body.recoveryRequired,true);
  const cookie=confirmed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const stateResponse=await fetch(base+'/api/state',{headers:{Cookie:cookie}});const state=await stateResponse.json();
  assert.equal(state.user,null);assert.equal(state.recoveryRequired,true);
  const nextHeaders={Origin:origin,Cookie:stateResponse.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'};
  calls.length=0;
  for(const route of ['/api/profile','/api/auth/mfa/setup']){
   const r=await fetch(base+route,{method:route.endsWith('profile')?'PATCH':'POST',headers:nextHeaders,body:'{}'});
   assert.ok([401,403].includes(r.status));
  }
  assert.ok(!calls.some(c=>c.url.includes('/rest/v1/')),'Recovery cannot invoke marketplace RPC mutations');
 });
});

test('Supabase BFF rejects a tampered encrypted cookie before upstream mutation',async t=>{
 await withApp(t,()=>response(publicState),async({base,calls})=>{
  const {headers,cookie}=await clientSession(base);calls.length=0;
  const [name,value]=cookie.split('=');const tampered=value.slice(0,3)+(value[3]==='a'?'b':'a')+value.slice(4);
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{...headers,Cookie:name+'='+tampered},body:JSON.stringify({email:'test@example.com',password:'long enough password'})});
  assert.equal(r.status,403);assert.equal(calls.length,0);
 });
});

test('Supabase client preserves conflict/not-found status without leaking upstream internals',async()=>{
 const {createSupabaseClient}=await import('../server/supabase-client.js');
 for(const status of [401,403,404,409,429,503]){
  const client=createSupabaseClient({...options,fetchImpl:async()=>response({code:'PT'+status,message:'private SQL statement',details:'sensitive schema'},status)});
  await assert.rejects(client.rpc('snapshot'),e=>{assert.equal(e.status,status);assert.doesNotMatch(e.message,/private SQL|sensitive schema/);return true;});
 }
});

test('Supabase client bounds network requests and rejects redirection',async()=>{
 const {createSupabaseClient}=await import('../server/supabase-client.js');let observed;
 const client=createSupabaseClient({...options,fetchImpl:async(url,init)=>{observed=init;throw Error('secret network diagnostics');}});
 await assert.rejects(client.rpc('snapshot'),e=>e.status===503&&!e.message.includes('secret network diagnostics'));
 assert.ok(observed.signal instanceof AbortSignal);assert.equal(observed.redirect,'error');
});

test('Unconfirmed members can request a confirmation email without logging in',async t=>{
 await withApp(t,(url)=>String(url).includes('/auth/v1/resend')?response({}):response(publicState),async({base,calls})=>{
  const {headers}=await clientSession(base);calls.length=0;
  const r=await fetch(base+'/api/auth/resend',{method:'POST',headers,body:JSON.stringify({email:'not-yet-confirmed@example.com'})});
  assert.equal(r.status,200);const outgoing=calls.find(c=>c.url.includes('/auth/v1/resend'));assert.ok(outgoing);
  assert.deepEqual(JSON.parse(outgoing.init.body),{type:'signup',email:'not-yet-confirmed@example.com'});
  assert.doesNotMatch(await r.text(),/access_token|refresh_token/);
 });
});

test('Authenticated malformed JSON and executable image uploads never reach storage or mutation RPC',async t=>{
 const user={id:'11111111-1111-4111-8111-111111111111',email:'test@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
 await withApp(t,(url)=>String(url).includes('/auth/v1/token')?response({access_token:'valid-test-access',refresh_token:'test-refresh',expires_in:3600,user}):String(url).includes('/auth/v1/user')?response(user):response(publicState),async({base,calls})=>{
  const {headers}=await clientSession(base);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email:user.email,password:'long enough password'})});assert.equal(login.status,200);
  const data=await login.json(),authHeaders={Origin:origin,Cookie:login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),'X-CSRF-Token':data.csrf,'Content-Type':'application/json'};calls.length=0;
  const invalid=await fetch(base+'/api/profile',{method:'PATCH',headers:authHeaders,body:'{broken'});assert.equal(invalid.status,400);
  const upload=await fetch(base+'/api/uploads',{method:'POST',headers:{...authHeaders,'Content-Type':'image/svg+xml'},body:'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'});assert.equal(upload.status,400);
  assert.ok(!calls.some(c=>c.url.includes('/storage/v1/')||c.url.includes('/rest/v1/')));
 });
});

test('MFA login withholds cookies until challenge verification succeeds',async t=>{
 const factor='22222222-2222-4222-8222-222222222222';
 const user={id:'11111111-1111-4111-8111-111111111111',email:'mfa@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[{id:factor,factor_type:'totp',status:'verified'}]};
 const session=access=>({access_token:access,refresh_token:'refresh-'+access,expires_in:3600,user});
 await withApp(t,(url,init)=>{
  if(String(url).includes('grant_type=password'))return response(session('aal1-access'));
  if(String(url).endsWith('/auth/v1/user'))return response(user);
  if(String(url).endsWith('/challenge'))return response({id:'challenge-id'});
  if(String(url).endsWith('/verify'))return JSON.parse(init.body).code==='123456'?response(session('aal2-access')):response({error:'incorrect_mfa_code',message:'private verifier detail'},400);
  if(String(url).includes('/logout'))return response({});
  return response(publicState);
 },async({base,calls})=>{
  const {headers}=await clientSession(base);
  for(const code of [undefined,'000000']){
   calls.length=0;
   const r=await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email:user.email,password:'long enough password',...(code?{code}:{})})});
   assert.ok([400,401].includes(r.status));assert.equal(r.headers.getSetCookie().length,0,'Failed MFA must never issue an authentication cookie');
   assert.ok(calls.some(c=>c.url.includes('/logout')),'Temporary password-only session is revoked');
   assert.ok(!calls.some(c=>c.url.includes('/rest/v1/')));
  }
  calls.length=0;
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email:user.email,password:'long enough password',code:'123456'})});
  assert.equal(r.status,200);assert.ok(r.headers.getSetCookie().length>0);
  const challenge=calls.findIndex(c=>c.url.endsWith(`/factors/${factor}/challenge`));const verify=calls.findIndex(c=>c.url.endsWith(`/factors/${factor}/verify`));
  assert.ok(challenge>=0&&verify>challenge);assert.deepEqual(JSON.parse(calls[verify].init.body),{challenge_id:'challenge-id',code:'123456'});
  assert.equal(calls[challenge].init.headers.Authorization,'Bearer aal1-access');assert.equal(calls[verify].init.headers.Authorization,'Bearer aal1-access');
  const authenticatedState=calls.find(c=>c.url.includes('/rest/v1/'));assert.equal(authenticatedState.init.headers.Authorization,'Bearer aal2-access');
 });
});

test('Production issues Secure Host-only cookies and checks the configured public origin',async t=>{
 const publicOrigin='https://two-hands.example';
 await withApp(t,()=>response(publicState),async({base,calls})=>{
  const {headers}=await clientSession(base);const state=await fetch(base+'/api/state');
  for(const cookie of state.headers.getSetCookie()){
   assert.match(cookie,/^__Host-th_supabase=/);assert.match(cookie,/; Secure(?:;|$)/);assert.match(cookie,/; Path=\/(?:;|$)/);assert.match(cookie,/; HttpOnly(?:;|$)/);assert.doesNotMatch(cookie,/; Domain=/i);
  }
  calls.length=0;
  const wrong=await fetch(base+'/api/auth/forgot',{method:'POST',headers,body:JSON.stringify({email:'test@example.com'})});assert.equal(wrong.status,403);assert.equal(calls.length,0);
  const right=await fetch(base+'/api/auth/forgot',{method:'POST',headers:{...headers,Origin:publicOrigin},body:JSON.stringify({email:'test@example.com'})});assert.equal(right.status,200);assert.ok(calls.some(c=>c.url.endsWith('/recover')));
 },{origin:publicOrigin,production:true});
});

test('Refreshing a near-expiry recovery token preserves marketplace restrictions',async t=>{
 let now=Date.now();const user={id:'11111111-1111-4111-8111-111111111111',email:'recovery@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
 await withApp(t,(url)=>{
  if(String(url).includes('/auth/v1/verify'))return response({access_token:'initial-recovery',refresh_token:'recovery-refresh',expires_in:60,user});
  if(String(url).includes('grant_type=refresh_token'))return response({access_token:'renewed-recovery',refresh_token:'new-refresh',expires_in:3600,user});
  if(String(url).endsWith('/auth/v1/user'))return response(user);
  return response(publicState);
 },async({base,calls})=>{
  const {headers}=await clientSession(base);
  const r=await fetch(base+'/api/auth/confirm',{method:'POST',headers,body:JSON.stringify({type:'recovery',tokenHash:'valid-recovery-token-hash'})});assert.equal(r.status,200);
  const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');now+=31000;calls.length=0;
  const refreshed=await fetch(base+'/api/state',{headers:{Cookie:cookie}});assert.equal(refreshed.status,200);const state=await refreshed.json();
  assert.equal(state.recoveryRequired,true);assert.equal(state.user,null);
  const refresh=calls.find(c=>c.url.includes('grant_type=refresh_token'));assert.ok(refresh);assert.deepEqual(JSON.parse(refresh.init.body),{refresh_token:'recovery-refresh'});
  assert.equal(calls.find(c=>c.url.endsWith('/auth/v1/user')).init.headers.Authorization,'Bearer renewed-recovery');
  assert.ok(calls.filter(c=>c.url.includes('/rest/v1/')).every(c=>!c.init.headers.Authorization),'Recovery public state never uses the privileged recovery JWT');
  calls.length=0;
  const denied=await fetch(base+'/api/profile',{method:'PATCH',headers:{Origin:origin,Cookie:refreshed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'},body:JSON.stringify({name:'Attacker',shop:'Shop'})});
  assert.equal(denied.status,403);assert.ok(!calls.some(c=>c.url.includes('/rest/v1/')));
 },{clock:()=>now});
});
