begin;
alter table public.th_products add column auction_cancelled_at bigint;
alter table public.th_products add column auction_deleted_at bigint;
alter function public.th_snapshot() rename to th_snapshot_v8_base;
revoke all on function public.th_snapshot_v8_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_snapshot_v8_base();begin
 result:=result||jsonb_build_object('auctionManagement',true);
 result:=jsonb_set(result,'{products}',coalesce((select jsonb_agg(v||case when p.id is null then '{}'::jsonb else jsonb_build_object('auctionCancelledAt',p.auction_cancelled_at,
 'auctionCanCancel',p.mode='auction' and p.status='active' and p.ends_at>public.th_now() and p.reserved_order_id is null and not exists(select 1 from public.th_order_items where product_id=p.id),
 'auctionCanDelete',p.mode='auction' and p.reserved_order_id is null and not exists(select 1 from public.th_order_items where product_id=p.id) and (p.status in ('withdrawn','ended') or (p.status='active' and p.ends_at>public.th_now() and not exists(select 1 from public.th_bids where product_id=p.id)))) end order by ord) from jsonb_array_elements(result->'products') with ordinality x(v,ord) left join public.th_products p on p.id::text=v->>'id' where p.auction_deleted_at is null),'[]'::jsonb));
 result:=jsonb_set(result,'{bids}',coalesce((select jsonb_object_agg(k,v||case when p.auction_cancelled_at is not null then jsonb_build_object('status','cancelled','title',p.title) else '{}'::jsonb end) from jsonb_each(result->'bids')x(k,v) left join public.th_products p on p.id::text=k),'{}'::jsonb));
 return result;
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v8_base;
revoke all on function public.th_api_v8_base(text,jsonb) from public,anon,authenticated;
create function public.th_api(action text,payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid;pid uuid;p public.th_products%rowtype;begin
 if action not in ('auction_cancel','auction_delete') then return public.th_api_v8_base(action,payload);end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 uid:=public.th_require_user();perform public.th_limit(uid,'auction_management',30,3600);pid:=(payload->>'productId')::uuid;
 select p1.* into p from public.th_products p1 join public.th_shops s on s.id=p1.shop_id where p1.id=pid and s.user_id=uid for update of p1;
 if not found then raise exception using errcode='PT404',message='Own auction not found';end if;
 if p.mode<>'auction' then raise exception using errcode='PT400',message='Auction required';end if;
 -- Serialize against bids and settlement. Historical order links also block deletion.
 if p.reserved_order_id is not null or exists(select 1 from public.th_order_items where product_id=pid) or p.status in ('reserved','sold') then raise exception using errcode='PT409',message='Auction already has an order';end if;
 if action='auction_cancel' then
  if p.auction_cancelled_at is not null then return public.th_snapshot();end if;
  if p.status<>'active' or p.ends_at<=public.th_now() then raise exception using errcode='PT409',message='Auction already ended';end if;
  update public.th_products set status='withdrawn',auction_cancelled_at=public.th_now() where id=pid;
 else
  if p.auction_deleted_at is not null then return public.th_snapshot();end if;
  if p.status='active' and (exists(select 1 from public.th_bids where product_id=pid) or p.ends_at<=public.th_now()) then raise exception using errcode='PT409',message='Cancel auction before deleting';end if;
  if p.status not in ('active','ended','withdrawn') then raise exception using errcode='PT409',message='Auction cannot be deleted';end if;
  -- Soft delete: retain bids, reports and audit records for participants.
  update public.th_products set status='withdrawn',auction_cancelled_at=coalesce(auction_cancelled_at,public.th_now()),auction_deleted_at=public.th_now() where id=pid;
 end if;
 delete from public.th_cart where product_id=pid;
 delete from public.th_favorites where product_id=pid;
 insert into public.th_events(user_id,action,subject) values(uid,action,pid::text);
 return public.th_snapshot();
end$$;
revoke all on function public.th_api(text,jsonb) from public;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
