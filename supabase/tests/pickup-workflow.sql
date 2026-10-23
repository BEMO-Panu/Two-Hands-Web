-- PostgreSQL-only transaction test. Simulated signed claims; no real passwords,
-- messages to people, payments, Auth sessions or Storage bytes. Rolls back all.
begin;
create temporary table th_pickup_test_results(stage text,result text) on commit drop;
create function pg_temp.th_pickup_claims(uid uuid,aal text default 'aal1') returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','email','fixture@example.invalid','aal',aal,'amr',jsonb_build_array(jsonb_build_object('method','totp','timestamp',extract(epoch from clock_timestamp())::bigint)))::text,true);
end$$;
create function pg_temp.th_pickup_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'PICKUP ASSERT FAILED: %',label;end if;end$$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('93000000-7a21-4000-8000-'||lpad(n::text,12,'0'))::uuid,'pickup-fixture-'||n||'@example.invalid',now(),jsonb_build_object('name','Fixture '||n) from generate_series(1,5)n;
do $$declare uid uuid;begin
 for uid in select id from auth.users where id::text like '93000000-7a21-%' loop perform pg_temp.th_pickup_claims(uid);perform public.th_api('snapshot');end loop;
end$$;
update public.th_shops set status='verified' where user_id in ('93000000-7a21-4000-8000-000000000001','93000000-7a21-4000-8000-000000000003');
update public.th_profiles set role='admin' where id='93000000-7a21-4000-8000-000000000005';

