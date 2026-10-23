import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseApplication} from '../server/supabase-app.js';

const origin='http://localhost:4173',uid='11111111-1111-4111-8111-111111111111',order='22222222-2222-4222-8222-222222222222',shop='33333333-3333-4333-8333-333333333333';
const user={id:uid,email:'sample@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function fixture(fn,{rpc,snapshot={}}={}){
 const calls=[];
 const app=createSupabaseApplication({url:'https://sample-test.supabase.co',publishableKey:'sb_publishable_mock_only',origin,appKey:'ba'.repeat(32),fetchImpl:async(url,init={})=>{
  const target=String(url);calls.push({url:target,init});
  if(target.includes('grant_type=password'))return response({access_token:'payment-access',refresh_token:'payment-refresh',expires_in:3600,user});
  if(target.endsWith('/auth/v1/user'))return response(user);
  if(target.includes('/rest/v1/')){const body=JSON.parse(init.body);return body.action==='snapshot'?response({products:[],stores:[],user:{name:'Sample tester',role:'user'},...snapshot}):rpc?rpc(body,init):response({ok:true});}
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
const delivery=`/api/orders/${order}/delivery`,shipment=`/api/orders/${order}/shops/${shop}/ship`;
const details={delivery:'shipping',recipientName:' Test recipient ',phone:'+66 (81) 234-5678',address:' 123 Test Street Bangkok 10200 '};
const normalized={delivery:'shipping',recipientName:'Test recipient',phone:'+66 (81) 234-5678',address:'123 Test Street Bangkok 10200'};
const packageInfo={carrier:'Demo Delivery',trackingNumber:'DEMO-123_456'};
const rpcCalls=calls=>calls.filter(c=>c.url.includes('/rest/v1/'));

test('Delivery, shipment and reservation whitelist validated fields and use authenticated JWT',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const [path,body,action,payload] of [
   [delivery,details,'order_delivery',{orderId:order,...normalized}],
   [delivery,{delivery:'pickup',address:''},'order_delivery',{orderId:order,delivery:'pickup',recipientName:null,phone:null,address:null}],
   [shipment,packageInfo,'order_ship',{orderId:order,shopId:shop,...packageInfo}],
   ['/api/orders',{productIds:['p15'],requestKey:'delivery-checkout',...details},'reserve',{productIds:['p15'],requestKey:'delivery-checkout',...normalized}]
  ]){
   calls.length=0;const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200);
   const requests=rpcCalls(calls);assert.equal(requests.length,1);assert.deepEqual(JSON.parse(requests[0].init.body),{action,payload});assert.equal(requests[0].init.headers.Authorization,'Bearer payment-access');
  }
 });
});

test('Delivery API rejects forged financial authority, identities and shipment statuses before RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const [path,body] of [
   [delivery,{...details,orderId:order}],[delivery,{...details,userId:uid}],[delivery,{...details,fee:0}],
   [shipment,{...packageInfo,shopId:shop}],[shipment,{...packageInfo,sellerId:uid}],[shipment,{...packageInfo,shippedAt:1}],
   ['/api/orders',{productIds:['p15'],requestKey:'delivery-checkout',...details,total:1}],
   ['/api/orders',{productIds:['p15'],requestKey:'delivery-checkout',...details,shippingFee:0}]
  ]){
   const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,400);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Delivery and shipment fields enforce bounds, formats and prohibit pickup addresses',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const body of [
   {...details,delivery:'drone'},{...details,recipientName:''},{...details,recipientName:'x'.repeat(101)},
   {...details,phone:'12345'},{...details,phone:'1'.repeat(31)},{...details,phone:'call@example.com'},
   {...details,address:'too short'},{...details,address:'x'.repeat(1001)},
   {delivery:'pickup',address:'private address'},{delivery:'pickup',recipientName:'Private Name'}
  ]){
   const r=await fetch(base+delivery,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,400,JSON.stringify(body));
  }
  for(const body of [
   {...packageInfo,carrier:''},{...packageInfo,carrier:'x'.repeat(81)},
   {...packageInfo,trackingNumber:'12'},{...packageInfo,trackingNumber:'x'.repeat(101)},
   {...packageInfo,trackingNumber:'https://tracking.example'},{...packageInfo,trackingNumber:'<script>'}
  ]){
   const r=await fetch(base+shipment,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,400);
  }
  assert.equal(rpcCalls(calls).length,0);
  const maximum={delivery:'shipping',recipientName:'x'.repeat(100),phone:'1'.repeat(30),address:'x'.repeat(1000)};
  const r=await fetch(base+delivery,{method:'POST',headers,body:JSON.stringify(maximum)});assert.equal(r.status,200);
 });
});

test('Delivery APIs require valid order/shop UUIDs and POST without mutation for unsupported methods',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const path of ['/api/orders/invalid/delivery',`/api/orders/${order}/shops/invalid/ship`,`/api/orders/invalid/shops/${shop}/ship`]){
   const r=await fetch(base+path,{method:'POST',headers,body:'{}'});assert.equal(r.status,400);
  }
  for(const path of [delivery,shipment])for(const method of ['GET','PATCH','DELETE','PUT']){
   const r=await fetch(base+path,{method,headers,...(method==='GET'?{}:{body:'{}'})});assert.equal(r.status,405);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Delivery API denies forged CSRF and anonymous requests',async()=>{
 await fixture(async({base,headers,calls})=>{
  const forged=await fetch(base+delivery,{method:'POST',headers:{...headers,'X-CSRF-Token':'forged'},body:JSON.stringify(details)});assert.equal(forged.status,403);assert.equal(calls.length,0);
  const initial=await fetch(base+'/api/state'),state=await initial.json();calls.length=0;
  const anonymous=await fetch(base+shipment,{method:'POST',headers:{Origin:origin,Cookie:cookie(initial),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'},body:JSON.stringify(packageInfo)});assert.equal(anonymous.status,401);assert.equal(rpcCalls(calls).length,0);
 });
});

test('Delivery APIs preserve ownership denials and sanitize private address details from SQL errors',async()=>{
 await fixture(async({base,headers})=>{
  for(const [path,body] of [[delivery,details],[shipment,packageInfo]]){
   const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,404);assert.doesNotMatch(await r.text(),/PRIVATE_ADDRESS|recipient_phone/);
  }
 },{rpc:()=>response({code:'PT404',message:'PRIVATE_ADDRESS recipient_phone'},404)});
});


test('Shipping and seller profile capabilities require explicit installed database flags',async()=>{
 for(const [snapshot,expected] of [[{},false],[{shipping:'true',sellerProfiles:'true'},false],[{shipping:true,sellerProfiles:true},true]]){
  await fixture(async({base,headers})=>{
   const r=await fetch(base+'/api/state',{headers});assert.equal(r.status,200);const state=await r.json();
   assert.equal(state.capabilities.shipping,expected);assert.equal(state.capabilities.sellerProfiles,expected);
  },{snapshot});
 }
});
