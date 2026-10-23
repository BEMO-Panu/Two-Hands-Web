// Business rules for the browser-only demonstration; production must enforce these on a server.
export function bidError({ amount, current, increment, endsAt, now = Date.now(), own = false }) {
  if (own) return 'ไม่สามารถเสนอราคาสินค้าของตัวเองได้';
  if (!Number.isFinite(endsAt) || now >= endsAt) return 'การประมูลสิ้นสุดแล้ว';
  if (!Number.isSafeInteger(amount) || amount > 10000000 || amount < current + increment) return 'ราคาไม่ผ่านขั้นต่ำ หรือไม่ใช่จำนวนเต็มในช่วงที่กำหนด';
  return '';
}
export function checkoutTotal(items, delivery) {
  if (!['shipping', 'pickup'].includes(delivery)) throw new Error('วิธีจัดส่งไม่ถูกต้อง');
  if (!items.length || items.some(p => !Number.isSafeInteger(p.price) || p.price < 1)) throw new Error('รายการสินค้าไม่ถูกต้อง');
  return items.reduce((sum, p) => sum + p.price, 0) + (delivery === 'shipping' ? 50 : 0);
}
export function canReview(status) { return status === 'pending'; }
export function canAuction(status) { return status === 'verified'; }
