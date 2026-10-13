// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const r = require('../services/approvalRouting');
const { REQ_STATUS } = require('../services/workflowConstants');

const ROLES = { staff: 1, hr: 2, gm: 3, exec: 4, it: 5, fin: 6 };
const tiers = [
  { id: 30, role_id: ROLES.exec, role_name: 'Executive', max_amount: null, self_approval: 'auto' },
  { id: 10, role_id: ROLES.hr, role_name: 'HR', max_amount: '50000.00', self_approval: 'manual', role_is_hr_manager: true },
  { id: 20, role_id: ROLES.gm, role_name: 'GM', max_amount: '10000000.00', self_approval: 'auto' },
];
const route = (amount, roleId) => r.resolvePriceApproval(tiers, amount, { role_id: roleId });

test('staff: amount goes directly to matching tier', () => {
  assert.deepStrictEqual([route(50000, ROLES.staff).tier.id, route(50000, ROLES.staff).kind], [10, 'tier']);
  assert.strictEqual(route(2000000, ROLES.staff).tier.id, 20); // above HR → GM directly
  assert.strictEqual(route(10000001, ROLES.staff).tier.id, 30);
});

test('finance manager / IT admin follow the standard tiers', () => {
  assert.strictEqual(route(1000, ROLES.fin).tier.id, 10);
  assert.strictEqual(route(1000, ROLES.it).tier.id, 10);
});

test('HR requester: self-approves within 50k, GM above', () => {
  const small = route(40000, ROLES.hr);
  assert.strictEqual(small.kind, 'tier');
  assert.strictEqual(small.tier.id, 10);
  assert.strictEqual(small.requesterMayAct, true);
  const big = route(60000, ROLES.hr);
  assert.strictEqual(big.tier.id, 20);
  assert.strictEqual(big.requesterMayAct, false);
});

test('GM requester: auto-approved up to 10M (even below HR limit), Executive above', () => {
  assert.strictEqual(route(1000, ROLES.gm).kind, 'auto');
  assert.strictEqual(route(10000000, ROLES.gm).kind, 'auto');
  const big = route(10000001, ROLES.gm);
  assert.strictEqual(big.kind, 'tier');
  assert.strictEqual(big.tier.id, 30);
});

test('Executive requester: always auto-approved', () => {
  assert.strictEqual(route(5, ROLES.exec).kind, 'auto');
  assert.strictEqual(route(1e12, ROLES.exec).kind, 'auto');
});

test('escalate mode skips own tier; no tier covering → unrouted', () => {
  const esc = tiers.map((t) => (t.id === 10 ? { ...t, self_approval: 'escalate' } : t));
  assert.strictEqual(r.resolvePriceApproval(esc, 100, { role_id: ROLES.hr }).tier.id, 20);
  const capped = tiers.filter((t) => t.id !== 30);
  assert.strictEqual(r.resolvePriceApproval(capped, 2e7, { role_id: ROLES.staff }).kind, 'unrouted');
  assert.strictEqual(r.resolvePriceApproval([], 10, { role_id: ROLES.staff }).kind, 'unrouted');
});

test('inactive tiers are ignored', () => {
  const t = tiers.map((x) => (x.id === 10 ? { ...x, is_active: false } : x));
  assert.strictEqual(r.resolvePriceApproval(t, 100, { role_id: ROLES.staff }).tier.id, 20);
});

test('line manager / in-stock HR skip rules', () => {
  assert.ok(r.skipsLineManager({ is_gm: true }));
  assert.ok(r.skipsLineManager({ is_executive: true }));
  assert.ok(!r.skipsLineManager({ is_hr_manager: true }));
  assert.ok(r.skipsInStockHr({ is_hr_manager: true }));
  assert.ok(r.skipsInStockHr({ is_gm: true }));
  assert.ok(!r.skipsInStockHr({ is_finance_manager: true }));
  assert.ok(!r.skipsInStockHr({ is_it_admin: true }, { loneItAdmin: false }));
  assert.ok(r.skipsInStockHr({ is_it_admin: true }, { loneItAdmin: true }));
});

