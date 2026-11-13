// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const a = require('../services/availability');

const now = new Date('2026-11-13T10:00:00');
const mgr = (id, extra = {}) => ({ id, name: `M${id}`, status: 'Active', availability_status: 'Available', ...extra });
const leave = (id, extra = {}) => mgr(id, { availability_status: 'On Leave', ...extra });

test('statuses: default Available; end date expires the status', () => {
  assert.strictEqual(a.effectiveStatus({}, now), 'Available');
  assert.strictEqual(a.effectiveStatus({ availability_status: 'On Leave', availability_until: '2026-11-13' }, now), 'On Leave');
  assert.strictEqual(a.effectiveStatus({ availability_status: 'On Leave', availability_until: '2026-11-12' }, now), 'Available');
  assert.strictEqual(a.statusLabel({ availability_status: 'Custom', availability_custom: 'WFH' }, now), 'WFH');
  assert.strictEqual(a.statusLabel({ availability_status: 'On Leave', availability_until: '2026-11-20' }, now), 'On Leave until 2026-11-20');
});

test('only On Leave counts as away', () => {
  for (const s of ['Available', 'In a Meeting', 'On Break', 'Custom']) {
    assert.ok(!a.isOnLeave({ availability_status: s }, now), s);
  }
  assert.ok(a.isOnLeave({ availability_status: 'On Leave' }, now));
});

test('status validation', () => {
  assert.ok(a.validateStatusUpdate({ status: 'On Break' }, now).ok);
  assert.ok(!a.validateStatusUpdate({ status: 'Sleeping' }, now).ok);
  assert.ok(!a.validateStatusUpdate({ status: 'Custom' }, now).ok);
  assert.deepStrictEqual(a.validateStatusUpdate({ status: 'Custom', custom_text: ' WFH ' }, now).value, { status: 'Custom', custom: 'WFH', until: null });
  assert.ok(!a.validateStatusUpdate({ status: 'On Leave', until: '2026-11-01' }, now).ok);
  assert.strictEqual(a.validateStatusUpdate({ status: 'On Leave', until: '2026-11-20' }, now).value.until, '2026-11-20');
  assert.strictEqual(a.validateStatusUpdate({ status: 'Available', until: '2026-11-20' }, now).value.until, null);
});

test('Line Manager available → no forwarding', () => {
  const r = a.pickApprover([mgr(2), mgr(3)], 1, now);
  assert.strictEqual(r.approver.id, 2);
  assert.strictEqual(r.passedOver.length, 0);
});

test('Line Manager on leave → their manager; up to level 3', () => {
  assert.strictEqual(a.pickApprover([leave(2), mgr(3)], 1, now).approver.id, 3);
  assert.strictEqual(a.pickApprover([leave(2), leave(3), mgr(4)], 1, now).approver.id, 4);
});

test('all 3 levels unavailable, or chain ends → skip Line Manager step', () => {
  const r = a.pickApprover([leave(2), leave(3), leave(4), mgr(5)], 1, now);
  assert.strictEqual(r.approver, null); // level 4 is never used
  assert.strictEqual(r.passedOver.length, 3);
  assert.strictEqual(a.pickApprover([leave(2)], 1, now).approver, null);
  assert.strictEqual(a.pickApprover([], 1, now).approver, null);
});

test('requester and inactive managers are passed over; other statuses do not forward', () => {
  assert.strictEqual(a.pickApprover([mgr(1), mgr(3)], 1, now).approver.id, 3);
  assert.strictEqual(a.pickApprover([mgr(2, { status: 'Suspended' }), mgr(3)], 1, now).approver.id, 3);
  assert.strictEqual(a.pickApprover([mgr(2, { availability_status: 'In a Meeting' }), mgr(3)], 1, now).approver.id, 2);
  assert.strictEqual(a.pickApprover([leave(2, { availability_until: '2026-11-01' }), mgr(3)], 1, now).approver.id, 2);
});
