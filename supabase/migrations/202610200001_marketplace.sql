begin;

create function public.th_now() returns bigint language sql volatile set search_path='' as $$select floor(extract(epoch from clock_timestamp())*1000)::bigint$$;

create table public.th_profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 name text not null check(char_length(name) between 1 and 60),
 role text not null default 'user' check(role in ('user','admin')),
 created_at bigint not null default public.th_now()
);
create table public.th_shops (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references public.th_profiles(id),
 name text not null check(char_length(name) between 1 and 80),location text not null default '' check(char_length(location)<=120),
 bio text not null default '' check(char_length(bio)<=1500),status text not null default 'none' check(status in ('none','pending','verified','rejected')),
 submitted_at bigint,reviewed_at bigint,reviewed_by uuid references public.th_profiles(id),review_note text check(char_length(review_note)<=1500)
);
create table public.th_verification_details (
 shop_id uuid primary key references public.th_shops(id) on delete cascade,
 details text not null check(char_length(details) between 20 and 1500)
);
create table public.th_uploads (
 path text primary key,user_id uuid not null references public.th_profiles(id),created_at bigint not null default public.th_now(),
 check(path ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(png|jpg|webp)$')
);
create table public.th_products (
 id uuid primary key default gen_random_uuid(), shop_id uuid not null references public.th_shops(id),
 title text not null check(char_length(title) between 1 and 90),description text not null check(char_length(description) between 10 and 1500),
 category text not null check(category in ('fashion','electronics','home','camera','collectibles','sports')),
 condition text not null check(condition in ('เหมือนใหม่','สภาพดีมาก','สภาพดี','มีตำหนิ')),
 location text not null check(char_length(location) between 1 and 120),image_path text not null references public.th_uploads(path),
 price integer not null check(price between 1 and 10000000),mode text not null check(mode in ('fixed','auction')),
 bid_step integer not null default 50 check(bid_step between 1 and 100000),ends_at bigint,
 status text not null default 'active' check(status in ('active','reserved','ended')),
 reserved_order_id uuid,created_at bigint not null default public.th_now(),
 check((mode='auction' and ends_at is not null) or (mode='fixed' and ends_at is null))
);
create index th_auction_due on public.th_products(ends_at,id) where mode='auction' and status='active';
create index th_products_shop on public.th_products(shop_id);
create table public.th_bids (
 id uuid primary key default gen_random_uuid(),product_id uuid not null references public.th_products(id),user_id uuid not null references public.th_profiles(id),
 amount integer not null check(amount between 1 and 10000000),created_at bigint not null default public.th_now(),request_key text not null check(char_length(request_key) between 10 and 100),
 unique(user_id,request_key)
);
create index th_bids_product on public.th_bids(product_id,amount desc);
create table public.th_favorites(user_id uuid not null references public.th_profiles(id) on delete cascade,product_id uuid not null references public.th_products(id),primary key(user_id,product_id));
create table public.th_cart(user_id uuid not null references public.th_profiles(id) on delete cascade,product_id uuid not null references public.th_products(id),primary key(user_id,product_id));
create table public.th_orders (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.th_profiles(id),
 total integer not null check(total>0),delivery text not null default 'pickup' check(delivery='pickup'),
 status text not null default 'reserved' check(status in ('reserved','cancelled','expired')),
 created_at bigint not null default public.th_now(),expires_at bigint not null default (public.th_now()+1800000),
 request_key text not null check(char_length(request_key) between 10 and 100),payload jsonb not null,
 unique(user_id,request_key)
);
create index th_orders_expiry on public.th_orders(expires_at,id) where status='reserved';
alter table public.th_products add constraint th_product_reservation foreign key(reserved_order_id) references public.th_orders(id);
create table public.th_order_items (
 order_id uuid not null references public.th_orders(id),product_id uuid not null references public.th_products(id),
 shop_id uuid not null references public.th_shops(id),title text not null,price integer not null check(price>0),primary key(order_id,product_id)
);
create index th_seller_items on public.th_order_items(shop_id,order_id);
create table public.th_reports (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.th_profiles(id),product_id uuid references public.th_products(id),
 reason text not null check(char_length(reason) between 1 and 150),details text not null check(char_length(details) between 10 and 2000),
 status text not null default 'open' check(status in ('open','reviewed')),created_at bigint not null default public.th_now()
);
create table public.th_events(id bigint generated always as identity primary key,user_id uuid references public.th_profiles(id),action text not null,subject text,created_at bigint not null default public.th_now());
create table public.th_limits(user_id uuid not null references public.th_profiles(id) on delete cascade,action text not null,count integer not null,expires_at bigint not null,primary key(user_id,action));

-- No application role can read/write private tables, even through PostgREST directly.
-- All user-facing authorization lives in the small RPC surface below; RLS also
-- protects against accidental grants added later. Definer functions are owned by
-- the migration operator, never anon/authenticated.
do $$declare t text;begin
 foreach t in array array['th_profiles','th_shops','th_verification_details','th_uploads','th_products','th_bids','th_favorites','th_cart','th_orders','th_order_items','th_reports','th_events','th_limits'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
 end loop;
end$$;
revoke all on sequence public.th_events_id_seq from public,anon,authenticated;

create function public.th_text(value jsonb,label text,min_len integer,max_len integer) returns text language plpgsql immutable set search_path='' as $$
declare result text;begin
 if jsonb_typeof(value) is distinct from 'string' then raise exception using errcode='PT400',message=label||' must be text';end if;
 result=btrim(value#>>'{}');if char_length(result)<min_len or char_length(result)>max_len or regexp_replace(result,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then raise exception using errcode='PT400',message=label||' is invalid';end if;return result;
end$$;
create function public.th_integer(value jsonb,label text,min_value integer,max_value integer) returns integer language plpgsql immutable set search_path='' as $$
declare result numeric;begin
 if jsonb_typeof(value) is distinct from 'number' then raise exception using errcode='PT400',message=label||' must be an integer';end if;
 result=(value#>>'{}')::numeric;if trunc(result)<>result or result<min_value or result>max_value then raise exception using errcode='PT400',message=label||' is out of range';end if;return result::integer;
end$$;
create function public.th_require_user(verified boolean default true) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();u auth.users%rowtype;n text;begin
 if uid is null then raise exception using errcode='PT401',message='Sign in required';end if;
 select * into u from auth.users where id=uid;if not found or u.deleted_at is not null or u.banned_until>clock_timestamp() then raise exception using errcode='PT401',message='Account unavailable';end if;
 if verified and u.email_confirmed_at is null then raise exception using errcode='PT403',message='Verify your email first';end if;
 n=left(coalesce(nullif(btrim(u.raw_user_meta_data->>'name'),''),nullif(btrim(u.raw_user_meta_data->>'full_name'),''),'สมาชิก'),60);
 insert into public.th_profiles(id,name) values(uid,n) on conflict(id) do nothing;
 insert into public.th_shops(user_id,name) values(uid,left('ร้านของ '||n,80)) on conflict(user_id) do nothing;
 return uid;
end$$;
create function public.th_require_admin() returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.th_require_user();begin
 if not exists(select 1 from public.th_profiles where id=uid and role='admin') or coalesce(auth.jwt()->>'aal','')<>'aal2' or not exists(select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr','[]'::jsonb)) method where method->>'method' in ('totp','mfa/totp') and (method->>'timestamp')::numeric between extract(epoch from clock_timestamp())-600 and extract(epoch from clock_timestamp())+60) then raise exception using errcode='PT403',message='Administrator with MFA required';end if;return uid;
end$$;
create function public.th_limit(uid uuid,bucket text,max_count integer,seconds integer) returns void language plpgsql security definer set search_path='' as $$
declare hits integer;ms bigint:=public.th_now();begin
 insert into public.th_limits as l(user_id,action,count,expires_at) values(uid,bucket,1,ms+seconds::bigint*1000)
 on conflict(user_id,action) do update set count=case when l.expires_at<=ms then 1 else l.count+1 end,expires_at=case when l.expires_at<=ms then ms+seconds::bigint*1000 else l.expires_at end returning count into hits;
 if hits>max_count then raise exception using errcode='PT429',message='Too many requests; try later';end if;
end$$;

-- Bounded, safe to run repeatedly. Scheduled execution is recommended so an
-- auction can settle without a visitor. No bids/orders can mark money paid.
create function public.th_settle() returns void language plpgsql security definer set search_path='' as $$
declare p public.th_products%rowtype;b public.th_bids%rowtype;o public.th_orders%rowtype;oid uuid;ms bigint:=public.th_now();begin
 for p in select * from public.th_products where mode='auction' and status='active' and ends_at<=ms order by ends_at,id limit 50 for update skip locked loop
  if not exists(select 1 from public.th_shops where id=p.shop_id and status='verified') then update public.th_products set status='ended' where id=p.id;continue;end if;
  select * into b from public.th_bids where product_id=p.id order by amount desc limit 1;
  if not found then update public.th_products set status='ended' where id=p.id;continue;end if;
  insert into public.th_orders(user_id,total,request_key,payload) values(b.user_id,b.amount,'auction-'||p.id,jsonb_build_object('auction',p.id)) returning id into oid;
  insert into public.th_order_items values(oid,p.id,p.shop_id,p.title,b.amount);
  update public.th_products set status='reserved',reserved_order_id=oid where id=p.id;
 end loop;
 for o in select * from public.th_orders where status='reserved' and expires_at<=ms order by expires_at,id limit 50 for update skip locked loop
  update public.th_orders set status='expired' where id=o.id;
  update public.th_products set status=case when mode='auction' then 'ended' else 'active' end,reserved_order_id=null where reserved_order_id=o.id;
 end loop;
end$$;

create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();u auth.users%rowtype;pr public.th_profiles%rowtype;shop public.th_shops%rowtype;result jsonb;begin
 if uid is not null then perform public.th_require_user(false);select * into u from auth.users where id=uid;select * into pr from public.th_profiles where id=uid;select * into shop from public.th_shops where user_id=uid;end if;
 result=jsonb_build_object(
  'serverTime',public.th_now(),
  'user',case when uid is null then null else jsonb_build_object('id',uid,'email',u.email,'name',pr.name,'role',pr.role,'emailVerified',u.email_confirmed_at is not null,'mfaEnabled',exists(select 1 from auth.mfa_factors where user_id=uid and status='verified')) end,
  'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'store',p.shop_id,'title',p.title,'description',p.description,'category',p.category,'condition',p.condition,'location',p.location,'image','/api/media/'||p.image_path,'price',p.price,'mode',p.mode,'step',p.bid_step,'endsAt',p.ends_at,'status',p.status,'createdAt',p.created_at,'bids',(select count(*) from public.th_bids b where b.product_id=p.id),'isDemo',false) order by p.created_at desc,p.id) from public.th_products p),'[]'::jsonb),
  'stores',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'initial',left(s.name,1),'location',s.location,'bio',s.bio,'status',s.status,'verified',s.status='verified','isDemo',false)) from public.th_shops s),'[]'::jsonb),
  'profile',jsonb_build_object('name',coalesce(pr.name,'ผู้เยี่ยมชม'),'shop',coalesce(shop.name,'ร้านของฉัน'),'shopId',shop.id),
  'verification',jsonb_build_object('status',coalesce(shop.status,'none'),'reviewNote',shop.review_note),
  'favorites',coalesce((select jsonb_agg(product_id) from public.th_favorites where user_id=uid),'[]'::jsonb),
  'cart',coalesce((select jsonb_agg(product_id) from public.th_cart where user_id=uid),'[]'::jsonb),
  'bids',coalesce((select jsonb_object_agg(x.product_id,jsonb_build_object('history',x.history)) from (select product_id,jsonb_agg(jsonb_build_object('price',amount,'at',created_at) order by created_at,id) as history from public.th_bids where user_id=uid group by product_id)x),'{}'::jsonb),
  'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'total',o.total,'delivery',o.delivery,'address','','status',o.status,'at',o.created_at,'expiresAt',o.expires_at,'items',(select jsonb_agg(jsonb_build_object('id',i.product_id,'title',i.title,'price',i.price)) from public.th_order_items i where i.order_id=o.id)) order by o.created_at desc) from public.th_orders o where o.user_id=uid),'[]'::jsonb));
 return result;
end$$;

create function public.th_api(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<rpc>>
declare uid uuid;s public.th_shops%rowtype;p public.th_products%rowtype;b public.th_bids%rowtype;o public.th_orders%rowtype;
 oid uuid;pid uuid;upload_path text;request_key text;target_status text;note text;name_value text;location_value text;details_value text;
 ids uuid[];canonical jsonb;item_count integer;total_value integer;amount_value integer;mode_value text;price_value integer;step_value integer;hours_value integer;
begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 if action='media' then
  upload_path:=public.th_text(payload->'path','Image path',1,200);
  if not exists(select 1 from public.th_products where image_path=upload_path) then raise exception using errcode='PT404',message='Image not found';end if;return jsonb_build_object('path',upload_path);
 end if;
 if action='snapshot' then perform public.th_settle();return public.th_snapshot();end if;
 -- Refresh confirmed-email state from auth.users, never from user-supplied metadata.
 uid:=public.th_require_user(action not in ('profile','favorite_add','favorite_remove','cart_add','cart_remove','sales'));
 perform public.th_limit(uid,'all',120,60);
 select * into s from public.th_shops where user_id=uid;
 if action='profile' then
  name_value:=public.th_text(payload->'name','Name',1,60);details_value:=public.th_text(payload->'shop','Shop name',1,80);
  update public.th_profiles set name=name_value where id=uid;
  if s.name<>details_value then update public.th_shops set name=details_value,status='none',reviewed_by=null,reviewed_at=null,review_note=null where id=s.id;end if;
 elsif action='verification' then
  perform public.th_limit(uid,'verification',5,3600);
  if s.status in ('pending','verified') then raise exception using errcode='PT409',message='Shop is already pending or verified';end if;
  name_value:=public.th_text(payload->'name','Shop name',1,80);location_value:=public.th_text(payload->'location','Location',1,120);details_value:=public.th_text(payload->'bio','Private verification details',20,1500);
  update public.th_shops set name=name_value,location=location_value,status='pending',submitted_at=public.th_now(),reviewed_by=null,review_note=null,reviewed_at=null where id=s.id;
  insert into public.th_verification_details(shop_id,details) values(s.id,details_value) on conflict(shop_id) do update set details=excluded.details;
 elsif action='admin_requests' then
  perform public.th_require_admin();return jsonb_build_object('requests',coalesce((select jsonb_agg(jsonb_build_object('id',sh.id,'name',sh.name,'location',sh.location,'details',d.details,'status',sh.status,'submitted_at',sh.submitted_at,'email',u.email,'owner_name',pr.name) order by sh.submitted_at) from public.th_shops sh join public.th_verification_details d on d.shop_id=sh.id join auth.users u on u.id=sh.user_id join public.th_profiles pr on pr.id=sh.user_id where sh.status='pending'),'[]'::jsonb),'reports',coalesce((select jsonb_agg(to_jsonb(r)) from (select id,product_id,reason,details,status,created_at from public.th_reports order by created_at desc limit 100)r),'[]'::jsonb));
 elsif action='review' then
  perform public.th_require_admin();pid:=(payload->>'shopId')::uuid;target_status:=public.th_text(payload->'status','Status',1,20);note:=public.th_text(payload->'note','Review note',20,1500);
  if target_status not in ('verified','rejected') then raise exception using errcode='PT400',message='Invalid review decision';end if;
  select * into s from public.th_shops where id=pid for update;
  if not found or s.status<>'pending' then raise exception using errcode='PT409',message='No pending request';end if;
  if s.user_id=uid then raise exception using errcode='PT403',message='Cannot approve your own shop';end if;
  if not exists(select 1 from auth.users where id=s.user_id and email_confirmed_at is not null) then raise exception using errcode='PT403',message='Shop owner must verify email';end if;
  update public.th_shops set status=target_status,reviewed_by=uid,reviewed_at=public.th_now(),review_note=note where id=s.id;
 elsif action='upload_register' then
  perform public.th_limit(uid,'upload',20,3600);upload_path:=public.th_text(payload->'path','Image path',1,200);
  if upload_path !~ ('^'||uid::text||'/[a-f0-9-]{36}\.(png|jpg|webp)$') then raise exception using errcode='PT403',message='Image must be in your folder';end if;
  if not exists(select 1 from storage.objects ob where ob.bucket_id='product-photos' and ob.name=upload_path and ob.owner_id=uid::text and (ob.metadata->>'mimetype') in ('image/png','image/jpeg','image/webp') and (ob.metadata->>'size')::bigint between 1 and 2097152) then raise exception using errcode='PT400',message='Uploaded image not found or invalid';end if;
  insert into public.th_uploads(path,user_id) values(upload_path,uid) on conflict(path) do nothing;
  return jsonb_build_object('image','/api/media/'||upload_path);
 elsif action='product_create' then
  perform public.th_limit(uid,'product',20,3600);if s.status<>'verified' then raise exception using errcode='PT403',message='Shop verification required';end if;
  upload_path:=public.th_text(payload->'image','Image',1,220);if left(upload_path,11)<>'/api/media/' then raise exception using errcode='PT400',message='Upload your image first';end if;upload_path:=substr(upload_path,12);
  if not exists(select 1 from public.th_uploads where path=upload_path and user_id=uid) then raise exception using errcode='PT403',message='Image ownership required';end if;
  mode_value:=public.th_text(payload->'mode','Mode',1,10);if mode_value not in ('fixed','auction') then raise exception using errcode='PT400',message='Invalid sale mode';end if;
  price_value:=public.th_integer(payload->'price','Price',1,10000000);step_value:=50;hours_value:=0;
  if mode_value='auction' then step_value:=public.th_integer(payload->'step','Bid step',1,100000);hours_value:=public.th_integer(payload->'hours','Hours',1,168);end if;
  insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode,bid_step,ends_at)
  values(s.id,public.th_text(payload->'title','Title',1,90),public.th_text(payload->'description','Description',10,1500),public.th_text(payload->'category','Category',1,30),public.th_text(payload->'condition','Condition',1,30),public.th_text(payload->'location','Location',1,120),upload_path,price_value,mode_value,step_value,case when mode_value='auction' then public.th_now()+hours_value::bigint*3600000 else null end);
 elsif action='bid' then
  perform public.th_limit(uid,'bid',30,60);pid:=(payload->>'productId')::uuid;request_key:=public.th_text(payload->'requestKey','Request key',10,100);amount_value:=public.th_integer(payload->'amount','Amount',1,10000000);
  perform pg_advisory_xact_lock(hashtextextended('bid:'||uid::text||':'||request_key,0));
  select * into b from public.th_bids where user_id=uid and th_bids.request_key=rpc.request_key;
  if found then if b.product_id<>pid or b.amount<>amount_value then raise exception using errcode='PT409',message='Request key reused with different bid';end if;return public.th_snapshot();end if;
  select * into p from public.th_products where id=pid for update;
  if not found then raise exception using errcode='PT404',message='Product not found';end if;
  select * into s from public.th_shops where id=p.shop_id;
  if s.user_id=uid then raise exception using errcode='PT403',message='Cannot bid on own listing';end if;
  if s.status<>'verified' or p.mode<>'auction' or p.status<>'active' or p.ends_at<=public.th_now() then raise exception using errcode='PT409',message='Auction unavailable';end if;
  if amount_value<p.price+p.bid_step then raise exception using errcode='PT409',message='Bid is below next minimum';end if;
  insert into public.th_bids(product_id,user_id,amount,request_key) values(pid,uid,amount_value,request_key);
  update public.th_products set price=amount_value where id=pid;
 elsif action in ('favorite_add','favorite_remove','cart_add','cart_remove') then
  pid:=(payload->>'productId')::uuid;select * into p from public.th_products where id=pid;
  if not found then raise exception using errcode='PT404',message='Product not found';end if;
  if action='cart_add' then
   if p.mode<>'fixed' or p.status<>'active' or exists(select 1 from public.th_shops where id=p.shop_id and user_id=uid) then raise exception using errcode='PT409',message='Item cannot be added to cart';end if;
   insert into public.th_cart values(uid,pid) on conflict do nothing;
  elsif action='cart_remove' then delete from public.th_cart where user_id=uid and product_id=pid;
  elsif action='favorite_add' then insert into public.th_favorites values(uid,pid) on conflict do nothing;
  else delete from public.th_favorites where user_id=uid and product_id=pid;end if;
 elsif action='reserve' then
  perform public.th_limit(uid,'reserve',20,3600);
  if coalesce(payload->>'delivery','pickup')<>'pickup' or coalesce(payload->>'address','')<>'' then raise exception using errcode='PT400',message='MVP supports pickup only; do not submit an address';end if;
  request_key:=public.th_text(payload->'requestKey','Request key',10,100);
  if left(request_key,8)='auction-' then raise exception using errcode='PT400',message='Reserved system request key prefix';end if;
  if jsonb_typeof(payload->'productIds') is distinct from 'array' then raise exception using errcode='PT400',message='Select products';end if;
  item_count:=jsonb_array_length(payload->'productIds');if item_count<1 or item_count>20 then raise exception using errcode='PT400',message='Select 1 to 20 items';end if;
  select array_agg(distinct val::uuid order by val::uuid) into ids from jsonb_array_elements_text(payload->'productIds')x(val);
  if cardinality(ids)<>item_count then raise exception using errcode='PT400',message='Duplicate products';end if;
  canonical:=jsonb_build_object('productIds',to_jsonb(ids),'delivery','pickup');
  perform pg_advisory_xact_lock(hashtextextended('reserve:'||uid::text||':'||request_key,0));
  select * into o from public.th_orders where user_id=uid and th_orders.request_key=rpc.request_key;
  if found then if o.payload<>canonical then raise exception using errcode='PT409',message='Request key reused with different order';end if;return jsonb_build_object('ok',true,'orderId',o.id);end if;
  total_value:=0;item_count:=0;
  -- Same lock order for every checkout avoids cross-item deadlocks.
  for p in select * from public.th_products where id=any(ids) order by id for update loop
   item_count:=item_count+1;select * into s from public.th_shops where id=p.shop_id;
   if p.mode<>'fixed' or p.status<>'active' or s.status<>'verified' or s.user_id=uid then raise exception using errcode='PT409',message='An item is unavailable';end if;total_value:=total_value+p.price;
  end loop;
  if item_count<>cardinality(ids) then raise exception using errcode='PT404',message='Product not found';end if;
  insert into public.th_orders(user_id,total,request_key,payload) values(uid,total_value,request_key,canonical) returning id into oid;
  insert into public.th_order_items(order_id,product_id,shop_id,title,price) select oid,id,shop_id,title,price from public.th_products where id=any(ids);
  update public.th_products set status='reserved',reserved_order_id=oid where id=any(ids);
  delete from public.th_cart where user_id=uid and product_id=any(ids);
  insert into public.th_events(user_id,action,subject) values(uid,action,oid::text);return jsonb_build_object('ok',true,'orderId',oid);
 elsif action='cancel' then
  oid:=(payload->>'orderId')::uuid;select * into o from public.th_orders where id=oid and user_id=uid for update;
  if not found then raise exception using errcode='PT404',message='Reservation not found';end if;
  if o.status<>'reserved' then raise exception using errcode='PT409',message='Reservation cannot be cancelled';end if;
  update public.th_orders set status='cancelled' where id=oid;
  update public.th_products set status=case when mode='auction' then 'ended' else 'active' end,reserved_order_id=null where reserved_order_id=oid;
 elsif action='sales' then
  perform public.th_require_user(true);if s.status<>'verified' then raise exception using errcode='PT403',message='Verified seller required';end if;
  return jsonb_build_object('sales',coalesce((select jsonb_agg(jsonb_build_object('id',orders.id,'status',orders.status,'at',orders.created_at,'expiresAt',orders.expires_at,'buyerName',pr.name,'delivery','pickup','address',null,'subtotal',(select sum(price) from public.th_order_items where order_id=orders.id and shop_id=s.id),'items',(select jsonb_agg(jsonb_build_object('id',product_id,'title',title,'price',price)) from public.th_order_items where order_id=orders.id and shop_id=s.id)) order by orders.created_at desc) from public.th_orders orders join public.th_profiles pr on pr.id=orders.user_id where exists(select 1 from public.th_order_items where order_id=orders.id and shop_id=s.id)),'[]'::jsonb));
 elsif action='report' then
  perform public.th_limit(uid,'report',10,3600);pid:=nullif(payload->>'productId','')::uuid;
  insert into public.th_reports(user_id,product_id,reason,details) values(uid,pid,public.th_text(payload->'reason','Reason',1,150),public.th_text(payload->'details','Details',10,2000));
 else raise exception using errcode='PT404',message='Unknown marketplace action';end if;
 insert into public.th_events(user_id,action,subject) values(uid,action,coalesce(pid::text,oid::text));
 return public.th_snapshot();
end$$;

-- Storage access: own folder uploads only, no overwrite/delete mutation grants.
-- A listing photo is public marketplace content, while unlisted objects remain
-- readable only by their owner. Never put identity documents in this bucket.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('product-photos','product-photos',false,2097152,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=2097152,allowed_mime_types=excluded.allowed_mime_types;
create function public.th_photo_readable(object_name text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.th_products where image_path=object_name) or exists(select 1 from public.th_uploads where path=object_name and user_id=auth.uid())
$$;
create function public.th_email_confirmed() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp()))$$;
-- VOLATILE is required: the count must observe commits after waiting for the
-- per-user transaction lock. Fail closed under a fixed/stale snapshot isolation.
-- Count the authenticated UUID folder, not client-supplied object ownership.
create function public.th_photo_quota() returns boolean language plpgsql volatile security definer set search_path='' as $$
declare uid uuid:=auth.uid();objects bigint;begin
 if uid is null or current_setting('transaction_isolation')<>'read committed' then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('photo-quota:'||uid::text,0));
 select count(*) into objects from storage.objects where bucket_id='product-photos' and (storage.foldername(name))[1]=uid::text;
 return objects<200;
