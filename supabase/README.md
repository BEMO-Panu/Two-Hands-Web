# Two-Hands: Supabase PostgreSQL layer

This directory is local source preparation. It does not create a Supabase project,
apply a remote migration, configure email delivery, or prove production readiness.

## Install on a fresh project

1. Enable email/password Auth and email confirmation in Supabase. Configure SMTP,
   allowed site/redirect URLs and Auth abuse limits in the project dashboard.
2. Apply `migrations/202610200001_marketplace.sql` through Supabase migrations or
   its SQL editor as the project database operator. Apply once to a fresh schema.
3. Configure the BFF using the project URL and **publishable** key. User requests
   call `th_api` using the user's access token. No service-role key is needed.
4. Sign up and confirm the operator account. Open the app once so its profile is
   created. Promote only that known account through the SQL editor:

   ```sql
   update public.th_profiles set role='admin' where id='OPERATOR_AUTH_USER_UUID';
   ```

   There is no default admin. User metadata cannot assign privileges. Admin
   requests/reviews require a JWT with `aal2` and a TOTP authentication event no
   older than ten minutes. Enable TOTP in the app before reviewing sellers.

## RPC contract

`public.th_api(action text, payload jsonb default '{}')` returns JSON. Only this
RPC and narrowly scoped Storage policy helpers are executable by application
roles. Internal helpers/maintenance functions are not public RPCs.

- Anonymous: `snapshot`, `media {path}`. `media` resolves only photos referenced
  by a product. It returns `{path}`; it does not generate signed URLs.
- Account: `profile {name,shop}`, `favorite_add/remove {productId}`,
  `cart_add/remove {productId}`. Other mutations require confirmed email. Banned/deleted accounts are rejected
  by the RPC even if their previously issued access token has not expired.
- Seller: `verification {name,location,bio}` stores **private** review evidence
  separately from the public shop bio. Never upload identity documents here.
- Admin: `admin_requests {}`, `review {shopId,status,note}`. Self-review is
  forbidden. Shop renaming revokes its verification.
- Photos: `upload_register {path}` returns `{image:'/api/media/'+path}` after
  checking Storage object ownership, MIME metadata and size.
- Listings: `product_create {title,description,category,condition,location,image,
  price,mode,step,hours}`. Shop verification and own registered image required.
- Auctions: `bid {productId,amount,requestKey}`. Atomic product locks enforce
  increasing prices. Same request key and same payload are safe to retry.
- Reservations: `reserve {productIds,delivery:'pickup',requestKey}` returns
  `{ok:true,orderId}`. It locks products in UUID order and reserves them together.
  A request key starting `auction-` is reserved for system auction settlement.
  Request keys belong to the authenticated user; reusing one for another payload
  fails. `cancel {orderId}` is restricted to that reservation's buyer.
- `sales {}` returns own-shop items/subtotal and buyer display name. It excludes
  buyer email and other shops' items. Addresses are always null.
- `report {productId?,reason,details}` records a private report for administrators.

The snapshot preserves products/stores/profile/verification/bids/favorites/cart/
orders plus own user metadata and epoch milliseconds. The BFF adds CSRF tokens,
category labels and other presentation configuration.

## MVP limits and maintenance

This is a **pickup-only reservation MVP**. It collects no shipping address and
has no payment, refund, paid/shipped status, or fulfillment mutation. Reservations
expire after thirty minutes. Auctions reserve their winning item for the highest
bidder; seller verification does not guarantee the authenticity of every listing.

`snapshot` invokes bounded `th_settle()` work (up to fifty due auctions and fifty
expired reservations per call). For unattended settlement, the database operator
can enable Supabase Cron/pg_cron and schedule the following every minute using
the dashboard. It runs as the configured database operator, not an app user:

```sql
select public.th_settle();
```

The private `product-photos` Storage bucket restricts uploads to a confirmed
user's UUID folder, 2 MB and JPEG/PNG/WebP MIME types. Listed photos are readable
marketplace content; unlisted photos are private to their owner. Storage MIME
metadata is not binary image validation: the BFF must validate both uploaded and
proxied image bytes, because a user can call the Storage API directly. Original
files are not re-encoded or stripped of EXIF metadata. A database INSERT policy
caps each authenticated user's UUID folder at **200 objects**, including images
uploaded directly through the Storage API and never registered in the app.
A per-user advisory transaction lock serializes the quota check. This policy
requires READ COMMITTED isolation and fails closed at other isolation levels,
preventing a stale transaction snapshot from bypassing the cap. The helper derives
the user from `auth.uid()` and cannot count/allocate another user's allowance.

App users cannot overwrite or delete objects. If the quota is exhausted, the
project operator must use the Storage dashboard/operator API to clean up unused
files. Preserve every path referenced by `public.th_products.image_path` and any
pending registration in progress; never delete referenced listing photos. Remove
unused `th_uploads` metadata only after confirming no product references it. The
next upload counts the remaining actual objects; there is no counter to reset.
Project-wide quotas and image processing remain operator configuration tasks.

## Validation

`tests/security.sql` is a transaction with fixtures, simulated signed claims,
assertions, real role/RLS checks and final `ROLLBACK`. Run it only against a
**disposable** project after the migration; it makes no lasting fixture accounts.
Do not run `tests/local-bootstrap.sql` on hosted Supabase; it only mocks the Auth
and Storage interfaces for embedded local PostgreSQL tests.

An optional embedded test runner uses `@electric-sql/pglite`:

```bash
PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node supabase/tests/run-local.mjs
```

This executes actual PostgreSQL migrations/PLpgSQL/privileges/RLS against mocked
Supabase schemas. It does not test GoTrue login/email, Storage service behavior,
network failures, hosted configuration, or multi-connection concurrent races.
The SQL uses deterministic row/advisory locks; concurrent load must also be
validated against the configured hosted project before launch.
