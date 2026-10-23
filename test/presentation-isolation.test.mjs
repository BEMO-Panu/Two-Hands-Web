import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApplication} from '../server/app.js';
import {createSupabaseApplication} from '../server/supabase-app.js';
import {createPresentationApplication} from '../server/presentation-app.js';
const origin='http://localhost:4173';
const supabaseOptions={url:'https://presentation-isolation-test.supabase.co',publishableKey:'sb_publishable_fake_only',origin,appKey:'bd'.repeat(32)};
const cookies=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function listen(app){await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});return `http://127.0.0.1:${app.server.address().port}`;}
async function demoExercise(base){
 const initial=await fetch(base+'/api/demo/state');assert.equal(initial.status,200);const state=await initial.json();
 assert.ok(typeof state.csrf==='string'&&state.csrf.length>=20);
 assert.ok(initial.headers.getSetCookie().length>0);for(const value of initial.headers.getSetCookie())assert.doesNotMatch(value,/th_supabase|th_session/);
 const headers={Origin:origin,Cookie:cookies(initial),'X-CSRF-Token':state.csrf,'Content-Type':'application/json'};
 const role=await fetch(base+'/api/demo/role',{method:'POST',headers,body:JSON.stringify({role:'seller'})});assert.equal(role.status,200);
 return cookies(role)||cookies(initial);
}

test('Presentation routes remain disabled unless explicitly mounted',async()=>{
 let upstreamCalls=0;
 const app=createSupabaseApplication({...supabaseOptions,fetchImpl:async()=>{upstreamCalls++;throw Error('Unexpected external request');}});const base=await listen(app);
 try{const r=await fetch(base+'/api/demo/state');assert.equal(r.status,404);assert.equal(upstreamCalls,0);}finally{await app.close();}
});

test('Mounted presentation roles and state never call Supabase or create real authentication',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'presentation-supabase-isolation-'));let upstreamCalls=0;
 const demo=createPresentationApplication({origin,databasePath:path.join(dir,'presentation.sqlite')});
 const app=createSupabaseApplication({...supabaseOptions,presentationHandler:demo.handle,fetchImpl:async()=>{upstreamCalls++;return new Response(JSON.stringify({products:[],stores:[],orders:[],user:null}),{headers:{'Content-Type':'application/json'}});}});
 try{
  const base=await listen(app),demoCookie=await demoExercise(base);assert.equal(upstreamCalls,0);
  const real=await fetch(base+'/api/state',{headers:{Cookie:demoCookie}});assert.equal(real.status,200);const state=await real.json();
  assert.equal(state.user,null);assert.deepEqual(state.orders,[]);assert.equal(upstreamCalls,1);
 }finally{await app.close();await demo.close();rmSync(dir,{recursive:true,force:true});}
});

test('Mounted presentation does not write accounts, sessions, products or orders into real SQLite',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'presentation-sqlite-isolation-'));
 const demo=createPresentationApplication({origin,databasePath:path.join(dir,'presentation.sqlite')});
 const app=createApplication({origin,seedDemo:false,dataDir:path.join(dir,'real'),databasePath:path.join(dir,'real.sqlite'),presentationHandler:demo.handle,sendMail:async()=>{throw Error('Demo must never send email');}});
 try{
  const base=await listen(app);await demoExercise(base);
  for(const table of ['users','sessions','shops','products','orders','order_items','bids'])assert.equal(app.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0,`Demo touched real ${table}`);
 }finally{await app.close();await demo.close();rmSync(dir,{recursive:true,force:true});}
});
