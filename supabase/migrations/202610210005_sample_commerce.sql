begin;
-- Fictional catalog purchases use real signed-in ownership, with no fake seller
-- account, verification badge, physical stock or movement of money.
create table public.th_sample_cart (
 user_id uuid not null references public.th_profiles(id),product_id text not null,kind text not null default 'product' check(kind='product'),
 created_at bigint not null default public.th_now(),primary key(user_id,product_id),foreign key(kind,product_id) references public.th_demo_catalog(kind,id)
);
create table public.th_sample_orders (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.th_profiles(id),total integer not null check(total>0),
 status text not null default 'reserved' check(status in ('reserved','completed','cancelled','expired')),
 request_key text not null check(char_length(request_key) between 10 and 100),payload jsonb not null,items jsonb not null check(jsonb_typeof(items)='array'),
 created_at bigint not null default public.th_now(),expires_at bigint not null default(public.th_now()+1800000),completed_at bigint,
 unique(user_id,request_key)
);
create table public.th_sample_payments (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.th_sample_orders(id),user_id uuid not null references public.th_profiles(id),
 request_key text not null check(char_length(request_key) between 10 and 100),method text not null check(method in ('qr_demo','card_demo')),
 outcome text not null check(outcome in ('success','declined')),amount integer not null check(amount>0),reference text not null unique,
 created_at bigint not null default public.th_now(),unique(user_id,request_key)
);
create unique index th_one_successful_sample_payment on public.th_sample_payments(order_id) where outcome='success';
alter table public.th_sample_cart enable row level security;
alter table public.th_sample_orders enable row level security;
alter table public.th_sample_payments enable row level security;
revoke all on public.th_sample_cart,public.th_sample_orders,public.th_sample_payments from public,anon,authenticated;
create function public.th_sample_payment(oid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce((select jsonb_build_object('status','paid_demo','method',method,'reference',reference,'paidAt',created_at,'amount',amount,'isDemo',true) from public.th_sample_payments where order_id=oid and outcome='success'),jsonb_build_object('status','unpaid','isDemo',true));
$$;
revoke all on function public.th_sample_payment(uuid) from public,anon,authenticated;
alter function public.th_snapshot() rename to th_snapshot_v4_base;
revoke all on function public.th_snapshot_v4_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_snapshot_v4_base();uid uuid:=auth.uid();begin
 update public.th_sample_orders orders set status='expired' where user_id=uid and status='reserved' and expires_at<=public.th_now() and not exists(select 1 from public.th_sample_payments p where p.order_id=orders.id and outcome='success');
 result:=result||jsonb_build_object('sampleCommerce',true);
 result:=jsonb_set(result,'{products}',coalesce((select jsonb_agg(v||case when v->'isDemo'='true'::jsonb and v->>'mode'='fixed' then jsonb_build_object('purchasableDemo',true,'description','รายการสำหรับทดลองซื้อขายบนเว็บหลัก ชำระเงินจำลองเท่านั้น ไม่มีการส่งสินค้าหรือรับเงินจริง') else '{}'::jsonb end order by ord) from jsonb_array_elements(result->'products') with ordinality x(v,ord)),'[]'::jsonb));
 result:=jsonb_set(result,'{cart}',(result->'cart')||coalesce((select jsonb_agg(product_id order by created_at,product_id) from public.th_sample_cart where user_id=uid),'[]'::jsonb));
 result:=jsonb_set(result,'{orders}',coalesce((select jsonb_agg(v order by (v->>'at')::bigint desc,v->>'id') from (
 select value v from jsonb_array_elements(result->'orders') union all
 select jsonb_build_object('id',o.id,'source','sample','isDemo',true,'paymentRequired',true,'status',o.status,'total',o.total,'delivery','pickup','address','','at',o.created_at,'expiresAt',o.expires_at,'closedAt',o.completed_at,'items',o.items,'handoffs','[]'::jsonb,'payment',public.th_sample_payment(o.id),
 'paymentAttempts',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'method',p.method,'outcome',p.outcome,'amount',p.amount,'reference',p.reference,'at',p.created_at,'isDemo',true) order by p.created_at,p.id) from public.th_sample_payments p where p.order_id=o.id and p.user_id=uid),'[]'::jsonb)) from public.th_sample_orders o where o.user_id=uid
 )all_orders),'[]'::jsonb));return result;
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v4_base;
revoke all on function public.th_api_v4_base(text,jsonb) from public,anon,authenticated;
create function public.th_api(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<rpc>>
declare uid uuid;pid text;oid uuid;o public.th_sample_orders%rowtype;p public.th_sample_payments%rowtype;key_value text;method_value text;outcome_value text;canonical jsonb;items_value jsonb;ids jsonb;total_value integer;n integer;sample_count integer;result jsonb;ms bigint:=public.th_now();begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 if action not in ('cart_add','cart_remove','reserve','pay','cancel','sample_complete') then return public.th_api_v4_base(action,payload);end if;
 uid:=public.th_require_user();
 if action in ('cart_add','cart_remove') then
  pid:=payload->>'productId';
  if not exists(select 1 from public.th_demo_catalog where kind='product' and id=pid) then return public.th_api_v4_base(action,payload);end if;
  if action='cart_add' then
   perform public.th_limit(uid,'sample_cart',60,60);
   if not exists(select 1 from public.th_demo_catalog where kind='product' and id=pid and data->>'mode'='fixed') then raise exception using errcode='PT409',message='Sample auctions are display only';end if;
   insert into public.th_sample_cart(user_id,product_id) values(uid,pid) on conflict do nothing;
  else delete from public.th_sample_cart where user_id=uid and product_id=pid;end if;
  return public.th_snapshot();
 elsif action='reserve' then
  ids:=payload->'productIds';
  if jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids)<1 or jsonb_array_length(ids)>20 then raise exception using errcode='PT400',message='Select 1 to 20 products';end if;
  select count(*) into sample_count from jsonb_array_elements_text(ids)x(id) join public.th_demo_catalog c on c.kind='product' and c.id=x.id;
  if sample_count=0 then
   key_value:=public.th_text(payload->'requestKey','Request key',10,100);perform pg_advisory_xact_lock(hashtextextended('reserve:'||uid::text||':'||key_value,0));
   if exists(select 1 from public.th_sample_orders where user_id=uid and request_key=key_value) then raise exception using errcode='PT409',message='Order request key reused with different payload';end if;
   return public.th_api_v4_base(action,payload);
  end if;
  if sample_count<>jsonb_array_length(ids) then raise exception using errcode='PT400',message='Sample and seller products require separate orders';end if;
  if exists(select 1 from jsonb_array_elements_text(ids)x(id) group by id having count(*)>1) then raise exception using errcode='PT400',message='Duplicate sample product';end if;
  if payload->>'delivery' is distinct from 'pickup' then raise exception using errcode='PT400',message='Sample purchases simulate pickup only';end if;
  if exists(select 1 from jsonb_array_elements_text(ids)x(id) join public.th_demo_catalog c on c.kind='product' and c.id=x.id where c.data->>'mode'<>'fixed') then raise exception using errcode='PT409',message='Sample auctions are display only';end if;
  key_value:=public.th_text(payload->'requestKey','Request key',10,100);
  if left(key_value,8)='auction-' then raise exception using errcode='PT400',message='Reserved system request key prefix';end if;
  canonical:=jsonb_build_object('productIds',(select jsonb_agg(id order by id) from jsonb_array_elements_text(ids)x(id)),'delivery','pickup');
  perform pg_advisory_xact_lock(hashtextextended('reserve:'||uid::text||':'||key_value,0));
  if exists(select 1 from public.th_orders where user_id=uid and request_key=key_value) then raise exception using errcode='PT409',message='Order request key reused with different payload';end if;
  select * into o from public.th_sample_orders where user_id=uid and request_key=key_value;
  if found then
   if o.payload<>canonical then raise exception using errcode='PT409',message='Order request key reused with different payload';end if;
   return jsonb_build_object('orderId',o.id,'state',public.th_snapshot());
  end if;
  perform public.th_limit(uid,'sample_reserve',20,3600);
  select sum((c.data->>'price')::integer),jsonb_agg(jsonb_build_object('id',c.id,'title',c.data->>'title','price',(c.data->>'price')::integer,'shopId',c.data->>'store','isDemo',true) order by c.id) into total_value,items_value from public.th_demo_catalog c where c.kind='product' and c.id in(select jsonb_array_elements_text(ids));
  insert into public.th_sample_orders(user_id,total,request_key,payload,items) values(uid,total_value,key_value,canonical,items_value) returning id into oid;
  delete from public.th_sample_cart where user_id=uid and product_id in(select jsonb_array_elements_text(ids));
  insert into public.th_events(user_id,action,subject) values(uid,'sample_reserve',oid::text);return jsonb_build_object('orderId',oid,'state',public.th_snapshot());
 end if;
 oid:=(payload->>'orderId')::uuid;
 if action='pay' then
  key_value:=public.th_text(payload->'requestKey','Request key',10,100);perform pg_advisory_xact_lock(hashtextextended('pay:'||uid::text||':'||key_value,0));
  if exists(select 1 from public.th_sample_payments where user_id=uid and request_key=key_value and order_id<>oid) or exists(select 1 from public.th_order_payments where user_id=uid and request_key=key_value and order_id<>oid) then raise exception using errcode='PT409',message='Payment request key reused with different payload';end if;
 end if;
 if not exists(select 1 from public.th_sample_orders where id=oid) then
  if action='sample_complete' then raise exception using errcode='PT404',message='Own sample order not found';end if;
  return public.th_api_v4_base(action,payload);
 end if;
 select * into o from public.th_sample_orders where id=oid and user_id=uid for update;
 if not found then raise exception using errcode='PT404',message='Own sample order not found';end if;
 if action='pay' then
  perform public.th_limit(uid,'sample_payment',30,60);method_value:=payload->>'method';outcome_value:=payload->>'outcome';
  if method_value is null or method_value not in ('qr_demo','card_demo') or outcome_value is null or outcome_value not in ('success','declined') then raise exception using errcode='PT400',message='Simulated payment method and outcome required';end if;
  select * into p from public.th_sample_payments where user_id=uid and request_key=key_value;
  if found then
   if p.order_id<>oid or p.method<>method_value or p.outcome<>outcome_value then raise exception using errcode='PT409',message='Payment request key reused with different payload';end if;
  else
   if exists(select 1 from public.th_sample_payments where order_id=oid and outcome='success') then raise exception using errcode='PT409',message='Sample order already paid';end if;
   if o.status<>'reserved' or o.expires_at<=ms then raise exception using errcode='PT409',message='Open sample reservation required';end if;
   insert into public.th_sample_payments(order_id,user_id,request_key,method,outcome,amount,reference) values(oid,uid,key_value,method_value,outcome_value,o.total,'DEMO-SAMPLE-'||gen_random_uuid()) returning * into p;
   insert into public.th_events(user_id,action,subject) values(uid,'sample_payment_'||outcome_value,oid::text);
  end if;
  return jsonb_build_object('payment',public.th_sample_payment(oid),'attempt',jsonb_build_object('id',p.id,'outcome',p.outcome,'method',p.method,'reference',p.reference,'amount',p.amount,'at',p.created_at,'isDemo',true),'state',public.th_snapshot());
 elsif action='cancel' then
  if exists(select 1 from public.th_sample_payments where order_id=oid and outcome='success') then raise exception using errcode='PT409',message='Paid sample order cannot be cancelled; no real refund exists';end if;
  if o.status<>'reserved' then raise exception using errcode='PT409',message='Open sample order required';end if;
  update public.th_sample_orders set status='cancelled' where id=oid;
 else
  if not exists(select 1 from public.th_sample_payments where order_id=oid and outcome='success') then raise exception using errcode='PT409',message='Successful simulated payment required';end if;
  if o.status='completed' then return public.th_snapshot();end if;
  if o.status<>'reserved' then raise exception using errcode='PT409',message='Open sample order required';end if;
  update public.th_sample_orders set status='completed',completed_at=ms where id=oid;
 end if;
 insert into public.th_events(user_id,action,subject) values(uid,case when action='cancel' then 'sample_cancel' else 'sample_complete' end,oid::text);
 return public.th_snapshot();
end$$;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
comment on table public.th_demo_catalog is 'Fictional catalog. Fixed-price samples may be purchased through private per-user simulated orders. No actual seller verification, stock or funds.';
commit;
