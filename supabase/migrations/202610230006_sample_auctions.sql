begin;
-- Competitive fictional auctions shared by signed-in accounts. No fake sellers,
-- physical inventory or real funds; winners use the existing sample checkout.
create table public.th_sample_rounds (
 id uuid primary key default gen_random_uuid(),product_id text not null,kind text not null default 'product' check(kind='product'),
 starts_at bigint not null default public.th_now(),ends_at bigint not null default(public.th_now()+120000),
 status text not null default 'active' check(status in ('active','closed')),closed_at bigint,
 winner_id uuid references public.th_profiles(id),winning_amount integer,order_id uuid unique references public.th_sample_orders(id),
 foreign key(kind,product_id) references public.th_demo_catalog(kind,id),check(ends_at>starts_at),
 check((winner_id is null and winning_amount is null and order_id is null) or (winner_id is not null and winning_amount>0 and order_id is not null))
);
create unique index th_one_active_sample_round on public.th_sample_rounds(product_id) where status='active';
create index th_sample_round_deadline on public.th_sample_rounds(ends_at,id) where status='active';
create table public.th_sample_bids (
 id uuid primary key default gen_random_uuid(),round_id uuid not null references public.th_sample_rounds(id),user_id uuid not null references public.th_profiles(id),
 amount integer not null check(amount between 1 and 10000000),request_key text not null check(char_length(request_key) between 10 and 100),created_at bigint not null default public.th_now(),
 unique(user_id,request_key)
);
create index th_sample_round_bids on public.th_sample_bids(round_id,amount desc,created_at,id);
alter table public.th_sample_rounds enable row level security;
alter table public.th_sample_bids enable row level security;
revoke all on public.th_sample_rounds,public.th_sample_bids from public,anon,authenticated;
insert into public.th_sample_rounds(product_id) select id from public.th_demo_catalog where kind='product' and data->>'mode'='auction';
alter function public.th_settle() rename to th_settle_v5_base;
revoke all on function public.th_settle_v5_base() from public,anon,authenticated;
create function public.th_settle() returns void language plpgsql security definer set search_path='' as $$
declare r public.th_sample_rounds%rowtype;b public.th_sample_bids%rowtype;c jsonb;oid uuid;ms bigint:=public.th_now();begin
 perform public.th_settle_v5_base();
 for r in select * from public.th_sample_rounds where status='active' and ends_at<=ms order by ends_at,id limit 50 for update skip locked loop
  select data into c from public.th_demo_catalog where kind='product' and id=r.product_id;
  select * into b from public.th_sample_bids where round_id=r.id order by amount desc,created_at,id limit 1;
  if found then
   insert into public.th_sample_orders(user_id,total,request_key,payload,items)
   values(b.user_id,b.amount,'sample-auction-'||r.id,jsonb_build_object('auction',r.product_id,'roundId',r.id),
    jsonb_build_array(jsonb_build_object('id',r.product_id,'title',c->>'title','price',b.amount,'shopId',c->>'store','isDemo',true))) returning id into oid;
   update public.th_sample_rounds set status='closed',closed_at=ms,winner_id=b.user_id,winning_amount=b.amount,order_id=oid where id=r.id;
   insert into public.th_events(user_id,action,subject) values(b.user_id,'sample_auction_won',r.id::text);
  else update public.th_sample_rounds set status='closed',closed_at=ms where id=r.id;end if;
  insert into public.th_sample_rounds(product_id,starts_at,ends_at) values(r.product_id,ms,ms+120000);
 end loop;
