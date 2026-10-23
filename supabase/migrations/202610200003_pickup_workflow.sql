begin;

alter table public.th_products drop constraint th_products_status_check;
alter table public.th_products add constraint th_products_status_check check(status in ('active','reserved','ended','sold','withdrawn'));
alter table public.th_orders drop constraint th_orders_status_check;
alter table public.th_orders add constraint th_orders_status_check check(status in ('reserved','partially_completed','completed','cancelled','expired'));
alter table public.th_orders add column closed_at bigint;
create index th_pickup_expiry on public.th_orders(expires_at,id) where closed_at is null and status in ('reserved','partially_completed');
alter table public.th_reports add column reviewed_by uuid references public.th_profiles(id);
alter table public.th_reports add column reviewed_at bigint;
alter table public.th_reports add column review_note text check(char_length(review_note) between 10 and 1500);

create table public.th_order_handoffs (
 order_id uuid not null references public.th_orders(id),shop_id uuid not null references public.th_shops(id),
 buyer_confirmed_at bigint,seller_confirmed_at bigint,completed_at bigint,
 primary key(order_id,shop_id),
 check(completed_at is null or (buyer_confirmed_at is not null and seller_confirmed_at is not null))
);
create table public.th_order_messages (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.th_orders(id),shop_id uuid not null references public.th_shops(id),
 sender_id uuid not null references public.th_profiles(id),sender_role text not null check(sender_role in ('buyer','seller')),
 text text not null check(char_length(text) between 1 and 2000),created_at bigint not null default public.th_now()
);
create index th_thread_messages on public.th_order_messages(order_id,shop_id,created_at desc,id desc);
alter table public.th_order_handoffs enable row level security;
alter table public.th_order_messages enable row level security;
revoke all on public.th_order_handoffs,public.th_order_messages from public,anon,authenticated;

-- Keep the reviewed Auth/verification/bidding/reservation rules internal. A
-- wrapper exposes additional actions; callers cannot bypass its cancellation
-- guard by invoking the previous implementation directly.
alter function public.th_api(text,jsonb) rename to th_api_v2_base;
revoke all on function public.th_api_v2_base(text,jsonb) from public,anon,authenticated;
-- Upgrade older installed dispatcher bodies that qualified a local request_key
-- with the former implicit function label. Renaming must not break bid/reserve.
do $upgrade$
declare definition text;begin
 definition:=pg_get_functiondef('public.th_api_v2_base(text,jsonb)'::regprocedure);
 definition:=replace(definition,'th_api.request_key','rpc.request_key');
 if definition !~* '<<[[:space:]]*rpc[[:space:]]*>>' then
  definition:=regexp_replace(definition,'(AS \$[^$]*\$[[:space:]]*)(declare)',E'\\1<<rpc>>\n\\2','i');
 end if;
 if definition !~* '<<[[:space:]]*rpc[[:space:]]*>>' then raise exception 'Cannot normalize legacy marketplace dispatcher';end if;
 execute definition;
end $upgrade$;

alter function public.th_snapshot() rename to th_snapshot_v2_base;
revoke all on function public.th_snapshot_v2_base() from public,anon,authenticated;

create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_snapshot_v2_base();begin
 result:=result||jsonb_build_object('pickupWorkflow',true);
 result:=jsonb_set(result,'{orders}',coalesce((select jsonb_agg(v||jsonb_build_object(
  'closedAt',o.closed_at,
  'items',(select jsonb_agg(jsonb_build_object('id',i.product_id,'title',i.title,'price',i.price,'shopId',i.shop_id)) from public.th_order_items i where i.order_id=o.id),
  'handoffs',(select jsonb_agg(jsonb_build_object('shopId',s.id,'shopName',s.name,'buyerConfirmedAt',h.buyer_confirmed_at,'sellerConfirmedAt',h.seller_confirmed_at,'completedAt',h.completed_at) order by s.id) from public.th_shops s left join public.th_order_handoffs h on h.shop_id=s.id and h.order_id=o.id where exists(select 1 from public.th_order_items i where i.order_id=o.id and i.shop_id=s.id))
 ) order by o.created_at desc,o.id) from jsonb_array_elements(result->'orders') x(v) join public.th_orders o on o.id=(v->>'id')::uuid and o.user_id=auth.uid()),'[]'::jsonb));
 return result;
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;

