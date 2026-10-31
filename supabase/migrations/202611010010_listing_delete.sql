begin;
alter table public.th_products add column listing_deleted_at bigint;
alter function public.th_snapshot() rename to th_snapshot_v9_base;
revoke all on function public.th_snapshot_v9_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_snapshot_v9_base();begin
 result:=result||jsonb_build_object('listingDelete',true);
 result:=jsonb_set(result,'{products}',coalesce((select jsonb_agg(v||case when p.id is null then '{}'::jsonb else jsonb_build_object('canDeleteListing',
  p.reserved_order_id is null and not exists(select 1 from public.th_order_items where product_id=p.id) and
  (p.status in ('withdrawn','ended') or (p.status='active' and (p.mode='fixed' or p.ends_at>public.th_now())))) end order by ord)
  from jsonb_array_elements(result->'products') with ordinality x(v,ord) left join public.th_products p on p.id::text=v->>'id' where p.listing_deleted_at is null),'[]'::jsonb));
 return result;
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v9_base;
revoke all on function public.th_api_v9_base(text,jsonb) from public,anon,authenticated;
create function public.th_api(action text,payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid;pid uuid;p public.th_products%rowtype;begin
 if action<>'product_delete' then return public.th_api_v9_base(action,payload);end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 uid:=public.th_require_user();perform public.th_limit(uid,'listing_delete',30,3600);pid:=(payload->>'productId')::uuid;
 select p1.* into p from public.th_products p1 join public.th_shops s on s.id=p1.shop_id where p1.id=pid and s.user_id=uid for update of p1;
 if not found then raise exception using errcode='PT404',message='Own listing not found';end if;
 if p.listing_deleted_at is not null then return public.th_snapshot();end if;
 if p.reserved_order_id is not null or exists(select 1 from public.th_order_items where product_id=pid) or p.status in ('reserved','sold') then raise exception using errcode='PT409',message='Listing already has an order';end if;
 if p.mode='auction' then
  -- Both calls share this transaction and the product row lock: no bid can
  -- arrive between cancellation and removal.
  if p.status='active' then perform public.th_api_v9_base('auction_cancel',payload);end if;
  perform public.th_api_v9_base('auction_delete',payload);
 else
  if p.status not in ('active','withdrawn','ended') then raise exception using errcode='PT409',message='Listing cannot be deleted';end if;
  update public.th_products set status='withdrawn' where id=pid;
 end if;
 update public.th_products set listing_deleted_at=public.th_now() where id=pid;
 delete from public.th_cart where product_id=pid;delete from public.th_favorites where product_id=pid;
 insert into public.th_events(user_id,action,subject) values(uid,action,pid::text);
 return public.th_snapshot();
end$$;
revoke all on function public.th_api(text,jsonb) from public;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
