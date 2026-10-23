begin;
-- Simulated payment records only. No card data, bank account or real gateway.
alter table public.th_orders add column payment_required boolean not null default false;
alter table public.th_orders alter column payment_required set default true;
alter table public.th_order_handoffs add column preparing_at bigint;
alter table public.th_order_handoffs add column ready_at bigint;
alter table public.th_order_handoffs add constraint th_ready_prepared check(ready_at is null or preparing_at is not null);
create table public.th_order_payments (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.th_orders(id),user_id uuid not null references public.th_profiles(id),
 request_key text not null check(char_length(request_key) between 10 and 100),method text not null check(method in ('qr_demo','card_demo')),
 outcome text not null check(outcome in ('success','declined')),amount integer not null check(amount>0),reference text not null unique,
 created_at bigint not null default public.th_now(),unique(user_id,request_key)
);
create unique index th_one_successful_demo_payment on public.th_order_payments(order_id) where outcome='success';
alter table public.th_order_payments enable row level security;
revoke all on public.th_order_payments from public,anon,authenticated;
create function public.th_payment(oid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce((select jsonb_build_object('status','paid_demo','method',method,'reference',reference,'paidAt',created_at,'amount',amount,'isDemo',true) from public.th_order_payments where order_id=oid and outcome='success'),jsonb_build_object('status','unpaid','isDemo',true));
$$;
revoke all on function public.th_payment(uuid) from public,anon,authenticated;
alter function public.th_snapshot() rename to th_snapshot_v3_base;
revoke all on function public.th_snapshot_v3_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_snapshot_v3_base();begin
 result:=result||jsonb_build_object('orderPayments',true);
 result:=jsonb_set(result,'{orders}',coalesce((select jsonb_agg(v||jsonb_build_object('paymentRequired',o.payment_required,'payment',public.th_payment(o.id),
 'paymentAttempts',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'method',p.method,'outcome',p.outcome,'amount',p.amount,'reference',p.reference,'at',p.created_at,'isDemo',true) order by p.created_at,p.id) from public.th_order_payments p where p.order_id=o.id and p.user_id=auth.uid()),'[]'::jsonb),
 'handoffs',(select jsonb_agg(hv||jsonb_build_object('preparingAt',h.preparing_at,'readyAt',h.ready_at,'fulfillmentStatus',case when h.ready_at is not null then 'ready' when h.preparing_at is not null then 'preparing' else 'pending' end)) from jsonb_array_elements(v->'handoffs')x(hv) left join public.th_order_handoffs h on h.order_id=o.id and h.shop_id=(hv->>'shopId')::uuid)
 ) order by o.created_at desc,o.id) from jsonb_array_elements(result->'orders')x(v) join public.th_orders o on o.id=(v->>'id')::uuid and o.user_id=auth.uid()),'[]'::jsonb));return result;
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
-- Successful demo payments retain reservations until both sides complete pickup.
-- Keep their display deadline seven days away, while settlement and thread checks
-- treat an existing successful payment as open until explicit completion.
do $$declare definition text;begin
 definition:=pg_get_functiondef('public.th_settle()'::regprocedure);
 definition:=replace(definition,'and expires_at<=ms order by expires_at,id','and expires_at<=ms and not exists(select 1 from public.th_order_payments pay where pay.order_id=th_orders.id and pay.outcome=''success'') order by expires_at,id');execute definition;
end$$;
alter function public.th_order_thread(uuid,uuid) rename to th_order_thread_v3_base;
revoke all on function public.th_order_thread_v3_base(uuid,uuid) from public,anon,authenticated;
do $$declare definition text;begin
 definition:=pg_get_functiondef('public.th_order_thread_v3_base(uuid,uuid)'::regprocedure);
 definition:=replace(definition,'o.expires_at>public.th_now()','(o.expires_at>public.th_now() or exists(select 1 from public.th_order_payments pay where pay.order_id=o.id and pay.outcome=''success''))');execute definition;
