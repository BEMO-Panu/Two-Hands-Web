begin;
alter table public.th_orders drop constraint th_orders_delivery_check;
alter table public.th_orders add constraint th_orders_delivery_check check(delivery in ('pickup','shipping'));
-- Polymorphic order reference: RPC validates an actual or sample order with the
-- same owner while holding its row lock. No direct application grants exist.
create table public.th_order_delivery (
 order_id uuid primary key,user_id uuid not null references public.th_profiles(id),delivery text not null check(delivery in ('pickup','shipping')),
 recipient_name text,phone text,address text,initial_payload jsonb,
 check((delivery='pickup' and recipient_name is null and phone is null and address is null) or (delivery='shipping' and recipient_name is not null and phone is not null and address is not null and char_length(recipient_name) between 1 and 100 and char_length(phone) between 6 and 30 and char_length(address) between 10 and 1000))
);
create table public.th_order_shipments (
 order_id uuid not null references public.th_orders(id),shop_id uuid not null references public.th_shops(id),
 carrier text not null check(char_length(carrier) between 1 and 80),tracking_number text not null check(char_length(tracking_number) between 3 and 100),
 shipped_at bigint not null default public.th_now(),primary key(order_id,shop_id)
);
alter table public.th_order_delivery enable row level security;
alter table public.th_order_shipments enable row level security;
revoke all on public.th_order_delivery,public.th_order_shipments from public,anon,authenticated;
create function public.th_delivery_input(payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare method text:=coalesce(payload->>'delivery','pickup');recipient text;phone_value text;address_value text;begin
 if method not in ('pickup','shipping') then raise exception using errcode='PT400',message='Choose pickup or shipping';end if;
 if method='pickup' then return jsonb_build_object('delivery','pickup','recipientName',null,'phone',null,'address',null);end if;
 recipient:=public.th_text(payload->'recipientName','Recipient name',1,100);phone_value:=public.th_text(payload->'phone','Recipient phone',6,30);address_value:=public.th_text(payload->'address','Shipping address',10,1000);
 if phone_value!~'^[+0-9() -]+$' then raise exception using errcode='PT400',message='Invalid recipient phone';end if;
 return jsonb_build_object('delivery',method,'recipientName',recipient,'phone',phone_value,'address',address_value);
end$$;
revoke all on function public.th_delivery_input(jsonb) from public,anon,authenticated;
create function public.th_delivery_info(oid uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d public.th_order_delivery%rowtype;uid uuid:=auth.uid();begin
 select * into d from public.th_order_delivery where order_id=oid;
 if not found then return null;end if;
 if d.user_id=uid or (exists(select 1 from public.th_order_payments where order_id=oid and outcome='success') and exists(select 1 from public.th_order_items i join public.th_shops s on s.id=i.shop_id where i.order_id=oid and s.user_id=uid)) then
  return jsonb_build_object('delivery',d.delivery,'recipientName',d.recipient_name,'phone',d.phone,'address',d.address);
 end if;return null;
end$$;
revoke all on function public.th_delivery_info(uuid) from public,anon,authenticated;
create function public.th_shipment(oid uuid,sid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('carrier',carrier,'trackingNumber',tracking_number,'shippedAt',shipped_at,'isDemo',false,'isManual',true) from public.th_order_shipments where order_id=oid and shop_id=sid;
$$;
revoke all on function public.th_shipment(uuid,uuid) from public,anon,authenticated;
alter function public.th_snapshot() rename to th_snapshot_v7_base;
revoke all on function public.th_snapshot_v7_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_snapshot_v7_base();begin
 result:=result||jsonb_build_object('sellerProfiles',true,'deliveryOptions',true,'shipping',true);
 result:=jsonb_set(result,'{stores}',coalesce((select jsonb_agg(v||case when v->'isDemo'='true'::jsonb then jsonb_build_object('displayName',null,'joinedAt',null,'reviewedAt',null,'completedSales',null) else jsonb_build_object('displayName',pr.name,'joinedAt',pr.created_at,'reviewedAt',s.reviewed_at,'completedSales',(select count(*) from public.th_products p where p.shop_id=s.id and p.status='sold')) end) from jsonb_array_elements(result->'stores')x(v) left join public.th_shops s on s.id::text=v->>'id' left join public.th_profiles pr on pr.id=s.user_id),'[]'::jsonb));
 result:=jsonb_set(result,'{orders}',coalesce((select jsonb_agg(v||jsonb_build_object('delivery',coalesce(d.delivery,v->>'delivery','pickup'),'deliveryInfo',public.th_delivery_info((v->>'id')::uuid),
 'shipment',case when v->>'source'='sample' and d.delivery='shipping' and v#>>'{payment,status}'='paid_demo' then jsonb_build_object('carrier','Two-Hands จำลอง','trackingNumber','DEMO-'||(v->>'id'),'shippedAt',(v#>>'{payment,paidAt}')::bigint,'isDemo',true) else null end,
 'handoffs',coalesce((select jsonb_agg(h||jsonb_build_object('shipment',public.th_shipment((v->>'id')::uuid,(h->>'shopId')::uuid))) from jsonb_array_elements(case when jsonb_typeof(v->'handoffs')='array' then v->'handoffs' else '[]'::jsonb end)x(h)),'[]'::jsonb)) order by (v->>'at')::bigint desc,v->>'id') from jsonb_array_elements(result->'orders')x(v) left join public.th_order_delivery d on d.order_id=(v->>'id')::uuid and d.user_id=auth.uid()),'[]'::jsonb));
 return result;
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
alter function public.th_order_thread(uuid,uuid) rename to th_order_thread_v7_base;
revoke all on function public.th_order_thread_v7_base(uuid,uuid) from public,anon,authenticated;
create function public.th_order_thread(oid uuid,sid uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_order_thread_v7_base(oid,sid);method text;shipment jsonb;begin
 select delivery into method from public.th_orders where id=oid;shipment:=public.th_shipment(oid,sid);
 return result||jsonb_build_object('delivery',method,'deliveryInfo',public.th_delivery_info(oid),'handoff',(result->'handoff')||jsonb_build_object('shipment',shipment),
 'canConfirm',coalesce((result->>'canConfirm')::boolean,false) and (method='pickup' or (result->>'participantRole'='buyer' and shipment is not null)));
end$$;
revoke all on function public.th_order_thread(uuid,uuid) from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v7_base;
revoke all on function public.th_api_v7_base(text,jsonb) from public,anon,authenticated;
create function public.th_api(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid;oid uuid;sid uuid;details jsonb;original_details jsonb;result jsonb;key_value text;sample boolean;o public.th_orders%rowtype;so public.th_sample_orders%rowtype;d public.th_order_delivery%rowtype;shipment public.th_order_shipments%rowtype;carrier_value text;tracking_value text;paid boolean;method text;begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 if action not in ('reserve','order_delivery','pay','sales','order_ship','order_handoff') then return public.th_api_v7_base(action,payload);end if;
 uid:=public.th_require_user();
 if action='sales' then
  result:=public.th_api_v7_base(action,payload);
  return jsonb_set(result,'{sales}',coalesce((select jsonb_agg(v||jsonb_build_object('delivery',orders.delivery,'deliveryInfo',public.th_delivery_info(orders.id),'handoff',(v->'handoff')||jsonb_build_object('shipment',public.th_shipment(orders.id,(v->>'shopId')::uuid)))) from jsonb_array_elements(result->'sales')x(v) join public.th_orders orders on orders.id=(v->>'id')::uuid),'[]'::jsonb));
 elsif action='reserve' then
  details:=public.th_delivery_input(payload);key_value:=public.th_text(payload->'requestKey','Request key',10,100);
  perform pg_advisory_xact_lock(hashtextextended('reserve:'||uid::text||':'||key_value,0));
  select id into oid from public.th_orders where user_id=uid and request_key=key_value;
  if oid is null then select id into oid from public.th_sample_orders where user_id=uid and request_key=key_value;end if;
  if oid is not null then
   select initial_payload into original_details from public.th_order_delivery where order_id=oid and user_id=uid;
   original_details:=coalesce(original_details,public.th_delivery_input('{}'));
   if original_details<>details then raise exception using errcode='PT409',message='Order request key reused with different delivery details';end if;
  end if;
  result:=public.th_api_v7_base(action,(payload-'recipientName'-'phone'-'address')||jsonb_build_object('delivery','pickup','address',''));
  oid:=(result->>'orderId')::uuid;
  insert into public.th_order_delivery(order_id,user_id,delivery,recipient_name,phone,address,initial_payload) values(oid,uid,details->>'delivery',details->>'recipientName',details->>'phone',details->>'address',details) on conflict(order_id) do nothing;
  update public.th_orders orders set delivery=current_details.delivery from public.th_order_delivery current_details where orders.id=oid and orders.user_id=uid and current_details.order_id=orders.id;
  return result||jsonb_build_object('state',public.th_snapshot());
 end if;
 oid:=(payload->>'orderId')::uuid;
 select * into o from public.th_orders where id=oid for update;sample:=not found;
 if sample then select * into so from public.th_sample_orders where id=oid and user_id=uid for update;if not found then raise exception using errcode='PT404',message='Own order not found';end if;
 elsif action in ('order_delivery','pay') and o.user_id<>uid then raise exception using errcode='PT404',message='Own order not found';end if;
 select * into d from public.th_order_delivery where order_id=oid;
 paid:=case when sample then exists(select 1 from public.th_sample_payments where order_id=oid and outcome='success') else exists(select 1 from public.th_order_payments where order_id=oid and outcome='success') end;
 method:=coalesce(d.delivery,o.delivery,'pickup');
 if action='order_delivery' then
  perform public.th_limit(uid,'delivery_update',30,60);details:=public.th_delivery_input(payload);
  if paid or (sample and (so.status<>'reserved' or so.expires_at<=public.th_now())) or (not sample and (o.status<>'reserved' or o.closed_at is not null or o.expires_at<=public.th_now())) then raise exception using errcode='PT409',message='Delivery details can change only before payment on an open order';end if;
  insert into public.th_order_delivery(order_id,user_id,delivery,recipient_name,phone,address) values(oid,uid,details->>'delivery',details->>'recipientName',details->>'phone',details->>'address') on conflict(order_id) do update set delivery=excluded.delivery,recipient_name=excluded.recipient_name,phone=excluded.phone,address=excluded.address;
  if not sample then update public.th_orders set delivery=details->>'delivery',payment_required=payment_required or details->>'delivery'='shipping' where id=oid;end if;return public.th_snapshot();
 elsif action='pay' then
  if method='shipping' and (d.order_id is null or d.recipient_name is null or d.phone is null or d.address is null) then raise exception using errcode='PT409',message='Shipping recipient details required before payment';end if;
  return public.th_api_v7_base(action,payload);
 end if;
 if sample then raise exception using errcode='PT404',message='Actual shop order required';end if;
 sid:=(payload->>'shopId')::uuid;
 if not exists(select 1 from public.th_order_items i join public.th_shops s on s.id=i.shop_id where i.order_id=oid and i.shop_id=sid and (s.user_id=uid or (action='order_handoff' and o.user_id=uid))) then raise exception using errcode='PT404',message='Own shop order not found';end if;
 if action='order_handoff' then
  if method='shipping' and (o.user_id<>uid or not exists(select 1 from public.th_order_shipments where order_id=oid and shop_id=sid)) then raise exception using errcode='PT409',message='Seller must record simulated shipment before buyer confirms delivery';end if;
  return public.th_api_v7_base(action,payload);
 end if;
 carrier_value:=public.th_text(payload->'carrier','Carrier',1,80);tracking_value:=public.th_text(payload->'trackingNumber','Tracking number',3,100);
 if tracking_value!~'^[A-Za-z0-9_-]+$' then raise exception using errcode='PT400',message='Invalid tracking number';end if;
 if method<>'shipping' or not paid then raise exception using errcode='PT409',message='Paid shipping order required';end if;
 select * into shipment from public.th_order_shipments where order_id=oid and shop_id=sid;
 if found then
  if shipment.carrier<>carrier_value or shipment.tracking_number<>tracking_value then raise exception using errcode='PT409',message='Shipment already recorded with different details';end if;
  return public.th_order_thread(oid,sid);
 end if;
 if o.status not in ('reserved','partially_completed') or o.closed_at is not null or not exists(select 1 from public.th_order_handoffs where order_id=oid and shop_id=sid and ready_at is not null) then raise exception using errcode='PT409',message='Prepare and mark items ready before shipment';end if;
 perform public.th_limit(uid,'order_ship',30,60);
 insert into public.th_order_shipments(order_id,shop_id,carrier,tracking_number) values(oid,sid,carrier_value,tracking_value);
 update public.th_order_handoffs set seller_confirmed_at=coalesce(seller_confirmed_at,public.th_now()) where order_id=oid and shop_id=sid;
 insert into public.th_events(user_id,action,subject) values(uid,'order_ship',oid::text||'/'||sid::text);
 return public.th_order_thread(oid,sid);
end$$;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
commit;
