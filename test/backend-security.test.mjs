import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../server/app.js';
import {totp, hash, validateTrustedProxyIps, rateLimitAddress} from '../server/security.js';
const origin='http://localhost:4173',pw='a very long unique password!';
test('production configuration fails closed',()=>{
 assert.throws(()=>createApplication({production:true,origin}),/HTTPS/);
 assert.throws(()=>createApplication({production:true,origin:'https://example.com',seedDemo:true}),/demo/);
 assert.throws(()=>createApplication({production:true,origin:'https://example.com'}),/APP_KEY/);
 assert.throws(()=>createApplication({origin:origin+'/path'}),/origin/);
});
test('trusted proxy configuration and untrusted spoof handling',()=>{
 for(const value of ['127.0.0.1',['*'],['127.0.0.0/8'],[''],['127.0.0.1,::1'],['fe80::1%eth0']])assert.throws(()=>validateTrustedProxyIps(value),/TRUSTED_PROXY_IPS/);
 const req=(peer,headers)=>({socket:{remoteAddress:peer},headers});
 const trust=validateTrustedProxyIps(['172.29.81.2']);
 assert.equal(rateLimitAddress(req('172.29.81.2',{'x-real-ip':'203.0.113.9'}),trust),'203.0.113.9');
 assert.equal(rateLimitAddress(req('172.29.81.3',{'x-real-ip':'203.0.113.9'}),trust),'172.29.81.3');
 for(const value of ['203.0.113.9,203.0.113.10','invalid',' 203.0.113.9',['203.0.113.9'],'fe80::1%eth0'])assert.equal(rateLimitAddress(req('172.29.81.2',{'x-real-ip':value}),trust),'172.29.81.2');
 assert.equal(rateLimitAddress(req('172.29.81.2',{'x-forwarded-for':'203.0.113.9'}),trust),'172.29.81.2');
});
test('trusted proxy client buckets are separate; spoofed forwarding cannot bypass rate limit',async()=>{
 for(const trustedProxyIps of [[],['127.0.0.1']]){
  const dir=mkdtempSync(path.join(tmpdir(),'two-hands-proxy-'));
  const app=createApplication({databasePath:':memory:',dataDir:dir,seedDemo:false,trustedProxyIps,sendMail:async()=>{}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
   const limited=trustedProxyIps.length?'203.0.113.9':'127.0.0.1';
   app.db.prepare('INSERT INTO rate_limits VALUES(?,?,?)').run('all:'+hash(limited),300,Date.now()+60000);
   const request=headers=>fetch(base+'/api/health',{headers});
   assert.equal((await request({'X-Real-IP':'203.0.113.9'})).status,429);
   assert.equal((await request({'X-Real-IP':'203.0.113.10'})).status,trustedProxyIps.length?200:429);
   assert.equal((await request({'X-Forwarded-For':'203.0.113.10'})).status,trustedProxyIps.length?200:429);
   if(trustedProxyIps.length){app.db.prepare('INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)').run('all:'+hash('127.0.0.1'),300,Date.now()+60000);assert.equal((await request({'X-Real-IP':'bad,203.0.113.10','X-Forwarded-For':'203.0.113.10'})).status,429);}
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
 }
});
test('persistent database authentication and marketplace security',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'two-hands-test-')),messages=[];let now=Date.now();
 const opts={databasePath:path.join(dir,'db.sqlite'),dataDir:dir,origin,seedDemo:false,clock:()=>now,sendMail:async m=>messages.push(m)};
 let app=createApplication(opts);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 let base=`http://127.0.0.1:${app.server.address().port}`;
 const client=()=>({cookie:'',csrf:'',async req(url,method='GET',data,headers={}){const r=await fetch(base+url,{method,headers:{Cookie:this.cookie,Origin:origin,'X-CSRF-Token':this.csrf,...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},body:data===undefined?undefined:JSON.stringify(data)});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];const body=await r.json();if(body.csrf)this.csrf=body.csrf;return {status:r.status,body,headers:r.headers};}});
 async function register(c,mail){await c.req('/api/state');const r=await c.req('/api/auth/register','POST',{email:mail,name:'Test user',password:pw,role:'admin',emailVerified:true});assert.equal(r.status,201);return r.body;}
 async function verify(c,mail){const m=messages.findLast(x=>x.to===mail&&x.kind==='verify');assert.ok(m);return c.req('/api/auth/verify','POST',{token:m.url.split('=')[1]});}
 const seller=client(),buyer=client(),other=client(),admin=client();let sellState,buyState,otherState,adminState;
 try {
 await t.test('unauthenticated and cross-origin requests rejected; no default accounts',async()=>{
  const health=await buyer.req('/api/health');assert.equal(health.status,200);assert.equal(health.headers.get('set-cookie'),null);
  const r=await buyer.req('/api/state');assert.equal(r.body.user,null);assert.equal(r.body.products.length,0);
  assert.equal((await buyer.req('/api/profile','PATCH',{name:'n',shop:'s'})).status,401);
  assert.equal((await buyer.req('/api/auth/register','POST',{},{Origin:'https://evil.example'})).status,403);
  assert.equal((await buyer.req('/api/auth/register','POST',{}, {'X-CSRF-Token':'bad'})).status,403);
  assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
 });
 await t.test('register ignores privilege fields and requires email verification',async()=>{
  sellState=await register(seller,'seller@example.com');buyState=await register(buyer,'buyer@example.com');otherState=await register(other,'other@example.com');adminState=await register(admin,'admin@example.com');
  assert.equal(sellState.user.role,'user');assert.equal(sellState.user.emailVerified,false);
  assert.equal((await seller.req('/api/verification','POST',{name:'Shop',location:'Bangkok',bio:'This private verification reference should stay private'})).status,403);
  for(const [c,m] of [[seller,'seller'],[buyer,'buyer'],[other,'other'],[admin,'admin']])assert.equal((await verify(c,m+'@example.com')).status,200);
 });
 await t.test('private store review, ownership, and admin self approval',async()=>{
  const details='PRIVATE evidence reviewed offline by an authorized human';
  assert.equal((await seller.req('/api/verification','POST',{name:'Shop',location:'Bangkok',bio:details,status:'verified'})).status,200);
  let state=(await other.req('/api/state')).body;assert.equal(state.stores.find(s=>s.id===sellState.profile.shopId).verified,false);assert.ok(!JSON.stringify(state).includes(details));
  assert.equal((await other.req('/api/admin/requests')).status,403);
  app.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminState.user.id);
  assert.equal((await admin.req('/api/admin/requests')).body.requests[0].details,details);
  assert.equal((await admin.req(`/api/admin/shops/${sellState.profile.shopId}/review`,'POST',{status:'verified',note:'Checked public business references in person'})).status,200);
  await admin.req('/api/verification','POST',{name:'Admin shop',location:'Bangkok',bio:details});
  assert.equal((await admin.req(`/api/admin/shops/${adminState.profile.shopId}/review`,'POST',{status:'verified',note:'Checked public business references in person'})).status,403);
 });
 let fixed,auction;
 await t.test('uploaded images required and seller permission enforced',async()=>{
  const bad=await fetch(base+'/api/uploads',{method:'POST',headers:{Cookie:seller.cookie,Origin:origin,'X-CSRF-Token':seller.csrf},body:'<svg onload="alert(1)">'});assert.equal(bad.status,400);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const r=await fetch(base+'/api/uploads',{method:'POST',headers:{Cookie:seller.cookie,Origin:origin,'X-CSRF-Token':seller.csrf},body:png});assert.equal(r.status,201);const {image}=await r.json();
  const item={title:"A lamp '); DROP TABLE users; --",description:'A real item with sufficient description',category:'home',condition:'สภาพดี',location:'Bangkok',price:100,image,mode:'fixed'};
  assert.equal((await other.req('/api/products','POST',item)).status,403);
  let result=await seller.req('/api/products','POST',item);assert.equal(result.status,201);fixed=result.body.products.find(p=>p.mode==='fixed').id;
  result=await seller.req('/api/products','POST',{...item,title:'Auction',mode:'auction',step:10,hours:1});assert.equal(result.status,201);auction=result.body.products.find(p=>p.mode==='auction').id;
  assert.equal((await buyer.req('/api/state')).body.products.length,2);
 });
 await t.test('checkout atomicity, retry idempotency and ownership',async()=>{
  const payload={productIds:[fixed],delivery:'pickup',requestKey:randomUUID()};
  assert.equal((await buyer.req('/api/orders','POST',{...payload,requestKey:'auction-'+auction})).status,400);
  assert.equal((await seller.req('/api/orders','POST',payload)).status,409);
  const results=await Promise.all([buyer.req('/api/orders','POST',payload),buyer.req('/api/orders','POST',payload)]);assert.deepEqual(results.map(x=>x.status),[201,201]);assert.equal(results[0].body.orderId,results[1].body.orderId);
  assert.equal((await other.req('/api/orders','POST',{...payload,requestKey:randomUUID()})).status,409);
  const id=results[0].body.orderId;assert.equal((await other.req(`/api/orders/${id}/cancel`,'POST',{})).status,404);
  assert.equal((await buyer.req('/api/orders','POST',{...payload,delivery:'shipping',address:'A complete postal delivery address'})).status,409);
  assert.equal((await buyer.req(`/api/orders/${id}/cancel`,'POST',{})).status,200);
  const competitors=await Promise.all([buyer.req('/api/orders','POST',{...payload,requestKey:randomUUID()}),other.req('/api/orders','POST',{...payload,requestKey:randomUUID()})]);assert.deepEqual(competitors.map(x=>x.status).sort(),[201,409]);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='awaiting_payment'").get().n,1);
 });
 await t.test('sales expose only own shop items, and release shipping address only after payment',async()=>{
  assert.equal((await client().req('/api/sales')).status,401);
  assert.equal((await other.req('/api/sales')).status,403);
  app.db.prepare("UPDATE shops SET status='verified' WHERE id=?").run(adminState.profile.shopId);
  const first=randomUUID(),second=randomUUID();
  for(const [id,shop,price,title] of [[first,sellState.profile.shopId,100,'Seller lamp'],[second,adminState.profile.shopId,333,'Another shop private product']])app.db.prepare("INSERT INTO products(id,shop_id,title,description,category,condition,location,image,price,mode,created_at) SELECT ?,?,?,description,category,condition,location,image,?,'fixed',created_at FROM products WHERE id=?").run(id,shop,title,price,fixed);
  const address='Sensitive home address for fulfilled shipping only';
  const result=await buyer.req('/api/orders','POST',{productIds:[first,second],delivery:'shipping',address,requestKey:randomUUID()});assert.equal(result.status,201);const id=result.body.orderId;
  let own=(await seller.req('/api/sales')).body.sales.find(sale=>sale.id===id);
  assert.equal(own.subtotal,100);assert.deepEqual(own.items.map(item=>item.id),[first]);assert.equal(own.address,null);assert.equal(own.buyerName,'Test user');assert.ok(!JSON.stringify(own).includes('buyer@example.com'));assert.ok(!JSON.stringify(own).includes('Another shop private product'));
  const theirs=(await admin.req('/api/sales')).body.sales.find(sale=>sale.id===id);assert.equal(theirs.subtotal,333);assert.deepEqual(theirs.items.map(item=>item.id),[second]);assert.equal(theirs.address,null);
  app.db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(id);
  own=(await seller.req('/api/sales')).body.sales.find(sale=>sale.id===id);assert.equal(own.address,address);
  app.db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(id);assert.equal((await seller.req('/api/sales')).body.sales.find(sale=>sale.id===id).address,null);
 });
 await t.test('concurrent bids cannot accept identical highest prices and retries are safe',async()=>{
  const a={amount:110,requestKey:randomUUID()},b={amount:110,requestKey:randomUUID()};
  assert.equal((await seller.req(`/api/products/${auction}/bids`,'POST',a)).status,403);
  const results=await Promise.all([buyer.req(`/api/products/${auction}/bids`,'POST',a),other.req(`/api/products/${auction}/bids`,'POST',b)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  const winner=results[0].status===200?buyer:other,payload=results[0].status===200?a:b;
  assert.equal((await winner.req(`/api/products/${auction}/bids`,'POST',payload)).status,200);assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM bids').get().n,1);
  now+=3600001;await winner.req('/api/state');assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key=?').get('auction-'+auction).n,1);
 });
 await t.test('password reset revokes all sessions and token cannot be reused',async()=>{
  // The fake clock advanced past idle expiry; sign in again.
  await buyer.req('/api/state');assert.equal((await buyer.req('/api/auth/login','POST',{email:'buyer@example.com',password:pw})).status,200);
  const extra=client();await extra.req('/api/state');await extra.req('/api/auth/login','POST',{email:'buyer@example.com',password:pw});
  await buyer.req('/api/auth/forgot','POST',{email:'buyer@example.com'});const token=messages.findLast(x=>x.kind==='reset').url.split('=')[1];
  assert.equal((await buyer.req('/api/auth/reset','POST',{token,password:pw+' changed'})).status,200);
  assert.equal((await extra.req('/api/state')).body.user,null);assert.equal((await buyer.req('/api/auth/reset','POST',{token,password:pw})).status,400);
  assert.equal((await buyer.req('/api/auth/login','POST',{email:'buyer@example.com',password:pw})).status,401);
  assert.equal((await buyer.req('/api/auth/login','POST',{email:'buyer@example.com',password:pw+' changed'})).status,200);
 });
 await t.test('2FA is encrypted, resists replay, recovery codes single use',async()=>{
  const setup=await buyer.req('/api/auth/mfa/setup','POST',{});assert.equal(setup.status,200);const secret=setup.body.secret,code=totp(secret,Math.floor(now/30000));
  const enabled=await buyer.req('/api/auth/mfa/enable','POST',{code});assert.equal(enabled.status,200);assert.equal(enabled.body.recoveryCodes.length,8);assert.ok(!app.db.prepare('SELECT mfa_secret FROM users WHERE id=?').get(buyState.user.id).mfa_secret.includes(secret));
  await buyer.req('/api/auth/logout','POST',{});assert.equal((await buyer.req('/api/auth/login','POST',{email:'buyer@example.com',password:pw+' changed',code})).status,401);
  const recovery=enabled.body.recoveryCodes[0];assert.equal((await buyer.req('/api/auth/login','POST',{email:'buyer@example.com',password:pw+' changed',code:recovery})).status,200);
  await buyer.req('/api/auth/logout','POST',{});assert.equal((await buyer.req('/api/auth/login','POST',{email:'buyer@example.com',password:pw+' changed',code:recovery})).status,401);
 });
 await t.test('database and sessions survive server restart',async()=>{
  await app.close();app=createApplication(opts);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,4);assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM bids').get().n,1);
 });
 } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
