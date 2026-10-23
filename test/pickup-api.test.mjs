import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseApplication} from '../server/supabase-app.js';
const origin='http://localhost:4173',uid='11111111-1111-4111-8111-111111111111',order='22222222-2222-4222-8222-222222222222',shop='33333333-3333-4333-8333-333333333333';
const user={id:uid,email:'pickup@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function fixture(fn,{rpc,clock=Date.now,expiresIn=3600}={}){
 const calls=[];
 const app=createSupabaseApplication({url:'https://pickup-test.supabase.co',publishableKey:'sb_publishable_mock_only',origin,appKey:'da'.repeat(32),clock,fetchImpl:async(url,init={})=>{
  calls.push({url:String(url),init});
  if(String(url).includes('grant_type=password'))return response({access_token:'pickup-access',refresh_token:'pickup-refresh',expires_in:expiresIn,user});
  if(String(url).includes('grant_type=refresh_token'))return response({access_token:'refreshed-access',refresh_token:'refreshed-refresh',expires_in:3600,user});
  if(String(url).endsWith('/auth/v1/user'))return response(user);
  if(String(url).includes('/rest/v1/')){const b=JSON.parse(init.body);return b.action==='snapshot'?response({products:[],stores:[],user:{name:'Pickup tester',role:'user'}}):rpc?rpc(b,init):response({ok:true});}
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
const endpoint=`/api/orders/${order}/shops/${shop}`;
const rpcCalls=calls=>calls.filter(c=>c.url.includes('/rest/v1/'));

test('Pickup messages and handoff whitelist path identities and use authenticated upstream JWT',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const [suffix,body,action] of [
   ['messages',{text:' นัดรับตอนเย็น ',senderId:'attacker',senderRole:'admin',orderId:'spoof',shopId:'spoof'},'order_message'],
   ['handoff',{buyerConfirmedAt:1,sellerConfirmedAt:1,completedAt:1,userId:'attacker',role:'admin'},'order_handoff']]){
   calls.length=0;const r=await fetch(base+endpoint+'/'+suffix,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200);
   const request=rpcCalls(calls);assert.equal(request.length,1);
   assert.deepEqual(JSON.parse(request[0].init.body),{action,payload:{orderId:order,shopId:shop,...(suffix==='messages'?{text:'นัดรับตอนเย็น'}:{})}});
   assert.equal(request[0].init.headers.Authorization,'Bearer pickup-access');
  }
 });
});

test('Pickup API rejects forged CSRF before upstream and invalid UUIDs before RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  const csrf=await fetch(base+endpoint+'/messages',{method:'POST',headers:{...headers,'X-CSRF-Token':'forged'},body:'{"text":"Hello"}'});assert.equal(csrf.status,403);assert.equal(calls.length,0);
  for(const path of [`/api/orders/not-a-uuid/shops/${shop}/messages`,`/api/orders/${order}/shops/not-a-uuid/handoff`]){
   const r=await fetch(base+path,{method:'POST',headers,body:'{"text":"Hello"}'});assert.equal(r.status,400);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Pickup message bounds accept 2000 characters and reject empty or oversized messages',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const text of ['', '   ', 'x'.repeat(2001)]){
   const r=await fetch(base+endpoint+'/messages',{method:'POST',headers,body:JSON.stringify({text})});assert.equal(r.status,400);
  }
  assert.equal(rpcCalls(calls).length,0);
  const text='x'.repeat(2000),r=await fetch(base+endpoint+'/messages',{method:'POST',headers,body:JSON.stringify({text})});assert.equal(r.status,200);
  assert.equal(JSON.parse(rpcCalls(calls)[0].init.body).payload.text,text);
 });
});

test('Pickup read and mutation endpoints reject unsupported methods without mutation RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const [suffix,method] of [['messages','PUT'],['messages','DELETE'],['messages','PATCH'],['handoff','GET'],['handoff','DELETE']]){
   const r=await fetch(base+endpoint+'/'+suffix,{method,headers,...(method==='GET'?{}:{body:'{}'})});assert.equal(r.status,405);
  }
  assert.equal(rpcCalls(calls).length,0);
  const r=await fetch(base+endpoint+'/messages',{headers});assert.equal(r.status,200);
  assert.deepEqual(JSON.parse(rpcCalls(calls)[0].init.body),{action:'order_messages',payload:{orderId:order,shopId:shop}});
 });
});

test('Pickup API preserves upstream ownership denial and sanitizes private SQL details',async()=>{
 await fixture(async({base,headers})=>{
  const r=await fetch(base+endpoint+'/messages',{headers});assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/PRIVATE_SQL|other_buyer_email/);
 },{rpc:()=>response({code:'PT403',message:'PRIVATE_SQL other_buyer_email'},403)});
});

