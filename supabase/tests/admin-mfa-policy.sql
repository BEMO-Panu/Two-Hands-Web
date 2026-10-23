-- Rollback-only administrator policy checks. No factor enrollment/removal or
-- real authentication accounts are created by this transaction fixture.
begin;
create temporary table th_admin_policy_results(stage text,result text) on commit drop;
create function pg_temp.th_admin_claim(uid uuid,metadata jsonb default '{}') returns void language plpgsql as $$begin perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','aal','aal1','user_metadata',metadata)::text,true);end$$;
create function pg_temp.th_admin_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ADMIN POLICY ASSERT FAILED: %',label;end if;end$$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values('98000000-7a21-4000-8000-000000000001','policy-admin@example.invalid',now(),'{}'),('98000000-7a21-4000-8000-000000000002','policy-seller@example.invalid',now(),'{}'),('98000000-7a21-4000-8000-000000000003','policy-normal@example.invalid',now(),'{"role":"admin"}');
do $$declare admin_uid uuid:='98000000-7a21-4000-8000-000000000001';seller_uid uuid:='98000000-7a21-4000-8000-000000000002';normal_uid uuid:='98000000-7a21-4000-8000-000000000003';admin_shop uuid;seller_shop uuid;reply jsonb;begin
 perform pg_temp.th_admin_claim(admin_uid);perform public.th_api('snapshot');perform pg_temp.th_admin_claim(seller_uid);perform public.th_api('snapshot');perform pg_temp.th_admin_claim(normal_uid);perform public.th_api('snapshot');
 update public.th_profiles set role='admin' where id=admin_uid;
 perform pg_temp.th_admin_claim(normal_uid,'{"role":"admin","isAdmin":true}');reply:=public.th_api('auth_policy');
 perform pg_temp.th_admin_assert(reply->'isAdmin'='false'::jsonb and reply->'adminMfaRequired'='true'::jsonb,'normal user cannot bypass enrolled-factor policy with metadata');
 begin perform public.th_api('admin_requests');raise exception 'Regular user read administrator inbox';exception when sqlstate 'PT403' then null;end;
 begin perform public.th_api('auth_policy','{"isAdmin":true}');raise exception 'Client policy input accepted';exception when sqlstate 'PT400' then null;end;
 perform set_config('request.jwt.claims','{}',true);
 begin perform public.th_api('auth_policy');raise exception 'Anonymous auth policy accepted';exception when sqlstate 'PT401' then null;end;
 perform pg_temp.th_admin_claim(admin_uid);reply:=public.th_api('auth_policy');perform pg_temp.th_admin_assert(reply->'isAdmin'='true'::jsonb and reply->'adminMfaRequired'='false'::jsonb,'database administrator allowed password-only policy at aal1');
 reply:=public.th_api('snapshot');perform pg_temp.th_admin_assert(reply->'adminMfaRequired'='false'::jsonb and reply#>>'{user,role}'='admin','snapshot publishes administrator policy');
 insert into pg_temp.th_admin_policy_results values('Private database role determines administrator exemption; user metadata cannot grant it','PASS');
 perform pg_temp.th_admin_claim(seller_uid);perform public.th_api('verification','{"name":"Seller fixture shop","location":"Bangkok","bio":"Seller fixture public profile and contact evidence"}');select id into seller_shop from public.th_shops where user_id=seller_uid;
 perform pg_temp.th_admin_claim(admin_uid);perform public.th_api('verification','{"name":"Administrator fixture shop","location":"Bangkok","bio":"Administrator fixture own shop contact and review evidence"}');select id into admin_shop from public.th_shops where user_id=admin_uid;
 reply:=public.th_api('admin_requests');perform pg_temp.th_admin_assert(jsonb_array_length(reply->'requests')>=2,'aal1 administrator lists pending applications');
 begin perform public.th_api('review',jsonb_build_object('shopId',admin_shop,'status','verified','note','Cannot review own shop even after policy changes'));raise exception 'Administrator approved own shop';exception when sqlstate 'PT403' then null;end;
 update auth.users set email_confirmed_at=null where id=seller_uid;
 begin perform public.th_api('review',jsonb_build_object('shopId',seller_shop,'status','verified','note','Unconfirmed seller should remain pending review'));raise exception 'Administrator approved unconfirmed seller';exception when sqlstate 'PT403' then null;end;
 update auth.users set email_confirmed_at=now() where id=seller_uid;
 perform public.th_api('review',jsonb_build_object('shopId',seller_shop,'status','verified','note','Checked seller contact and public shop details carefully'));
 perform pg_temp.th_admin_assert((select status='verified' and reviewed_by=admin_uid from public.th_shops where id=seller_shop),'aal1 administrator reviews another confirmed shop');
 reply:=public.th_api('admin_reports');perform pg_temp.th_admin_assert(jsonb_typeof(reply->'reports')='array','aal1 administrator accesses moderation');
 insert into pg_temp.th_admin_policy_results values('Password-only administrator can review other confirmed stores; self-review stays forbidden','PASS');
 update auth.users set email_confirmed_at=null where id=admin_uid;
 begin perform public.th_api('auth_policy');raise exception 'Unconfirmed administrator exempted';exception when sqlstate 'PT403' then null;end;
 begin perform public.th_api('admin_requests');raise exception 'Unconfirmed administrator accessed inbox';exception when sqlstate 'PT403' then null;end;
 update auth.users set email_confirmed_at=now(),banned_until=clock_timestamp()+interval '1 hour' where id=admin_uid;
 begin perform public.th_api('auth_policy');raise exception 'Banned administrator exempted';exception when sqlstate 'PT401' then null;end;
 begin perform public.th_api('admin_requests');raise exception 'Banned administrator accessed inbox';exception when sqlstate 'PT401' then null;end;
 update auth.users set banned_until=null,deleted_at=clock_timestamp() where id=admin_uid;
 begin perform public.th_api('auth_policy');raise exception 'Deleted administrator exempted';exception when sqlstate 'PT401' then null;end;
 insert into pg_temp.th_admin_policy_results values('Email confirmation, banned and deleted account checks remain enforced','PASS');
end$$;
set local role authenticated;
do $$begin
 begin perform public.th_require_admin();raise exception 'Private administrator helper exposed';exception when insufficient_privilege then null;end;
 begin perform public.th_api_v6_base('snapshot');raise exception 'Old dispatcher bypass exposed';exception when insufficient_privilege then null;end;
 begin perform public.th_snapshot_v6_base();raise exception 'Old private snapshot exposed';exception when insufficient_privilege then null;end;
end$$;
reset role;
select stage,result from pg_temp.th_admin_policy_results;
rollback;
