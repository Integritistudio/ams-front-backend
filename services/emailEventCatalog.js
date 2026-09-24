/**
 * Catalog of notification email events, variables, and default copy.
 * Custom templates in DB bind to these event keys.
 */

const COMMON_CTA = {
  tickets: 'View tickets',
  approvals: 'Open pending approvals',
  requisitions: 'View requisition',
  assets: 'View my assets',
  portal: 'Open portal',
  account: 'View my account',
};

const EVENTS = [
  {
    key: 'ticket.created',
    name: 'Ticket created',
    description: 'Sent when a support ticket is created (requester, IT Admin, assignee).',
    category: 'Tickets',
    defaultSubject: 'Ticket {{ticketId}} — {{subject}}',
    defaultBody:
      'A support ticket has been submitted.\n\nTicket: {{ticketId}}\nSubject: {{subject}}\nPriority: {{priority}}\nAssigned to: {{assignedTo}}\nRequester: {{requesterName}} ({{requesterEmail}})',
    variables: [
      'ticketId', 'subject', 'status', 'priority', 'category', 'department',
      'requesterName', 'requesterEmail', 'assignedTo', 'description', 'slaDue', 'recipientRole',
    ],
  },
  {
    key: 'ticket.assigned',
    name: 'Ticket assigned',
    description: 'Sent when a ticket is assigned to someone.',
    category: 'Tickets',
    defaultSubject: 'Ticket {{ticketId}} assigned to you',
    defaultBody:
      'Ticket {{ticketId}} "{{subject}}" was assigned to {{assignedTo}}.\nPriority: {{priority}}.',
    variables: [
      'ticketId', 'subject', 'status', 'priority', 'assignedTo', 'previousAssignee',
      'requesterName', 'updatedBy',
    ],
  },
  {
    key: 'ticket.status_changed',
    name: 'Ticket status changed',
    description: 'Sent when IT Admin changes ticket status (In Progress, On Hold, Resolved, etc.).',
    category: 'Tickets',
    defaultSubject: 'Ticket {{ticketId}}: {{status}}',
    defaultBody:
      'Ticket {{ticketId}} status is now {{status}}.\n{{latestUpdate}}',
    variables: [
      'ticketId', 'subject', 'status', 'priority', 'holdReason', 'latestUpdate',
      'updatedBy', 'requesterName',
    ],
  },
  {
    key: 'ticket.reply',
    name: 'Ticket reply',
    description: 'Sent when someone posts a reply on a ticket.',
    category: 'Tickets',
    defaultSubject: 'Reply on Ticket {{ticketId}}',
    defaultBody:
      '{{repliedBy}} replied on ticket {{ticketId}}:\n\n{{replyMessage}}',
    variables: [
      'ticketId', 'subject', 'status', 'repliedBy', 'replyMessage', 'requesterName',
    ],
  },
  {
    key: 'requisition.created',
    name: 'Asset request submitted',
    description: 'Sent to requester when a normal asset request is submitted for approval.',
    category: 'Asset Requests',
    defaultSubject: 'Requisition {{requestId}} submitted',
    defaultBody:
      'Your asset request {{requestId}} for "{{item}}" was forwarded to {{approverName}}.',
    variables: [
      'requestId', 'item', 'type', 'status', 'urgency', 'project', 'department',
      'requesterName', 'requesterEmail', 'approverName', 'justification',
    ],
  },
  {
    key: 'requisition.pending_approver',
    name: 'Asset request needs approval',
    description: 'Sent to Approver/Executive when a request needs their sign-off.',
    category: 'Asset Requests',
    defaultSubject: 'Pending Requisition {{requestId}}',
    defaultBody:
      'New asset requisition {{requestId}} for "{{item}}" was submitted by {{requesterName}} and needs your approval.',
    variables: [
      'requestId', 'item', 'type', 'urgency', 'project', 'department',
      'requesterName', 'requesterEmail', 'justification', 'approverName',
    ],
  },
  {
    key: 'requisition.created_executive',
    name: 'Executive Priority request (auto → IT)',
    description: 'Sent when an Executive creates a request that skips Approver and goes to IT.',
    category: 'Asset Requests',
    defaultSubject: 'Executive Priority — Requisition {{requestId}}',
    defaultBody:
      'Executive {{actionedBy}} submitted requisition {{requestId}} for "{{item}}". Manager approval was skipped — please action under Pending Approvals.',
    variables: [
      'requestId', 'item', 'type', 'urgency', 'project', 'department',
      'requesterName', 'requesterEmail', 'justification', 'actionedBy', 'executivePriority',
    ],
  },
  {
    key: 'requisition.approved',
    name: 'Asset request approved (requester)',
    description: 'Sent to the requester when Approver/Executive approves and forwards to IT.',
    category: 'Asset Requests',
    defaultSubject: 'Approved Requisition {{requestId}}',
    defaultBody:
      'Your requisition {{requestId}} for "{{item}}" has been approved by {{actionedBy}} and forwarded to IT for fulfillment.',
    variables: [
      'requestId', 'item', 'status', 'actionedBy', 'slaHours', 'requesterName',
      'approverName', 'department', 'project',
    ],
  },
  {
    key: 'requisition.approved_confirm',
    name: 'Asset request approved (your confirmation)',
    description: 'Confirmation sent to the Approver/Executive who just approved the request.',
    category: 'Asset Requests',
    defaultSubject: 'You approved Requisition {{requestId}}',
    defaultBody:
      'You have approved requisition {{requestId}} for "{{item}}" (requested by {{requesterName}}). It has been sent to IT Admin for fulfillment.',
    variables: [
      'requestId', 'item', 'status', 'actionedBy', 'slaHours', 'requesterName',
      'approverName', 'department', 'project',
    ],
  },
  {
    key: 'requisition.approved_it',
    name: 'Asset request approved (IT action)',
    description: 'Sent to IT Admin / procurement when a request is approved and needs IT action.',
    category: 'Asset Requests',
    defaultSubject: 'Approved Requisition {{requestId}} — action required',
    defaultBody:
      '{{actionedBy}} (Approver/Manager) approved requisition {{requestId}} for "{{item}}" (requested by {{requesterName}}). Please take care of it now under Pending Approvals.',
    variables: [
      'requestId', 'item', 'status', 'actionedBy', 'slaHours', 'requesterName',
      'approverName', 'department', 'project',
    ],
  },
  {
    key: 'requisition.rejected',
    name: 'Asset request rejected',
    description: 'Sent when a request is rejected by the signer.',
    category: 'Asset Requests',
    defaultSubject: 'Rejected Requisition {{requestId}}',
    defaultBody:
      'Your requisition {{requestId}} was rejected by {{actionedBy}}: {{rejectReason}}',
    variables: [
      'requestId', 'item', 'status', 'actionedBy', 'rejectReason', 'requesterName',
    ],
  },
  {
    key: 'requisition.status_changed',
    name: 'Asset request IT status update',
    description: 'Sent when IT Admin sets In Progress / On Hold / Completed on an asset request.',
    category: 'Asset Requests',
    defaultSubject: 'Requisition {{requestId}}: {{status}}',
    defaultBody:
      'Asset request {{requestId}} status is now {{status}}.\n{{latestUpdate}}',
    variables: [
      'requestId', 'item', 'status', 'holdReason', 'latestUpdate', 'actionedBy',
      'requesterName',
    ],
  },
  {
    key: 'requisition.reply',
    name: 'Asset request reply',
    description: 'Sent when a comment/reply is posted on an asset request.',
    category: 'Asset Requests',
    defaultSubject: 'Reply on Requisition {{requestId}}',
    defaultBody:
      '{{repliedBy}} replied on requisition {{requestId}}:\n\n{{replyMessage}}',
    variables: [
      'requestId', 'item', 'repliedBy', 'replyMessage', 'requesterName',
    ],
  },
  {
    key: 'requisition.completed_procurement',
    name: 'Completed via procurement',
    description: 'Sent when a linked Procurement Log completes an asset request.',
    category: 'Asset Requests',
    defaultSubject: 'Completed Requisition {{requestId}}',
    defaultBody:
      'Asset request {{requestId}} for "{{item}}" has been completed via procurement delivery.',
    variables: [
      'requestId', 'item', 'status', 'procurementId', 'vendor', 'cost', 'brand',
      'serialNumber', 'requesterName', 'actionedBy',
    ],
  },
  {
    key: 'asset.assigned',
    name: 'Asset assigned',
    description: 'Sent when an asset is assigned or reassigned to a user.',
    category: 'Assets',
    defaultSubject: 'Asset assigned: {{assetName}}',
    defaultBody:
      'IT assigned asset "{{assetName}}" ({{assetCode}}) to your account.',
    variables: [
      'assetId', 'assetCode', 'assetName', 'category', 'brand', 'serialNumber',
      'assignedDate', 'note', 'assignedBy', 'userEmail',
    ],
  },
  {
    key: 'user.created',
    name: 'User account created',
    description: 'Welcome email when an administrator creates a user account.',
    category: 'Users',
    defaultSubject: 'Your IT Service Desk account has been created',
    defaultBody:
      'An administrator created an IT Service Desk account for you ({{email}}).',
    variables: [
      'name', 'email', 'department', 'designation', 'manager', 'phone', 'status', 'roleName',
    ],
  },
  {
    key: 'user.updated',
    name: 'User account updated',
    description: 'Sent when an administrator updates a user profile.',
    category: 'Users',
    defaultSubject: 'Your IT Service Desk account was updated',
    defaultBody:
      'An administrator updated your IT Service Desk profile. Updated fields: {{changedFields}}.',
    variables: [
      'name', 'email', 'department', 'designation', 'manager', 'phone', 'status',
      'roleName', 'changedFields',
    ],
  },
  {
    key: 'user.role_transferred',
    name: 'Approver / IT Admin transferred',
    description: 'Sent to previous and new holders when a special role is transferred.',
    category: 'Users',
    defaultSubject: '{{kind}} role update',
    defaultBody:
      'The {{kind}} designation changed. Previous: {{previousHolder}}. New: {{newHolder}}. Pending work moved: {{pendingMoved}}.',
    variables: [
      'kind', 'previousHolder', 'newHolder', 'fallbackRole', 'pendingMoved', 'name', 'email',
    ],
  },
  {
    key: 'auth.password_setup',
    name: 'Password setup',
    description: 'Sent when a user must set their first password (link email).',
    category: 'Auth',
    defaultSubject: 'Set up your IT Service Desk password',
    defaultBody:
      'An administrator created your account. Use the button/link to choose a password. Link valid for 24 hours.\n\nName: {{name}}\nEmail: {{email}}',
    variables: ['name', 'email', 'setupUrl', 'linkValidity'],
  },
  {
    key: 'auth.password_reset',
    name: 'Password reset',
    description: 'Sent when a user requests a password reset.',
    category: 'Auth',
    defaultSubject: 'Reset your IT Service Desk password',
    defaultBody:
      'We received a request to reset your password. Use the button/link to choose a new password.\n\nName: {{name}}\nEmail: {{email}}',
    variables: ['name', 'email', 'resetUrl'],
  },
];