end$$;
create policy th_photo_insert on storage.objects for insert to authenticated with check(
 bucket_id='product-photos' and (storage.foldername(name))[1]=auth.uid()::text
 and name ~ ('^'||auth.uid()::text||'/[a-f0-9-]{36}\.(png|jpg|webp)$')
 and auth.jwt()->>'email' is not null
 and owner_id=auth.uid()::text and public.th_email_confirmed() and public.th_photo_quota()
);
create policy th_photo_select on storage.objects for select to anon,authenticated using(
 bucket_id='product-photos' and (owner_id=auth.uid()::text or public.th_photo_readable(name))
);
-- Revoke default PUBLIC execute before exposing only the two intended surfaces.
revoke all on function public.th_now() from public,anon,authenticated;
revoke all on function public.th_text(jsonb,text,integer,integer) from public,anon,authenticated;
revoke all on function public.th_integer(jsonb,text,integer,integer) from public,anon,authenticated;
revoke all on function public.th_require_user(boolean) from public,anon,authenticated;
revoke all on function public.th_require_admin() from public,anon,authenticated;
revoke all on function public.th_limit(uuid,text,integer,integer) from public,anon,authenticated;
revoke all on function public.th_settle() from public,anon,authenticated;
revoke all on function public.th_snapshot() from public,anon,authenticated;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
revoke all on function public.th_photo_readable(text) from public,anon,authenticated;
revoke all on function public.th_email_confirmed() from public,anon,authenticated;
revoke all on function public.th_photo_quota() from public,anon,authenticated;
grant execute on function public.th_photo_quota() to authenticated;
grant execute on function public.th_email_confirmed() to authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
grant execute on function public.th_photo_readable(text) to anon,authenticated;
commit;
