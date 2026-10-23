// Native REST client: publishable API key + per-request user JWT. No elevated key.
import { HttpError } from './security.js';
// Only exact, known business errors are translated; arbitrary upstream text stays private.
const rpcReasons={
 'Cannot approve your own shop':{reason:'own_shop_review',message:'ไม่สามารถตรวจหรืออนุมัติร้านของตัวเองได้ ต้องให้ผู้ดูแลอีกบัญชีตรวจสอบ'},
 'Administrator with MFA required':{reason:'admin_mfa_required',message:'กรุณายืนยันตัวตนผู้ดูแลด้วยรหัสผ่านและรหัส 2FA อีกครั้งก่อนตรวจรายการ'},
 'Shop owner must verify email':{reason:'shop_email_unverified',message:'เจ้าของร้านต้องยืนยันอีเมลก่อน จึงจะอนุมัติร้านได้'}
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
  if(!response.ok){let code='upstream_error',known;try{const data=await response.json();code=data.code||data.error_code||code;if(route==='/rest/v1/rpc/th_api'&&response.status===403&&code==='PT403')known=Object.hasOwn(rpcReasons,data.message)?rpcReasons[data.message]:undefined;}catch{}
   const status=response.status===429?429:response.status===401?401:response.status===403?403:response.status===404?404:response.status===409?409:response.status>=500?503:code==='23505'||code==='40001'||code==='40P01'?409:400;
   const error=new SupabaseError(status,code);if(known){error.message=known.message;error.reason=known.reason;}throw error;
  }
  if(raw)return response;
  if(response.status===204)return {};
  try{return await response.json();}catch{throw new SupabaseError();}
 }
 return {request,auth:(route,method='GET',body,token)=>request('/auth/v1'+route,{method,body,token}),rpc:(action,payload={},token)=>request('/rest/v1/rpc/th_api',{method:'POST',body:{action,payload},token})};
}
