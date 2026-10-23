import { test } from 'node:test';
import assert from 'node:assert/strict';
import { password } from '../server/security.js';
import { createSupabaseApplication } from '../server/supabase-app.js';

test('password policy accepts 8 through 128 UTF-16 units and rejects shorter/longer input',()=>{
 for(const value of ['12345678','x'.repeat(128),'界'.repeat(128)])assert.equal(password(value),value);
 for(const value of ['1234567','x'.repeat(129),'界'.repeat(171),null,12345678])assert.throws(()=>password(value),e=>e.status===400);
 // 128 UTF-16 units imply at most 384 UTF-8 bytes, so the 512-byte
 // defense cannot be triggered independently of the character cap.
 assert.ok(Buffer.byteLength('界'.repeat(128))<=512);
 assert.ok(Buffer.byteLength('界'.repeat(171))>512);
});

test('password validation preserves whitespace and Unicode without normalization',()=>{
 for(const value of [' 123456 ', 'e\u0301'.repeat(4), '\u00e9'.repeat(8)])assert.equal(password(value),value);
 assert.notEqual(password('e\u0301'.repeat(4)), 'e\u0301'.repeat(4).normalize('NFC'));
});

test('Supabase registration enforces boundaries before upstream and forwards exact password bytes',async()=>{
 const origin='http://localhost:4173',calls=[];
 const app=createSupabaseApplication({url:'https://password-policy-test.supabase.co',publishableKey:'sb_publishable_test_only',origin,appKey:'ac'.repeat(32),fetchImpl:async(url,init)=>{
  calls.push({url:String(url),init});return new Response(JSON.stringify(String(url).includes('/signup')?{user:{id:'test'}}:{products:[],stores:[],user:null}),{status:200,headers:{'Content-Type':'application/json'}});
 }});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 try {
  const initial=await fetch(base+'/api/state'),state=await initial.json();
  const headers={Origin:origin,'X-CSRF-Token':state.csrf,Cookie:initial.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'Content-Type':'application/json'};
  for(const value of ['1234567','x'.repeat(129),' 123456 ','x'.repeat(128)]){
   calls.length=0;const r=await fetch(base+'/api/auth/register',{method:'POST',headers,body:JSON.stringify({email:'test@example.com',name:'Tester',password:value})});
   if(value.length<8||value.length>128){assert.equal(r.status,400);assert.equal(calls.length,0);}
   else {assert.equal(r.status,202);assert.equal(JSON.parse(calls.find(c=>c.url.includes('/signup')).init.body).password,value);}
  }
 }finally{await app.close();}
});

test('Supabase login and reauthentication preserve significant password whitespace',async()=>{
 const origin='http://localhost:4173',calls=[],value=' 123456 ';
 const user={id:'11111111-1111-4111-8111-111111111111',email:'test@example.com',email_confirmed_at:'2026-01-01T00:00:00Z',factors:[]};
 const app=createSupabaseApplication({url:'https://password-policy-test.supabase.co',publishableKey:'sb_publishable_test_only',origin,appKey:'ac'.repeat(32),fetchImpl:async(url,init)=>{
  calls.push({url:String(url),init});
  const body=String(url).includes('grant_type=password')?{access_token:'test-access',refresh_token:'test-refresh',expires_in:3600,user}:String(url).endsWith('/auth/v1/user')?user:{products:[],stores:[],user:null};
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 }});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 try {
  const initial=await fetch(base+'/api/state');let state=await initial.json(),cookie=initial.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  for(const route of ['login','reauth']){
   calls.length=0;
   const r=await fetch(base+'/api/auth/'+route,{method:'POST',headers:{Origin:origin,'X-CSRF-Token':state.csrf,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:value})});
   assert.equal(r.status,200);assert.equal(JSON.parse(calls.find(c=>c.url.includes('grant_type=password')).init.body).password,value);
   const body=await r.json();cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
   if(body.csrf)state=body;
  }
 }finally{await app.close();}
});
