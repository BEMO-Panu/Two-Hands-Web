import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseClient} from '../server/supabase-client.js';
const client=(message,code='PT403',status=403)=>createSupabaseClient({url:'https://mock.supabase.co',publishableKey:'sb_publishable_mock',fetchImpl:async()=>new Response(JSON.stringify({message,code,details:'PRIVATE_DB_DETAIL'}),{status})});
test('Admin denial distinguishes self-review, stale MFA and unverified email without exposing arbitrary upstream messages',async()=>{
 for(const [message,reason,expected] of [
  ['Cannot approve your own shop','own_shop_review',/ร้านของตัวเอง/],
  ['Administrator with MFA required','admin_mfa_required',/รหัสผ่านและรหัส 2FA/],
  ['Shop owner must verify email','shop_email_unverified',/เจ้าของร้านต้องยืนยันอีเมล/]
 ])await assert.rejects(client(message).rpc('review',{}),e=>e.status===403&&e.reason===reason&&expected.test(e.message)&&!e.message.includes('PRIVATE'));
 for(const message of ['PRIVATE_DB_DETAIL','toString','__proto__'])await assert.rejects(client(message).rpc('review',{}),e=>e.status===403&&!e.reason&&e.message==='คุณไม่มีสิทธิ์ทำรายการนี้');
 await assert.rejects(client('Cannot approve your own shop','different_code').rpc('review',{}),e=>!e.reason&&e.message==='คุณไม่มีสิทธิ์ทำรายการนี้');
 await assert.rejects(client('Administrator with MFA required').auth('/user'),e=>!e.reason&&e.message==='คุณไม่มีสิทธิ์ทำรายการนี้');
});
