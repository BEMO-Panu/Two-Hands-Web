import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseApplication} from '../server/supabase-app.js';
const origin='http://localhost:4173',uid='11111111-1111-4111-8111-111111111111',factor='22222222-2222-4222-8222-222222222222';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function fixture(fn,{policy={isAdmin:true,adminMfaRequired:false},policyStatus=200,confirmed=true,metadata={},snapshot={adminMfaRequired:false}}={}){
 const calls=[],user={id:uid,email:'admin-policy@example.test',email_confirmed_at:confirmed?'2026-01-01T00:00:00Z':null,user_metadata:metadata,factors:[{id:factor,factor_type:'totp',status:'verified'}]};
 const token={access_token:'password-access',refresh_token:'refresh-token',expires_in:3600,user};
 const app=createSupabaseApplication({url:'https://mfa-policy-test.supabase.co',publishableKey:'sb_publishable_mock_only',origin,appKey:'bb'.repeat(32),fetchImpl:async(url,init={})=>{
  const target=String(url);calls.push({url:target,init});
  if(target.includes('grant_type=password')||target.endsWith('/auth/v1/verify'))return response(token);
  if(target.endsWith('/auth/v1/user'))return response(user);
  if(target.endsWith(`/factors/${factor}/challenge`))return response({id:'challenge-id'});
  if(target.endsWith(`/factors/${factor}/verify`))return response({...token,access_token:'verified-access'});
  if(target.includes('/rest/v1/')){const b=JSON.parse(init.body);if(b.action==='auth_policy')return response(policy,policyStatus);return response({products:[],stores:[],user:{name:'Policy tester',role:'admin'},...snapshot});}
  return response({});
 }});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});const base=`http://127.0.0.1:${app.server.address().port}`;
 const post=(path,headers,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
 try{
  const initial=await fetch(base+'/api/state'),state=await initial.json();
  const headers={Origin:origin,Cookie:cookie(initial),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'};
  calls.length=0;await fn({base,headers,calls,user,post,login:(code)=>post('/api/auth/login',headers,{email:user.email,password:'password123',...(code?{code}:{})})});
 }finally{await app.close();}
}
const challenges=calls=>calls.filter(c=>c.url.includes('/factors/'));

test('Confirmed database admin can log in without a TOTP challenge only with explicit server policy',async()=>{
 await fixture(async({login,calls})=>{
  const r=await login();assert.equal(r.status,200);const state=await r.json();
  assert.equal(state.capabilities.adminMfaRequired,false);assert.equal(state.user.mfaEnabled,true,'Enrolled factor is preserved');assert.equal(challenges(calls).length,0);
  const request=calls.find(c=>c.url.includes('/rest/v1/')&&JSON.parse(c.init.body).action==='auth_policy');assert.ok(request);assert.equal(request.init.headers.Authorization,'Bearer password-access');
 });
});

test('Regular users and forged admin metadata still require enrolled TOTP',async()=>{
 await fixture(async({login,calls})=>{const r=await login();assert.equal(r.status,401);assert.match((await r.json()).error,/2FA/);assert.equal(challenges(calls).length,0);},
 {policy:{isAdmin:false,adminMfaRequired:false},metadata:{role:'admin',isAdmin:true}});
});

test('Missing, unknown, string-valued and failed policy responses retain MFA',async()=>{
 for(const options of [{policy:{}},{policy:null},{policy:{isAdmin:'true',adminMfaRequired:false}},{policy:{isAdmin:true,adminMfaRequired:'false'}},{policy:{isAdmin:true}},{policy:{isAdmin:true,adminMfaRequired:true}},{policyStatus:404},{policyStatus:503}]){
  await fixture(async({login,calls})=>{const r=await login();assert.equal(r.status,401,JSON.stringify(options));assert.equal(challenges(calls).length,0);},options);
 }
});

test('An unconfirmed account cannot use admin MFA policy exemption',async()=>{
 await fixture(async({login,calls})=>{const r=await login();assert.equal(r.status,401);assert.ok(!calls.some(c=>c.url.includes('/rest/v1/')&&JSON.parse(c.init.body).action==='auth_policy'));},{confirmed:false});
});

test('Old database policy failures still accept a valid TOTP through existing challenge verification',async()=>{
 await fixture(async({login,calls})=>{const r=await login('123456');assert.equal(r.status,200);assert.equal(challenges(calls).length,2);const verify=challenges(calls).find(c=>c.url.endsWith('/verify'));assert.deepEqual(JSON.parse(verify.init.body),{challenge_id:'challenge-id',code:'123456'});},{policyStatus:404});
});

test('Admin reauthentication and recovery reset use the same server-confirmed MFA exemption',async()=>{
 await fixture(async({login,calls,post,headers})=>{
  const signed=await login();assert.equal(signed.status,200);const state=await signed.json();
  const authenticated={...headers,Cookie:cookie(signed),'X-CSRF-Token':state.csrf};calls.length=0;
  const reauth=await post('/api/auth/reauth',authenticated,{password:'password123'});assert.equal(reauth.status,200);assert.equal(challenges(calls).length,0);assert.ok(calls.some(c=>c.url.includes('/rest/v1/')&&JSON.parse(c.init.body).action==='auth_policy'));
 });
 await fixture(async({base,post,headers,calls})=>{
  const confirmed=await post('/api/auth/confirm',headers,{type:'recovery',tokenHash:'test-recovery-token-at-least-sixteen'});assert.equal(confirmed.status,200);
  const recovery=await fetch(base+'/api/state',{headers:{Cookie:cookie(confirmed)}});const recoveryState=await recovery.json();
  const res=await post('/api/auth/reset',{...headers,Cookie:cookie(recovery),'X-CSRF-Token':recoveryState.csrf},{password:'newpassword123'});assert.equal(res.status,200);assert.equal(challenges(calls).length,0);assert.ok(calls.some(c=>c.url.endsWith('/auth/v1/user')&&c.init.method==='PUT'));
 });
});

test('Absent snapshot policy defaults to requiring admin MFA',async()=>{
 await fixture(async({login})=>{const r=await login();assert.equal(r.status,200);assert.equal((await r.json()).capabilities.adminMfaRequired,true);},{snapshot:{}});
});
