-- Execute after the migration on a disposable fresh Supabase project.
-- Simulates server-issued claims; application clients cannot set JWT claims.
-- All fixture rows, helpers and changes are rolled back.
begin;
create function public.th_test_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'ASSERT FAILED: %',label;end if;end$$;
create function public.th_test_claims(uid uuid,aal text default 'aal1',age integer default 0) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',uid,'email','test@example.invalid','role','authenticated','aal',aal,'amr',jsonb_build_array(jsonb_build_object('method','totp','timestamp',extract(epoch from clock_timestamp())::bigint-age)))::text,true)::text::void
$$;
-- auth.users permits these minimal rows in hosted Supabase; no passwords are
-- created and all UUIDs/emails are isolated test fixtures.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('10000000-0000-4000-8000-000000000001','seller-th-test@example.invalid',now(),'{"name":"Seller"}'),
 ('10000000-0000-4000-8000-000000000002','buyer-th-test@example.invalid',now(),'{"name":"Buyer"}'),
 ('10000000-0000-4000-8000-000000000003','admin-th-test@example.invalid',now(),'{"name":"Admin"}'),
 ('10000000-0000-4000-8000-000000000004','unverified-th-test@example.invalid',null,'{"name":"Unverified","role":"admin"}');
do $$declare uid uuid;begin
 foreach uid in array array['10000000-0000-4000-8000-000000000001'::uuid,'10000000-0000-4000-8000-000000000002'::uuid,'10000000-0000-4000-8000-000000000003'::uuid,'10000000-0000-4000-8000-000000000004'::uuid] loop
 perform public.th_test_claims(uid);perform public.th_api('snapshot');end loop;
end$$;
select public.th_test_assert((select role='user' from public.th_profiles where id='10000000-0000-4000-8000-000000000004'),'metadata cannot assign admin');
update public.th_profiles set role='admin' where id='10000000-0000-4000-8000-000000000003';

do $$declare seller uuid:='10000000-0000-4000-8000-000000000001';buyer uuid:='10000000-0000-4000-8000-000000000002';admin uuid:='10000000-0000-4000-8000-000000000003';unverified uuid:='10000000-0000-4000-8000-000000000004';
 seller_shop uuid;buyer_shop uuid;admin_shop uuid;fixed uuid;auction uuid;second uuid;oid uuid;answer jsonb;photo text;result jsonb;
