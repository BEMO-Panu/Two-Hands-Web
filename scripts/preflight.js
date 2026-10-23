import {createSupabaseClient} from '../server/supabase-client.js';
const local=process.argv.includes('--local');
try{
 if(process.env.DATA_PROVIDER!=='supabase')throw Error('Set DATA_PROVIDER=supabase');
 if(!/^[a-f0-9]{64}$/i.test(process.env.APP_KEY||''))throw Error('APP_KEY must be a stable 64-character hex secret');
 const origin=new URL(process.env.APP_ORIGIN);
 if(origin.origin!==process.env.APP_ORIGIN||origin.username||origin.password)throw Error('APP_ORIGIN must be an exact origin without path');
 if(!local&&(process.env.NODE_ENV!=='production'||origin.protocol!=='https:'))throw Error('Production requires NODE_ENV=production and an HTTPS APP_ORIGIN');
 if(local&&!['localhost','127.0.0.1','[::1]'].includes(origin.hostname))throw Error('--local is for loopback origins only');
 const client=createSupabaseClient({url:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY});
 const data=await client.rpc('snapshot');
 if(data.pickupWorkflow!==true)throw Error('Apply all Supabase migrations, including pickup_workflow, before launch');
 if(data.orderPayments!==true)throw Error('Apply 202610210004_order_payments.sql before using integrated checkout');
 if(data.sampleCommerce!==true)throw Error('Apply 202610210005_sample_commerce.sql to enable sample purchases');
 if(data.sampleAuctions!==true)throw Error('Apply 202610230006_sample_auctions.sql to enable main storefront sample auctions');
 console.log('PASS: environment shape and live Supabase pickup/payment/sample auction schema');
 console.log(`Catalog: ${data.products.filter(p=>!p.isDemo).length} real listings, ${data.products.filter(p=>p.isDemo).length} sample listings`);
 console.log('Manual checks still required: SMTP email delivery, admin MFA, two-account browser trial, public HTTPS and backup restore.');
}catch(e){console.error('Preflight failed:',e.code||e.message);process.exitCode=1;}