end$$;
create function public.th_order_thread(oid uuid,sid uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_order_thread_v3_base(oid,sid);o public.th_orders%rowtype;h public.th_order_handoffs%rowtype;paid boolean;begin
 select * into o from public.th_orders where id=oid;select * into h from public.th_order_handoffs where order_id=oid and shop_id=sid;
 paid:=exists(select 1 from public.th_order_payments where order_id=oid and outcome='success');
 return result||jsonb_build_object('paymentRequired',o.payment_required,'payment',case when o.user_id=auth.uid() then public.th_payment(oid) else jsonb_build_object('status',case when paid then 'paid_demo' else 'unpaid' end,'isDemo',true) end,
 'canConfirm',coalesce((result->>'canConfirm')::boolean,false) and (not o.payment_required or (paid and h.ready_at is not null)),
 'handoff',(result->'handoff')||jsonb_build_object('preparingAt',h.preparing_at,'readyAt',h.ready_at,'fulfillmentStatus',case when h.ready_at is not null then 'ready' when h.preparing_at is not null then 'preparing' else 'pending' end));
end$$;
revoke all on function public.th_order_thread(uuid,uuid) from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v3_base;
revoke all on function public.th_api_v3_base(text,jsonb) from public,anon,authenticated;
do $$declare definition text;begin
 definition:=pg_get_functiondef('public.th_api_v3_base(text,jsonb)'::regprocedure);
 definition:=replace(definition,'o.expires_at<=ms','(o.expires_at<=ms and not exists(select 1 from public.th_order_payments pay where pay.order_id=o.id and pay.outcome=''success''))');execute definition;
end$$;
create function public.th_api(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<rpc>>
declare uid uuid;oid uuid;sid uuid;o public.th_orders%rowtype;p public.th_order_payments%rowtype;key_value text;method_value text;outcome_value text;state_value text;result jsonb;paid boolean;ms bigint:=public.th_now();begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 if action not in ('pay','fulfill','order_handoff','cancel','sales') then return public.th_api_v3_base(action,payload);end if;
 uid:=public.th_require_user();
 if action='sales' then
  result:=public.th_api_v3_base(action,payload);
  return jsonb_set(result,'{sales}',coalesce((select jsonb_agg(v||jsonb_build_object('paymentRequired',o1.payment_required,'paymentDemo',exists(select 1 from public.th_order_payments where order_id=o1.id and outcome='success'),'payment',jsonb_build_object('status',case when exists(select 1 from public.th_order_payments where order_id=o1.id and outcome='success') then 'paid_demo' else 'unpaid' end,'isDemo',true),
  'handoff',(v->'handoff')||jsonb_build_object('preparingAt',h.preparing_at,'readyAt',h.ready_at,'fulfillmentStatus',case when h.ready_at is not null then 'ready' when h.preparing_at is not null then 'preparing' else 'pending' end)) order by o1.created_at desc,o1.id) from jsonb_array_elements(result->'sales')x(v) join public.th_orders o1 on o1.id=(v->>'id')::uuid left join public.th_order_handoffs h on h.order_id=o1.id and h.shop_id=(v->>'shopId')::uuid),'[]'::jsonb));
 end if;
 oid:=(payload->>'orderId')::uuid;
 if action='pay' then
  perform public.th_limit(uid,'demo_payment',30,60);
  key_value:=public.th_text(payload->'requestKey','Request key',10,100);method_value:=payload->>'method';outcome_value:=payload->>'outcome';
  if method_value is null or method_value not in ('qr_demo','card_demo') or outcome_value is null or outcome_value not in ('success','declined') then raise exception using errcode='PT400',message='Simulated payment method and outcome required';end if;
  perform pg_advisory_xact_lock(hashtextextended('pay:'||uid::text||':'||key_value,0));
  select * into p from public.th_order_payments where user_id=uid and request_key=key_value;
  if found then
   if p.order_id is distinct from oid or p.method<>method_value or p.outcome<>outcome_value then raise exception using errcode='PT409',message='Payment request key reused with different payload';end if;
  end if;
 end if;
 select * into o from public.th_orders where id=oid for update;
 if not found or (action in ('pay','cancel') and o.user_id<>uid) then raise exception using errcode='PT404',message='Own order not found';end if;
 paid:=exists(select 1 from public.th_order_payments where order_id=oid and outcome='success');
 if action='pay' then
  if p.id is null then
   if paid then raise exception using errcode='PT409',message='Order already has a successful simulated payment';end if;
   if o.status<>'reserved' or o.closed_at is not null or o.expires_at<=ms then raise exception using errcode='PT409',message='Open reservation required for simulated payment';end if;
   insert into public.th_order_payments(order_id,user_id,request_key,method,outcome,amount,reference) values(oid,uid,key_value,method_value,outcome_value,o.total,'DEMO-'||gen_random_uuid()) returning * into p;
   if outcome_value='success' then update public.th_orders set expires_at=ms+604800000 where id=oid;end if;
   insert into public.th_events(user_id,action,subject) values(uid,'demo_payment_'||outcome_value,oid::text);
  end if;
  result:=public.th_snapshot();return jsonb_build_object('payment',public.th_payment(oid),'attempt',jsonb_build_object('id',p.id,'outcome',p.outcome,'method',p.method,'reference',p.reference,'amount',p.amount,'at',p.created_at,'isDemo',true),'state',result);
 elsif action='cancel' then
  if paid then raise exception using errcode='PT409',message='Paid demo order cannot be cancelled; no real charge or refund exists';end if;
  return public.th_api_v3_base(action,payload);
 end if;
 sid:=(payload->>'shopId')::uuid;
 if not exists(select 1 from public.th_order_items i join public.th_shops s on s.id=i.shop_id where i.order_id=oid and i.shop_id=sid and (s.user_id=uid or (action='order_handoff' and o.user_id=uid))) then raise exception using errcode='PT404',message='Own shop order not found';end if;
 if action='order_handoff' then
  if o.payment_required and (not paid or not exists(select 1 from public.th_order_handoffs where order_id=oid and shop_id=sid and ready_at is not null)) then raise exception using errcode='PT409',message='Simulated payment and seller readiness required before pickup';end if;
  return public.th_api_v3_base(action,payload);
 end if;
 perform public.th_limit(uid,'fulfill',30,60);state_value:=payload->>'status';
 if state_value is null or state_value not in ('preparing','ready') then raise exception using errcode='PT400',message='Fulfillment status must be preparing or ready';end if;
 if not paid or o.status not in ('reserved','partially_completed') or o.closed_at is not null then raise exception using errcode='PT409',message='Successful simulated payment required before preparing';end if;
 insert into public.th_order_handoffs(order_id,shop_id) values(oid,sid) on conflict do nothing;
 if exists(select 1 from public.th_order_handoffs where order_id=oid and shop_id=sid and completed_at is not null) then raise exception using errcode='PT409',message='Pickup already completed';end if;
 if state_value='ready' and not exists(select 1 from public.th_order_handoffs where order_id=oid and shop_id=sid and preparing_at is not null) then raise exception using errcode='PT409',message='Prepare items before marking ready';end if;
 update public.th_order_handoffs set preparing_at=coalesce(preparing_at,ms),ready_at=case when state_value='ready' then coalesce(ready_at,ms) else ready_at end where order_id=oid and shop_id=sid;
 insert into public.th_events(user_id,action,subject) values(uid,'fulfill_'||state_value,oid::text||'/'||sid::text);
 return public.th_order_thread(oid,sid);
end$$;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
commit;