end$$;
revoke all on function public.th_settle() from public,anon,authenticated;
alter function public.th_snapshot() rename to th_snapshot_v5_base;
revoke all on function public.th_snapshot_v5_base() from public,anon,authenticated;
create function public.th_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;v jsonb;r public.th_sample_rounds%rowtype;last_round public.th_sample_rounds%rowtype;bid_value jsonb;max_value integer;bid_count integer;my_amount integer;leader uuid;own_round uuid;real_order uuid;own_result public.th_sample_rounds%rowtype;uid uuid:=auth.uid();products_value jsonb:='[]';bids_value jsonb;status_value text;begin
 perform public.th_settle();result:=public.th_snapshot_v5_base();bids_value:=result->'bids';
 for v in select value from jsonb_array_elements(result->'products') loop
  if v->'isDemo'='true'::jsonb and v->>'mode'='auction' then
   select * into r from public.th_sample_rounds where product_id=v->>'id' and status='active';
   select max(amount),count(*) into max_value,bid_count from public.th_sample_bids where round_id=r.id;
   select user_id into leader from public.th_sample_bids where round_id=r.id order by amount desc,created_at,id limit 1;
   select * into last_round from public.th_sample_rounds where product_id=v->>'id' and status='closed' order by closed_at desc,starts_at desc,id desc limit 1;
   v:=v||jsonb_build_object('bidableDemo',true,'roundId',r.id,'endsAt',r.ends_at,'price',coalesce(max_value,(v->>'price')::integer),'bids',bid_count,'description','ประมูลสินค้าจำลองร่วมกับบัญชีอื่น รอบละ 2 นาที ผู้เสนอราคาสูงสุดจะได้รับคำสั่งซื้อและชำระเงินจำลอง ไม่มีสินค้าหรือเงินส่งมอบจริง',
   'lastAuctionResult',case when last_round.id is null then null else jsonb_build_object('roundId',last_round.id,'winningAmount',last_round.winning_amount,'winnerIsYou',coalesce(last_round.winner_id=uid,false),'closedAt',last_round.closed_at)||case when last_round.winner_id=uid then jsonb_build_object('orderId',last_round.order_id) else '{}'::jsonb end end);
   if uid is not null and exists(select 1 from public.th_sample_bids b join public.th_sample_rounds br on br.id=b.round_id where b.user_id=uid and br.product_id=v->>'id') then
    select max(amount) into my_amount from public.th_sample_bids where round_id=r.id and user_id=uid;
    select br.* into own_result from public.th_sample_rounds br where br.product_id=v->>'id' and br.status='closed' and exists(select 1 from public.th_sample_bids where round_id=br.id and user_id=uid) order by br.closed_at desc,br.starts_at desc,br.id desc limit 1;
    status_value:=case when my_amount is not null then case when leader=uid then 'leading' else 'outbid' end when own_result.winner_id=uid then 'won' else 'lost' end;
    select coalesce(jsonb_agg(jsonb_build_object('price',b.amount,'at',b.created_at,'roundId',b.round_id) order by b.created_at,b.id),'[]'::jsonb) into bid_value from (select b1.* from public.th_sample_bids b1 join public.th_sample_rounds br on br.id=b1.round_id where b1.user_id=uid and br.product_id=v->>'id' order by b1.created_at desc,b1.id desc limit 100)b;
    bids_value:=bids_value||jsonb_build_object(v->>'id',jsonb_build_object('history',bid_value,'status',status_value,'myAmount',my_amount,'currentRoundId',r.id,'winnerIsYou',coalesce(own_result.winner_id=uid,false))||case when own_result.winner_id=uid then jsonb_build_object('orderId',own_result.order_id) else '{}'::jsonb end);
   end if;
  elsif v->>'mode'='auction' and uid is not null and bids_value?(v->>'id') then
   select user_id into leader from public.th_bids where product_id=(v->>'id')::uuid order by amount desc,created_at,id limit 1;
   select max(amount) into my_amount from public.th_bids where product_id=(v->>'id')::uuid and user_id=uid;
   select orders.id into real_order from public.th_orders orders join public.th_order_items i on i.order_id=orders.id where orders.user_id=uid and i.product_id=(v->>'id')::uuid order by orders.created_at desc,orders.id desc limit 1;
   status_value:=case when real_order is not null then 'won' when v->>'status'='active' then case when leader=uid then 'leading' else 'outbid' end else 'lost' end;
   bids_value:=jsonb_set(bids_value,array[v->>'id'],(bids_value->(v->>'id'))||jsonb_build_object('status',status_value,'myAmount',my_amount,'winnerIsYou',real_order is not null)||case when real_order is not null then jsonb_build_object('orderId',real_order) else '{}'::jsonb end);
  end if;
  products_value:=products_value||jsonb_build_array(v);
 end loop;
 return result||jsonb_build_object('products',products_value,'bids',bids_value,'sampleAuctions',true);
