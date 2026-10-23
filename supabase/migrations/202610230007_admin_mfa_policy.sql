begin;
-- Explicit deployment policy: administrators may authenticate with their normal
-- password alone. Other accounts retain their enrolled-factor login policy.
-- Role authority remains the private database profile, never client metadata.
create or replace function public.th_require_admin() returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.th_require_user();begin
 if not exists(select 1 from public.th_profiles where id=uid and role='admin') then raise exception using errcode='PT403',message='Administrator required';end if;
 return uid;
end$$;
revoke all on function public.th_require_admin() from public,anon,authenticated;
alter function public.th_snapshot() rename to th_snapshot_v6_base;
revoke all on function public.th_snapshot_v6_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language sql security definer set search_path='' as $$
 select public.th_snapshot_v6_base()||jsonb_build_object('adminMfaRequired',false);
$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v6_base;
revoke all on function public.th_api_v6_base(text,jsonb) from public,anon,authenticated;
create function public.th_api(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid;is_admin boolean;begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 if action<>'auth_policy' then return public.th_api_v6_base(action,payload);end if;
 if payload<>'{}'::jsonb then raise exception using errcode='PT400',message='Authentication policy takes no input';end if;
 uid:=public.th_require_user();perform public.th_limit(uid,'auth_policy',120,60);
 select exists(select 1 from public.th_profiles where id=uid and role='admin') into is_admin;
 return jsonb_build_object('isAdmin',is_admin,'adminMfaRequired',not is_admin);
end$$;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
commit;
