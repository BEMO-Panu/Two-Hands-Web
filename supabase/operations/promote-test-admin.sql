-- Operator-only: run AFTER creating admintest@twohands.test through Supabase Auth.
-- A disposable test account, not a default login seeded by the application.
-- Set the password yourself in Dashboard; this SQL does not create credentials.
-- Review the email/UUID and run only in the intended test project.
begin;
do $$
declare target uuid;
begin
 select id into strict target from auth.users
 where lower(email)='admintest@twohands.test'
   and email_confirmed_at is not null and deleted_at is null
   and (banned_until is null or banned_until<=clock_timestamp());
 insert into public.th_profiles(id,name,role)
 values(target,'ผู้ดูแลทดสอบ','admin')
 on conflict(id) do update set role='admin';
 insert into public.th_shops(user_id,name)
 values(target,'ร้านของผู้ดูแลทดสอบ') on conflict(user_id) do nothing;
 insert into public.th_events(user_id,action,subject)
 values(target,'test_admin_promoted_by_operator',target::text);
end$$;
select p.id,p.name,p.role from public.th_profiles p
 join auth.users u on u.id=p.id where lower(u.email)='admintest@twohands.test';
commit;
-- Before public launch: demote/disable this test account through the operator
-- workflow. Admin actions still require enrolled TOTP and a fresh aal2 session.