-- Only still-reserved products are ever released. Completed shop handoffs keep
-- their products sold even if other shops' pickup reservations subsequently end.
create or replace function public.th_settle() returns void language plpgsql security definer set search_path='' as $$
declare p public.th_products%rowtype;b public.th_bids%rowtype;o public.th_orders%rowtype;oid uuid;ms bigint:=public.th_now();begin
 for p in select * from public.th_products where mode='auction' and status='active' and ends_at<=ms order by ends_at,id limit 50 for update skip locked loop
  if not exists(select 1 from public.th_shops where id=p.shop_id and status='verified') then update public.th_products set status='ended' where id=p.id;continue;end if;
  select * into b from public.th_bids where product_id=p.id order by amount desc limit 1;
  if not found then update public.th_products set status='ended' where id=p.id;continue;end if;
  insert into public.th_orders(user_id,total,request_key,payload) values(b.user_id,b.amount,'auction-'||p.id,jsonb_build_object('auction',p.id)) returning id into oid;
  insert into public.th_order_items values(oid,p.id,p.shop_id,p.title,b.amount);
  update public.th_products set status='reserved',reserved_order_id=oid where id=p.id;
 end loop;
 for o in select * from public.th_orders where status in ('reserved','partially_completed') and closed_at is null and expires_at<=ms order by expires_at,id limit 50 for update skip locked loop
  update public.th_orders set status=case when exists(select 1 from public.th_products where reserved_order_id=o.id and status='sold') then 'partially_completed' else 'expired' end,closed_at=ms where id=o.id;
  update public.th_products set status=case when mode='auction' then 'ended' else 'active' end,reserved_order_id=null where reserved_order_id=o.id and status='reserved';
 end loop;
end$$;
revoke all on function public.th_settle() from public,anon,authenticated;

