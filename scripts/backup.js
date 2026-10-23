import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.env.DATA_PROVIDER==='supabase')throw Error('This CLI is SQLite-only. Use Supabase Dashboard/SQL and follow SUPABASE_SETUP.md.');
const source=path.resolve(process.env.DATABASE_PATH||path.join(root,'.local','two-hands.sqlite'));
if(!existsSync(source))throw new Error('Database not found; refusing to create an empty backup');
const destination=path.resolve(process.argv[2]||path.join(root,'.local','backups',`two-hands-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`));
if(destination===source||existsSync(destination))throw new Error('Backup destination must be a new file');
mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
const db=new DatabaseSync(source,{readOnly:true});
try {await backup(db,destination);chmodSync(destination,0o600);console.log(`Database backup saved: ${destination}`);}finally{db.close();}