do $$declare seller uuid:='93000000-7a21-4000-8000-000000000001';buyer uuid:='93000000-7a21-4000-8000-000000000002';seller2 uuid:='93000000-7a21-4000-8000-000000000003';outsider uuid:='93000000-7a21-4000-8000-000000000004';admin uuid:='93000000-7a21-4000-8000-000000000005';
 shop1 uuid;shop2 uuid;photo1 text;photo2 text;item1 uuid;item2 uuid;edit_item uuid;auction uuid;full1 uuid;full2 uuid;oid uuid;other_order uuid;full_order uuid;report_id uuid;
 reply jsonb;state jsonb;sale jsonb;before_deadline bigint;before_step integer;sold_at bigint;begin
 select id into shop1 from public.th_shops where user_id=seller;select id into shop2 from public.th_shops where user_id=seller2;
 photo1:=seller::text||'/93000000-7a21-4000-8000-000000000099.png';photo2:=seller2::text||'/93000000-7a21-4000-8000-000000000099.png';
 insert into storage.objects(bucket_id,name,owner_id,metadata) values('product-photos',photo1,seller::text,'{"mimetype":"image/png","size":1024}'),('product-photos',photo2,seller2::text,'{"mimetype":"image/png","size":1024}');
 perform pg_temp.th_pickup_claims(seller);perform public.th_api('upload_register',jsonb_build_object('path',photo1));
 perform pg_temp.th_pickup_claims(seller2);perform public.th_api('upload_register',jsonb_build_object('path',photo2));
 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode)
 values(shop1,'Shop one item','Original item description','home','สภาพดี','Bangkok',photo1,100,'fixed') returning id into item1;
 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode)
 values(shop2,'Shop two PRIVATE TITLE','Another item description','home','สภาพดี','Bangkok',photo2,200,'fixed') returning id into item2;
 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode)
 values(shop1,'Editable item','Editable item description','home','สภาพดี','Bangkok',photo1,90,'fixed') returning id into edit_item;
 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode,bid_step,ends_at)
 values(shop1,'Editable auction','Editable auction description','home','สภาพดี','Bangkok',photo1,300,'auction',10,public.th_now()+3600000) returning id into auction;
 perform pg_temp.th_pickup_claims(buyer);reply:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(item1,item2),'delivery','pickup','requestKey','pickup-multi-reserve-01'));oid:=(reply->>'orderId')::uuid;
 state:=public.th_api('snapshot');perform pg_temp.th_pickup_assert(state->'pickupWorkflow'='true'::jsonb,'capability exposed');
 select v into reply from jsonb_array_elements(state->'orders')x(v) where v->>'id'=oid::text;
 perform pg_temp.th_pickup_assert(jsonb_array_length(reply->'handoffs')=2 and reply#>>'{items,0,shopId}' is not null,'buyer gets shop groups and item shop IDs');
 reply:=public.th_api('order_message',jsonb_build_object('orderId',oid,'shopId',shop1,'text',E'PRIVATE_THREAD_SHOP_ONE\nMeeting at the safe pickup point'));
 perform pg_temp.th_pickup_assert(reply->>'participantRole'='buyer' and reply->'canMessage'='true'::jsonb,'buyer thread role and send capability');
 perform pg_temp.th_pickup_claims(seller);reply:=public.th_api('order_messages',jsonb_build_object('orderId',oid,'shopId',shop1));
 perform pg_temp.th_pickup_assert(position('PRIVATE_THREAD_SHOP_ONE' in reply::text)>0 and reply->>'participantRole'='seller','seller sees own conversation');
 reply:=public.th_api('order_message',jsonb_build_object('orderId',oid,'shopId',shop1,'text','Confirmed safe meeting point'));
 perform pg_temp.th_pickup_assert(jsonb_array_length(reply->'messages')=2 and position('@example.invalid' in reply::text)=0,'messages include names but no account emails');
 perform pg_temp.th_pickup_claims(seller2);
 begin perform public.th_api('order_messages',jsonb_build_object('orderId',oid,'shopId',shop1));raise exception 'Other seller read private thread';exception when sqlstate 'PT404' then null;end;
 begin perform public.th_api('order_message',jsonb_build_object('orderId',oid,'shopId',shop1,'text','Cross-shop injection'));raise exception 'Other seller injected message';exception when sqlstate 'PT404' then null;end;
 begin perform public.th_api('order_handoff',jsonb_build_object('orderId',oid,'shopId',shop1));raise exception 'Other seller confirmed another shop';exception when sqlstate 'PT404' then null;end;
 reply:=public.th_api('order_messages',jsonb_build_object('orderId',oid,'shopId',shop2));perform pg_temp.th_pickup_assert(reply->'messages'='[]'::jsonb,'other shop thread is separate');
 perform pg_temp.th_pickup_claims(outsider);
 begin perform public.th_api('order_messages',jsonb_build_object('orderId',oid,'shopId',shop1));raise exception 'Outsider read private conversation';exception when sqlstate 'PT404' then null;end;
 perform set_config('request.jwt.claims','{}',true);
 begin perform public.th_api('order_messages',jsonb_build_object('orderId',oid,'shopId',shop1));raise exception 'Anonymous read private conversation';exception when sqlstate 'PT401' then null;end;
 insert into pg_temp.th_pickup_test_results values('Private per-shop messages and participant isolation','PASS');

 perform pg_temp.th_pickup_claims(buyer);
 begin perform public.th_api('order_message',jsonb_build_object('orderId',oid,'shopId',shop1,'text',repeat('x',2001)));raise exception 'Oversized message accepted';exception when sqlstate 'PT400' then null;end;
 insert into public.th_order_messages(order_id,shop_id,sender_id,sender_role,text) select oid,shop1,buyer,'buyer','Fixture bounded conversation '||n from generate_series(1,198)n;
 begin perform public.th_api('order_message',jsonb_build_object('orderId',oid,'shopId',shop1,'text','Message beyond thread limit'));raise exception 'Unbounded thread accepted';exception when sqlstate 'PT409' then null;end;
 reply:=public.th_api('order_messages',jsonb_build_object('orderId',oid,'shopId',shop1));perform pg_temp.th_pickup_assert(jsonb_array_length(reply->'messages')=100,'only latest 100 messages returned');
 reply:=public.th_api('order_handoff',jsonb_build_object('orderId',oid,'shopId',shop1));
 perform pg_temp.th_pickup_assert(reply#>'{handoff,buyerConfirmedAt}'<>'null'::jsonb and reply#>'{handoff,sellerConfirmedAt}'='null'::jsonb and reply->'canConfirm'='false'::jsonb,'buyer confirmation alone cannot complete pickup');
 perform pg_temp.th_pickup_assert((select status='reserved' from public.th_products where id=item1),'single confirmation leaves product reserved');
 begin perform public.th_api('cancel',jsonb_build_object('orderId',oid));raise exception 'One-sided handoff confirmation cancelled';exception when sqlstate 'PT409' then null;end;
 perform pg_temp.th_pickup_claims(seller);reply:=public.th_api('order_handoff',jsonb_build_object('orderId',oid,'shopId',shop1));
 sold_at:=(reply#>>'{handoff,completedAt}')::bigint;
 perform pg_temp.th_pickup_assert(sold_at is not null and reply->>'orderStatus'='partially_completed','two parties complete one shop only');
 perform pg_temp.th_pickup_assert((select status='sold' from public.th_products where id=item1) and (select status='reserved' from public.th_products where id=item2),'only completed shop items sold');
 perform pg_temp.th_pickup_claims(buyer);
 begin perform public.th_api('cancel',jsonb_build_object('orderId',oid));raise exception 'Partial completion cancelled';exception when sqlstate 'PT409' then null;end;
 insert into pg_temp.th_pickup_test_results values('Bounded messages and two-party partial handoff','PASS');

 update public.th_orders set expires_at=public.th_now()-1 where id=oid;perform public.th_settle();perform public.th_settle();
 perform pg_temp.th_pickup_assert((select status='sold' and reserved_order_id=oid from public.th_products where id=item1),'expiry never relists sold product');
 perform pg_temp.th_pickup_assert((select status='active' and reserved_order_id is null from public.th_products where id=item2),'expiry releases remaining shop reservation');
 perform pg_temp.th_pickup_assert((select status='partially_completed' and closed_at is not null from public.th_orders where id=oid),'partial expired order closes without losing completion');
 reply:=public.th_api('order_messages',jsonb_build_object('orderId',oid,'shopId',shop1));perform pg_temp.th_pickup_assert(reply->'canMessage'='false'::jsonb and reply->'canConfirm'='false'::jsonb,'historical conversation read only');
 begin perform public.th_api('order_message',jsonb_build_object('orderId',oid,'shopId',shop1,'text','Late message'));raise exception 'Closed thread accepted message';exception when sqlstate 'PT409' then null;end;
 begin perform public.th_api('order_handoff',jsonb_build_object('orderId',oid,'shopId',shop2));raise exception 'Expired uncompleted handoff accepted';exception when sqlstate 'PT409' then null;end;
 reply:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(item2),'delivery','pickup','requestKey','pickup-released-reserve-01'));other_order:=(reply->>'orderId')::uuid;perform public.th_settle();
 perform pg_temp.th_pickup_assert((select status='reserved' and reserved_order_id=other_order from public.th_products where id=item2),'old expired order cannot release a new reservation');
 perform public.th_api('cancel',jsonb_build_object('orderId',other_order));
 insert into pg_temp.th_pickup_test_results values('Partial expiry retains sold items and safely releases remainder','PASS');

 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode)
 values(shop1,'Complete pickup A','Complete pickup description A','home','สภาพดี','Bangkok',photo1,80,'fixed') returning id into full1;
 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode)
 values(shop2,'Complete pickup B','Complete pickup description B','home','สภาพดี','Bangkok',photo2,70,'fixed') returning id into full2;
 reply:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(full1,full2),'delivery','pickup','requestKey','pickup-full-reserve-01'));full_order:=(reply->>'orderId')::uuid;
 perform public.th_api('order_handoff',jsonb_build_object('orderId',full_order,'shopId',shop1));perform public.th_api('order_handoff',jsonb_build_object('orderId',full_order,'shopId',shop2));
 perform pg_temp.th_pickup_claims(seller);perform public.th_api('order_handoff',jsonb_build_object('orderId',full_order,'shopId',shop1));
 perform pg_temp.th_pickup_claims(seller2);reply:=public.th_api('order_handoff',jsonb_build_object('orderId',full_order,'shopId',shop2));
 perform pg_temp.th_pickup_assert(reply->>'orderStatus'='completed' and reply->'closedAt'<>'null'::jsonb,'all shop handoffs complete order');
 perform pg_temp.th_pickup_assert((select count(*)=2 from public.th_products where id in (full1,full2) and status='sold'),'all products sold after full handoff');
 reply:=public.th_api('order_handoff',jsonb_build_object('orderId',full_order,'shopId',shop2));perform pg_temp.th_pickup_assert(reply->>'orderStatus'='completed','completed handoff retries idempotent');
 update public.th_orders set expires_at=public.th_now()-1 where id=full_order;perform public.th_settle();perform pg_temp.th_pickup_assert((select status='completed' from public.th_orders where id=full_order),'completed order does not expire');
 perform pg_temp.th_pickup_claims(buyer);
 begin perform public.th_api('cancel',jsonb_build_object('orderId',full_order));raise exception 'Completed order cancelled';exception when sqlstate 'PT409' then null;end;
 perform pg_temp.th_pickup_claims(seller);reply:=public.th_api('sales');
 select v into sale from jsonb_array_elements(reply->'sales')x(v) where v->>'id'=full_order::text;
 perform pg_temp.th_pickup_assert(sale->>'shopId'=shop1::text and (sale->>'subtotal')::integer=80 and jsonb_array_length(sale->'items')=1,'sales remain isolated to own completed shop');
 perform pg_temp.th_pickup_assert(sale#>'{handoff,completedAt}'<>'null'::jsonb and position('@example.invalid' in sale::text)=0,'sales include handoff without email');
 update public.th_shops set status='none' where id=shop1;reply:=public.th_api('sales');perform pg_temp.th_pickup_assert(jsonb_array_length(reply->'sales')>=1,'seller can resolve existing orders after verification revoked');update public.th_shops set status='verified' where id=shop1;
 insert into pg_temp.th_pickup_test_results values('Full multi-shop completion and historical seller privacy','PASS');

 -- Listing updates cannot race past a bid/reservation because the row is locked.
 perform public.th_api('product_update',jsonb_build_object('productId',edit_item,'title','Updated item','price',95,'mode','auction','image','https://evil.invalid'));
 perform pg_temp.th_pickup_assert((select title='Updated item' and price=95 and mode='fixed' and image_path=photo1 from public.th_products where id=edit_item),'allowed listing fields only');
 select ends_at,bid_step into before_deadline,before_step from public.th_products where id=auction;
 perform public.th_api('product_update',jsonb_build_object('productId',auction,'price',350,'hours',999,'step',1));
 perform pg_temp.th_pickup_assert((select price=350 and ends_at=before_deadline and bid_step=before_step from public.th_products where id=auction),'zero-bid auction editable without changing deadline/step');
 perform pg_temp.th_pickup_claims(outsider);
 begin perform public.th_api('product_update',jsonb_build_object('productId',edit_item,'price',1));raise exception 'Other user edited listing';exception when sqlstate 'PT404' then null;end;
 begin perform public.th_api('product_withdraw',jsonb_build_object('productId',edit_item));raise exception 'Other user withdrew listing';exception when sqlstate 'PT404' then null;end;
 perform pg_temp.th_pickup_claims(buyer);perform public.th_api('bid',jsonb_build_object('productId',auction,'amount',360,'requestKey','pickup-managed-auction-bid-01'));
 perform pg_temp.th_pickup_claims(seller);
 begin perform public.th_api('product_update',jsonb_build_object('productId',auction,'price',1));raise exception 'Auction with bids edited';exception when sqlstate 'PT409' then null;end;
 begin perform public.th_api('product_withdraw',jsonb_build_object('productId',auction));raise exception 'Auction with bids withdrawn';exception when sqlstate 'PT409' then null;end;
 begin perform public.th_api('product_update',jsonb_build_object('productId',item1,'price',1));raise exception 'Sold listing edited';exception when sqlstate 'PT409' then null;end;
 perform public.th_api('product_withdraw',jsonb_build_object('productId',edit_item));perform pg_temp.th_pickup_assert((select status='withdrawn' from public.th_products where id=edit_item),'own active no-bid listing withdrawn');
 perform pg_temp.th_pickup_claims(buyer);
 begin perform public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(edit_item),'delivery','pickup','requestKey','pickup-withdrawn-reserve-01'));raise exception 'Withdrawn listing reserved';exception when sqlstate 'PT409' then null;end;
 insert into pg_temp.th_pickup_test_results values('Owned listing edit/withdraw and bid/sold protections','PASS');

 perform public.th_api('report',jsonb_build_object('productId',item1,'reason','Suspicious listing','details','Private report evidence for the administrator'));
 select id into report_id from public.th_reports where user_id=buyer and product_id=item1;
 begin perform public.th_api('admin_reports');raise exception 'Buyer read moderation inbox';exception when sqlstate 'PT403' then null;end;
 perform pg_temp.th_pickup_claims(admin);
 begin perform public.th_api('admin_reports');raise exception 'Admin without MFA read moderation inbox';exception when sqlstate 'PT403' then null;end;
 perform pg_temp.th_pickup_claims(admin,'aal2');reply:=public.th_api('admin_reports');
 perform pg_temp.th_pickup_assert(position('Private report evidence' in reply::text)>0 and position('@example.invalid' in reply::text)=0,'fresh MFA admin receives private report with no email');
 perform public.th_api('review_report',jsonb_build_object('reportId',report_id,'note','PRIVATE_ADMIN_REVIEW_NOTE: reviewed the report carefully'));
 perform pg_temp.th_pickup_assert((select status='reviewed' and reviewed_by=admin and reviewed_at is not null from public.th_reports where id=report_id),'report reviewed by fresh MFA admin');
 perform set_config('request.jwt.claims','{}',true);reply:=public.th_api('snapshot');perform pg_temp.th_pickup_assert(position('PRIVATE_ADMIN_REVIEW_NOTE' in reply::text)=0 and position('PRIVATE_THREAD_SHOP_ONE' in reply::text)=0,'private moderation/chat absent from public state');
 insert into pg_temp.th_pickup_test_results values('Private report inbox and MFA administrator review','PASS');
end$$;

select pg_temp.th_pickup_claims('93000000-7a21-4000-8000-000000000001');
set local role authenticated;
do $$begin
 begin perform 1 from public.th_order_messages;raise exception 'Direct messages readable';exception when insufficient_privilege then null;end;
 begin perform 1 from public.th_order_handoffs;raise exception 'Direct handoffs readable';exception when insufficient_privilege then null;end;
 begin perform public.th_api_v2_base('snapshot');raise exception 'Old dispatcher bypass exposed';exception when insufficient_privilege then null;end;
 begin perform public.th_snapshot_v2_base();raise exception 'Old private snapshot exposed';exception when insufficient_privilege then null;end;
end$$;
reset role;
select stage,result from pg_temp.th_pickup_test_results;
rollback;
