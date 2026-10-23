import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoStores, demoProducts } from './demo-data.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function openDatabase(filename,{seedDemo=false}={}) {
 if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
 const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 if(filename!==':memory:')chmodSync(filename,0o600);
 db.exec('CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
 for(const file of readdirSync(path.join(root,'migrations')).filter(n=>n.endsWith('.sql')).sort()){
  if(db.prepare('SELECT 1 FROM migrations WHERE name=?').get(file))continue;
  transaction(db,()=>{db.exec(readFileSync(path.join(root,'migrations',file),'utf8'));db.prepare('INSERT INTO migrations VALUES(?,?)').run(file,Date.now());});
 }
 if(seedDemo)transaction(db,()=>{
  for(const shop of demoStores){const user=`demo-${shop.id}`;db.prepare('INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,NULL,?)').run(user,`${shop.id}@example.invalid`,shop.name,Date.now());db.prepare('INSERT OR IGNORE INTO shops(id,user_id,name,location,bio,status,is_demo) VALUES(?,?,?,?,?,?,1)').run(shop.id,user,shop.name,shop.location,shop.bio,'none');}
  for(const p of demoProducts)db.prepare('INSERT OR IGNORE INTO products(id,shop_id,title,description,category,condition,location,image,price,mode,bid_step,ends_at,created_at,is_demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)').run(p.id,p.store,p.title,p.description,p.category,p.condition,p.location,p.image,p.price,p.mode,p.step||50,p.mode==='auction'?Date.now()+p.hours*3600000:null,Date.now());
 });
 return db;
}
export function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
