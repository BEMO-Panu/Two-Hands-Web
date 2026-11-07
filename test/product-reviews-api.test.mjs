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
const endpoint=`/api/orders/${order}/reviews`;
test('Review sends validated product rating and comment through authenticated RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify({productId:product,rating:4,comment:'  สินค้าดี  '})});assert.equal(r.status,200);
  const call=calls.find(c=>c.url.includes('/rest/v1/'));assert.deepEqual(JSON.parse(call.init.body),{action:'product_review',payload:{orderId:order,productId:product,rating:4,comment:'สินค้าดี'}});assert.equal(call.init.headers.Authorization,'Bearer payment-access');
 });
});
test('Review rejects forged fields, bad values and CSRF before reaching RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const body of [{productId:product,rating:0,comment:'x'},{productId:product,rating:6,comment:'x'},{productId:product,rating:5,comment:' '},{productId:'fake',rating:5,comment:'x'},{productId:product,rating:5,comment:'x',buyerId:uid}])assert.equal((await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(body)})).status,400);
  assert.equal((await fetch(base+endpoint,{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:'{}'})).status,403);assert.equal(calls.filter(c=>c.url.includes('/rest/v1/')).length,0);
 });
});
test('Review requires actual completed purchase and sanitizes upstream errors',async()=>{
 await fixture(async({base,headers})=>{
  const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify({productId:product,rating:5,comment:'x'})});assert.equal(r.status,403);assert.equal((await r.json()).reason,'review_purchase_required');
 },{rpc:()=>response({code:'PT403',message:'Completed purchase required for review'},403)});
});
