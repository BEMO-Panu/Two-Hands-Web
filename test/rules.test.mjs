import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bidError, checkoutTotal, canReview, canAuction } from '../dist/rules.js';
const bid = {amount:8600,current:8500,increment:100,endsAt:1000,now:999};
test('auction accepts the minimum but refuses lower, fractional, excessive and non-finite bids',()=>{
 assert.equal(bidError(bid),'');
 for(const amount of [8500,8599,8600.5,10000001,Infinity,NaN])assert.ok(bidError({...bid,amount}));
});
test('auction closes at the exact deadline and never permits the seller to bid',()=>{
 assert.ok(bidError({...bid,now:1000})); assert.ok(bidError({...bid,now:1001}));assert.ok(bidError({...bid,own:true}));
});
test('shipping has one fee per order; pickup has none; invalid checkout is refused',()=>{
 assert.equal(checkoutTotal([{price:2400},{price:100}],'shipping'),2550);
 assert.equal(checkoutTotal([{price:2400}],'pickup'),2400);
 assert.throws(()=>checkoutTotal([],'shipping'));
 assert.throws(()=>checkoutTotal([{price:2400}],'unknown'));
 assert.throws(()=>checkoutTotal([{price:-1}],'pickup'));
});
test('only pending requests can be reviewed, and only verified demo shops can open auctions',()=>{
 assert.equal(canReview('pending'),true);assert.equal(canAuction('verified'),true);
 for(const status of ['none','rejected',null]){assert.equal(canReview(status),false);assert.equal(canAuction(status),false);}
 assert.equal(canAuction('pending'),false);assert.equal(canReview('verified'),false);
});
