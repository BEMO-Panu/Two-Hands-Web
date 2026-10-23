-- Two-Hands seller/buyer workflow smoke test for the Supabase SQL editor.
-- SQL-ONLY SIMULATION: confirmed Auth rows, JWT claims and Storage metadata are
-- fixtures. This does NOT test real sign-in, email, MFA, uploads or image bytes.
-- No password is assigned. Nothing survives the final ROLLBACK.
-- Run the WHOLE file together as the database operator on the prepared project.
-- An assertion error aborts the transaction: no fixture changes can be committed.
-- If your SQL client stops on error, issue ROLLBACK before doing anything else.
begin;

create temporary table th_hosted_flow_results(
 sequence integer generated always as identity,
 stage text not null,result text not null,details jsonb not null default '{}'
) on commit drop;

create function pg_temp.th_flow_claims(uid uuid,aal text default 'aal1') returns void
language plpgsql set search_path='' as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object(
  'sub',uid,'role','authenticated','email','workflow-fixture@example.invalid','aal',aal,
  'amr',jsonb_build_array(jsonb_build_object('method','totp','timestamp',extract(epoch from clock_timestamp())::bigint))
 )::text,true);
end$$;
create function pg_temp.th_flow_assert(ok boolean,label text) returns void
language plpgsql set search_path='' as $$begin
 if ok is distinct from true then raise exception 'WORKFLOW ASSERTION FAILED: %',label;end if;
end$$;

-- Reserved fixture namespace. Never update/delete a real account to make room.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('90000000-7a21-4000-8000-000000000001','two-hands-flow-seller@example.invalid',now(),'{"name":"ร้านทดลอง Two-Hands"}'),
 ('90000000-7a21-4000-8000-000000000002','two-hands-flow-buyer@example.invalid',now(),'{"name":"ผู้ซื้อทดลอง Two-Hands"}'),
 ('90000000-7a21-4000-8000-000000000003','two-hands-flow-reviewer@example.invalid',now(),'{"name":"ผู้ตรวจร้านทดลอง"}');

do $$
declare
 seller uuid:='90000000-7a21-4000-8000-000000000001';
 buyer uuid:='90000000-7a21-4000-8000-000000000002';
 reviewer uuid:='90000000-7a21-4000-8000-000000000003';
 seller_shop uuid;reviewer_shop uuid;fixed_id uuid;auction_id uuid;other_id uuid;reservation_id uuid;winner_order_id uuid;
 image_path text:=seller::text||'/90000000-7a21-4000-8000-000000000099.png';
 state jsonb;answer jsonb;retry jsonb;sale jsonb;
