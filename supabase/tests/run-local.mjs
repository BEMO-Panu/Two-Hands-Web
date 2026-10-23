// Optional local execution: npm install --no-save @electric-sql/pglite in a temp
// folder, then set PGLITE_MODULE to its dist/index.js absolute file URL/path.
import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
async function applyPayments(target) {
 // Existing historical orders remain usable without retroactively requiring a
 // new demo charge; all subsequently inserted orders get the true default.
 await target.exec(`insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values('95000000-7a21-4000-8000-000000000001','migration-order@example.invalid',now(),'{}');
 insert into public.th_profiles(id,name) values('95000000-7a21-4000-8000-000000000001','Historical fixture');
 insert into public.th_orders(id,user_id,total,request_key,payload) values('95000000-7a21-4000-8000-000000000002','95000000-7a21-4000-8000-000000000001',100,'historical-migration-order-01','{}');`);
 await target.exec(await readFile(new URL('../migrations/202610210004_order_payments.sql',import.meta.url),'utf8'));
 const check=await target.query(`select payment_required from public.th_orders where id='95000000-7a21-4000-8000-000000000002'`);
 if(check.rows[0]?.payment_required!==false) throw Error('Historical order unexpectedly requires a demo payment');
 await target.exec(`delete from public.th_orders where id='95000000-7a21-4000-8000-000000000002';delete from public.th_profiles where id='95000000-7a21-4000-8000-000000000001';delete from auth.users where id='95000000-7a21-4000-8000-000000000001';`);
 await target.exec(await readFile(new URL('./order-payments.sql',import.meta.url),'utf8'));
 await target.exec(await readFile(new URL('../migrations/202610210005_sample_commerce.sql',import.meta.url),'utf8'));
 await target.exec(await readFile(new URL('./order-payments.sql',import.meta.url),'utf8'));
 await target.exec(await readFile(new URL('./sample-commerce.sql',import.meta.url),'utf8'));
 await target.exec(await readFile(new URL('../migrations/202610230006_sample_auctions.sql',import.meta.url),'utf8'));
 await target.exec(await readFile(new URL('./hosted-flow.sql',import.meta.url),'utf8'));
 await target.exec(await readFile(new URL('./order-payments.sql',import.meta.url),'utf8'));
 await target.exec(await readFile(new URL('./sample-auctions.sql',import.meta.url),'utf8'));
}
try {
 await db.exec(await readFile(new URL('./local-bootstrap.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../migrations/202610200001_marketplace.sql',import.meta.url),'utf8'));
 const catalog=await readFile(new URL('../migrations/202610200002_demo_catalog.sql',import.meta.url),'utf8');
 await db.exec(catalog);await db.exec(catalog); // Reapplication must not duplicate samples.
 await db.exec(await readFile(new URL('../migrations/202610200003_pickup_workflow.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('./demo-catalog.sql',import.meta.url),'utf8'));
 const result=await db.exec(await readFile(new URL('./security.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('./hosted-flow.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('./pickup-workflow.sql',import.meta.url),'utf8'));
 await applyPayments(db);
 // Older hosted installations used the former function name as a local
 // variable qualifier. Exercise additive upgrade against that stored source.
 const legacy=new PGlite();
 try {
  await legacy.exec(await readFile(new URL('./local-bootstrap.sql',import.meta.url),'utf8'));
  const original=(await readFile(new URL('../migrations/202610200001_marketplace.sql',import.meta.url),'utf8')).replace('<<rpc>>\n','').replaceAll('rpc.request_key','th_api.request_key');
  await legacy.exec(original);await legacy.exec(catalog);
  await legacy.exec(await readFile(new URL('../migrations/202610200003_pickup_workflow.sql',import.meta.url),'utf8'));
  await legacy.exec(await readFile(new URL('./hosted-flow.sql',import.meta.url),'utf8'));
  await legacy.exec(await readFile(new URL('./pickup-workflow.sql',import.meta.url),'utf8'));
  await applyPayments(legacy);
 } finally {await legacy.close();}
 console.log('PASS: shared sample auction competition, deadline winner, private order, payment and repeat rounds');
 console.log('PASS: authenticated sample catalog purchases, private cart/orders/receipts and simulated completion');
 console.log('PASS: simulated order payments, private receipts, retries, seller preparation and completed pickup');
 console.log('PASS: legacy stored dispatcher upgrade preserves bid/reserve and pickup workflow');
 console.log('PASS: pickup messaging, two-party handoffs, expiry, listing management and moderation');
 console.log('PASS: display-only demo catalog and real seller/buyer workflow after additive migration');
 console.log('PASS: embedded PostgreSQL migration + transactional RPC/RLS security assertions');
 console.log('This mocks Supabase auth/storage interfaces; hosted Auth/Storage delivery is not tested.');
} catch(error){console.error(error.code,error.message,error.where||'');process.exitCode=1;} finally {await db.close();}
