/**
 * Build structured detail rows for rich notification emails.
 * Empty / null values are omitted.
 */

function fmt(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).trim();
}

function fmtDate(value) {
  if (!value) return '';
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return fmt(value);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_e) {
    return fmt(value);
  }
}

function rows(pairs) {
  return (pairs || [])
    .map(([label, value]) => ({ label, value: fmt(value) }))
    .filter((r) => r.label && r.value !== '');
}

function ticketDetails(ticket, extras = {}) {
  return rows([
    ['Ticket ID', ticket?.public_id],
    ['Subject', ticket?.subject],
    ['Status', extras.status || ticket?.status],
    ['Priority', ticket?.priority],
    ['Category', ticket?.category],
    ['Other category', ticket?.other_category],
    ['Department', ticket?.department],
    ['Requester', ticket?.requester_name],
    ['Requester email', ticket?.requester_email],
    ['Assigned to', ticket?.assigned_to],
    ['SLA due', fmtDate(ticket?.due_timestamp)],
    ['Created', fmtDate(ticket?.created_timestamp || ticket?.created_at)],
    ['Previous assignee', extras.previousAssignee],
    ['Updated by', extras.updatedBy],
    ['Hold reason', extras.holdReason || ticket?.hold_reason],
    ['Description', ticket?.description],
    ['Latest update', extras.replyText || extras.note],
    ['Reply from', extras.repliedBy],
    ['Reply message', extras.replyMessage],
  ]);
}

function requisitionDetails(row, extras = {}) {
  return rows([
    ['Request ID', row?.public_id],
    ['Item / asset', row?.item],
    ['Type', row?.type],
    ['Status', extras.status || row?.status],
    ['Urgency', row?.urgency],
    ['Project', row?.project],
    ['Department', row?.department],
    ['Requester', row?.requester_name],
    ['Requester email', row?.requester_email],
    ['Approver / signer', row?.approver_name],
    ['Executive Priority', extras.executivePriority ? 'Yes' : ''],
    ['SLA hours', extras.slaHours],
    ['SLA due', fmtDate(row?.due_timestamp)],
    ['Created', fmtDate(row?.created_timestamp || row?.created_at)],
    ['Actioned by', extras.actionedBy],
    ['Hold reason', extras.holdReason || row?.hold_reason],
    ['Rejection reason', extras.rejectReason],
    ['Justification', row?.justification],
    ['Latest update', extras.replyText || extras.note],
    ['Reply from', extras.repliedBy],
    ['Reply message', extras.replyMessage],
    ['Procurement item', extras.procurementItem],
    ['Vendor', extras.vendor],
  ]);
}

function assetDetails(asset, extras = {}) {
  return rows([
    ['Asset ID', asset?.public_id],
    ['Asset code', asset?.asset_code],
    ['Asset name', asset?.name],
    ['Category', asset?.category],
    ['Brand', asset?.brand],
    ['Serial number', asset?.serial_number],
    ['Assigned to', asset?.user_email || extras.userEmail],
    ['Assigned date', fmtDate(asset?.assigned_date)],
    ['Note', asset?.note],
    ['Description', asset?.description],
    ['Assigned by', extras.assignedBy],
  ]);
}

function userAccountDetails(user, extras = {}) {
  return rows([
    ['Name', user?.name],
    ['Email', user?.email],
    ['Department', user?.department],
    ['Designation', user?.designation],
    ['Line manager', user?.manager],
    ['Phone', user?.phone],
    ['Status', user?.status],
    ['Role', extras.roleName || user?.role_name],
    ['Changed fields', extras.changedFields],
    ['Previous designation', extras.previousKind],
    ['New designation', extras.newKind],
    ['Previous holder', extras.previousHolder],
    ['New holder', extras.newHolder],
    ['Fallback role', extras.fallbackRole],
    ['Pending work moved', extras.pendingMoved],
  ]);
}

