import { isIP } from 'node:net';
import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCb);
export const randomToken=()=>randomBytes(32).toString('base64url');
export const hash=v=>createHash('sha256').update(String(v)).digest('hex');
export class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
export const fail=(status,message)=>{throw new HttpError(status,message);};
export function string(value,name,{min=1,max=1000}={}){if(typeof value!=='string'||value.trim().length<min||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail(400,`${name} ไม่ถูกต้อง`);return value.trim();}
export function integer(value,name,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,`${name} ไม่ถูกต้อง`);return value;}
export function choice(value,list,name){if(!list.includes(value))fail(400,`${name} ไม่ถูกต้อง`);return value;}
export function email(value){const s=string(value,'อีเมล',{max:254}).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))fail(400,'รูปแบบอีเมลไม่ถูกต้อง');return s;}
export function password(value){if(typeof value!=='string'||value.length<8||value.length>128||Buffer.byteLength(value)>512)fail(400,'รหัสผ่านต้องยาว 8–128 ตัวอักษร');return value;}
let hashing=0;
async function derive(value,salt){if(hashing>=2)fail(503,'ระบบกำลังตรวจรหัสผ่าน กรุณาลองใหม่');hashing++;try{return await scrypt(value,salt,64,{N:131072,r:8,p:1,maxmem:192*1024*1024});}finally{hashing--;}}
export async function passwordHash(value){const salt=randomBytes(16).toString('hex');return `scrypt$131072$8$1$${salt}$${(await derive(value,salt)).toString('hex')}`;}
export async function passwordMatches(value,stored){const parts=(stored||'').split('$');const valid=parts.length===6&&parts[0]==='scrypt'&&parts[1]==='131072'&&parts[2]==='8'&&parts[3]==='1';const salt=valid?parts[4]:'00000000000000000000000000000000';const actual=await derive(value,salt);const expected=valid?Buffer.from(parts[5],'hex'):Buffer.alloc(64);return expected.length===actual.length&&timingSafeEqual(actual,expected)&&valid;}
export function secureEqual(a,b){const x=hash(a||''),y=hash(b||'');return timingSafeEqual(Buffer.from(x),Buffer.from(y));}
export function rateLimit(db,key,limit,windowMs,now=Date.now()){
 const row=db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
 if(!row||row.expires_at<=now)db.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,expires_at=excluded.expires_at').run(key,now+windowMs);
 else {if(row.count>=limit)fail(429,'ลองบ่อยเกินไป กรุณารอสักครู่');db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);}
}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newMfaSecret(){let bits=0,value=0,result='';for(const b of randomBytes(20)){value=(value<<8)|b;bits+=8;while(bits>=5){result+=alphabet[(value>>>(bits-5))&31];bits-=5;}}return result;}
function decode32(secret){let bits=0,value=0,out=[];for(const c of secret){value=(value<<5)|alphabet.indexOf(c);bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totp(secret,step){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(step));const h=createHmac('sha1',decode32(secret)).update(b).digest();const off=h[19]&15;return String((h.readUInt32BE(off)&0x7fffffff)%1000000).padStart(6,'0');}
export function totpStep(secret,code,last=-1,now=Date.now()){if(typeof code!=='string'||!/^\d{6}$/.test(code))return null;const t=Math.floor(now/30000);for(const s of [t,t-1,t+1])if(s>last&&secureEqual(totp(secret,s),code))return s;return null;}
export function encrypt(value,key){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([c.update(value,'utf8'),c.final()]);return [iv.toString('hex'),c.getAuthTag().toString('hex'),data.toString('hex')].join('.');}
export function decrypt(value,key){const [iv,tag,data]=value.split('.');const c=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));c.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([c.update(Buffer.from(data,'hex')),c.final()]).toString('utf8');}
// Check container structure and image dimensions before serving untrusted raster bytes.
// The browser still decodes images; SVG/HTML are never accepted.
export function inspectImage(data){
 let type,extension,width,height;
 if(data.length>=45&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.readUInt32BE(8)===13&&data.subarray(12,16).toString()==='IHDR'&&data.subarray(-8,-4).toString()==='IEND'){
  type='image/png';extension='png';width=data.readUInt32BE(16);height=data.readUInt32BE(20);
 }else if(data.length>=16&&data[0]===255&&data[1]===216&&data.at(-2)===255&&data.at(-1)===217){
  for(let at=2;at+4<data.length;){
   if(data[at++]!==255)break;while(data[at]===255)at++;
   const marker=data[at++];if(marker===218||marker===217)break;if(marker===1||(marker>=208&&marker<=215))continue;
   if(at+2>data.length)break;const len=data.readUInt16BE(at);if(len<2||at+len>data.length)break;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&len>=8){height=data.readUInt16BE(at+3);width=data.readUInt16BE(at+5);type='image/jpeg';extension='jpg';break;}at+=len;
  }
 }else if(data.length>=30&&data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'&&data.readUInt32LE(4)+8===data.length){
  const format=data.subarray(12,16).toString();
  if(format==='VP8X'&&data.readUInt32LE(16)===10){width=1+data.readUIntLE(24,3);height=1+data.readUIntLE(27,3);}
  else if(format==='VP8L'&&data[20]===47){const bits=data.readUInt32LE(21);width=1+(bits&16383);height=1+((bits>>>14)&16383);}
  else if(format==='VP8 '&&data.subarray(23,26).equals(Buffer.from([157,1,42]))){width=data.readUInt16LE(26)&16383;height=data.readUInt16LE(28)&16383;}
  if(width){type='image/webp';extension='webp';}
 }
 if(!type||!width||!height||width>8192||height>8192||width*height>24000000)fail(400,'ภาพไม่ถูกต้อง หรือใหญ่เกิน 8192 พิกเซล / 24 ล้านพิกเซล');
 return {type,extension};
}

export function validateTrustedProxyIps(value){
 if(!Array.isArray(value)||value.some(ip=>typeof ip!=='string'||!isIP(ip)||ip.includes('%')))throw new Error('TRUSTED_PROXY_IPS must contain only exact IPv4 or IPv6 addresses');
 return new Set(value);
}
export function rateLimitAddress(req,trustedProxyIps){
 const peer=req.socket.remoteAddress||'unknown',forwarded=req.headers['x-real-ip'];
 // Only an explicitly trusted immediate peer may assert a single client IP.
 // X-Forwarded-For, comma-separated chains, arrays, zones and whitespace are ignored.
 return trustedProxyIps.has(peer)&&typeof forwarded==='string'&&isIP(forwarded)&&!forwarded.includes('%')?forwarded:peer;
}
