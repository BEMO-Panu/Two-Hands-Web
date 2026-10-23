// Local, explicit operator action. No default admin or default password is created.
import { openDatabase } from '../server/database.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.env.DATA_PROVIDER==='supabase')throw Error('This CLI is SQLite-only. Use Supabase Dashboard/SQL and follow SUPABASE_SETUP.md.');
const mail=process.argv[2]?.trim().toLowerCase();
if(!mail){console.error('Usage: npm run admin -- owner@example.com');process.exit(2);}
const db=openDatabase(process.env.DATABASE_PATH||path.join(root,'.local','two-hands.sqlite'));
try{const user=db.prepare('SELECT * FROM users WHERE email=?').get(mail);if(!user||!user.email_verified)throw new Error('Register and verify this email first');db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);db.prepare('INSERT INTO security_events(user_id,action,subject,created_at) VALUES(?,?,?,?)').run(user.id,'admin_promoted',user.id,Date.now());console.log('Admin access granted. Sign in again and enable 2FA before production admin actions.');}finally{db.close();}
