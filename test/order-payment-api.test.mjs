import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseApplication} from '../server/supabase-app.js';

const origin='http://localhost:4173',uid='11111111-1111-4111-8111-111111111111',order='22222222-2222-4222-8222-222222222222',shop='33333333-3333-4333-8333-333333333333';
const user={id:uid,email:'payment@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function fixture(fn,{rpc}={}){
 const calls=[];
 const app=createSupabaseApplication({url:'https://payment-test.supabase.co',publishableKey:'sb_publishable_mock_only',origin,appKey:'ba'.repeat(32),fetchImpl:async(url,init={})=>{
  const target=String(url);calls.push({url:target,init});
  if(target.includes('grant_type=password'))return response({access_token:'payment-access',refresh_token:'payment-refresh',expires_in:3600,user});
  if(target.endsWith('/auth/v1/user'))return response(user);
  if(target.includes('/rest/v1/')){const body=JSON.parse(init.body);return body.action==='snapshot'?response({products:[],stores:[],user:{name:'Payment tester',role:'user'}}):rpc?rpc(body,init):response({ok:true});}
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
const payment=`/api/orders/${order}/pay`,fulfillment=`/api/orders/${order}/shops/${shop}/fulfill`;
const rpcCalls=calls=>calls.filter(c=>c.url.includes('/rest/v1/'));

// These API tests exercise the HTTP trust boundary. PostgreSQL tests separately
// prove ownership, amount calculation and idempotency under authenticated RPCs.
test('Order payment and fulfillment deny forged CSRF before reaching Supabase',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const path of [payment,fulfillment]){
   const r=await fetch(base+path,{method:'POST',headers:{...headers,'X-CSRF-Token':'forged'},body:'{}'});assert.equal(r.status,403);
  }
  assert.equal(calls.length,0);
 });
});

test('Order payment and fulfillment reject anonymous callers',async()=>{
 await fixture(async({base,calls})=>{
  const initial=await fetch(base+'/api/state'),state=await initial.json();calls.length=0;
  for(const path of [payment,fulfillment]){
   const r=await fetch(base+path,{method:'POST',headers:{Origin:origin,Cookie:cookie(initial),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,401);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Order payment and fulfillment preserve upstream ownership denial without leaking SQL details',async()=>{
 await fixture(async({base,headers})=>{
  for(const [path,body] of [[payment,{method:'qr_demo',outcome:'success',requestKey:'payment-test-ownership'}],[fulfillment,{status:'preparing'}]]){
   const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/PRIVATE_SQL|other_buyer_email/);
  }
 },{rpc:()=>response({code:'PT403',message:'PRIVATE_SQL other_buyer_email'},403)});
});


test('Order payment and fulfillment forward only validated fields with authenticated upstream JWT',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const [path,body,action,payload] of [
   [payment,{method:'qr_demo',outcome:'success',requestKey:'payment-api-success'},'pay',{orderId:order,method:'qr_demo',outcome:'success',requestKey:'payment-api-success'}],
   [payment,{method:'card_demo',outcome:'declined',requestKey:'payment-api-decline'},'pay',{orderId:order,method:'card_demo',outcome:'declined',requestKey:'payment-api-decline'}],
   [fulfillment,{status:'ready'},'fulfill',{orderId:order,shopId:shop,status:'ready'}]
  ]){
   calls.length=0;const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200);
   const requests=rpcCalls(calls);assert.equal(requests.length,1);assert.deepEqual(JSON.parse(requests[0].init.body),{action,payload});
   assert.equal(requests[0].init.headers.Authorization,'Bearer payment-access');
  }
 });
});

test('Order payment and fulfillment reject caller authority, invalid fields and invalid identities before RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  const valid={method:'qr_demo',outcome:'success',requestKey:'payment-api-success'};
  for(const [path,body] of [
   [payment,{...valid,amount:1}],[payment,{...valid,userId:uid}],[payment,{...valid,orderId:order}],[payment,{...valid,paymentStatus:'paid'}],
   [payment,{...valid,method:'promptpay'}],[payment,{...valid,outcome:'paid'}],[payment,{...valid,requestKey:'short'}],
   [payment,{...valid,requestKey:'x'.repeat(101)}],[payment,{...valid,requestKey:1234567890}],
   [payment,{...valid,outcome:null}],[payment,{...valid,method:null}],
   [`/api/orders/not-a-uuid/pay`,valid],
   [fulfillment,{status:'ready',userId:uid}],[fulfillment,{status:'ready',shopId:shop}],[fulfillment,{status:'completed'}],
   [fulfillment,{status:null}],[fulfillment,{}],
   [`/api/orders/not-a-uuid/shops/${shop}/fulfill`,{status:'ready'}],
   [`/api/orders/${order}/shops/not-a-uuid/fulfill`,{status:'ready'}]
  ]){
   const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,400,`${path} ${JSON.stringify(body)}`);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Order payment and fulfillment reject unsupported methods without mutation RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const path of [payment,fulfillment])for(const method of ['GET','PATCH','DELETE','PUT']){
   const r=await fetch(base+path,{method,headers,...(method==='GET'?{}:{body:'{}'})});assert.equal(r.status,405,`${method} ${path}`);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});