test('A refreshed auth cookie survives later pickup conflict responses',async()=>{
 let now=Date.now();
 await fixture(async({base,headers,calls})=>{
  now+=31000;
  const r=await fetch(base+endpoint+'/messages',{method:'POST',headers,body:'{"text":"Hello"}'});assert.equal(r.status,409);assert.ok(r.headers.getSetCookie().length>0,'Rotated tokens must reach the browser even when RPC fails');
  assert.ok(calls.some(c=>c.url.includes('grant_type=refresh_token')));
  assert.ok(!cookie(r).includes('refreshed-access'));
  calls.length=0;
  const state=await fetch(base+'/api/state',{headers:{Cookie:cookie(r)}});assert.equal(state.status,200);
  assert.ok(!calls.some(c=>c.url.includes('grant_type=refresh_token')));
  assert.equal(calls.find(c=>c.url.endsWith('/auth/v1/user')).init.headers.Authorization,'Bearer refreshed-access');
 },{clock:()=>now,expiresIn:60,rpc:()=>response({code:'PT409',message:'Conflict'},409)});
});

test('Listing edits and withdrawals whitelist writable fields and authoritative product path',async()=>{
 await fixture(async({base,headers,calls})=>{
  const product='44444444-4444-4444-8444-444444444444';
  const fields={title:'Updated lamp',description:'An accurate updated description',category:'home',condition:'สภาพดี',location:'Bangkok',price:250};
  const edit=await fetch(base+'/api/products/'+product,{method:'PATCH',headers,body:JSON.stringify({...fields,productId:'spoof',shopId:'spoof',status:'sold',role:'admin',verified:true})});assert.equal(edit.status,200);
  assert.deepEqual(JSON.parse(rpcCalls(calls)[0].init.body),{action:'product_update',payload:{productId:product,...fields}});
  calls.length=0;
  const withdraw=await fetch(base+'/api/products/'+product+'/withdraw',{method:'POST',headers,body:'{"productId":"spoof","userId":"attacker"}'});assert.equal(withdraw.status,200);
  assert.deepEqual(JSON.parse(rpcCalls(calls)[0].init.body),{action:'product_withdraw',payload:{productId:product}});
  calls.length=0;
  for(const [path,method,body] of [[`/api/products/not-a-uuid`,'PATCH',fields],[`/api/products/${product}`,'POST',fields],[`/api/products/${product}/withdraw`,'PATCH',{}]]){
   const invalid=await fetch(base+path,{method,headers,body:JSON.stringify(body)});assert.ok([400,405].includes(invalid.status));
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Report review forwards only the report path and validated note, never claimed admin identity',async()=>{
 await fixture(async({base,headers,calls})=>{
  const report='55555555-5555-4555-8555-555555555555',note='Checked independent references for this report';
  const list=await fetch(base+'/api/admin/reports',{headers});assert.equal(list.status,200);assert.deepEqual(JSON.parse(rpcCalls(calls)[0].init.body),{action:'admin_reports',payload:{}});
  calls.length=0;
  const review=await fetch(base+`/api/admin/reports/${report}/review`,{method:'POST',headers,body:JSON.stringify({note,reportId:'spoof',adminId:'spoof',role:'admin',status:'deleted'})});assert.equal(review.status,200);
  const request=rpcCalls(calls)[0];assert.deepEqual(JSON.parse(request.init.body),{action:'review_report',payload:{reportId:report,note}});assert.equal(request.init.headers.Authorization,'Bearer pickup-access');
  calls.length=0;
  for(const [id,text] of [['not-a-uuid',note],[report,'x'.repeat(19)],[report,'x'.repeat(1501)]]){
   const r=await fetch(base+`/api/admin/reports/${id}/review`,{method:'POST',headers,body:JSON.stringify({note:text})});assert.equal(r.status,400);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Duplicate shop verification returns shop-specific conflict without leaking database errors',async()=>{
 await fixture(async({base,headers})=>{
  const r=await fetch(base+'/api/verification',{method:'POST',headers,body:JSON.stringify({name:'Test shop',location:'Bangkok',bio:'Shop details for verification'})});
  assert.equal(r.status,409);
  const body=await r.json();
  assert.match(body.error,/ร้านส่งคำขอแล้วหรือผ่านการตรวจสอบแล้ว/);
  assert.doesNotMatch(body.error,/ราคา|PRIVATE|database/);
 },{rpc:()=>response({code:'PT409',message:'PRIVATE database conflict'},409)});
});
