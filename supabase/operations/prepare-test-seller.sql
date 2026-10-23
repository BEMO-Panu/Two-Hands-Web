-- Operator-only: run after manually creating sellertest@twohands.test in Auth.
-- Creates a regular test seller and submits a pending request; never approves it.
-- No passwords, Auth credential changes, or admin grants.
begin;
do $$declare target uuid;current_status text;begin
 select id into strict target from auth.users where lower(email)='sellertest@twohands.test' and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp());
 if exists(select 1 from public.th_profiles where id=target and role='admin') then raise exception 'Test seller must not be an administrator';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',target,'role','authenticated','aal','aal1')::text,true);
 perform public.th_require_user();
 select status into current_status from public.th_shops where user_id=target;
 if current_status in ('none','rejected') then
  perform public.th_api('profile',jsonb_build_object('name','ผู้ขายทดสอบ Two-Hands','shop','ร้านผู้ขายทดสอบ Two-Hands'));
  perform public.th_api('verification',jsonb_build_object('name','ร้านผู้ขายทดสอบ Two-Hands','location','กรุงเทพฯ (ข้อมูลทดสอบ)','bio','ร้านสำหรับทดสอบระบบ Two-Hands โดยเจ้าของระบบ ใช้ข้อมูลสมมติ ไม่มีเอกสารส่วนตัวหรือสินค้าที่ขายจริง ผู้ดูแลสามารถใช้บัญชี Admin คนละบัญชีตรวจคำขอนี้ได้'));
 end if;
end$$;
select u.email,p.role,s.name,s.status from auth.users u join public.th_profiles p on p.id=u.id join public.th_shops s on s.user_id=u.id where lower(u.email)='sellertest@twohands.test';
commit;