function getEvent(key) {
  return EVENTS.find((e) => e.key === key) || null;
}

function listEvents() {
  return EVENTS.map((e) => ({
    key: e.key,
    name: e.name,
    description: e.description,
    category: e.category,
    variables: e.variables,
    defaultSubject: e.defaultSubject,
    defaultBody: e.defaultBody,
  }));
}

/** Sample values for UI preview */
function sampleVarsFor(key) {
  const base = {
    ticketId: 'TKT-20260324001',
    subject: 'Laptop not connecting to VPN',
    status: 'Assigned',
    priority: 'High',
    category: 'Network',
    department: 'IT & Software Engineering',
    requesterName: 'Alex Staff',
    requesterEmail: 'alex.staff@example.com',
    assignedTo: 'it.admin@example.com',
    description: 'VPN client fails after update.',
    slaDue: '24 Mar 2026, 14:00',
    previousAssignee: 'IT Support',
    updatedBy: 'Sam Admin',
    holdReason: 'Waiting for vendor response',
    latestUpdate: 'IT Support marked ticket In Progress.',
    repliedBy: 'Sam Admin',
    replyMessage: 'We are checking your VPN profile.',
    recipientRole: 'Requester',
    requestId: 'REQ-20260324001',
    item: 'Dell Latitude 5540',
    type: 'Hardware',
    urgency: 'Urgent',
    project: 'FY26 Refresh',
    approverName: 'Pat Approver',
    justification: 'Current laptop battery health is below 60%.',
    actionedBy: 'Casey Executive',
    executivePriority: 'Yes',
    slaHours: '48',
    rejectReason: 'Budget not approved this quarter',
    procurementId: 'PROC-20260324001',
    vendor: 'Dell',
    cost: '1200',
    brand: 'Dell',
    serialNumber: 'SN-12345',
    assetId: 'AST-20260324001',
    assetCode: 'LT-0042',
    assetName: 'Dell Latitude 5540',
    assignedDate: '24 Mar 2026',
    note: 'Include charger and docking station.',
    assignedBy: 'Sam Admin',
    userEmail: 'alex.staff@example.com',
    name: 'Alex Staff',
    email: 'alex.staff@example.com',
    designation: 'Analyst',
    manager: 'Line Manager',
    phone: '+1 555 0100',
    roleName: 'Staff',
    changedFields: 'department, phone',
    kind: 'Approver',
    previousHolder: 'Old Approver (old@example.com)',
    newHolder: 'New Approver (new@example.com)',
    fallbackRole: 'Staff',
    pendingMoved: '3 pending approval(s)',
    setupUrl: 'https://portal.example.com/setup-password?token=…',
    resetUrl: 'https://portal.example.com/reset-password?token=…',
    linkValidity: '24 hours',
    portalUrl: process.env.FRONTEND_URL || 'http://localhost:3001',
  };
  const ev = getEvent(key);
  if (!ev) return base;
  const out = {};
  for (const v of ev.variables) {
    if (base[v] !== undefined) out[v] = base[v];
  }
  out.portalUrl = base.portalUrl;
  return out;
}

module.exports = {
  EVENTS,
  COMMON_CTA,
  getEvent,
  listEvents,
  sampleVarsFor,
};
