/**
 * Pure rules for fulfilling an approved asset request from inventory (no DB access).
 *
 * Requirements (Hardware / Software Asset Request, Steps 4A, 7, 8; Common "Inventory and Procurement"):
 *  - Existing stock: assign from inventory after approval; no procurement log.
 *  - Purchase: only after payment, Admin/IT verifies the item / license and clicks Confirm Purchase;
 *    that alone creates the procurement log and adds the stock to inventory.
 *  - Approval or invoice receipt must not register inventory.
 *  - Items must be registered in inventory before assignment; the request completes once assigned.
 */
const { REQ_STATUS } = require('./workflowConstants');

/** Statuses in which IT is fulfilling an approved request. */
const FULFILMENT_STATUSES = [REQ_STATUS.SENT_TO_IT, REQ_STATUS.IN_PROGRESS, REQ_STATUS.IN_PROCUREMENT];

function result(ok, message, status = 409) {
  return ok ? { ok: true } : { ok: false, status, message };
}

/** Request needs a purchase (IT found no suitable stock at the inventory check). */
function isPurchasePath(row) {
  return row?.inventory_available === false;
}

function requestedQuantity(row) {
  const n = Math.floor(Number(row?.quantity));
  return n > 0 ? n : 1;
}

/** Finance has processed payment — or the request predates Finance processing (legacy approvals). */
function isPaid(row) {
  const fin = row?.finance_details;
  if (!fin) return true;
  return Boolean(fin.paid_at);
}

function checkConfirmPurchase(row) {
  if (!row) return result(false, 'Requisition not found', 404);
  if (!isPurchasePath(row)) {
    return result(false, 'This request is fulfilled from existing stock; no purchase to confirm.');
  }
  if (row.purchase_confirmed_at) return result(false, 'Purchase was already confirmed for this request.');
  if (!FULFILMENT_STATUSES.includes(row.status)) {
    return result(false, `Cannot confirm a purchase while the request is "${row.status}".`);
  }
  if (!isPaid(row)) return result(false, 'Finance has not processed the payment yet.');
  return result(true);
}

/**
 * May one more asset be assigned against this request?
 * @param {object} row requisition
 * @param {number} linkedCount assets already linked to the request
 */
function checkAssignToRequest(row, linkedCount) {
  if (!row) return result(false, 'Linked asset request not found', 400);
  if (![...FULFILMENT_STATUSES, REQ_STATUS.ON_HOLD].includes(row.status)) {
    return result(false, `Assets can only be assigned once the request is approved (current status "${row.status}").`);
  }
  if (isPurchasePath(row) && !row.purchase_confirmed_at) {
    return result(false, 'Confirm the purchase first: the purchased item must be registered in inventory before assignment.');
  }
  const qty = requestedQuantity(row);
  if (Number(linkedCount) >= qty) {
    return result(false, `All ${qty} requested item(s) are already assigned for this request.`);
  }
  return result(true);
}

function checkComplete(row, linkedCount) {
  if (!row) return result(false, 'Requisition not found', 404);
  if (!FULFILMENT_STATUSES.includes(row.status)) {
    return result(false, `Cannot complete a request that is "${row.status}".`, 400);
  }
  if (isPurchasePath(row) && !row.purchase_confirmed_at) {
    return result(false, 'Cannot complete: confirm the purchase first.', 400);
  }
  const qty = requestedQuantity(row);
  if (Number(linkedCount) < qty) {
    return result(
      false,
      `Cannot complete: ${linkedCount} of ${qty} requested item(s) assigned. Assign the rest under Assign Assets.`,
      400
    );
  }
  return result(true);
}

module.exports = {
  FULFILMENT_STATUSES,
  isPurchasePath,
  requestedQuantity,
  isPaid,
  checkConfirmPurchase,
  checkAssignToRequest,
  checkComplete,
};
