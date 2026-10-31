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

const product='44444444-4444-4444-8444-444444444444';
const path=operation=>`/api/products/${product}/auction/${operation}`;
test('Auction management validates POST and empty payload and forwards authenticated identity only',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const operation of ['cancel','delete']){
   calls.length=0;const r=await fetch(base+path(operation),{method:'POST',headers,body:'{}'});assert.equal(r.status,200);
   const request=calls.find(c=>c.url.includes('/rest/v1/'));assert.deepEqual(JSON.parse(request.init.body),{action:'auction_'+operation,payload:{productId:product}});assert.equal(request.init.headers.Authorization,'Bearer payment-access');
  }
 });
});
test('Auction management rejects spoofed authority and malformed identities before mutation',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const body of [{userId:uid},{productId:product},{status:'withdrawn'},{force:true}]){
   const r=await fetch(base+path('cancel'),{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,400);
  }
  const invalid=await fetch(base+'/api/products/p15/auction/delete',{method:'POST',headers,body:'{}'});assert.equal(invalid.status,400);
  const wrong=await fetch(base+path('delete'),{method:'DELETE',headers});assert.equal(wrong.status,405);
  assert.equal(calls.filter(c=>c.url.includes('/rest/v1/')).length,0);
 });
});
test('Auction management preserves CSRF and owner denial',async()=>{
 await fixture(async({base,headers,calls})=>{
  const rejected=await fetch(base+path('cancel'),{method:'POST',headers:{...headers,'X-CSRF-Token':'forged'},body:'{}'});assert.equal(rejected.status,403);assert.equal(calls.length,0);
  const r=await fetch(base+path('cancel'),{method:'POST',headers,body:'{}'});assert.equal(r.status,404);assert.match((await r.json()).error,/ไม่พบประกาศ/);
 },{rpc:()=>response({code:'PT404',message:'Own auction not found'},404)});
});
test('Auction management capability defaults off until database migration is installed',async()=>{
 for(const flag of [undefined,false,'true',true])await fixture(async({base,headers})=>{
  const r=await fetch(base+'/api/state',{headers});assert.equal((await r.json()).capabilities.auctionManagement,flag===true);
 },{snapshot:{auctionManagement:flag}});
});

test('Unified product deletion forwards only product id and rejects extra authority and forged CSRF',async()=>{
 await fixture(async({base,headers,calls})=>{
  const endpoint=base+'/api/products/'+product;
  for(const body of [{force:true},{userId:uid}])assert.equal((await fetch(endpoint,{method:'DELETE',headers,body:JSON.stringify(body)})).status,400);
  assert.equal((await fetch(endpoint,{method:'DELETE',headers:{...headers,'X-CSRF-Token':'fake'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/products/p15',{method:'DELETE',headers,body:'{}'})).status,400);
  assert.equal(calls.filter(c=>c.url.includes('/rest/v1/')).length,0);
  const r=await fetch(endpoint,{method:'DELETE',headers,body:'{}'});assert.equal(r.status,200);
  const request=calls.find(c=>c.url.includes('/rest/v1/'));assert.deepEqual(JSON.parse(request.init.body),{action:'product_delete',payload:{productId:product}});assert.equal(request.init.headers.Authorization,'Bearer payment-access');
 });
});