create function public.th_order_thread(oid uuid,sid uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.th_require_user();o public.th_orders%rowtype;s public.th_shops%rowtype;h public.th_order_handoffs%rowtype;open_thread boolean;begin
 select * into o from public.th_orders where id=oid;select * into s from public.th_shops where id=sid;
 if o.id is null or s.id is null or not exists(select 1 from public.th_order_items where order_id=oid and shop_id=sid) or (o.user_id<>uid and s.user_id<>uid) then raise exception using errcode='PT404',message='Order conversation not found';end if;
 select * into h from public.th_order_handoffs where order_id=oid and shop_id=sid;
 open_thread:=o.status in ('reserved','partially_completed') and o.closed_at is null and o.expires_at>public.th_now() and h.completed_at is null;
 return jsonb_build_object('orderId',oid,'shopId',sid,'orderStatus',o.status,'expiresAt',o.expires_at,'closedAt',o.closed_at,'canMessage',open_thread,'canConfirm',open_thread and (case when uid=o.user_id then h.buyer_confirmed_at is null else h.seller_confirmed_at is null end),'participantRole',case when uid=o.user_id then 'buyer' else 'seller' end,
  'handoff',jsonb_build_object('buyerConfirmedAt',h.buyer_confirmed_at,'sellerConfirmedAt',h.seller_confirmed_at,'completedAt',h.completed_at),
  'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'text',m.text,'senderRole',m.sender_role,'senderName',pr.name,'at',m.created_at) order by m.created_at,m.id) from (select * from public.th_order_messages where order_id=oid and shop_id=sid order by created_at desc,id desc limit 100)m join public.th_profiles pr on pr.id=m.sender_id),'[]'::jsonb));
end$$;
revoke all on function public.th_order_thread(uuid,uuid) from public,anon,authenticated;

create function public.th_api(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<rpc>>
declare uid uuid;oid uuid;sid uuid;pid uuid;o public.th_orders%rowtype;s public.th_shops%rowtype;p public.th_products%rowtype;h public.th_order_handoffs%rowtype;
 message_text text;ms bigint;changed integer;expected integer;result jsonb;
begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 if action not in ('order_messages','order_message','order_handoff','sales','cancel','product_update','product_withdraw','admin_reports','review_report') then return public.th_api_v2_base(action,payload);end if;
 uid:=public.th_require_user();perform public.th_limit(uid,'all',120,60);
 -- Reads can close overdue reservations, but never reopen completed handoffs.
 perform public.th_settle();
 if action='admin_reports' then
  perform public.th_require_admin();return jsonb_build_object('reports',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'reason',r.reason,'details',r.details,'productId',r.product_id,'productTitle',p1.title,'status',r.status,'createdAt',r.created_at,'reviewedAt',r.reviewed_at,'reviewNote',r.review_note,'reporterName',pr.name) order by r.created_at desc,r.id) from (select * from public.th_reports order by created_at desc,id limit 100)r join public.th_profiles pr on pr.id=r.user_id left join public.th_products p1 on p1.id=r.product_id),'[]'::jsonb));
 elsif action='review_report' then
  perform public.th_require_admin();pid:=(payload->>'reportId')::uuid;message_text:=public.th_text(payload->'note','Private review note',10,1500);
  perform 1 from public.th_reports where id=pid and status='open' for update;
  if not found then raise exception using errcode='PT409',message='Open report not found';end if;
  update public.th_reports set status='reviewed',reviewed_by=uid,reviewed_at=public.th_now(),review_note=message_text where id=pid;
  insert into public.th_events(user_id,action,subject) values(uid,action,pid::text);return jsonb_build_object('ok',true);
 elsif action in ('product_update','product_withdraw') then
  perform public.th_limit(uid,'listing_management',30,3600);pid:=(payload->>'productId')::uuid;
  select p1.* into p from public.th_products p1 join public.th_shops s1 on s1.id=p1.shop_id where p1.id=pid and s1.user_id=uid for update of p1;
  if not found then raise exception using errcode='PT404',message='Own listing not found';end if;
  select * into s from public.th_shops where id=p.shop_id;
  if s.status<>'verified' then raise exception using errcode='PT403',message='Verified shop required';end if;
  if p.status<>'active' or exists(select 1 from public.th_bids where product_id=p.id) then raise exception using errcode='PT409',message='Listing with bids or a reservation cannot be changed';end if;
  if action='product_withdraw' then
   update public.th_products set status='withdrawn' where id=p.id;delete from public.th_cart where product_id=p.id;
  else
   update public.th_products set
    title=case when payload?'title' then public.th_text(payload->'title','Title',1,90) else p.title end,
    description=case when payload?'description' then public.th_text(payload->'description','Description',10,1500) else p.description end,
    category=case when payload?'category' then public.th_text(payload->'category','Category',1,30) else p.category end,
    condition=case when payload?'condition' then public.th_text(payload->'condition','Condition',1,30) else p.condition end,
    location=case when payload?'location' then public.th_text(payload->'location','Location',1,120) else p.location end,
    price=case when payload?'price' then public.th_integer(payload->'price','Price',1,10000000) else p.price end
   where id=p.id;
  end if;
  insert into public.th_events(user_id,action,subject) values(uid,action,p.id::text);return public.th_snapshot();
 elsif action='sales' then
  select * into s from public.th_shops where user_id=uid;
  -- A shop that lost verification can still resolve its existing orders; this
  -- does not grant listing, bidding or new reservation privileges.
  if s.status<>'verified' and not exists(select 1 from public.th_order_items where shop_id=s.id) then raise exception using errcode='PT403',message='Seller access required';end if;
  return jsonb_build_object('sales',coalesce((select jsonb_agg(jsonb_build_object('id',orders.id,'shopId',s.id,'status',orders.status,'at',orders.created_at,'expiresAt',orders.expires_at,'closedAt',orders.closed_at,'buyerName',pr.name,'delivery','pickup','address',null,
   'handoff',jsonb_build_object('buyerConfirmedAt',hh.buyer_confirmed_at,'sellerConfirmedAt',hh.seller_confirmed_at,'completedAt',hh.completed_at),
   'subtotal',(select sum(price) from public.th_order_items where order_id=orders.id and shop_id=s.id),
   'items',(select jsonb_agg(jsonb_build_object('id',product_id,'title',title,'price',price,'shopId',shop_id)) from public.th_order_items where order_id=orders.id and shop_id=s.id)) order by orders.created_at desc,orders.id)
  from public.th_orders orders join public.th_profiles pr on pr.id=orders.user_id left join public.th_order_handoffs hh on hh.order_id=orders.id and hh.shop_id=s.id where exists(select 1 from public.th_order_items where order_id=orders.id and shop_id=s.id)),'[]'::jsonb));
 end if;
 oid:=(payload->>'orderId')::uuid;
 if action='cancel' then
  select * into o from public.th_orders where id=oid and user_id=uid for update;
  if not found then raise exception using errcode='PT404',message='Own reservation not found';end if;
  if o.status<>'reserved' or o.closed_at is not null or exists(select 1 from public.th_order_handoffs where order_id=oid and (buyer_confirmed_at is not null or seller_confirmed_at is not null)) or exists(select 1 from public.th_products where reserved_order_id=oid and status='sold') then raise exception using errcode='PT409',message='Pickup with a handoff confirmation cannot be cancelled';end if;
  update public.th_orders set status='cancelled',closed_at=public.th_now() where id=oid;
  update public.th_products set status=case when mode='auction' then 'ended' else 'active' end,reserved_order_id=null where reserved_order_id=oid and status='reserved';
  insert into public.th_events(user_id,action,subject) values(uid,action,oid::text);return public.th_snapshot();
 end if;
 sid:=(payload->>'shopId')::uuid;
 if action='order_messages' then return public.th_order_thread(oid,sid);end if;
 -- Both parties mutate the same order row, serializing completion, cancellation
 -- and expiry. Other sellers on a multi-shop order are not thread participants.
 select * into o from public.th_orders where id=oid for update;
 select * into s from public.th_shops where id=sid;
 if o.id is null or s.id is null or not exists(select 1 from public.th_order_items where order_id=oid and shop_id=sid) or (o.user_id<>uid and s.user_id<>uid) then raise exception using errcode='PT404',message='Order conversation not found';end if;
 select * into h from public.th_order_handoffs where order_id=oid and shop_id=sid;
 if action='order_handoff' and h.completed_at is not null then return public.th_order_thread(oid,sid);end if;
 ms:=public.th_now();
 if o.status not in ('reserved','partially_completed') or o.closed_at is not null or o.expires_at<=ms or h.completed_at is not null then raise exception using errcode='PT409',message='This pickup conversation is read only';end if;
 if action='order_message' then
  perform public.th_limit(uid,'order_message',30,60);message_text:=public.th_text(payload->'text','Message',1,2000);
  if (select count(*) from public.th_order_messages where order_id=oid and shop_id=sid)>=200 then raise exception using errcode='PT409',message='Conversation reached its message limit';end if;
  insert into public.th_order_messages(order_id,shop_id,sender_id,sender_role,text) values(oid,sid,uid,case when uid=o.user_id then 'buyer' else 'seller' end,message_text);
 else
  perform public.th_limit(uid,'order_handoff',20,60);
  insert into public.th_order_handoffs(order_id,shop_id) values(oid,sid) on conflict do nothing;
  if uid=o.user_id then update public.th_order_handoffs set buyer_confirmed_at=coalesce(buyer_confirmed_at,ms) where order_id=oid and shop_id=sid;
  else update public.th_order_handoffs set seller_confirmed_at=coalesce(seller_confirmed_at,ms) where order_id=oid and shop_id=sid;end if;
  select * into h from public.th_order_handoffs where order_id=oid and shop_id=sid;
  if h.buyer_confirmed_at is not null and h.seller_confirmed_at is not null then
   select count(*) into expected from public.th_order_items where order_id=oid and shop_id=sid;
   update public.th_products set status='sold' where reserved_order_id=oid and shop_id=sid and status='reserved';get diagnostics changed=row_count;
   if changed<>expected then raise exception using errcode='PT409',message='Reserved items changed; pickup cannot complete';end if;
   update public.th_order_handoffs set completed_at=ms where order_id=oid and shop_id=sid;
   if not exists(select 1 from public.th_order_items i where i.order_id=oid and not exists(select 1 from public.th_order_handoffs done where done.order_id=oid and done.shop_id=i.shop_id and done.completed_at is not null)) then
    update public.th_orders set status='completed',closed_at=ms where id=oid;
   else update public.th_orders set status='partially_completed' where id=oid;end if;
  end if;
 end if;
 insert into public.th_events(user_id,action,subject) values(uid,action,oid::text||'/'||sid::text);
 return public.th_order_thread(oid,sid);
end$$;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
commit;
