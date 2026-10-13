const tierService = require('../services/approvalTierService');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function describe(tier) {
  const limit = tier.max_amount === null ? 'unlimited' : `up to ${tier.max_amount}`;
  return `${tier.role_name} (${limit}, self-approval: ${tier.self_approval})`;
}

function handleError(err, res, next) {
  if (err.status) return res.status(err.status).json({ success: false, message: err.message });
  return next(err);
}

async function list(req, res, next) {
  try {
    return res.json({ success: true, data: await tierService.listTiers() });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const tier = await tierService.createTier(req.body || {});
    await addAuditLog({
      user: actor(req),
      action: 'Created Approval Tier',
      details: `Approval tier ${describe(tier)}`,
      targetId: String(tier.id),
    });
    return res.status(201).json({ success: true, data: tier });
  } catch (err) {
    return handleError(err, res, next);
  }
}

async function update(req, res, next) {
  try {
    const tier = await tierService.updateTier(req.params.id, req.body || {});
    await addAuditLog({
      user: actor(req),
      action: 'Updated Approval Tier',
      details: `Approval tier ${describe(tier)}${tier.is_active ? '' : ' [inactive]'}`,
      targetId: String(tier.id),
    });
    return res.json({ success: true, data: tier });
  } catch (err) {
    return handleError(err, res, next);
  }
}

async function remove(req, res, next) {
  try {
    const tier = await tierService.removeTier(req.params.id);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Approval Tier',
      details: `Removed approval tier ${describe(tier)}`,
      targetId: String(tier.id),
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return handleError(err, res, next);
  }
}

module.exports = { list, create, update, remove };
