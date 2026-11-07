begin;
create table public.th_product_reviews (
 id uuid primary key default gen_random_uuid(),order_id uuid not null,product_id text not null,
 buyer_id uuid not null references public.th_profiles(id),shop_id uuid references public.th_shops(id),
 is_sample boolean not null default false,rating integer not null check(rating between 1 and 5),
 comment text not null check(char_length(comment) between 1 and 500),created_at bigint not null default public.th_now(),
 unique(order_id,product_id),check((is_sample and shop_id is null) or (not is_sample and shop_id is not null))
);
create index th_reviews_product on public.th_product_reviews(product_id,created_at desc);
create index th_reviews_shop on public.th_product_reviews(shop_id) where not is_sample;
alter table public.th_product_reviews enable row level security;
revoke all on public.th_product_reviews from public,anon,authenticated;
alter function public.th_snapshot() rename to th_snapshot_v10_base;
revoke all on function public.th_snapshot_v10_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=public.th_snapshot_v10_base();begin
 result:=result||jsonb_build_object('productReviews',true);
 result:=jsonb_set(result,'{products}',coalesce((select jsonb_agg(v||jsonb_build_object('reviewCount',coalesce(r.cnt,0),'ratingAverage',r.avg_rating,'reviews',coalesce(r.reviews,'[]'::jsonb)) order by ord) from jsonb_array_elements(result->'products') with ordinality x(v,ord) left join lateral (select count(*) cnt,round(avg(rating)::numeric,1) avg_rating,(select jsonb_agg(jsonb_build_object('rating',q.rating,'comment',q.comment,'at',q.created_at,'isDemo',q.is_sample) order by q.created_at desc,q.id) from (select id,rating,comment,created_at,is_sample from public.th_product_reviews where product_id=v->>'id' order by created_at desc,id limit 20)q) reviews from public.th_product_reviews where product_id=v->>'id')r on true),'[]'::jsonb));
 result:=jsonb_set(result,'{stores}',coalesce((select jsonb_agg(v||case when v->'isDemo'='true'::jsonb then '{}'::jsonb else jsonb_build_object('ratingAverage',r.avg_rating,'reviewCount',coalesce(r.cnt,0)) end order by ord) from jsonb_array_elements(result->'stores') with ordinality x(v,ord) left join lateral (select count(*) cnt,round(avg(rating)::numeric,1) avg_rating from public.th_product_reviews where shop_id::text=v->>'id' and not is_sample)r on true),'[]'::jsonb));
 result:=result||jsonb_build_object('myReviews',coalesce((select jsonb_agg(jsonb_build_object('orderId',order_id,'productId',product_id,'rating',rating)) from public.th_product_reviews where buyer_id=auth.uid()),'[]'::jsonb));
 return result;
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v10_base;
revoke all on function public.th_api_v10_base(text,jsonb) from public,anon,authenticated;
create function public.th_api(action text,payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid;oid uuid;pid text;rating_value int;comment_value text;shopid uuid;sample boolean:=false;begin
 if action<>'product_review' then return public.th_api_v10_base(action,payload);end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 uid:=public.th_require_user();perform public.th_limit(uid,'product_review',30,3600);
 oid:=(payload->>'orderId')::uuid;pid:=public.th_text(payload->'productId','Product',1,100);rating_value:=public.th_integer(payload->'rating','Rating',1,5);comment_value:=public.th_text(payload->'comment','Comment',1,500);
 select i.shop_id into shopid from public.th_orders o join public.th_order_items i on i.order_id=o.id join public.th_order_handoffs h on h.order_id=o.id and h.shop_id=i.shop_id join public.th_shops sh on sh.id=i.shop_id where o.id=oid and o.user_id=uid and sh.user_id<>uid and i.product_id::text=pid and h.completed_at is not null;
 if not found then
  sample:=exists(select 1 from public.th_sample_orders o where o.id=oid and o.user_id=uid and o.status='completed' and exists(select 1 from jsonb_array_elements(o.items) i where i->>'id'=pid));
  if not sample then raise exception using errcode='PT403',message='Completed purchase required for review';end if;
 end if;
 begin insert into public.th_product_reviews(order_id,product_id,buyer_id,shop_id,is_sample,rating,comment) values(oid,pid,uid,shopid,sample,rating_value,comment_value);
 exception when unique_violation then raise exception using errcode='PT409',message='Product already reviewed';end;
 insert into public.th_events(user_id,action,subject) values(uid,'product_review',pid);
 return public.th_snapshot();
end$$;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
