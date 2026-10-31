import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseClient} from '../server/supabase-client.js';
import {createSupabaseApplication} from '../server/supabase-app.js';
const origin='http://localhost:4173';
const config={url:'https://test.supabase.co',publishableKey:'sb_publishable_test',appKey:'ab'.repeat(32),origin};
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});
test('Auth distinguishes known email quota, confirmation and credentials errors without leaking upstream details',async()=>{
 for(const [code,reason,status] of [['email_not_confirmed','email_not_confirmed',400],['invalid_credentials','invalid_credentials',400],['over_email_send_rate_limit','email_send_rate_limit',429]]){
  const sb=createSupabaseClient({...config,fetchImpl:async()=>response({code,message:'private upstream details'},status)});
  await assert.rejects(()=>sb.auth('/signup','POST',{}),e=>e.reason===reason&&!e.message.includes('private upstream details'));
 }
 const sb=createSupabaseClient({...config,fetchImpl:async()=>response({code:'unknown',message:'secret'},400)});
 await assert.rejects(()=>sb.auth('/signup'),e=>!e.reason&&!e.message.includes('secret'));
});
test('Auth retains upstream retry delay without inventing one',async()=>{
 const sb=createSupabaseClient({...config,fetchImpl:async()=>response({code:'over_request_rate_limit'},429,{'Retry-After':'42'})});
 await assert.rejects(()=>sb.auth('/token'),e=>e.retryAfter===42&&e.message.includes('42'));
 const without=createSupabaseClient({...config,fetchImpl:async()=>response({code:'over_email_send_rate_limit'},429)});
 await assert.rejects(()=>without.auth('/signup'),e=>e.retryAfter===undefined&&e.reason==='email_send_rate_limit');
});
async function fixture(run,signupTokens=false){
 let now=Date.now(),signupCalls=0;
 const app=createSupabaseApplication({...config,clock:()=>now,fetchImpl:async(url)=>{
  if(String(url).includes('/signup')){signupCalls++;return response(signupTokens?{access_token:'access'}:{user:{id:'new-user'}});}
  if(String(url).includes('/token'))return response({code:'invalid_credentials'},400);
  return response({products:[],stores:[],user:null});
 }});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const r=await fetch(base+'/api/state'),state=await r.json();
  const headers={Origin:origin,'Content-Type':'application/json','X-CSRF-Token':state.csrf,Cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
  const post=(route,mail='person@example.com')=>fetch(base+'/api/auth/'+route,{method:'POST',headers,body:JSON.stringify({email:mail,name:'Tester',password:'password123'})});
  await run({post,advance:ms=>{now+=ms;},count:()=>signupCalls});
 }finally{await app.close();}
}
test('Login retries do not block registration; four attempts allowed; account throttle expires',()=>fixture(async({post,advance,count})=>{
 for(let i=0;i<20;i++)assert.equal((await post('login')).status,400);
 for(let i=0;i<20;i++)assert.equal((await post('register')).status,202);
 const limited=await post('register');assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'900');assert.equal((await limited.json()).reason,'local_rate_limit');assert.equal(count(),20);
 assert.equal((await post('register','another@example.com')).status,202);
 advance(15*60000+1);assert.equal((await post('register')).status,202);
}));
test('Registration keeps confirmation mandatory and rejects automatic login tokens',()=>fixture(async({post})=>{
 const r=await post('register');assert.equal(r.status,503);assert.doesNotMatch(r.headers.get('set-cookie')||'',/access/);
},true));
test('Pending registration explains confirmation and prevents repeated signup confusion',()=>fixture(async({post})=>{
 const r=await post('register');assert.equal(r.status,202);const data=await r.json();assert.equal(data.requiresEmailConfirmation,true);assert.match(data.message,/ไม่ต้องสมัครซ้ำ/);
}));
