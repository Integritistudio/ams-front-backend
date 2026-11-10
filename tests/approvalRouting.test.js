// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const r = require('../services/approvalRouting');
const { REQ_STATUS } = require('../services/workflowConstants');

const ROLES = { staff: 1, hr: 2, gm: 3, exec: 4, it: 5, fin: 6 };
// Requirements thresholds: HR ≤ 50,000; GM ≤ 300,000; Executive above.
const tiers = [
  { id: 30, role_id: ROLES.exec, role_name: 'Executive', max_amount: null, self_approval: 'auto' },
  { id: 10, role_id: ROLES.hr, role_name: 'HR', max_amount: '50000.00', self_approval: 'manual', role_is_hr_manager: true },
  { id: 20, role_id: ROLES.gm, role_name: 'GM', max_amount: '300000.00', self_approval: 'auto' },
];
const chain = (amount, roleId, t = tiers) => r.resolveApprovalChain(t, amount, { role_id: roleId });
const shape = (steps) => steps.map((s) => `${s.tier_id ?? 'SA'}:${s.kind}${s.requester_may_act ? '+self' : ''}`);

test('staff: approvals are sequential up to the tier covering the amount', () => {
  assert.deepStrictEqual(shape(chain(30000, ROLES.staff)), ['10:approve']);
  assert.deepStrictEqual(shape(chain(50000, ROLES.staff)), ['10:approve']); // boundary: up to 50k → HR only
  assert.deepStrictEqual(shape(chain(50001, ROLES.staff)), ['10:approve', '20:approve']);
  assert.deepStrictEqual(shape(chain(300000, ROLES.staff)), ['10:approve', '20:approve']);
  assert.deepStrictEqual(shape(chain(300001, ROLES.staff)), ['10:approve', '20:approve', '30:approve']);
});

test('finance manager / IT admin follow the standard chain', () => {
  assert.deepStrictEqual(shape(chain(1000, ROLES.fin)), ['10:approve']);
  assert.deepStrictEqual(shape(chain(400000, ROLES.it)), ['10:approve', '20:approve', '30:approve']);
});

test('HR requester (manual): may approve own HR step; higher tiers still approve', () => {
  assert.deepStrictEqual(shape(chain(40000, ROLES.hr)), ['10:approve+self']);
  assert.deepStrictEqual(shape(chain(60000, ROLES.hr)), ['10:approve+self', '20:approve']);
});

test('GM requester (auto): HR still approves; GM step auto; Executive above GM limit', () => {
  assert.deepStrictEqual(shape(chain(1000, ROLES.gm)), ['10:approve']);
  assert.deepStrictEqual(shape(chain(200000, ROLES.gm)), ['10:approve', '20:auto']);
  assert.deepStrictEqual(shape(chain(500000, ROLES.gm)), ['10:approve', '20:auto', '30:approve']);
});

test('Executive requester (auto): lower tiers approve, own step auto', () => {
  assert.deepStrictEqual(shape(chain(5, ROLES.exec)), ['10:approve']);
  assert.deepStrictEqual(shape(chain(1e9, ROLES.exec)), ['10:approve', '20:approve', '30:auto']);
});

test('escalate: own step skipped; top-of-chain skip adds the next tier', () => {
  const esc = tiers.map((t) => (t.id === 10 || t.id === 20 ? { ...t, self_approval: 'escalate' } : t));
  assert.deepStrictEqual(shape(chain(100, ROLES.hr, esc)), ['10:skipped', '20:approve']);
  assert.deepStrictEqual(shape(chain(200000, ROLES.hr, esc)), ['10:skipped', '20:approve']);
  assert.deepStrictEqual(shape(chain(200000, ROLES.gm, esc)), ['10:approve', '20:skipped', '30:approve']);
  const capped = esc.filter((t) => t.id !== 30);
  assert.deepStrictEqual(shape(chain(200000, ROLES.gm, capped)), ['10:approve', '20:skipped', 'SA:approve']);
});

test('no tier covers amount → all tiers then Super Admin; no tiers → Super Admin only', () => {
  const capped = tiers.filter((t) => t.id !== 30);
  assert.deepStrictEqual(shape(chain(2e7, ROLES.staff, capped)), ['10:approve', '20:approve', 'SA:approve']);
  assert.deepStrictEqual(shape(chain(10, ROLES.staff, [])), ['SA:approve']);
});

test('inactive tiers are ignored', () => {
  const t = tiers.map((x) => (x.id === 10 ? { ...x, is_active: false } : x));
  assert.deepStrictEqual(shape(chain(100, ROLES.staff, t)), ['20:approve']);
});

test('nextPendingStep walks the chain past approved / auto / skipped steps', () => {
  const steps = chain(500000, ROLES.gm);
  assert.strictEqual(r.nextPendingStep(steps), 0);
  steps[0].status = 'approved';
  assert.strictEqual(r.nextPendingStep(steps), 2); // GM step is auto
  steps[2].status = 'approved';
  assert.strictEqual(r.nextPendingStep(steps), -1);
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

test('price approval follows the current chain step, incl. self-approval flag', () => {
  const hr = user(20, ROLES.hr, { is_hr_manager: true });
  const gm = user(30, ROLES.gm, { is_gm: true });
  const steps = chain(60000, ROLES.hr);
  const atHr = row(REQ_STATUS.PENDING_PRICE_APPROVAL, {
    approval_tier_id: 10, approval_chain: steps, requester_id: 20, requester_role_id: ROLES.hr,
  });
  assert.ok(r.getStageAccess(hr, atHr, ctx).canAct); // manual → HR may approve own step
  assert.ok(!r.getStageAccess(gm, atHr, ctx).canAct); // GM waits for HR first
  const afterHr = steps.map((s, i) => (i === 0 ? { ...s, status: 'approved' } : s));
  const atGm = { ...atHr, approval_tier_id: 20, approval_chain: afterHr };
  assert.ok(r.getStageAccess(gm, atGm, ctx).canAct);
  assert.ok(!r.getStageAccess(hr, atGm, ctx).canAct);
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
