import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const production=process.env.NODE_ENV==='production';
const provider=process.env.DATA_PROVIDER||'sqlite';
const port=Number(process.env.PORT||4173),host=process.env.HOST||'127.0.0.1';
if(!production&&!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Development mode may only bind to loopback; use NODE_ENV=production for public hosting');
if(!['sqlite','supabase'].includes(provider))throw Error('DATA_PROVIDER must be sqlite or supabase');
const common={production,origin:process.env.APP_ORIGIN||`http://localhost:${port}`,appKey:process.env.APP_KEY,trustedProxyIps:process.env.TRUSTED_PROXY_IPS?process.env.TRUSTED_PROXY_IPS.split(',').map(ip=>ip.trim()):[]};
// One storefront, one identity: no anonymous classroom role-switching handler.
let app;
if(provider==='supabase'){
 const {createSupabaseApplication}=await import('../server/supabase-app.js');
 app=createSupabaseApplication({...common,url:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY});
}else{
 const {createApplication}=await import('../server/app.js');
 app=createApplication({...common,databasePath:process.env.DATABASE_PATH||path.join(root,'.local','two-hands.sqlite'),dataDir:process.env.DATA_DIR||path.join(root,'.local'),seedDemo:!production&&process.env.SEED_DEMO!=='false'});
}
app.server.on('error',e=>{console.error(e.message);process.exitCode=1;});
app.server.listen(port,host,()=>console.log(`Two-Hands: ${common.origin} · ${provider} · ${production?'production':'local development'}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
