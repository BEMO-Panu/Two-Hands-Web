// Native REST client: publishable API key + per-request user JWT. No elevated key.
import { HttpError } from './security.js';
// Only exact, known business errors are translated; arbitrary upstream text stays private.
const rpcReasons={
 'Own listing not found':{reason:'listing_owner_required',message:'ไม่พบประกาศของคุณ'},
 'Listing already has an order':{reason:'listing_has_order',message:'สินค้านี้มีคำสั่งซื้อแล้ว จึงลบประกาศไม่ได้ กรุณาจัดการผ่านรายการขาย'},
 'Own auction not found':{reason:'auction_owner_required',message:'ไม่พบประกาศประมูลของคุณ'},
 'Auction already has an order':{reason:'auction_has_order',message:'ประมูลนี้มีคำสั่งซื้อแล้ว จึงยกเลิกหรือลบประกาศไม่ได้ กรุณาจัดการผ่านรายการขาย'},
 'Auction already ended':{reason:'auction_ended',message:'ประมูลสิ้นสุดแล้ว กรุณาโหลดข้อมูลล่าสุด'},
 'Cancel auction before deleting':{reason:'auction_cancel_first',message:'กรุณายกเลิกประมูลก่อนลบประกาศที่มีผู้เสนอราคา'},
 'Cannot approve your own shop':{reason:'own_shop_review',message:'ไม่สามารถตรวจหรืออนุมัติร้านของตัวเองได้ ต้องให้ผู้ดูแลอีกบัญชีตรวจสอบ'},
 'Administrator with MFA required':{reason:'admin_mfa_required',message:'กรุณายืนยันตัวตนผู้ดูแลด้วยรหัสผ่านและรหัส 2FA อีกครั้งก่อนตรวจรายการ'},
 'Shop owner must verify email':{reason:'shop_email_unverified',message:'เจ้าของร้านต้องยืนยันอีเมลก่อน จึงจะอนุมัติร้านได้'}
};
const authReasons={
 email_address_not_authorized:{reason:'email_not_authorized',message:'บริการอีเมลเริ่มต้นยังส่งถึงอีเมลนี้ไม่ได้ ผู้ดูแลต้องตั้งค่า SMTP ก่อนเปิดสมัครให้บุคคลทั่วไป'},
 email_not_confirmed:{reason:'email_not_confirmed',message:'บัญชีนี้ยังไม่ได้ยืนยันอีเมล กรุณาเปิดลิงก์ในอีเมลก่อนเข้าสู่ระบบ ไม่ต้องสมัครซ้ำ'},
 invalid_credentials:{reason:'invalid_credentials',message:'อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่'},
 over_email_send_rate_limit:{reason:'email_send_rate_limit',message:'บริการอีเมลยืนยันถึงโควตาแล้ว การกดซ้ำจะไม่ช่วย กรุณาติดต่อผู้ดูแลเพื่อตั้งค่าบริการอีเมลหรือวิธีสมัคร'},
 over_request_rate_limit:{reason:'auth_rate_limit',message:'บริการเข้าสู่ระบบได้รับคำขอถี่เกินไป กรุณารอตามเวลาที่แจ้งก่อนลองใหม่'},
 email_address_invalid:{reason:'invalid_email',message:'บริการสมาชิกไม่รับอีเมลนี้ กรุณาตรวจรูปแบบอีเมล'},
 weak_password:{reason:'weak_password',message:'รหัสผ่านไม่ผ่านเงื่อนไขของระบบสมาชิก กรุณาใช้รหัสอย่างน้อย 8 ตัวอักษร'},
 user_already_exists:{reason:'account_exists',message:'อีเมลนี้มีบัญชีแล้ว กรุณาเข้าสู่ระบบ หรือกดลืมรหัสผ่าน'},
 signup_disabled:{reason:'signup_disabled',message:'ระบบปิดรับสมาชิกชั่วคราว กรุณาติดต่อผู้ดูแล'}
};
export class SupabaseError extends HttpError {
 constructor(status=503, code='upstream_error') { super(status, status===429?'ทำรายการบ่อยเกินไป กรุณาลองใหม่ภายหลัง':status===401?'กรุณาเข้าสู่ระบบหรือยืนยันรหัส 2FA อีกครั้ง':status===403?'คุณไม่มีสิทธิ์ทำรายการนี้':status===404?'ไม่พบข้อมูล':status===409?'สถานะรายการเปลี่ยนแปลง กรุณาอัปเดตข้อมูลแล้วลองใหม่':status===400?'ข้อมูลไม่ถูกต้อง หรือรายการนี้ไม่พร้อมใช้งาน':'ไม่สามารถเชื่อมต่อบริการข้อมูลได้ กรุณาลองใหม่');this.code=code; }
}
export function createSupabaseClient({url,publishableKey,fetchImpl=fetch}) {
 let base;try{base=new URL(url);}catch{throw Error('SUPABASE_URL is required');}
 if(base.origin!==url||base.username||base.password||!(base.protocol==='https:'||(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw Error('SUPABASE_URL must be an HTTPS origin (HTTP allowed only for local Supabase)');
 if(typeof publishableKey!=='string'||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw Error('SUPABASE_PUBLISHABLE_KEY must be a publishable key; secret/service_role keys are not supported');
 async function request(route,{method='GET',token,body,headers={},raw=false}={}) {
  const h={apikey:publishableKey,...headers};if(token)h.Authorization='Bearer '+token;
  if(body!==undefined&&!raw)h['Content-Type']='application/json';
  let response;try{response=await fetchImpl(url+route,{method,headers:h,body:body===undefined?undefined:raw?body:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});}catch{throw new SupabaseError();}
  if(!response.ok){let code='upstream_error',known;try{const data=await response.json();code=data.code||data.error_code||code;if(route.startsWith('/auth/v1/'))known=Object.hasOwn(authReasons,code)?authReasons[code]:undefined;if(route==='/rest/v1/rpc/th_api'&&[400,403,404,409].includes(response.status)&&/^PT(400|403|404|409)$/.test(code))known=Object.hasOwn(rpcReasons,data.message)?rpcReasons[data.message]:undefined;}catch{}
   const status=response.status===429?429:response.status===401?401:response.status===403?403:response.status===404?404:response.status===409?409:response.status>=500?503:code==='23505'||code==='40001'||code==='40P01'?409:400;
   const error=new SupabaseError(status,code);if(known){error.message=known.message;error.reason=known.reason;}const retry=response.headers.get('retry-after');if(status===429&&retry&&/^\d+$/.test(retry)){error.retryAfter=Math.min(86400,Math.max(1,Number(retry)));if(code!=='over_email_send_rate_limit')error.message+=` (ลองอีกครั้งใน ${error.retryAfter} วินาที)`;}throw error;
  }
  if(raw)return response;
  if(response.status===204)return {};
  try{return await response.json();}catch{throw new SupabaseError();}
 }
 return {request,auth:(route,method='GET',body,token)=>request('/auth/v1'+route,{method,body,token}),rpc:(action,payload={},token)=>request('/rest/v1/rpc/th_api',{method:'POST',body:{action,payload},token})};
}
