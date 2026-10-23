import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseApplication} from '../server/supabase-app.js';

const origin='http://localhost:4173',uid='11111111-1111-4111-8111-111111111111',order='22222222-2222-4222-8222-222222222222',shop='33333333-3333-4333-8333-333333333333';
const user={id:uid,email:'sample@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function fixture(fn,{rpc}={}){
 const calls=[];
 const app=createSupabaseApplication({url:'https://sample-test.supabase.co',publishableKey:'sb_publishable_mock_only',origin,appKey:'ba'.repeat(32),fetchImpl:async(url,init={})=>{
  const target=String(url);calls.push({url:target,init});
  if(target.includes('grant_type=password'))return response({access_token:'payment-access',refresh_token:'payment-refresh',expires_in:3600,user});
  if(target.endsWith('/auth/v1/user'))return response(user);
  if(target.includes('/rest/v1/')){const body=JSON.parse(init.body);return body.action==='snapshot'?response({products:[],stores:[],user:{name:'Sample tester',role:'user'}}):rpc?rpc(body,init):response({ok:true});}
  return response({});
 }});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const initial=await fetch(base+'/api/state'),state=await initial.json();
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:origin,Cookie:cookie(initial),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'password123'})});assert.equal(login.status,200);const signed=await login.json();
  const headers={Origin:origin,Cookie:cookie(login),'X-CSRF-Token':signed.csrf,'Content-Type':'application/json'};
  calls.length=0;await fn({base,headers,calls});
 }finally{await app.close();}
}
const endpoint=`/api/orders/${order}/complete-sample`;
const rpcCalls=calls=>calls.filter(c=>c.url.includes('/rest/v1/'));

test('Sample receipt uses authenticated RPC and authoritative order path only',async()=>{
 await fixture(async({base,headers,calls})=>{
  const r=await fetch(base+endpoint,{method:'POST',headers,body:'{}'});assert.equal(r.status,200);
  const requests=rpcCalls(calls);assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(requests[0].init.body),{action:'sample_complete',payload:{orderId:order}});
  assert.equal(requests[0].init.headers.Authorization,'Bearer payment-access');
 });
});

test('Sample receipt rejects payload authority injection and invalid identities before RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const body of [{orderId:order},{buyerId:uid},{status:'completed'},{paid:true},{amount:1},{shopId:shop}]){
   const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,400);
  }
  const invalid=await fetch(base+'/api/orders/not-a-uuid/complete-sample',{method:'POST',headers,body:'{}'});assert.equal(invalid.status,400);
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Sample receipt requires POST and rejects unsupported methods without mutation',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const method of ['GET','PATCH','DELETE','PUT']){
   const r=await fetch(base+endpoint,{method,headers,...(method==='GET'?{}:{body:'{}'})});assert.equal(r.status,405);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Sample receipt rejects forged CSRF and anonymous callers',async()=>{
 await fixture(async({base,headers,calls})=>{
  const forged=await fetch(base+endpoint,{method:'POST',headers:{...headers,'X-CSRF-Token':'forged'},body:'{}'});assert.equal(forged.status,403);assert.equal(calls.length,0);
  const initial=await fetch(base+'/api/state'),state=await initial.json();calls.length=0;
  const anonymous=await fetch(base+endpoint,{method:'POST',headers:{Origin:origin,Cookie:cookie(initial),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'},body:'{}'});assert.equal(anonymous.status,401);assert.equal(rpcCalls(calls).length,0);
 });
});

test('Sample receipt preserves ownership denials without leaking private upstream details',async()=>{
 await fixture(async({base,headers})=>{
  const r=await fetch(base+endpoint,{method:'POST',headers,body:'{}'});assert.equal(r.status,404);assert.doesNotMatch(await r.text(),/PRIVATE_SQL|buyer_secret/);
 },{rpc:()=>response({code:'PT404',message:'PRIVATE_SQL buyer_secret'},404)});
});

test('Main cart and checkout accept canonical samples and real IDs but reject unbounded sample identities',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const id of ['p1','p15','p16',shop]){
   const cart=await fetch(base+'/api/cart/'+id,{method:'PUT',headers,body:'{}'});assert.equal(cart.status,200);
   const reserve=await fetch(base+'/api/orders',{method:'POST',headers,body:JSON.stringify({productIds:[id],delivery:'pickup',requestKey:'sample-api-checkout'})});assert.equal(reserve.status,200);
  }
  calls.length=0;
  for(const id of ['p0','p17','p01','not-a-uuid']){
   const cart=await fetch(base+'/api/cart/'+id,{method:'PUT',headers,body:'{}'});assert.equal(cart.status,400);
   const reserve=await fetch(base+'/api/orders',{method:'POST',headers,body:JSON.stringify({productIds:[id],delivery:'pickup',requestKey:'sample-api-checkout'})});assert.equal(reserve.status,400);
  }
  for(const productIds of [[],Array(21).fill('p1'),null,'p1',[1]]){
   const r=await fetch(base+'/api/orders',{method:'POST',headers,body:JSON.stringify({productIds,delivery:'pickup',requestKey:'sample-api-checkout'})});assert.equal(r.status,400);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});
