import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseApplication} from '../server/supabase-app.js';

const origin='http://localhost:4173',uid='11111111-1111-4111-8111-111111111111',order='22222222-2222-4222-8222-222222222222',shop='33333333-3333-4333-8333-333333333333';
const user={id:uid,email:'auction@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function fixture(fn,{rpc}={}){
 const calls=[];
 const app=createSupabaseApplication({url:'https://auction-test.supabase.co',publishableKey:'sb_publishable_mock_only',origin,appKey:'ba'.repeat(32),fetchImpl:async(url,init={})=>{
  const target=String(url);calls.push({url:target,init});
  if(target.includes('grant_type=password'))return response({access_token:'payment-access',refresh_token:'payment-refresh',expires_in:3600,user});
  if(target.endsWith('/auth/v1/user'))return response(user);
  if(target.includes('/rest/v1/')){const body=JSON.parse(init.body);return body.action==='snapshot'?response({products:[],stores:[],user:{name:'Auction tester',role:'user'}}):rpc?rpc(body,init):response({ok:true});}
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
const round='44444444-4444-4444-8444-444444444444',endpoint='/api/products/p14/bids';
const valid={amount:5000,requestKey:'sample-auction-api',roundId:round};
const rpcCalls=calls=>calls.filter(c=>c.url.includes('/rest/v1/'));

test('Sample auction bid forwards authoritative sample identity and round using authenticated JWT',async()=>{
 await fixture(async({base,headers,calls})=>{
  const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(valid)});assert.equal(r.status,200);
  const requests=rpcCalls(calls);assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(requests[0].init.body),{action:'bid',payload:{productId:'p14',...valid}});
  assert.equal(requests[0].init.headers.Authorization,'Bearer payment-access');
 });
});

test('Sample auction bids reject client authority, invalid rounds, amounts and request keys before RPC',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const body of [
   {...valid,productId:'p1'},{...valid,userId:uid},{...valid,price:1},{...valid,winnerId:uid},
   {...valid,roundId:'invalid'},{...valid,roundId:null},{...valid,roundId:undefined},
   {...valid,amount:0},{...valid,amount:10000001},{...valid,amount:5000.5},{...valid,amount:'5000'},
   {...valid,requestKey:'short'},{...valid,requestKey:'x'.repeat(101)}
  ]){
   const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,400,JSON.stringify(body));
  }
  for(const id of ['p0','p17','p01','not-a-uuid']){
   const r=await fetch(base+'/api/products/'+id+'/bids',{method:'POST',headers,body:JSON.stringify(valid)});assert.equal(r.status,400);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Sample auction bids reject forged CSRF and anonymous requests',async()=>{
 await fixture(async({base,headers,calls})=>{
  const forged=await fetch(base+endpoint,{method:'POST',headers:{...headers,'X-CSRF-Token':'forged'},body:JSON.stringify(valid)});assert.equal(forged.status,403);assert.equal(calls.length,0);
  const initial=await fetch(base+'/api/state'),state=await initial.json();calls.length=0;
  const anonymous=await fetch(base+endpoint,{method:'POST',headers:{Origin:origin,Cookie:cookie(initial),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'},body:JSON.stringify(valid)});assert.equal(anonymous.status,401);assert.equal(rpcCalls(calls).length,0);
 });
});

test('Sample auction bids reject unsupported methods without mutation',async()=>{
 await fixture(async({base,headers,calls})=>{
  for(const method of ['GET','PATCH','DELETE','PUT']){
   const r=await fetch(base+endpoint,{method,headers,...(method==='GET'?{}:{body:'{}'})});assert.equal(r.status,405);
  }
  assert.equal(rpcCalls(calls).length,0);
 });
});

test('Sample auction bid conflict errors hide upstream details',async()=>{
 await fixture(async({base,headers})=>{
  const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(valid)});assert.equal(r.status,409);assert.doesNotMatch(await r.text(),/PRIVATE_SQL|winner_email/);
 },{rpc:()=>response({code:'PT409',message:'PRIVATE_SQL winner_email'},409)});
});

test('Actual UUID auction bid retains its existing payload contract and uses authoritative path identity',async()=>{
 await fixture(async({base,headers,calls})=>{
  const body={amount:6000,requestKey:'actual-auction-api'};
  const r=await fetch(base+`/api/products/${shop}/bids`,{method:'POST',headers,body:JSON.stringify({...body,productId:'spoof'})});assert.equal(r.status,200);
  assert.deepEqual(JSON.parse(rpcCalls(calls)[0].init.body),{action:'bid',payload:{...body,productId:shop}});
 });
});