begin
 select id into seller_shop from public.th_shops where user_id=seller;select id into buyer_shop from public.th_shops where user_id=buyer;select id into admin_shop from public.th_shops where user_id=admin;
 perform public.th_test_claims(buyer);update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=buyer;
 begin perform public.th_api('snapshot');raise exception 'Banned user RPC access bypass';exception when sqlstate 'PT401' then null;end;
 perform public.th_test_assert(not public.th_email_confirmed(),'banned user cannot upload even with old JWT');update auth.users set banned_until=null where id=buyer;
 perform public.th_test_claims(unverified);
 begin perform public.th_api('verification','{"name":"Unverified","location":"Bangkok","bio":"Private reference requiring manual review"}');raise exception 'Unverified email bypass';exception when sqlstate 'PT403' then null;end;
 perform public.th_test_claims(seller);
 perform public.th_test_assert(public.th_text(to_jsonb(E'Line one\nLine two\r\n\tTabbed text'::text),'Multiline',1,200)=E'Line one\nLine two\r\n\tTabbed text','textarea permits newline carriage return and tab');
 begin perform public.th_text(to_jsonb(E'Invalid\x01text'::text),'Control character',1,100);raise exception 'Control character accepted';exception when sqlstate 'PT400' then null;end;
 perform public.th_api('verification',jsonb_build_object('name','Seller shop','location','Bangkok','bio',E'SECRET_VERIFICATION_EVIDENCE_FOR_TEST_ONLY\nSecond private evidence line\twith tab'));
 perform public.th_test_assert((select status='pending' from public.th_shops where id=seller_shop),'verification starts pending');
 perform set_config('request.jwt.claims','{}',true);answer:=public.th_api('snapshot');
 perform public.th_test_assert(answer->'user'='null'::jsonb,'anonymous state has no user');
 perform public.th_test_assert(position('SECRET_VERIFICATION' in answer::text)=0,'anonymous cannot read evidence');
 begin perform public.th_api('profile','{"name":"attacker","shop":"attacker"}');raise exception 'Anon write bypass';exception when sqlstate 'PT401' then null;end;
 perform public.th_test_claims(buyer,'aal2');
 begin perform public.th_api('admin_requests');raise exception 'Non-admin bypass';exception when sqlstate 'PT403' then null;end;
 perform public.th_test_claims(admin);
 begin perform public.th_api('admin_requests');raise exception 'Admin no MFA bypass';exception when sqlstate 'PT403' then null;end;
 perform public.th_test_claims(admin,'aal2',601);
 begin perform public.th_api('admin_requests');raise exception 'Stale admin MFA bypass';exception when sqlstate 'PT403' then null;end;
 perform public.th_test_claims(admin,'aal2');answer:=public.th_api('admin_requests');perform public.th_test_assert(position('SECRET_VERIFICATION' in answer::text)>0,'admin can inspect evidence');
 perform public.th_api('review',jsonb_build_object('shopId',seller_shop,'status','verified','note','Checked independent references for this test shop'));
 perform public.th_api('verification','{"name":"Admin shop","location":"Bangkok","bio":"Private admin verification requiring a second reviewer"}');
 begin perform public.th_api('review',jsonb_build_object('shopId',admin_shop,'status','verified','note','Self approval must always be rejected by the database'));raise exception 'Admin self approval bypass';exception when sqlstate 'PT403' then null;end;
 -- Simulate a separate authorized operator having reviewed the second store.
 update public.th_shops set status='verified' where id=admin_shop;
 photo:=seller::text||'/20000000-0000-4000-8000-000000000001.png';
 insert into storage.objects(bucket_id,name,owner_id,metadata) values('product-photos',photo,seller::text,'{"mimetype":"image/png","size":1024}');
 perform public.th_test_claims(seller);answer:=public.th_api('upload_register',jsonb_build_object('path',photo));
 perform public.th_test_assert(answer->>'image'='/api/media/'||photo,'upload image contract');
 perform public.th_api('product_create',jsonb_build_object('title','A fixed lamp','description',E'A genuine item described for testing\nSecond description line\twith tab','category','home','condition','สภาพดี','location','Bangkok','image','/api/media/'||photo,'price',100,'mode','fixed','verified',true));
 select id into fixed from public.th_products where shop_id=seller_shop;
 perform public.th_api('product_create',jsonb_build_object('title','Auction lamp','description','Auction item described in detail','category','home','condition','สภาพดี','location','Bangkok','image','/api/media/'||photo,'price',100,'mode','auction','step',10,'hours',1));
 select id into auction from public.th_products where mode='auction';
 begin perform public.th_api('bid',jsonb_build_object('productId',auction,'amount',110,'requestKey','own-bid-test-01'));raise exception 'Own bid bypass';exception when sqlstate 'PT403' then null;end;
 perform public.th_test_claims(buyer);
 begin perform public.th_api('upload_register',jsonb_build_object('path',photo));raise exception 'Foreign upload ownership bypass';exception when sqlstate 'PT403' then null;end;
 perform public.th_api('bid',jsonb_build_object('productId',auction,'amount',110,'requestKey','buyer-bid-test-01'));
 perform public.th_api('bid',jsonb_build_object('productId',auction,'amount',110,'requestKey','buyer-bid-test-01'));
 perform public.th_test_assert((select count(*)=1 from public.th_bids where product_id=auction),'bid retries idempotent');
 begin perform public.th_api('bid',jsonb_build_object('productId',auction,'amount',120,'requestKey','buyer-bid-test-01'));raise exception 'Bid key reuse bypass';exception when sqlstate 'PT409' then null;end;
 -- A second store's item in the same reservation must not leak to the first.
 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode) values(admin_shop,'Other shop item','Other store item description','home','สภาพดี','Bangkok',photo,333,'fixed') returning id into second;
 begin perform public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(fixed),'delivery','pickup','requestKey','auction-'||auction));raise exception 'System auction request key namespace collision';exception when sqlstate 'PT400' then null;end;
 answer:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(fixed,second),'delivery','pickup','requestKey','checkout-test-0001'));oid:=(answer->>'orderId')::uuid;
 result:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(second,fixed),'delivery','pickup','requestKey','checkout-test-0001'));perform public.th_test_assert(result->>'orderId'=oid::text,'reordered checkout retry idempotent');
 begin perform public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(fixed),'delivery','pickup','requestKey','checkout-test-0001'));raise exception 'Order key reused payload bypass';exception when sqlstate 'PT409' then null;end;
 perform public.th_test_claims(seller);answer:=public.th_api('sales');
 perform public.th_test_assert(jsonb_array_length(answer->'sales')=1,'seller sees own sale');
 perform public.th_test_assert((answer#>>'{sales,0,subtotal}')::integer=100,'seller subtotal excludes other stores');
 perform public.th_test_assert(jsonb_array_length(answer#>'{sales,0,items}')=1,'seller sees only own items');
 perform public.th_test_assert(position('Other shop item' in answer::text)=0 and position('buyer-th-test@example.invalid' in answer::text)=0,'no other shop content or buyer email');
 perform public.th_test_assert(answer#>'{sales,0,address}'='null'::jsonb,'pickup MVP collects no address');
 begin perform public.th_api('cancel',jsonb_build_object('orderId',oid));raise exception 'Foreign cancel bypass';exception when sqlstate 'PT404' then null;end;
 perform public.th_test_claims(buyer);perform public.th_api('cancel',jsonb_build_object('orderId',oid));perform public.th_test_assert((select status='active' from public.th_products where id=fixed),'cancel releases item');
 begin perform public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(fixed),'delivery','shipping','address','Private address','requestKey','shipping-test-001'));raise exception 'Shipping address accepted';exception when sqlstate 'PT400' then null;end;
 answer:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(fixed),'delivery','pickup','requestKey','checkout-test-0002'));oid:=(answer->>'orderId')::uuid;
 update public.th_orders set expires_at=public.th_now()-1 where id=oid;perform public.th_settle();perform public.th_test_assert((select status='expired' from public.th_orders where id=oid),'stale reservation expires');
 update public.th_products set ends_at=public.th_now()-1 where id=auction;perform public.th_settle();perform public.th_settle();perform public.th_test_assert((select count(*)=1 from public.th_orders where request_key='auction-'||auction),'auction settlement idempotent');
 perform public.th_test_claims(seller);perform public.th_api('profile','{"name":"Seller","shop":"Changed legal shop name"}');perform public.th_test_assert((select status='none' from public.th_shops where id=seller_shop),'renaming revokes shop verification');
end$$;

-- Exercise real database role grants/RLS, rather than only definer owner calls.
select public.th_test_claims('10000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$begin
 begin perform 1 from public.th_verification_details;raise exception 'Private table readable';exception when insufficient_privilege then null;end;
 begin update public.th_profiles set role='admin' where id=auth.uid();raise exception 'Role writable';exception when insufficient_privilege then null;end;
 begin perform public.th_settle();raise exception 'Private maintenance executable';exception when insufficient_privilege then null;end;
 -- Valid own-folder image can be uploaded; other folders are denied by RLS.
 insert into storage.objects(bucket_id,name,metadata) values('product-photos','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000099.png','{"mimetype":"image/png","size":1024}');
 begin insert into storage.objects(bucket_id,name,metadata) values('product-photos','10000000-0000-4000-8000-000000000002/20000000-0000-4000-8000-000000000099.png','{"mimetype":"image/png","size":1024}');raise exception 'Foreign folder upload bypass';exception when insufficient_privilege then null;end;
end$$;
reset role;
-- Fill the remaining own-folder allowance as the test operator, then exercise
-- the INSERT policy as the real authenticated role. Includes unregistered files.
insert into storage.objects(bucket_id,name,owner_id,metadata)
select 'product-photos','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-'||lpad(n::text,12,'0')||'.png','10000000-0000-4000-8000-000000000001','{"mimetype":"image/png","size":1024}'::jsonb
from generate_series(1,198)n;
select public.th_test_assert((select count(*)=200 from storage.objects where bucket_id='product-photos' and (storage.foldername(name))[1]='10000000-0000-4000-8000-000000000001'),'quota includes all own-folder objects');
set local role authenticated;
do $$begin
 begin insert into storage.objects(bucket_id,name,metadata) values('product-photos','10000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000099.png','{"mimetype":"image/png","size":1024}');raise exception 'Direct Storage API bypassed image quota';exception when insufficient_privilege then null;end;
end$$;
reset role;
select public.th_test_assert(not has_function_privilege('anon','public.th_photo_quota()','EXECUTE'),'quota helper not executable by anonymous clients');
select public.th_test_assert(not has_function_privilege('anon','public.th_snapshot()','EXECUTE'),'private snapshot helper not exposed');
select public.th_test_assert(not has_function_privilege('authenticated','public.th_limit(uuid,text,integer,integer)','EXECUTE'),'clients cannot choose rate-limit key');
select public.th_test_assert(has_function_privilege('anon','public.th_api(text,jsonb)','EXECUTE'),'anon can call only approved RPC dispatcher');
rollback;

-- A fixed-snapshot transaction must fail closed rather than bypass counting.
begin isolation level repeatable read;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$begin if public.th_photo_quota() then raise exception 'Quota accepted unsafe transaction isolation';end if;end$$;
rollback;
