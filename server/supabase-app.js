import {createServer} from 'node:http';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSupabaseClient,SupabaseError} from './supabase-client.js';
import {HttpError,fail,string,integer,choice,email,password,secureEqual,inspectImage,validateTrustedProxyIps,rateLimitAddress} from './security.js';
import {categories,images} from './demo-data.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const HOUR=3600000,DAY=24*HOUR;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mediaPath=/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpg|png|webp)$/;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
export function createSupabaseApplication({url,publishableKey,origin='http://localhost:4173',appKey,production=false,fetchImpl=fetch,clock=Date.now,trustedProxyIps=[],presentationHandler}={}) {
 const parsed=new URL(origin);
 if(parsed.origin!==origin||parsed.username||parsed.password||(!production&&!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))throw Error('APP_ORIGIN must be an exact origin; development is loopback only');
 if(production&&parsed.protocol!=='https:')throw Error('Production APP_ORIGIN requires HTTPS');
 if(!/^[a-f\d]{64}$/i.test(appKey||''))throw Error('Supabase mode requires a stable APP_KEY (64 hex characters)');
 if(production&&new URL(url).protocol!=='https:')throw Error('Production SUPABASE_URL requires HTTPS');
 const sb=createSupabaseClient({url,publishableKey,fetchImpl}),key=Buffer.from(appKey,'hex'),trusted=validateTrustedProxyIps(trustedProxyIps);
 const cookieName=production?'__Host-th_supabase':'th_supabase';
 const limits=new Map(),refreshing=new Map();
 function seal(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(origin));const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64url');}
 function unseal(value){try{if(value.length>12000)return null;const b=Buffer.from(value,'base64url'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(Buffer.from(origin));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());}catch{return null;}}
 function fresh(){return {csrf:randomBytes(24).toString('base64url'),issued:clock(),seen:clock()};}
 function load(req){const raw=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);const s=raw&&unseal(raw);return s&&typeof s.csrf==='string'&&s.issued<=clock()&&clock()-s.issued<7*DAY&&clock()-s.seen<(s.access?30*60000:HOUR)?s:fresh();}
 function save(res,s){s.seen=clock();const encrypted=seal(s);
  // Fail safely instead of emitting a browser-truncated authentication cookie.
  if(encrypted.length>3800)fail(503,'ข้อมูลบัญชีใหญ่เกินขนาดเซสชัน กรุณาติดต่อผู้ดูแล');
  res.setHeader('Set-Cookie',`${cookieName}=${encrypted}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${s.access?1800:3600}${production?'; Secure':''}`);
 }
 function tokens(s,data,{recovery=false,renew=false}={}){if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string')throw new SupabaseError();return {...s,...(renew?{issued:clock(),csrf:randomBytes(24).toString('base64url')}:{}),access:data.access_token,refresh:data.refresh_token,expires:clock()+Math.min(Number(data.expires_in)||3600,86400)*1000,recovery};}
 async function refresh(s){const id=createHash('sha256').update(s.refresh).digest('hex');let p=refreshing.get(id);if(!p){if(refreshing.size>1000)fail(503,'เซิร์ฟเวอร์กำลังมีงานมาก กรุณาลองใหม่');p=sb.auth('/token?grant_type=refresh_token','POST',{refresh_token:s.refresh});refreshing.set(id,p);const timer=setTimeout(()=>refreshing.delete(id),5000);timer.unref();}return tokens(s,await p,{recovery:s.recovery});}
 async function sessionUser(s){if(!s.access)return {s,user:null};try{if(s.expires<=clock()+30000)s=await refresh(s);const user=await sb.auth('/user','GET',undefined,s.access);if(!user?.id)throw new SupabaseError(401);return {s,user};}catch(e){if(e.status===401||e.status===400)return {s:fresh(),user:null};throw e;}}
 async function enforceMfa(s,code){const user=await sb.auth('/user','GET',undefined,s.access);const factor=user.factors?.find(f=>f.factor_type==='totp'&&f.status==='verified');if(factor){if(!/^\d{6}$/.test(code||''))fail(401,'กรุณาใส่รหัส 2FA 6 หลักจากแอปยืนยันตัวตน');const challenge=await sb.auth(`/factors/${factor.id}/challenge`,'POST',{},s.access);const result=await sb.auth(`/factors/${factor.id}/verify`,'POST',{challenge_id:challenge.id,code},s.access);s=tokens(s,result,{renew:true});}return s;}
 function loginPassword(value){if(typeof value!=='string'||!value.length||value.length>128||Buffer.byteLength(value)>512)fail(400,'รหัสผ่านไม่ถูกต้อง');return value;}
 function limit(key,count,ms){const now=clock();let b=limits.get(key);if(!b||b.end<=now){if(limits.size>=10000){for(const [k,v] of limits)if(v.end<=now)limits.delete(k);if(limits.size>=10000)fail(503,'เซิร์ฟเวอร์กำลังมีงานมาก');}b={n:0,end:now+ms};limits.set(key,b);}if(++b.n>count)fail(429,'ทำรายการบ่อยเกินไป กรุณาลองใหม่ภายหลัง');}
 const empty={products:[],stores:[],profile:{},verification:{status:'none'},bids:{},favorites:[],cart:[],orders:[]};
 const extras=s=>({provider:'supabase',capabilities:{payments:false,shipping:false,mfa:true,pickupWorkflow:false,presentationDemo:!!presentationHandler},production,csrf:s.csrf,categories,images,serverTime:clock(),recoveryRequired:!!s.recovery});
 async function state(s,user){const data=await sb.rpc('snapshot',{},s.recovery?undefined:s.access);return {...empty,...data,...extras(s),capabilities:{...extras(s).capabilities,pickupWorkflow:data.pickupWorkflow===true,orderPayments:data.orderPayments===true,sampleCommerce:data.sampleCommerce===true,sampleAuctions:data.sampleAuctions===true},serverTime:Number.isFinite(Number(data.serverTime))?Number(data.serverTime):clock(),user:user&&!s.recovery?{id:user.id,email:user.email,name:data.user?.name||user.user_metadata?.name||'สมาชิก',role:data.user?.role||'user',emailVerified:!!user.email_confirmed_at,mfaEnabled:!!user.factors?.some(f=>f.factor_type==='totp'&&f.status==='verified')}:null};}
 async function read(req,binary=false){let n=0,chunks=[];const max=binary?2*1024*1024:65536;for await(const c of req){n+=c.length;if(n>max)fail(413,'ไฟล์หรือข้อมูลใหญ่เกินกำหนด');chunks.push(c);}const b=Buffer.concat(chunks);if(binary)return b;if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))fail(415,'ต้องส่งข้อมูลแบบ JSON');try{const data=JSON.parse(b.toString());if(!data||Array.isArray(data)||typeof data!=='object')throw Error();return data;}catch{fail(400,'JSON ไม่ถูกต้อง');}}
 function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
 const server=createServer({requestTimeout:30000,headersTimeout:10000,maxHeaderSize:16384},async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://images.unsplash.com blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
  try{
   const route=new URL(req.url,'http://localhost').pathname,isWrite=!['GET','HEAD'].includes(req.method),ip=createHash('sha256').update(rateLimitAddress(req,trusted)).digest('hex');
   limit('all:'+ip,300,60000);
   if(route==='/demo.html'&&req.method==='GET'){res.writeHead(302,{Location:'/','Cache-Control':'no-store'});res.end();return;}
   if(route.startsWith('/api/demo/')){if(!presentationHandler)fail(404,'โหมดสาธิตยังไม่เปิดใช้งาน');return await presentationHandler(req,res);}
   if(req.method==='GET'&&route==='/api/health'){await sb.rpc('snapshot');return json(res,{ok:true,provider:'supabase'});}
   if(route.startsWith('/api/media/')&&['GET','HEAD'].includes(req.method)){
    const object=route.slice('/api/media/'.length);if(!mediaPath.test(object))fail(404,'ไม่พบรูป');
    // RPC only signs a registered image referenced by a publicly visible product.
    const result=await sb.rpc('media',{path:object});if(typeof result.path!=='string'||result.path!==object)fail(404,'ไม่พบรูป');
    const signed=await sb.request('/storage/v1/object/sign/product-photos/'+object,{method:'POST',body:{expiresIn:60}});
    if(typeof signed.signedURL!=='string'||!signed.signedURL.startsWith('/object/sign/product-photos/'))throw new SupabaseError();
    const response=await sb.request('/storage/v1'+signed.signedURL,{raw:true});const data=Buffer.from(await response.arrayBuffer());const info=inspectImage(data);
    res.writeHead(200,{'Content-Type':info.type,'Cache-Control':'public, max-age=60','Content-Disposition':'inline'});return res.end(req.method==='HEAD'?undefined:data);
   }
   if(route.startsWith('/api/')){
    let s=load(req);
    if(isWrite){if(req.headers.origin!==origin||!secureEqual(req.headers['x-csrf-token'],s.csrf))fail(403,'คำขอไม่ผ่านการตรวจสอบ กรุณารีเฟรชแล้วลองใหม่');limit('write:'+ip,100,60000);}
    const previousSession=s;let auth=await sessionUser(s);s=auth.s;let user=auth.user;
    // Persist token refresh even when a later validation or database action fails.
    if(s!==previousSession)save(res,s);
    const respond=(data,status=200)=>{save(res,s);return json(res,data,status);};
    if(route==='/api/state'&&req.method==='GET')return respond(await state(s,user));
    if(route.startsWith('/api/auth/')){
     if(!isWrite)fail(405,'Method not allowed');const b=await read(req);limit('auth:'+ip,20,15*60000);
     if(route==='/api/auth/register'){
      const mail=email(b.email),name=string(b.name,'ชื่อ',{max:60}),pw=password(b.password);
      const result=await sb.auth('/signup','POST',{email:mail,password:pw,data:{name}});
      // Email confirmation is mandatory. Discard any automatic sign-in tokens.
      if(result.access_token){try{await sb.auth('/logout?scope=local','POST',{},result.access_token);}catch{}fail(503,'กรุณาเปิด Confirm email ใน Supabase ก่อนเปิดรับสมาชิก');}
      return respond({message:'หากสมัครด้วยอีเมลนี้ได้ ระบบจะส่งลิงก์ยืนยัน กรุณาตรวจอีเมล'},202);
     }
     if(route==='/api/auth/login'){
      const result=await sb.auth('/token?grant_type=password','POST',{email:email(b.email),password:loginPassword(b.password)});
      let next=tokens(fresh(),result,{renew:true});try{next=await enforceMfa(next,b.code);}catch(e){try{await sb.auth('/logout?scope=local','POST',{},next.access);}catch{}throw e;}
      s=next;user=await sb.auth('/user','GET',undefined,s.access);return respond(await state(s,user));
     }
     if(route==='/api/auth/logout'){if(s.access)await sb.auth('/logout?scope=local','POST',{},s.access);s=fresh();return respond(await state(s,null));}
     if(route==='/api/auth/forgot'){const mail=email(b.email);limit('forgot:'+createHash('sha256').update(mail).digest('hex'),3,HOUR);await sb.auth('/recover','POST',{email:mail});return respond({message:'หากมีบัญชีนี้ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่'});}
     if(route==='/api/auth/resend'){const mail=user?.email||email(b.email);limit('resend:'+createHash('sha256').update(mail).digest('hex'),3,HOUR);await sb.auth('/resend','POST',{type:'signup',email:mail});return respond({message:'หากบัญชียังไม่ยืนยัน ระบบจะส่งอีเมลให้'});}
     if(route==='/api/auth/confirm'){
      if(!['signup','recovery'].includes(b.type))fail(400,'ชนิดลิงก์ไม่ถูกต้อง');const token=string(b.tokenHash,'ลิงก์ยืนยัน',{min:16,max:200});
      const result=await sb.auth('/verify','POST',{type:b.type,token_hash:token});s=tokens(fresh(),result,{recovery:b.type==='recovery',renew:true});return respond({ok:true,recoveryRequired:!!s.recovery});
     }
     if(route==='/api/auth/reset'){
      if(!user||!s.recovery)fail(403,'กรุณาเปิดลิงก์ตั้งรหัสผ่านจากอีเมล');const next=await enforceMfa(s,b.code);s={...next,recovery:true};await sb.auth('/user','PUT',{password:password(b.password)},s.access);await sb.auth('/logout?scope=global','POST',{},s.access);s=fresh();return respond({ok:true});
     }
     if(!user||s.recovery)fail(401,'กรุณาเข้าสู่ระบบ');
     if(route==='/api/auth/reauth'){
      const result=await sb.auth('/token?grant_type=password','POST',{email:user.email,password:loginPassword(b.password)});let next=tokens(fresh(),result,{renew:true});try{next=await enforceMfa(next,b.code);}catch(e){try{await sb.auth('/logout?scope=local','POST',{},next.access);}catch{}throw e;}const previous=s.access;s=next;await sb.auth('/logout?scope=local','POST',{},previous);return respond({ok:true});
     }
     if(route==='/api/auth/mfa/setup'){
      if(!user.email_confirmed_at)fail(403,'กรุณายืนยันอีเมล');const result=await sb.auth('/factors','POST',{factor_type:'totp',friendly_name:'Two-Hands '+randomUUID().slice(0,8),issuer:'Two-Hands'},s.access);return respond({factorId:result.id,secret:result.totp?.secret,uri:result.totp?.uri});
     }
     if(route==='/api/auth/mfa/enable'){
      if(!uuid.test(b.factorId||'')||!/^\d{6}$/.test(b.code||''))fail(400,'รหัส 2FA ไม่ถูกต้อง');const challenge=await sb.auth(`/factors/${b.factorId}/challenge`,'POST',{},s.access);const result=await sb.auth(`/factors/${b.factorId}/verify`,'POST',{challenge_id:challenge.id,code:b.code},s.access);s=tokens(s,result);return respond({ok:true});
     }
     fail(404,'ไม่พบ API');
    }
    if(s.recovery)fail(403,'กรุณาตั้งรหัสผ่านใหม่ให้เสร็จก่อนทำรายการ');
    if(!user)fail(401,'กรุณาเข้าสู่ระบบ');
    if(route==='/api/uploads'&&req.method==='POST'){
     if(!user.email_confirmed_at)fail(403,'กรุณายืนยันอีเมล');limit('upload:'+user.id,20,HOUR);const bytes=await read(req,true),info=inspectImage(bytes),object=`${user.id}/${randomUUID()}.${info.extension}`;
     await sb.request('/storage/v1/object/product-photos/'+object,{method:'POST',token:s.access,headers:{'Content-Type':info.type,'x-upsert':'false'},body:bytes,raw:true});
     try{return respond(await sb.rpc('upload_register',{path:object},s.access),201);}catch(e){try{await sb.request('/storage/v1/object/product-photos',{method:'DELETE',token:s.access,body:{prefixes:[object]}});}catch{}throw e;}
    }
    let action,payload={};
    const pickupRoute=/^\/api\/orders\/([^/]+)\/shops\/([^/]+)\/(messages|handoff|fulfill)$/.exec(route);
    const paymentRoute=/^\/api\/orders\/([^/]+)\/pay$/.exec(route);
    const sampleCompleteRoute=/^\/api\/orders\/([^/]+)\/complete-sample$/.exec(route);
    const listingRoute=/^\/api\/products\/([^/]+)(\/withdraw)?$/.exec(route);
    if(sampleCompleteRoute){
     if(req.method!=='POST')fail(405,'วิธีทำรายการไม่ถูกต้อง');
     if(!uuid.test(sampleCompleteRoute[1]))fail(400,'รหัสคำสั่งซื้อไม่ถูกต้อง');
     const b=await read(req);if(Object.keys(b).length)fail(400,'ไม่ต้องส่งข้อมูลเพิ่มเติมเพื่อยืนยันรับสินค้าตัวอย่าง');
     action='sample_complete';payload={orderId:sampleCompleteRoute[1]};
     limit('sample_complete:'+user.id,30,60000);
    }else if(paymentRoute){
     if(req.method!=='POST')fail(405,'วิธีทำรายการไม่ถูกต้อง');
     if(!uuid.test(paymentRoute[1]))fail(400,'รหัสคำสั่งซื้อไม่ถูกต้อง');
     const b=await read(req);if(Object.keys(b).some(k=>!['method','outcome','requestKey'].includes(k)))fail(400,'ส่งเฉพาะวิธีจ่ายและผลจำลอง ห้ามส่งยอดเงินหรือข้อมูลบัตรจริง');
     action='pay';payload={orderId:paymentRoute[1],method:choice(b.method,['qr_demo','card_demo'],'วิธีชำระจำลอง'),outcome:choice(b.outcome,['success','declined'],'ผลชำระจำลอง'),requestKey:string(b.requestKey,'รหัสคำขอ',{min:10,max:100})};
     limit('payment:'+user.id,30,60000);
    }else if(pickupRoute){
     const [,orderId,shopId,operation]=pickupRoute;
     if(!uuid.test(orderId)||!uuid.test(shopId))fail(400,'รหัสการจองหรือร้านค้าไม่ถูกต้อง');
     payload={orderId,shopId};
     if(operation==='messages'&&req.method==='GET')action='order_messages';
     else if(operation==='messages'&&req.method==='POST'){
      const b=await read(req);payload.text=string(b.text,'ข้อความ',{min:1,max:2000});action='order_message';limit('message:'+user.id,30,60000);
     }else if(operation==='fulfill'&&req.method==='POST'){
      const b=await read(req);if(Object.keys(b).some(k=>k!=='status'))fail(400,'ข้อมูลเตรียมสินค้าไม่ถูกต้อง');
      action='fulfill';payload.status=choice(b.status,['preparing','ready'],'สถานะเตรียมสินค้า');
     }else if(operation==='handoff'&&req.method==='POST'){await read(req);action='order_handoff';}
     else fail(405,'วิธีทำรายการไม่ถูกต้อง');
    }else if(listingRoute&&['PATCH','POST'].includes(req.method)){
     const [,productId,withdraw]=listingRoute;
     if(!uuid.test(productId))fail(400,'รหัสสินค้าไม่ถูกต้อง');
     payload={productId};
     if(withdraw&&req.method==='POST'){await read(req);action='product_withdraw';}
     else if(!withdraw&&req.method==='PATCH'){
      const b=await read(req);action='product_update';
      for(const [name,label,max] of [['title','ชื่อสินค้า',90],['description','รายละเอียด',1500],['category','หมวดหมู่',30],['condition','สภาพสินค้า',30],['location','พื้นที่นัดรับ',120]])payload[name]=string(b[name],label,{min:name==='description'?10:1,max});
      payload.price=integer(b.price,'ราคา',1,10000000);
     }else fail(405,'วิธีทำรายการไม่ถูกต้อง');
    }

    if(action){/* Validated pickup/listing action above. */}
    else if(route==='/api/sales'&&req.method==='GET')action='sales';
    else if(route==='/api/admin/requests'&&req.method==='GET')action='admin_requests';
    else if(route==='/api/admin/reports'&&req.method==='GET')action='admin_reports';
    else if(/^\/api\/admin\/reports\/[^/]+\/review$/.test(route)&&req.method==='POST'){
     const reportId=route.split('/')[4];if(!uuid.test(reportId))fail(400,'รหัสรายงานไม่ถูกต้อง');
     const b=await read(req);action='review_report';payload={reportId,note:string(b.note,'บันทึกผลตรวจ',{min:20,max:1500})};
    }
    else if(route==='/api/profile'&&req.method==='PATCH'){action='profile';payload=await read(req);}
    else if(route==='/api/verification'&&req.method==='POST'){action='verification';payload=await read(req);}
    else if(/^\/api\/admin\/shops\/[^/]+\/review$/.test(route)&&req.method==='POST'){action='review';payload={...await read(req),shopId:route.split('/')[4]};}
    else if(route==='/api/products'&&req.method==='POST'){action='product_create';payload=await read(req);}
    else if(/^\/api\/products\/[^/]+\/bids$/.test(route)){
     const productId=route.split('/')[3];
     if(req.method!=='POST')fail(405,'วิธีทำรายการไม่ถูกต้อง');
     if(/^p(?:[1-9]|1[0-6])$/.test(productId)){
      const b=await read(req);if(Object.keys(b).some(k=>!['amount','requestKey','roundId'].includes(k)))fail(400,'ส่งเฉพาะราคาเสนอ รหัสคำขอ และรอบประมูล');
      if(typeof b.roundId!=='string'||!uuid.test(b.roundId))fail(400,'รหัสรอบประมูลไม่ถูกต้อง กรุณาอัปเดตสินค้าแล้วลองใหม่');
      action='bid';payload={productId,amount:integer(b.amount,'ราคาเสนอ',1,10000000),requestKey:string(b.requestKey,'รหัสคำขอ',{min:10,max:100}),roundId:b.roundId};
      limit('sample_bid:'+user.id,30,60000);
     }else{
      if(!uuid.test(productId))fail(400,'รหัสสินค้าไม่ถูกต้อง');
      action='bid';payload={...await read(req),productId};
     }
    }
    else if(/^\/api\/(favorites|cart)\/[^/]+$/.test(route)&&['PUT','DELETE'].includes(req.method)){const [, ,kind,productId]=route.split('/');if(kind==='cart'&&!uuid.test(productId)&&!/^p(?:[1-9]|1[0-6])$/.test(productId))fail(400,'รหัสสินค้าไม่ถูกต้อง');action=(kind==='favorites'?'favorite':'cart')+(req.method==='PUT'?'_add':'_remove');payload={productId};}
    else if(route==='/api/orders'&&req.method==='POST'){action='reserve';payload=await read(req);if(payload.delivery!=='pickup')fail(400,'MVP เปิดเฉพาะนัดรับ ยังไม่เปิดจัดส่งหรือชำระเงิน');if(!Array.isArray(payload.productIds)||payload.productIds.length<1||payload.productIds.length>20||payload.productIds.some(id=>typeof id!=='string'||(!uuid.test(id)&&!/^p(?:[1-9]|1[0-6])$/.test(id))))fail(400,'เลือกสินค้า 1 ถึง 20 รายการด้วยรหัสสินค้าที่ถูกต้อง');}
    else if(/^\/api\/orders\/[^/]+\/cancel$/.test(route)&&req.method==='POST'){action='cancel';payload={orderId:route.split('/')[3]};}
    else if(route==='/api/reports'&&req.method==='POST'){action='report';payload=await read(req);}
    if(!action)fail(404,'ไม่พบ API');
    try{return respond(await sb.rpc(action,payload,s.access));}
    catch(error){
     if(action==='verification'&&error instanceof SupabaseError&&error.status===409)fail(409,'ร้านส่งคำขอแล้วหรือผ่านการตรวจสอบแล้ว กรุณาเปิดสถานะร้านค้าเพื่อดูข้อมูลล่าสุด');
     throw error;
    }
   }
   if(!['GET','HEAD'].includes(req.method))fail(405,'Method not allowed');
   const base=path.join(root,'dist'),filename=path.resolve(base,'.'+decodeURIComponent(route==='/'?'/index.html':route));if(!filename.startsWith(base+path.sep))fail(403,'Forbidden');const bytes=await readFile(filename);res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(e){if(res.headersSent)return res.end();if(e instanceof HttpError)return json(res,{error:e.message,...(e.reason?{reason:e.reason}:{})},e.status);if(e.code==='ENOENT')return json(res,{error:'ไม่พบไฟล์'},404);console.error('[supabase]',e.name);json(res,{error:'เกิดข้อผิดพลาดภายใน กรุณาลองใหม่'},500);}
 });
 return {server,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
