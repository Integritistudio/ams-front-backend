// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const f = require('../services/fulfillmentRules');
const inv = require('../services/inventoryService');
const { REQ_STATUS: S } = require('../services/workflowConstants');

const paid = { paid_at: '2026-11-01T10:00:00Z', quote_amount: 120000 };
const purchase = (extra = {}) => ({ status: S.SENT_TO_IT, inventory_available: false, finance_details: paid, quantity: 2, ...extra });
const stock = (extra = {}) => ({ status: S.SENT_TO_IT, inventory_available: true, quantity: 1, ...extra });

test('Confirm Purchase: only for purchase-path requests, after payment, once', () => {
  assert.ok(f.checkConfirmPurchase(purchase()).ok);
  assert.ok(f.checkConfirmPurchase(purchase({ status: S.IN_PROGRESS })).ok);
  assert.ok(!f.checkConfirmPurchase(stock()).ok); // in-stock path: no procurement log
  assert.ok(!f.checkConfirmPurchase(purchase({ finance_details: { quote_amount: 1 } })).ok); // not paid yet
  assert.ok(!f.checkConfirmPurchase(purchase({ purchase_confirmed_at: '2026-11-02' })).ok);
  assert.ok(!f.checkConfirmPurchase(purchase({ status: S.PENDING_FINANCE_PROCESSING })).ok); // approval / invoice alone
  assert.ok(!f.checkConfirmPurchase(purchase({ status: S.ON_HOLD })).ok);
  assert.strictEqual(f.checkConfirmPurchase(null).status, 404);
});

test('legacy requests without Finance processing count as paid', () => {
  assert.ok(f.isPaid({ finance_details: null }));
  assert.ok(!f.isPaid({ finance_details: { quote_amount: 5 } }));
});

test('assignment against a request: approved, purchase confirmed, not over quantity', () => {
  assert.ok(f.checkAssignToRequest(stock(), 0).ok);
  assert.ok(!f.checkAssignToRequest(stock(), 1).ok); // already fully assigned
  assert.ok(!f.checkAssignToRequest(purchase(), 0).ok); // must confirm purchase first
  assert.ok(f.checkAssignToRequest(purchase({ purchase_confirmed_at: 'x' }), 1).ok);
  assert.ok(!f.checkAssignToRequest(purchase({ purchase_confirmed_at: 'x' }), 2).ok);
  assert.ok(!f.checkAssignToRequest(stock({ status: S.PENDING_HR }), 0).ok); // not approved yet
  assert.ok(f.checkAssignToRequest(stock({ status: S.ON_HOLD }), 0).ok);
});

test('completion needs every requested item assigned (and purchase confirmed)', () => {
  assert.ok(f.checkComplete(stock(), 1).ok);
  assert.ok(!f.checkComplete(stock(), 0).ok);
  assert.ok(!f.checkComplete(purchase(), 2).ok);
  assert.ok(f.checkComplete(purchase({ purchase_confirmed_at: 'x' }), 2).ok);
  assert.ok(!f.checkComplete(purchase({ purchase_confirmed_at: 'x' }), 1).ok);
  assert.ok(!f.checkComplete(stock({ status: S.COMPLETED }), 1).ok);
});

test('quantity defaults to 1; inventory type and asset category follow the request type', () => {
  assert.strictEqual(f.requestedQuantity({}), 1);
  assert.strictEqual(f.requestedQuantity({ quantity: 3 }), 3);
  assert.strictEqual(inv.inventoryTypeFor('Software'), 'Software');
  assert.strictEqual(inv.inventoryTypeFor('Hardware'), 'Hardware');
  assert.strictEqual(inv.assetCategoryFor('Software'), 'Software License');
  assert.strictEqual(inv.assetCategoryFor('Hardware'), 'Hardware');
});
