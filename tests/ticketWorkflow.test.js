// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const flow = require('../services/ticketWorkflow');
const { TICKET_STATUS: S } = require('../services/workflowConstants');

const itAdmin = { id: 50, is_it_admin: true };
const otherItAdmin = { id: 51, is_it_admin: true };
const staff = { id: 1, is_it_admin: false };
const ticket = (status, extra = {}) => ({ status, assigned_to_id: 50, ...extra });

test('category, summary and description are mandatory', () => {
  assert.deepStrictEqual(flow.validateNewTicket({ category: 'Hardware', subject: 'x', description: 'y' }), []);
  const errs = flow.validateNewTicket({ subject: '  ' });
  assert.ok(errs.some((e) => e.startsWith('category')));
  assert.ok(errs.some((e) => e.startsWith('subject')));
  assert.ok(errs.some((e) => e.startsWith('description')));
  assert.ok(flow.validateNewTicket({ category: 'Other', subject: 'x', description: 'y' })[0].startsWith('other_category'));
});

test('new ticket goes to Line Manager, or straight to IT triage without one', () => {
  assert.strictEqual(flow.initialStatus(9), S.PENDING_LINE_MANAGER);
  assert.strictEqual(flow.initialStatus(null), S.PENDING_TRIAGE);
});

test('only Admin/IT triage and assign; assignment moves triage → Assigned, reassignment keeps status', () => {
  const t = ticket(S.PENDING_TRIAGE, { assigned_to_id: null });
  assert.ok(flow.checkAction('assign', itAdmin, t).ok);
  assert.strictEqual(flow.checkAction('assign', staff, t).status, 403);
  assert.strictEqual(flow.assignTarget(t), S.ASSIGNED);
  assert.strictEqual(flow.assignTarget(ticket(S.ON_HOLD)), S.ON_HOLD);
  assert.strictEqual(flow.checkAction('assign', itAdmin, ticket(S.PENDING_LINE_MANAGER)).status, 409);
  assert.strictEqual(flow.checkAction('assign', itAdmin, ticket(S.COMPLETED)).status, 409);
});

test('only the assignee records progress and resolution', () => {
  const t = ticket(S.ASSIGNED);
  assert.deepStrictEqual(flow.checkAction('in_progress', itAdmin, t), { ok: true, to: S.IN_PROGRESS });
  assert.strictEqual(flow.checkAction('in_progress', otherItAdmin, t).status, 403);
  assert.strictEqual(flow.checkAction('resolve', staff, t).status, 403);
  assert.strictEqual(flow.checkAction('resolve', itAdmin, ticket(S.IN_PROGRESS)).to, S.RESOLVED);
});

test('assignee transitions follow the lifecycle', () => {
  assert.strictEqual(flow.checkAction('hold', itAdmin, ticket(S.IN_PROGRESS)).to, S.ON_HOLD);
  assert.strictEqual(flow.checkAction('resume', itAdmin, ticket(S.ON_HOLD)).to, S.IN_PROGRESS);
  assert.strictEqual(flow.checkAction('resolve', itAdmin, ticket(S.ON_HOLD)).status, 409); // resume first
  assert.strictEqual(flow.checkAction('in_progress', itAdmin, ticket(S.REJECTED)).status, 409);
  assert.strictEqual(flow.checkAction('resolve', itAdmin, ticket(S.RESOLVED)).status, 409);
});

test('Admin/IT completes only resolved tickets', () => {
  assert.strictEqual(flow.checkAction('complete', otherItAdmin, ticket(S.RESOLVED)).to, S.COMPLETED);
  assert.strictEqual(flow.checkAction('complete', staff, ticket(S.RESOLVED)).status, 403);
  assert.strictEqual(flow.checkAction('complete', itAdmin, ticket(S.IN_PROGRESS)).status, 409);
});

test('details are editable only during triage / work, never after completion', () => {
  assert.ok(flow.checkAction('edit', itAdmin, ticket(S.PENDING_TRIAGE)).ok);
  assert.ok(flow.checkAction('edit', itAdmin, ticket(S.IN_PROGRESS)).ok);
  assert.strictEqual(flow.checkAction('edit', itAdmin, ticket(S.PENDING_LINE_MANAGER)).status, 409);
  assert.strictEqual(flow.checkAction('edit', itAdmin, ticket(S.COMPLETED)).status, 409);
  assert.strictEqual(flow.checkAction('edit', staff, ticket(S.IN_PROGRESS)).status, 403);
});

test('priority values and SLA hours', () => {
  assert.ok(flow.isPriority('High'));
  assert.ok(!flow.isPriority('Urgent'));
  assert.strictEqual(flow.slaHours('High'), 4);
  assert.strictEqual(flow.slaHours('Low'), 48);
});