function detailsToPlainText(details) {
  if (!details?.length) return '';
  return details.map((d) => `${d.label}: ${d.value}`).join('\n');
}

function ticketVars(ticket, extras = {}) {
  return {
    ticketId: fmt(ticket?.public_id),
    subject: fmt(ticket?.subject),
    status: fmt(extras.status || ticket?.status),
    priority: fmt(ticket?.priority),
    category: fmt(ticket?.category),
    department: fmt(ticket?.department),
    requesterName: fmt(ticket?.requester_name),
    requesterEmail: fmt(ticket?.requester_email),
    assignedTo: fmt(ticket?.assigned_to),
    description: fmt(ticket?.description),
    slaDue: fmtDate(ticket?.due_timestamp),
    previousAssignee: fmt(extras.previousAssignee),
    updatedBy: fmt(extras.updatedBy),
    holdReason: fmt(extras.holdReason || ticket?.hold_reason),
    latestUpdate: fmt(extras.replyText || extras.note),
    repliedBy: fmt(extras.repliedBy),
    replyMessage: fmt(extras.replyMessage),
    recipientRole: fmt(extras.recipientRole),
  };
}

function requisitionVars(row, extras = {}) {
  return {
    requestId: fmt(row?.public_id),
    item: fmt(row?.item),
    type: fmt(row?.type),
    status: fmt(extras.status || row?.status),
    urgency: fmt(row?.urgency),
    project: fmt(row?.project),
    department: fmt(row?.department),
    requesterName: fmt(row?.requester_name),
    requesterEmail: fmt(row?.requester_email),
    approverName: fmt(row?.approver_name),
    justification: fmt(row?.justification),
    executivePriority: extras.executivePriority ? 'Yes' : '',
    slaHours: fmt(extras.slaHours),
    actionedBy: fmt(extras.actionedBy),
    holdReason: fmt(extras.holdReason || row?.hold_reason),
    rejectReason: fmt(extras.rejectReason),
    latestUpdate: fmt(extras.replyText || extras.note),
    repliedBy: fmt(extras.repliedBy),
    replyMessage: fmt(extras.replyMessage),
    procurementId: fmt(extras.procurementId),
    vendor: fmt(extras.vendor),
    cost: fmt(extras.cost),
    brand: fmt(extras.brand),
    serialNumber: fmt(extras.serialNumber),
  };
}

function assetVars(asset, extras = {}) {
  return {
    assetId: fmt(asset?.public_id),
    assetCode: fmt(asset?.asset_code),
    assetName: fmt(asset?.name),
    category: fmt(asset?.category),
    brand: fmt(asset?.brand),
    serialNumber: fmt(asset?.serial_number),
    assignedDate: fmtDate(asset?.assigned_date),
    note: fmt(asset?.note),
    assignedBy: fmt(extras.assignedBy),
    userEmail: fmt(asset?.user_email || extras.userEmail),
  };
}

function userVars(user, extras = {}) {
  return {
    name: fmt(user?.name),
    email: fmt(user?.email),
    department: fmt(user?.department),
    designation: fmt(user?.designation),
    manager: fmt(user?.manager),
    phone: fmt(user?.phone),
    status: fmt(user?.status),
    roleName: fmt(extras.roleName || user?.role_name),
    changedFields: fmt(extras.changedFields),
    kind: fmt(extras.kind || extras.newKind || extras.previousKind),
    previousHolder: fmt(extras.previousHolder),
    newHolder: fmt(extras.newHolder),
    fallbackRole: fmt(extras.fallbackRole),
    pendingMoved: fmt(extras.pendingMoved),
  };
}

module.exports = {
  fmt,
  fmtDate,
  rows,
  ticketDetails,
  requisitionDetails,
  assetDetails,
  userAccountDetails,
  detailsToPlainText,
  ticketVars,
  requisitionVars,
  assetVars,
  userVars,
};
