/**
 * Enterprise portal workflow constants — asset requests & tickets.
 */

const REQ_STATUS = {
  PENDING_LINE_MANAGER: 'Pending Line Manager Approval',
  PENDING_IT_INVENTORY: 'Pending IT Inventory Check',
  PENDING_IT_PRICING: 'Pending IT Pricing',
  PENDING_PRICE_APPROVAL: 'Pending Price Approval',
  PENDING_FINANCE_PROCESSING: 'Pending Finance Processing',
  PENDING_HR: 'Pending HR Approval',
  // Legacy stages (pre requester-based workflow) — still actionable for existing rows
  PENDING_FINANCE: 'Pending Finance Approval',
  PENDING_GM: 'Pending GM Approval',
  PENDING_EXECUTIVE: 'Pending Executive Approval',
  SENT_TO_IT: 'Approved - Sent to IT',
  IN_PROGRESS: 'In Progress',
  ON_HOLD: 'On Hold',
  IN_PROCUREMENT: 'In Procurement',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
};

const TICKET_STATUS = {
  PENDING_LINE_MANAGER: 'Pending Line Manager',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In Progress',
  ON_HOLD: 'On Hold',
  RESOLVED: 'Resolved',
  REJECTED: 'Rejected',
};

const IT_QUEUE_STATUSES = [
  REQ_STATUS.SENT_TO_IT,
  REQ_STATUS.IN_PROGRESS,
  REQ_STATUS.IN_PROCUREMENT,
  REQ_STATUS.ON_HOLD,
];

const SIGNER_PENDING = [
  REQ_STATUS.PENDING_LINE_MANAGER,
  REQ_STATUS.PENDING_IT_INVENTORY,
  REQ_STATUS.PENDING_IT_PRICING,
  REQ_STATUS.PENDING_PRICE_APPROVAL,
  REQ_STATUS.PENDING_FINANCE_PROCESSING,
  REQ_STATUS.PENDING_HR,
  REQ_STATUS.PENDING_FINANCE,
  REQ_STATUS.PENDING_GM,
  REQ_STATUS.PENDING_EXECUTIVE,
];

module.exports = {
  REQ_STATUS,
  TICKET_STATUS,
  IT_QUEUE_STATUSES,
  SIGNER_PENDING,
};