end$$;
revoke all on function public.th_snapshot() from public,anon,authenticated;
alter function public.th_api(text,jsonb) rename to th_api_v5_base;
revoke all on function public.th_api_v5_base(text,jsonb) from public,anon,authenticated;
create function public.th_api(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<rpc>>
declare uid uuid;pid text;rid uuid;r public.th_sample_rounds%rowtype;b public.th_sample_bids%rowtype;key_value text;amount_value integer;highest integer;step_value integer;begin
 if jsonb_typeof(payload) is distinct from 'object' then raise exception using errcode='PT400',message='Payload must be an object';end if;
 if action='reserve' and left(coalesce(payload->>'requestKey',''),15)='sample-auction-' then raise exception using errcode='PT400',message='Reserved sample auction request key prefix';end if;
 if action<>'bid' then return public.th_api_v5_base(action,payload);end if;
 uid:=public.th_require_user();pid:=payload->>'productId';key_value:=public.th_text(payload->'requestKey','Request key',10,100);
 perform pg_advisory_xact_lock(hashtextextended('bid:'||uid::text||':'||key_value,0));
 if not exists(select 1 from public.th_demo_catalog where kind='product' and id=pid) then
  if exists(select 1 from public.th_sample_bids where user_id=uid and request_key=key_value) then raise exception using errcode='PT409',message='Bid request key reused with different payload';end if;
  return public.th_api_v5_base(action,payload);
 end if;
 if not exists(select 1 from public.th_demo_catalog where kind='product' and id=pid and data->>'mode'='auction') then raise exception using errcode='PT409',message='Sample product is not an auction';end if;
 if payload->>'roundId' is null then raise exception using errcode='PT400',message='Sample auction round required';end if;
 rid:=(payload->>'roundId')::uuid;amount_value:=public.th_integer(payload->'amount','Amount',1,10000000);
 if exists(select 1 from public.th_bids where user_id=uid and request_key=key_value) then raise exception using errcode='PT409',message='Bid request key reused with different payload';end if;
 select * into b from public.th_sample_bids where user_id=uid and request_key=key_value;
 if found then
  if b.round_id<>rid or b.amount<>amount_value or not exists(select 1 from public.th_sample_rounds where id=rid and product_id=pid) then raise exception using errcode='PT409',message='Bid request key reused with different payload';end if;
  return public.th_snapshot();
 end if;
 perform public.th_limit(uid,'sample_bid',30,60);perform public.th_settle();
 select * into r from public.th_sample_rounds where id=rid and product_id=pid for update;
 if not found then raise exception using errcode='PT404',message='Sample auction round not found';end if;
 if r.status<>'active' or r.ends_at<=public.th_now() then raise exception using errcode='PT409',message='Sample auction round ended; refresh for the next round';end if;
 select (data->>'step')::integer,(data->>'price')::integer into step_value,highest from public.th_demo_catalog where kind='product' and id=pid;
 select coalesce(max(amount),highest) into highest from public.th_sample_bids where round_id=rid;
 if amount_value<highest+step_value then raise exception using errcode='PT409',message='Sample bid must exceed current price by the bid step';end if;
 insert into public.th_sample_bids(round_id,user_id,amount,request_key) values(rid,uid,amount_value,key_value);
 insert into public.th_events(user_id,action,subject) values(uid,'sample_bid',rid::text);
 return public.th_snapshot();
end$$;
revoke all on function public.th_api(text,jsonb) from public,anon,authenticated;
grant execute on function public.th_api(text,jsonb) to anon,authenticated;
commit;
