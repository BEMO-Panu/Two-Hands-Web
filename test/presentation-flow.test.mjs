import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPresentationApplication} from '../server/presentation-app.js';
const origin='http://localhost:4173';
async function setup(fn){
 const dir=mkdtempSync(path.join(tmpdir(),'twohands-demo-flow-'));let now=Date.now();
 const demo=createPresentationApplication({origin,databasePath:path.join(dir,'demo.sqlite'),clock:()=>now});
 const server=createServer((req,res)=>demo.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function browser(){let cookie='',csrf='';return {async req(route,method='GET',body){const r=await fetch(base+'/api/demo'+route,{method,headers:{Cookie:cookie,...(method==='GET'?{}:{Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'})},body:method==='GET'?undefined:JSON.stringify(body||{})});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');const data=await r.json();if(data.csrf)csrf=data.csrf;return {status:r.status,data};}};}
 try{await fn({browser,advance:ms=>{now+=ms;}});}finally{await new Promise(r=>server.close(r));demo.close();rmSync(dir,{recursive:true,force:true});}
}
const key=()=>crypto.randomUUID();
async function order(a){const initial=await a.req('/state');const p=initial.data.products[0];assert.equal((await a.req('/cart/'+p.id,'PUT')).status,200);const r=await a.req('/orders','POST',{requestKey:key()});assert.equal(r.status,201);return {id:r.data.orderId,price:p.price,product:p.id};}
test('Classroom demo handles decline, retry, receipt, seller preparation and buyer completion',()=>setup(async({browser})=>{
 const a=await browser(),o=await order(a),pay={method:'qr_demo',outcome:'declined',requestKey:key()};
 let r=await a.req('/orders/'+o.id+'/pay','POST',pay);assert.equal(r.status,200);assert.equal(r.data.orders[0].status,'awaiting_payment');assert.equal(r.data.receipts.length,0);
 assert.equal((await a.req('/orders/'+o.id+'/fulfill','POST',{status:'ready'})).status,403);
 const success={method:'card_demo',outcome:'success',requestKey:key()};r=await a.req('/orders/'+o.id+'/pay','POST',success);assert.equal(r.status,200);assert.equal(r.data.orders[0].status,'paid_demo');assert.equal(r.data.receipts[0].total,o.price);assert.equal(r.data.receipts[0].demo,true);
 r=await a.req('/orders/'+o.id+'/pay','POST',success);assert.equal(r.status,200);assert.equal(r.data.receipts.length,1);assert.equal(r.data.paymentAttempts.length,2);
 assert.equal((await a.req('/orders/'+o.id+'/cancel','POST')).status,409);
 assert.equal((await a.req('/orders/'+o.id+'/receive','POST')).status,409);
 await a.req('/role','POST',{role:'seller'});assert.equal((await a.req('/orders/'+o.id+'/fulfill','POST',{status:'ready'})).status,409);
 assert.equal((await a.req('/orders/'+o.id+'/fulfill','POST',{status:'preparing'})).status,200);
 assert.equal((await a.req('/orders/'+o.id+'/fulfill','POST',{status:'ready'})).status,200);
 await a.req('/role','POST',{role:'buyer'});r=await a.req('/orders/'+o.id+'/receive','POST');assert.equal(r.status,200);assert.equal(r.data.orders[0].status,'completed');assert.equal(r.data.products.find(p=>p.id===o.product).status,'sold');
 assert.equal((await a.req('/cart/'+o.product,'PUT')).status,409);
}));
test('Demo payments reject forged totals and sensitive fields, isolate browsers and serialize duplicate successes',()=>setup(async({browser})=>{
 const a=await browser(),b=await browser(),o=await order(a);await b.req('/state');
 const payment={method:'qr_demo',outcome:'success',requestKey:key()};
 assert.equal((await b.req('/orders/'+o.id+'/pay','POST',payment)).status,404);
 for(const extra of [{amount:1},{cardNumber:'not-a-real-card'},{cvv:'dummy'},{account:'dummy'}])assert.equal((await a.req('/orders/'+o.id+'/pay','POST',{...payment,...extra})).status,400);
 const results=await Promise.all([a.req('/orders/'+o.id+'/pay','POST',{...payment,requestKey:key()}),a.req('/orders/'+o.id+'/pay','POST',{...payment,requestKey:key()})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const state=(await a.req('/state')).data;assert.equal(state.receipts.length,1);assert.equal(state.receipts[0].total,o.price);assert.equal((await b.req('/state')).data.orders.length,0);
}));
test('Reset and expiry safely clear only the demo session even when it contains paid orders',()=>setup(async({browser,advance})=>{
 const a=await browser(),b=await browser(),o=await order(a);await b.req('/state');
 await a.req('/orders/'+o.id+'/pay','POST',{method:'qr_demo',outcome:'success',requestKey:key()});
 let r=await a.req('/reset','POST');assert.equal(r.status,200);assert.equal(r.data.orders.length,0);assert.equal(r.data.receipts.length,0);assert.equal(r.data.products.length,16);
 const again=await order(a);await a.req('/orders/'+again.id+'/pay','POST',{method:'qr_demo',outcome:'success',requestKey:key()});advance(86400001);
 r=await a.req('/state');assert.equal(r.status,200);assert.equal(r.data.orders.length,0);assert.equal(r.data.receipts.length,0);
 assert.equal((await b.req('/state')).status,200);
}));

test('Seller can soft-delete and restore own demo listings, but cannot delete another browser or reserved items',()=>setup(async({browser})=>{
 const a=await browser(),b=await browser();let initial=(await a.req('/state')).data;await b.req('/state');
 await a.req('/role','POST',{role:'seller'});
 let r=await a.req('/products','POST',{title:'รายการสำหรับลบทดสอบ',description:'รายละเอียดสินค้าสำหรับทดสอบการลบและกู้คืน',category:'home',condition:'สภาพดี',location:'กรุงเทพฯ',price:450,image:'lamp'});assert.equal(r.status,201);
 const p=r.data.products.find(p=>p.title==='รายการสำหรับลบทดสอบ');
 await b.req('/role','POST',{role:'seller'});assert.equal((await b.req('/products/'+p.id,'DELETE')).status,404);
 await a.req('/role','POST',{role:'buyer'});assert.equal((await a.req('/cart/'+p.id,'PUT')).status,200);assert.equal((await a.req('/products/'+p.id,'DELETE')).status,403);
 await a.req('/role','POST',{role:'seller'});r=await a.req('/products/'+p.id,'DELETE');assert.equal(r.status,200);assert.ok(!r.data.products.some(x=>x.id===p.id));assert.ok(r.data.deletedProducts.some(x=>x.id===p.id));assert.ok(!r.data.cart.includes(p.id));
 await a.req('/role','POST',{role:'buyer'});assert.equal((await a.req('/cart/'+p.id,'PUT')).status,404);
 await a.req('/role','POST',{role:'seller'});r=await a.req('/products/'+p.id+'/restore','POST');assert.equal(r.status,200);assert.ok(r.data.products.some(x=>x.id===p.id));assert.ok(!r.data.deletedProducts.some(x=>x.id===p.id));
 await a.req('/role','POST',{role:'buyer'});await a.req('/cart/'+p.id,'PUT');r=await a.req('/orders','POST',{requestKey:key()});assert.equal(r.status,201);
 await a.req('/role','POST',{role:'seller'});assert.equal((await a.req('/products/'+p.id,'DELETE')).status,409);
}));