const user = (id, roleId, flags = {}) => ({ id, role: { id: roleId, ...flags } });
const ctx = { tiers, itAdminIds: [50, 51] };
const row = (status, extra = {}) => ({ status, requester_id: 1, requester_role_id: ROLES.staff, ...extra });

test('line manager can act, nobody else', () => {
  const r1 = row(REQ_STATUS.PENDING_LINE_MANAGER, { line_manager_id: 9 });
  assert.ok(r.getStageAccess(user(9, ROLES.hr, { is_hr_manager: true }), r1, ctx).canAct);
  assert.ok(!r.getStageAccess(user(8, ROLES.staff), r1, ctx).canAct);
});

test('IT admin cannot verify own request unless they are the only one', () => {
  const own = row(REQ_STATUS.PENDING_IT_INVENTORY, { requester_id: 50, requester_role_id: ROLES.it, requester_is_it_admin: true });
  const it50 = user(50, ROLES.it, { is_it_admin: true });
  const it51 = user(51, ROLES.it, { is_it_admin: true });
  assert.ok(!r.getStageAccess(it50, own, ctx).canAct);
  assert.ok(r.getStageAccess(it51, own, ctx).canAct);
  assert.ok(r.getStageAccess(it50, own, { ...ctx, itAdminIds: [50] }).canAct);
  assert.strictEqual(r.getStageAccess(it51, own, ctx).action, 'inventory_check');
});

test('HR in-stock approval: HR can act, HR requester cannot', () => {
  const hr = user(20, ROLES.hr, { is_hr_manager: true });
  assert.ok(r.getStageAccess(hr, row(REQ_STATUS.PENDING_HR), ctx).canAct);
  assert.ok(!r.getStageAccess(hr, row(REQ_STATUS.PENDING_HR, { requester_id: 20 }), ctx).canAct);
});

test('price approval: tier role acts; HR may self-approve (manual); GM tier excludes requester', () => {
  const hr = user(20, ROLES.hr, { is_hr_manager: true });
  const gm = user(30, ROLES.gm, { is_gm: true });
  const atHr = row(REQ_STATUS.PENDING_PRICE_APPROVAL, { approval_tier_id: 10 });
  assert.ok(r.getStageAccess(hr, atHr, ctx).canAct);
  assert.ok(!r.getStageAccess(gm, atHr, ctx).canAct);
  assert.ok(r.getStageAccess(hr, { ...atHr, requester_id: 20, requester_role_id: ROLES.hr }, ctx).canAct);
  const atGm = row(REQ_STATUS.PENDING_PRICE_APPROVAL, { approval_tier_id: 20, requester_id: 30, requester_role_id: ROLES.gm });
  assert.ok(!r.getStageAccess(gm, atGm, ctx).canAct);
});

test('unrouted price approval: Super Admin only', () => {
  const un = row(REQ_STATUS.PENDING_PRICE_APPROVAL, { approval_tier_id: null });
  assert.ok(!r.getStageAccess(user(20, ROLES.hr, { is_hr_manager: true }), un, ctx).canAct);
  assert.ok(r.getStageAccess({ ...user(99, null), is_super_admin: true }, un, ctx).canAct);
});

test('finance processing: Finance acts even on own request', () => {
  const fin = user(60, ROLES.fin, { is_finance_manager: true });
  const own = row(REQ_STATUS.PENDING_FINANCE_PROCESSING, { requester_id: 60, requester_role_id: ROLES.fin });
  const a = r.getStageAccess(fin, own, ctx);
  assert.ok(a.canAct);
  assert.strictEqual(a.action, 'finance_process');
});

test('IT queue statuses are not approval stages', () => {
  assert.ok(!r.getStageAccess(user(50, ROLES.it, { is_it_admin: true }), row(REQ_STATUS.SENT_TO_IT), ctx).canAct);
});
