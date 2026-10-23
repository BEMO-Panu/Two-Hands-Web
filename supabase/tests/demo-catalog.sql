-- Additive display-only demo catalog checks. All account fixtures roll back.
begin;
do $$declare state jsonb;uid uuid:='91000000-7a21-4000-8000-000000000001';shop uuid;begin
 perform set_config('request.jwt.claims','{}',true);state:=public.th_api('snapshot');
 if (select count(*) from jsonb_array_elements(state->'products')x(v) where v->'isDemo'='true'::jsonb)<>16 then raise exception 'Expected sixteen demo products';end if;
 if (select count(*) from jsonb_array_elements(state->'stores')x(v) where v->'isDemo'='true'::jsonb)<>5 then raise exception 'Expected five demo stores';end if;
 if exists(select 1 from public.th_demo_catalog where kind='store' and data->'verified'<>'false'::jsonb) then raise exception 'Demo store implies actual verification';end if;
 if exists(select 1 from public.th_demo_catalog where kind='product' and data->>'mode'='auction' and (data->>'endsAt')::bigint<=public.th_now()) then raise exception 'Newly seeded demo auction deadline must be future';end if;
 if exists(select 1 from public.th_demo_catalog where kind='product' and data->>'image' not in ('chair','camera','headphones','sneakers','bag','books','lamp','bike','watch','vinyl','coat','table')) then raise exception 'Unknown sample image key';end if;
 if (select count(*) from public.th_products)<>0 or (select count(*) from public.th_shops)<>0 then raise exception 'Demo seed modified live trading tables';end if;
 if state->'user'<>'null'::jsonb or state->'orders'<>'[]'::jsonb or state->'bids'<>'{}'::jsonb then raise exception 'Anonymous own-account state changed';end if;
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(uid,'catalog-fixture@example.invalid',now(),'{"name":"Catalog test buyer"}');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','aal','aal1')::text,true);state:=public.th_api('snapshot');shop:=(state#>>'{profile,shopId}')::uuid;
 if state#>>'{user,name}'<>'Catalog test buyer' or state#>>'{user,role}'<>'user' or state#>>'{verification,status}'<>'none' then raise exception 'Catalog changed own profile/permissions/verification';end if;
 if state->'cart'<>'[]'::jsonb or state->'favorites'<>'[]'::jsonb or state->'orders'<>'[]'::jsonb then raise exception 'Catalog populated private user lists';end if;
 -- Catalog IDs are not live product UUIDs; direct RPC attempts cannot purchase,
 -- bid or add demo data to a real cart, even if the UI checks are bypassed.
 begin perform public.th_api('reserve','{"productIds":["p13"],"delivery":"pickup","requestKey":"catalog-reserve-test"}');raise exception 'Demo product reservation succeeded';exception when invalid_text_representation then null;end;
 begin perform public.th_api('bid','{"productId":"p14","amount":5000,"requestKey":"catalog-bid-test"}');raise exception 'Demo auction bid succeeded';exception when invalid_text_representation then null;end;
 begin perform public.th_api('cart_add','{"productId":"p13"}');raise exception 'Demo cart mutation succeeded';exception when invalid_text_representation then null;end;
 if (select count(*) from public.th_orders)<>0 or (select count(*) from public.th_bids)<>0 or (select count(*) from public.th_cart)<>0 then raise exception 'Demo entries entered transactional tables';end if;
end$$;
set local role authenticated;
do $$begin
 begin perform 1 from public.th_demo_catalog;raise exception 'Direct catalog table grants exposed';exception when insufficient_privilege then null;end;
 begin perform public.th_snapshot();raise exception 'Private snapshot helper exposed';exception when insufficient_privilege then null;end;
end$$;
reset role;
select 'PASS' as result,'16 products / 5 stores, display-only, permissions preserved' as demo_catalog;
rollback;
