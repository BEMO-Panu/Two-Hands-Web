// Isolated classroom simulation. This module never calls Supabase, payment
// providers, the live database, or any real account/order implementation.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {demoProducts,demoStores,images,categories} from './demo-data.js';
import {randomToken,hash,secureEqual,HttpError,fail,string,integer,choice} from './security.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DAY=86400000;
const validate=(body,keys)=>{if(Object.keys(body).some(k=>!keys.includes(k)))fail(400,'ส่งเฉพาะข้อมูลเดโมที่กำหนด ห้ามส่งข้อมูลบัตรหรือบัญชีจริง');return body;};
const requestKey=value=>string(value,'requestKey',{min:10,max:100});
export function createPresentationApplication({origin='http://localhost:4173',production=false,databasePath=path.join(root,'.local','presentation.sqlite'),clock=Date.now}={}){
 if(new URL(origin).origin!==origin||production&&new URL(origin).protocol!=='https:')throw new Error('Demo origin must be an exact origin; production requires HTTPS');
 if(databasePath!==':memory:')mkdirSync(path.dirname(databasePath),{recursive:true,mode:0o700});
 const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');if(databasePath!==':memory:')chmodSync(databasePath,0o600);
 db.exec(`CREATE TABLE IF NOT EXISTS demo_sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('buyer','seller')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS demo_products(session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,price INTEGER NOT NULL CHECK(price BETWEEN 1 AND 10000000),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reserved','sold')),PRIMARY KEY(session_id,id));
 CREATE TABLE IF NOT EXISTS demo_cart(session_id TEXT NOT NULL,product_id TEXT NOT NULL,PRIMARY KEY(session_id,product_id),FOREIGN KEY(session_id,product_id) REFERENCES demo_products(session_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS demo_orders(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN ('awaiting_payment','paid_demo','preparing','ready','completed','cancelled')),total INTEGER NOT NULL CHECK(total>0),items TEXT NOT NULL,request_key TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(session_id,request_key));
 CREATE TABLE IF NOT EXISTS demo_payments(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,order_id TEXT NOT NULL REFERENCES demo_orders(id),total INTEGER NOT NULL,method TEXT NOT NULL CHECK(method IN ('qr_demo','card_demo')),outcome TEXT NOT NULL CHECK(outcome IN ('success','declined')),request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(session_id,request_key));
 CREATE TABLE IF NOT EXISTS demo_receipts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,order_id TEXT NOT NULL UNIQUE REFERENCES demo_orders(id),total INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'THB',method TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS demo_receipts_immutable BEFORE UPDATE ON demo_receipts BEGIN SELECT RAISE(ABORT,'Demo receipts are immutable');END;
 CREATE TRIGGER IF NOT EXISTS demo_payments_immutable BEFORE UPDATE ON demo_payments BEGIN SELECT RAISE(ABORT,'Demo payment attempts are immutable');END;
 CREATE TABLE IF NOT EXISTS demo_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
 if(!db.prepare('PRAGMA table_info(demo_products)').all().some(c=>c.name==='deleted_at'))db.exec('ALTER TABLE demo_products ADD COLUMN deleted_at INTEGER');
 const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 const limit=(key,max,window)=>{const row=one('SELECT * FROM demo_limits WHERE key=?',key),now=clock();if(row&&row.expires_at>now&&row.count>=max)fail(429,'ลองบ่อยเกินไป กรุณารอสักครู่');run('INSERT INTO demo_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END',key,now+window,now,now);};
 const setCookie=(res,token)=>res.setHeader('Set-Cookie',`th_demo=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${production?'; Secure':''}`);
 // Explicit child-first cleanup also supports an existing demo database whose
 // order references were created without cascading foreign keys.
 function purgeSession(id){run('DELETE FROM demo_receipts WHERE session_id=?',id);run('DELETE FROM demo_payments WHERE session_id=?',id);run('DELETE FROM demo_orders WHERE session_id=?',id);run('DELETE FROM demo_sessions WHERE id=?',id);}
 function createSession(res){
  transaction(()=>{for(const row of all('SELECT id FROM demo_sessions WHERE expires_at<=?',clock()))purgeSession(row.id);});run('DELETE FROM demo_limits WHERE expires_at<=?',clock());
  if(one('SELECT count(*) AS n FROM demo_sessions').n>=1000)fail(503,'พื้นที่สาธิตเต็ม กรุณาลองภายหลัง');
  const token=randomToken(),id=hash(token),csrf=randomToken(),now=clock();
  transaction(()=>{run('INSERT INTO demo_sessions(id,csrf,role,created_at,expires_at) VALUES(?,?,?,?,?)',id,csrf,'buyer',now,now+DAY);
   for(const p of demoProducts){const {hours,...rest}=p;const data={...rest,mode:'fixed',description:'รายการสาธิตการซื้อแบบราคาคงที่ ไม่รับเงินจริง — '+p.description,endsAt:null,step:50,bids:0,createdAt:now,isDemo:true};run('INSERT INTO demo_products(session_id,id,data,price) VALUES(?,?,?,?)',id,p.id,JSON.stringify(data),p.price);}});
  setCookie(res,token);return one('SELECT * FROM demo_sessions WHERE id=?',id);
 }
 function session(req,res){const cookie=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('th_demo='));const token=cookie?.slice(8);return token&&token.length<=100&&one('SELECT * FROM demo_sessions WHERE id=? AND expires_at>? AND revoked=0',hash(token),clock())||createSession(res);}
 function requireRole(s,role){if(s.role!==role)fail(403,`กรุณาเปลี่ยนเป็นบทบาท${role==='buyer'?'ผู้ซื้อ':'ผู้ขาย'}ในโหมดเดโม`);}
 function ownOrder(s,id){const o=one('SELECT * FROM demo_orders WHERE id=? AND session_id=?',id,s.id);if(!o)fail(404,'ไม่พบคำสั่งซื้อเดโม');return o;}
 function snapshot(s){
  s=one('SELECT * FROM demo_sessions WHERE id=?',s.id);
  const orders=all('SELECT * FROM demo_orders WHERE session_id=? ORDER BY created_at DESC,id',s.id).map(o=>({id:o.id,status:o.status,total:o.total,items:JSON.parse(o.items),at:o.created_at,updatedAt:o.updated_at,receiptId:one('SELECT id FROM demo_receipts WHERE order_id=? AND session_id=?',o.id,s.id)?.id||null}));
  return {demo:true,notice:'โหมดสาธิตสำหรับนำเสนอ ไม่มีการชำระเงินจริง',csrf:s.csrf,role:s.role,serverTime:clock(),images,categories,products:all('SELECT * FROM demo_products WHERE session_id=? AND deleted_at IS NULL ORDER BY rowid',s.id).map(p=>({...JSON.parse(p.data),price:p.price,status:p.status,isDemo:true})),deletedProducts:all('SELECT * FROM demo_products WHERE session_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',s.id).map(p=>({...JSON.parse(p.data),price:p.price,status:p.status,deletedAt:p.deleted_at,isDemo:true})),stores:demoStores.map(shop=>({...shop,isDemo:true})),cart:all('SELECT product_id FROM demo_cart WHERE session_id=? ORDER BY product_id',s.id).map(x=>x.product_id),orders,sales:orders,receipts:all('SELECT * FROM demo_receipts WHERE session_id=? ORDER BY created_at DESC,id',s.id).map(r=>({id:r.id,orderId:r.order_id,total:r.total,currency:r.currency,method:r.method,at:r.created_at,demo:true})),paymentAttempts:all('SELECT * FROM demo_payments WHERE session_id=? ORDER BY created_at DESC,id',s.id).map(p=>({id:p.id,orderId:p.order_id,total:p.total,method:p.method,outcome:p.outcome,at:p.created_at,demo:true}))};
 }
 async function body(req){let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)fail(413,'ข้อมูลเดโมใหญ่เกินไป');chunks.push(chunk);}if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(415,'ต้องส่ง JSON');try{const result=JSON.parse(Buffer.concat(chunks).toString());if(!result||Array.isArray(result)||typeof result!=='object')throw Error();return result;}catch{fail(400,'JSON ไม่ถูกต้อง');}}
 function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
 async function handle(req,res){
  let route;try{route=new URL(req.url,origin).pathname;}catch{return false;}
  if(!route.startsWith('/api/demo/'))return false;
  try{
   const write=!['GET','HEAD'].includes(req.method),s=session(req,res);limit('all:'+s.id,300,60000);
   if(write){if(req.headers.origin!==origin||!secureEqual(req.headers['x-csrf-token'],s.csrf))fail(403,'คำขอเดโมไม่ผ่าน CSRF กรุณารีเฟรช');limit('write:'+s.id,100,60000);}
   if(route==='/api/demo/state'&&req.method==='GET'){json(res,snapshot(s));return true;}
   if(route==='/api/demo/role'&&req.method==='POST'){const b=validate(await body(req),['role']);const role=choice(b.role,['buyer','seller'],'บทบาท');run('UPDATE demo_sessions SET role=? WHERE id=?',role,s.id);json(res,snapshot(s));return true;}
   if(route==='/api/demo/reset'&&req.method==='POST'){validate(await body(req),[]);limit('reset-ip:'+hash(req.socket.remoteAddress||'unknown'),30,60000);transaction(()=>purgeSession(s.id));json(res,snapshot(createSession(res)));return true;}
   if(/^\/api\/demo\/cart\/[^/]+$/.test(route)&&['PUT','DELETE'].includes(req.method)){
    requireRole(s,'buyer');if(req.headers['transfer-encoding']||Number(req.headers['content-length'])>0)validate(await body(req),[]);
    const id=decodeURIComponent(route.split('/')[4]),p=one('SELECT * FROM demo_products WHERE session_id=? AND id=?',s.id,id);if(!p||p.deleted_at!==null)fail(404,'ไม่พบสินค้าเดโม');
    if(req.method==='PUT'){if(p.status!=='active'||JSON.parse(p.data).mode!=='fixed')fail(409,'สินค้านี้เพิ่มตะกร้าเดโมไม่ได้');if(one('SELECT count(*) AS n FROM demo_cart WHERE session_id=?',s.id).n>=20)fail(409,'ตะกร้าเดโมใส่ได้ไม่เกิน 20 ชิ้น');run('INSERT OR IGNORE INTO demo_cart VALUES(?,?)',s.id,id);}else run('DELETE FROM demo_cart WHERE session_id=? AND product_id=?',s.id,id);
    json(res,snapshot(s));return true;
   }
   if(/^\/api\/demo\/products\/[^/]+(?:\/restore)?$/.test(route)&&['DELETE','POST'].includes(req.method)){
    requireRole(s,'seller');validate(await body(req),[]);
    const id=decodeURIComponent(route.split('/')[4]),restore=route.endsWith('/restore');
    if((restore&&req.method!=='POST')||(!restore&&req.method!=='DELETE'))fail(405,'วิธีทำรายการไม่ถูกต้อง');
    transaction(()=>{
     const p=one('SELECT * FROM demo_products WHERE session_id=? AND id=?',s.id,id);if(!p)fail(404,'ไม่พบสินค้าของร้านสาธิตนี้');
     if(p.status!=='active')fail(409,'ลบได้เฉพาะสินค้าที่ยังไม่ถูกจองหรือขาย');
     run('UPDATE demo_products SET deleted_at=? WHERE session_id=? AND id=?',restore?null:clock(),s.id,id);
     if(!restore)run('DELETE FROM demo_cart WHERE session_id=? AND product_id=?',s.id,id);
    });json(res,snapshot(s));return true;
   }
   if(route==='/api/demo/products'&&req.method==='POST'){
    requireRole(s,'seller');const b=validate(await body(req),['title','description','category','condition','location','price','image']);if(one('SELECT count(*) AS n FROM demo_products WHERE session_id=?',s.id).n>=200)fail(409,'สินค้าเดโมเต็ม');
    const id=randomUUID(),title=string(b.title,'ชื่อสินค้า',{max:90}),description=string(b.description,'รายละเอียด',{min:10,max:1500}),category=choice(b.category,categories.filter(c=>c.id!=='all').map(c=>c.id),'หมวดหมู่'),condition=choice(b.condition,['เหมือนใหม่','สภาพดีมาก','สภาพดี','มีตำหนิ'],'สภาพ'),location=string(b.location,'พื้นที่',{max:120}),price=integer(b.price,'ราคา',1,10000000),image=choice(b.image,Object.keys(images),'ภาพตัวอย่าง');
    run('INSERT INTO demo_products(session_id,id,data,price) VALUES(?,?,?,?)',s.id,id,JSON.stringify({id,title,description,category,condition,location,image,store:'room',mode:'fixed',step:50,bids:0,endsAt:null,createdAt:clock(),isDemo:true}),price);json(res,snapshot(s),201);return true;
   }
   if(route==='/api/demo/orders'&&req.method==='POST'){
    requireRole(s,'buyer');const b=validate(await body(req),['requestKey']),key=requestKey(b.requestKey);let orderId;
    transaction(()=>{const previous=one('SELECT id FROM demo_orders WHERE session_id=? AND request_key=?',s.id,key);if(previous){orderId=previous.id;return;}
     if(one('SELECT count(*) AS n FROM demo_orders WHERE session_id=?',s.id).n>=200)fail(409,'จำนวนคำสั่งซื้อเดโมเต็ม');
     const products=all('SELECT p.* FROM demo_cart c JOIN demo_products p ON p.session_id=c.session_id AND p.id=c.product_id WHERE c.session_id=? ORDER BY p.id',s.id);if(!products.length||products.some(p=>p.deleted_at!==null||p.status!=='active'||JSON.parse(p.data).mode!=='fixed'))fail(409,'เลือกสินค้าเดโมที่พร้อมขายก่อน');
     const items=products.map(p=>{const data=JSON.parse(p.data);return {id:p.id,title:data.title,price:p.price,image:data.image,store:data.store};}),total=items.reduce((sum,item)=>sum+item.price,0);orderId=randomUUID();
     run('INSERT INTO demo_orders VALUES(?,?,?,?,?,?,?,?)',orderId,s.id,'awaiting_payment',total,JSON.stringify(items),key,clock(),clock());
     for(const p of products)run("UPDATE demo_products SET status='reserved' WHERE session_id=? AND id=?",s.id,p.id);run('DELETE FROM demo_cart WHERE session_id=?',s.id);
    });json(res,{...snapshot(s),orderId},201);return true;
   }
   if(/^\/api\/demo\/orders\/[^/]+\/(pay|fulfill|receive|cancel)$/.test(route)&&req.method==='POST'){
    const id=route.split('/')[4],action=route.split('/')[5];requireRole(s,action==='fulfill'?'seller':'buyer');const b=await body(req);
    transaction(()=>{const o=ownOrder(s,id);
     if(action==='pay'){
      validate(b,['method','outcome','requestKey']);const method=choice(b.method,['qr_demo','card_demo'],'วิธีจ่ายจำลอง'),outcome=choice(b.outcome,['success','declined'],'ผลจำลอง'),key=requestKey(b.requestKey),fingerprint=hash(JSON.stringify({orderId:id,method,outcome}));
      const previous=one('SELECT * FROM demo_payments WHERE session_id=? AND request_key=?',s.id,key);if(previous){if(previous.payload_hash!==fingerprint)fail(409,'รหัสคำขอเดโมถูกใช้กับรายการอื่นแล้ว');return;}
      if(o.status!=='awaiting_payment')fail(409,'คำสั่งซื้อเดโมไม่อยู่ระหว่างรอจ่าย');if(one('SELECT count(*) AS n FROM demo_payments WHERE order_id=?',id).n>=20)fail(429,'ลองจ่ายเดโมบ่อยเกินไป');
      run('INSERT INTO demo_payments VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),s.id,id,o.total,method,outcome,key,fingerprint,clock());
      if(outcome==='success'){run("UPDATE demo_orders SET status='paid_demo',updated_at=? WHERE id=? AND session_id=?",clock(),id,s.id);run('INSERT INTO demo_receipts VALUES(?,?,?,?,?,?,?)',randomUUID(),s.id,id,o.total,'THB',method,clock());}
     }else if(action==='fulfill'){
      validate(b,['status']);const status=choice(b.status,['preparing','ready'],'สถานะจัดเตรียม');if(o.status===status)return;if(status==='preparing'&&o.status!=='paid_demo'||status==='ready'&&o.status!=='preparing')fail(409,'ลำดับเตรียมสินค้าเดโมไม่ถูกต้อง');run('UPDATE demo_orders SET status=?,updated_at=? WHERE id=? AND session_id=?',status,clock(),id,s.id);
     }else if(action==='receive'){
      validate(b,[]);if(o.status==='completed')return;if(o.status!=='ready')fail(409,'ผู้ขายเดโมยังไม่พร้อมส่งมอบ');run("UPDATE demo_orders SET status='completed',updated_at=? WHERE id=? AND session_id=?",clock(),id,s.id);for(const item of JSON.parse(o.items))run("UPDATE demo_products SET status='sold' WHERE session_id=? AND id=? AND status='reserved'",s.id,item.id);
     }else{
      validate(b,[]);if(o.status==='cancelled')return;if(o.status!=='awaiting_payment')fail(409,'ยกเลิกได้เฉพาะเดโมที่ยังไม่จ่าย');run("UPDATE demo_orders SET status='cancelled',updated_at=? WHERE id=? AND session_id=?",clock(),id,s.id);for(const item of JSON.parse(o.items))run("UPDATE demo_products SET status='active' WHERE session_id=? AND id=? AND status='reserved'",s.id,item.id);
     }
    });json(res,snapshot(s));return true;
   }
   fail(404,'ไม่พบ API เดโม');
  }catch(e){if(res.headersSent){res.end();return true;}if(e instanceof HttpError)json(res,{error:e.message,demo:true},e.status);else json(res,{error:'เกิดข้อผิดพลาดในโหมดเดโม',demo:true},500);return true;}
 }
 return {handle,close(){db.close();}};
}
