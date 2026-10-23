import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function createMailer({production,dataDir,apiKey,from}){
 if(production&&(!apiKey||!from))throw new Error('Production requires RESEND_API_KEY and MAIL_FROM');
 return async ({to,kind,url})=>{
  const subject=kind==='verify'?'ยืนยันอีเมล Two-Hands':'ตั้งรหัสผ่าน Two-Hands ใหม่';
  if(production){const r=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[to],subject,text:`${subject}\n\n${url}\n\nหากไม่ได้ทำรายการนี้ ไม่ต้องเปิดลิงก์นี้`})});if(!r.ok)throw new Error('Email delivery failed');}
  else{const dir=path.join(dataDir,'outbox');mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(path.join(dir,`${Date.now()}-${randomUUID()}.json`),JSON.stringify({to,kind,url,subject},null,2),{mode:0o600});}
 };
}