begin
 -- Lazy account creation is performed through the same RPC used by the BFF.
 perform pg_temp.th_flow_claims(seller);state:=public.th_api('snapshot');seller_shop:=(state#>>'{profile,shopId}')::uuid;
 perform pg_temp.th_flow_claims(buyer);state:=public.th_api('snapshot');
 perform pg_temp.th_flow_claims(reviewer);state:=public.th_api('snapshot');reviewer_shop:=(state#>>'{profile,shopId}')::uuid;
 update public.th_profiles set role='admin' where id=reviewer;
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('01 บัญชีผู้ขาย ผู้ซื้อ และผู้ตรวจร้าน','PASS',jsonb_build_object('accounts',3,'authMode','simulated SQL claims; no passwords'));

 perform pg_temp.th_flow_claims(seller);
 state:=public.th_api('verification',jsonb_build_object('name','ร้านมือสองทดลอง','location','กรุงเทพฯ','bio',E'FLOW_PRIVATE_VERIFICATION_EVIDENCE\nหลักฐานจำลองสำหรับผู้ตรวจร้านเท่านั้น'));
 perform pg_temp.th_flow_assert(state#>>'{verification,status}'='pending','seller verification must start pending');
 perform set_config('request.jwt.claims','{}',true);state:=public.th_api('snapshot');
 perform pg_temp.th_flow_assert(position('FLOW_PRIVATE_VERIFICATION_EVIDENCE' in state::text)=0,'public snapshot must not expose private evidence');
 perform pg_temp.th_flow_claims(reviewer,'aal2');
 perform public.th_api('review',jsonb_build_object('shopId',seller_shop,'status','verified','note','ตรวจหลักฐานจำลองโดยผู้ตรวจคนละบัญชีกับเจ้าของร้าน'));
 perform pg_temp.th_flow_assert((select status='verified' from public.th_shops where id=seller_shop),'independent admin review');
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('02 ส่งตรวจและยืนยันร้านโดยผู้ตรวจคนละคน','PASS','{"privateEvidenceHidden":true,"mfaClaims":"simulated fresh aal2/totp"}');

 -- SQL Storage metadata fixture: there is intentionally no real uploaded file.
 insert into storage.objects(bucket_id,name,owner_id,metadata)
 values('product-photos',image_path,seller::text,'{"mimetype":"image/png","size":128}');
 perform pg_temp.th_flow_claims(seller);
 answer:=public.th_api('upload_register',jsonb_build_object('path',image_path));
 state:=public.th_api('product_create',jsonb_build_object('title','โคมไฟมือสองสำหรับทดสอบ','description',E'สินค้าไฟล์ทดสอบเพื่อจำลองรายการขาย\nไม่มีการรับเงินจริงหรือจัดส่งจริง','category','home','condition','สภาพดี','location','กรุงเทพฯ','image',answer->>'image','price',850,'mode','fixed'));
 select id into strict fixed_id from public.th_products where shop_id=seller_shop and mode='fixed';
 state:=public.th_api('product_create',jsonb_build_object('title','กล้องประมูลสำหรับทดสอบ','description','รายการประมูลจำลองสำหรับทดสอบสิทธิ์และราคา','category','camera','condition','สภาพดี','location','กรุงเทพฯ','image',answer->>'image','price',1000,'mode','auction','step',100,'hours',1));
 select id into strict auction_id from public.th_products where shop_id=seller_shop and mode='auction';
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('03 ผู้ขายลงสินค้าราคาปกติและประมูล','PASS',jsonb_build_object('fixedPrice',850,'auctionStart',1000,'storageMode','metadata fixture; no bytes'));

 begin
  perform public.th_api('bid',jsonb_build_object('productId',auction_id,'amount',1100,'requestKey','hosted-own-bid-0001'));
  raise exception 'seller bid on own item unexpectedly succeeded';
 exception when sqlstate 'PT403' then null;end;
 perform pg_temp.th_flow_claims(buyer);
 perform public.th_api('bid',jsonb_build_object('productId',auction_id,'amount',1100,'requestKey','hosted-buyer-bid-0001'));
 perform public.th_api('bid',jsonb_build_object('productId',auction_id,'amount',1100,'requestKey','hosted-buyer-bid-0001'));
 perform pg_temp.th_flow_assert((select count(*)=1 from public.th_bids where product_id=auction_id),'same bid retry creates one bid');
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('04 ผู้ซื้อประมูลและส่งคำขอซ้ำอย่างปลอดภัย','PASS','{"highestBid":1100,"storedBids":1,"sellerSelfBidBlocked":true}');

 -- Add a second shop's fixture item to make the seller-privacy check meaningful.
 -- Only this fixture reviewer shop is marked verified by the test operator.
 update public.th_shops set status='verified' where id=reviewer_shop;
 insert into public.th_products(shop_id,title,description,category,condition,location,image_path,price,mode)
 values(reviewer_shop,'FLOW_OTHER_SHOP_PRIVATE_ITEM','Second store fixture for seller privacy assertions','home','สภาพดี','กรุงเทพฯ',image_path,200,'fixed') returning id into other_id;
 answer:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(fixed_id,other_id),'delivery','pickup','requestKey','hosted-checkout-0001'));
 reservation_id:=(answer->>'orderId')::uuid;
 retry:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(other_id,fixed_id),'delivery','pickup','requestKey','hosted-checkout-0001'));
 perform pg_temp.th_flow_assert(retry->>'orderId'=reservation_id::text,'checkout retry must reuse reservation');
 perform pg_temp.th_flow_assert((select count(*)=1 from public.th_orders where user_id=buyer and request_key='hosted-checkout-0001'),'one reservation for duplicate checkout');
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('05 ผู้ซื้อจองสินค้าและส่งคำขอซ้ำ','PASS',jsonb_build_object('total',1050,'ordersCreated',1,'delivery','pickup','payment','not implemented / no money moved'));

 perform pg_temp.th_flow_claims(seller);answer:=public.th_api('sales');
 select item into strict sale from jsonb_array_elements(answer->'sales')x(item) where item->>'id'=reservation_id::text;
 perform pg_temp.th_flow_assert(jsonb_array_length(sale->'items')=1 and (sale->>'subtotal')::integer=850,'seller sees only own item/subtotal');
 perform pg_temp.th_flow_assert(position('FLOW_OTHER_SHOP_PRIVATE_ITEM' in sale::text)=0 and position('two-hands-flow-buyer@example.invalid' in sale::text)=0,'sales must not expose other store item or buyer email');
 perform pg_temp.th_flow_assert(sale->'address'='null'::jsonb,'pickup-only sales has no private address');
 begin
  perform public.th_api('cancel',jsonb_build_object('orderId',reservation_id));raise exception 'seller cancelled buyer reservation';
 exception when sqlstate 'PT404' then null;end;
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('06 รายการขายแสดงเฉพาะของร้านตนเอง','PASS','{"ownSubtotal":850,"otherShopItemsHidden":true,"buyerEmailHidden":true,"foreignCancellationBlocked":true}');

 perform pg_temp.th_flow_claims(buyer);perform public.th_api('cancel',jsonb_build_object('orderId',reservation_id));
 perform pg_temp.th_flow_assert((select status='active' and reserved_order_id is null from public.th_products where id=fixed_id),'buyer cancellation releases fixed product');
 insert into pg_temp.th_hosted_flow_results(stage,result) values('07 ผู้ซื้อยกเลิกและสินค้ากลับมาพร้อมขาย','PASS');

 -- Place deadline exactly at now, then prove a fresh bid cannot enter afterward.
 update public.th_products set ends_at=public.th_now() where id=auction_id;
 begin
  perform public.th_api('bid',jsonb_build_object('productId',auction_id,'amount',1200,'requestKey','hosted-late-bid-0001'));raise exception 'late bid accepted';
 exception when sqlstate 'PT409' then null;end;
 perform public.th_settle();perform public.th_settle();
 select id into strict winner_order_id from public.th_orders where user_id=buyer and request_key='auction-'||auction_id;
 perform pg_temp.th_flow_assert((select total=1100 and status='reserved' from public.th_orders where id=winner_order_id),'highest bidder receives reservation');
 perform pg_temp.th_flow_assert((select count(*)=1 from public.th_orders where request_key='auction-'||auction_id),'settlement idempotent');
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('08 ปิดประมูลและจองให้ผู้ชนะเพียงครั้งเดียว','PASS','{"lateBidBlocked":true,"winningPrice":1100,"settlementRetriesSafe":true}');

 update public.th_orders set expires_at=public.th_now()-1 where id=winner_order_id;
 perform public.th_settle();
 perform pg_temp.th_flow_assert((select status='expired' from public.th_orders where id=winner_order_id),'winning reservation expires');
 perform pg_temp.th_flow_assert((select status='ended' and reserved_order_id is null from public.th_products where id=auction_id),'expired auction reservation ends listing');
 answer:=public.th_api('reserve',jsonb_build_object('productIds',jsonb_build_array(fixed_id),'delivery','pickup','requestKey','hosted-expiry-0001'));reservation_id:=(answer->>'orderId')::uuid;
 update public.th_orders set expires_at=public.th_now()-1 where id=reservation_id;perform public.th_settle();
 perform pg_temp.th_flow_assert((select status='expired' from public.th_orders where id=reservation_id),'fixed reservation expires');
 perform pg_temp.th_flow_assert((select status='active' and reserved_order_id is null from public.th_products where id=fixed_id),'expired fixed reservation relists item');
 insert into pg_temp.th_hosted_flow_results(stage,result,details) values('09 หมดอายุการจองโดยไม่มีการชำระเงิน','PASS','{"auctionStatus":"ended","fixedStatus":"active","expiredReservations":2}');
end$$;

select sequence,stage,result,details from pg_temp.th_hosted_flow_results order by sequence;
-- Every account/profile/shop/storage metadata/product/bid/order/helper above is
-- discarded. No existing account is promoted or permanently changed.
rollback;
