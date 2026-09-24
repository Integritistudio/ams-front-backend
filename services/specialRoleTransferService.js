const db = require('../config/database');
const Role = require('../models/Role');

const IT_PENDING_STATUSES = [
  'Approved - Sent to IT',
  'In Progress',
  'On Hold',
  'In Procurement',
];

function kindFromRole(role) {
  if (role?.is_it_admin) return 'IT Admin';
  if (role?.is_approver) return 'Approver';
  return null;
}

async function findCurrentHolder(role, excludeUserId = null) {
  if (!role?.id) return null;
  const holders = await Role.getUsers(role.id);
  return (
    holders.find(
      (u) =>
        (u.status || 'Active') !== 'Deleted' &&
        (!excludeUserId || Number(u.id) !== Number(excludeUserId))
    ) || null
  );
}

async function countApproverPending(holderId) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS c
     FROM requisitions
     WHERE approver_id = $1
       AND status = 'Pending Manager Approval'`,
    [holderId]
  );
  return result.rows[0]?.c || 0;
}

async function countItAdminPending(holder) {
  const name = (holder?.name || '').trim();
  const email = (holder?.email || '').trim().toLowerCase();

  const tickets = await db.query(
    `SELECT COUNT(*)::int AS c
     FROM tickets
     WHERE LOWER(status) NOT LIKE '%resolved%'
       AND (
         ($1 <> '' AND LOWER(TRIM(assigned_to)) = LOWER($1))
         OR ($2 <> '' AND LOWER(TRIM(assigned_to)) = $2)
       )`,
    [name, email]
  );

  const requisitions = await db.query(
    `SELECT COUNT(*)::int AS c
     FROM requisitions
     WHERE status = ANY($1::text[])`,
    [IT_PENDING_STATUSES]
  );

  return {
    tickets: tickets.rows[0]?.c || 0,
    requisitions: requisitions.rows[0]?.c || 0,
  };
}

/**
 * Preview what would move if this special role is transferred.
 */
async function previewTransfer(role, { excludeUserId } = {}) {
  const kind = kindFromRole(role);
  if (!kind) return null;

  const currentHolder = await findCurrentHolder(role, excludeUserId);
  if (!currentHolder) {
    return {
      required: false,
      kind,
      currentHolder: null,
      pending: { requisitions: 0, tickets: 0, total: 0 },
    };
  }

  let pending = { requisitions: 0, tickets: 0 };
  if (kind === 'Approver') {
    pending.requisitions = await countApproverPending(currentHolder.id);
  } else {
    pending = await countItAdminPending(currentHolder);
  }

  const total = (pending.requisitions || 0) + (pending.tickets || 0);
  return {
    required: true,
    kind,
    currentHolder: {
      id: currentHolder.id,
      name: currentHolder.name,
      email: currentHolder.email,
      status: currentHolder.status,
    },
    pending: { ...pending, total },
  };
}

async function pickFallbackRoleId(preferredId, specialRoleId) {
  if (preferredId) {
    const role = await Role.findById(preferredId);
    if (!role) {
      const err = new Error('Invalid demote_previous_to_role_id');
      err.status = 400;
      throw err;
    }
    if (role.is_it_admin || role.is_approver) {
      const err = new Error(
        'Previous person must be moved to a non–IT Admin / non–Approver role.'
      );
      err.status = 400;
      throw err;
    }
    if (Number(role.id) === Number(specialRoleId)) {
      const err = new Error('Fallback role cannot be the same special role.');
      err.status = 400;
      throw err;
    }
    return role.id;
  }

  const roles = await Role.findAll();
  const candidates = roles.filter(
    (r) =>
      r.is_active !== false &&
      !r.is_it_admin &&
      !r.is_approver &&
      Number(r.id) !== Number(specialRoleId)
  );
  const preferred = candidates.find((r) =>
    /staff|employee|user|member|general/i.test(r.name || '')
  );
  const pick = preferred || candidates[0];
  if (!pick) {
    const err = new Error(
      'No fallback role available for the previous IT Admin / Approver. Create a Staff (or similar) role first.'
    );
    err.status = 400;
    throw err;
  }
  return pick.id;
}

async function reassignApproverPending(client, fromUser, toUser) {
  const today = new Date().toISOString().slice(0, 10);
  const note = `Approver reassigned from ${fromUser.name} to ${toUser.name} on ${today}.\n`;
  const result = await client.query(
    `UPDATE requisitions
     SET approver_id = $1,
         approver_name = $2,
         decision_history = COALESCE(decision_history, '') || $3,
         updated_at = NOW()
     WHERE approver_id = $4
       AND status = 'Pending Manager Approval'
     RETURNING public_id`,
    [toUser.id, toUser.name, note, fromUser.id]
  );
  return result.rows.length;
}

async function reassignItAdminPending(client, fromUser, toUser) {
  const assigneeLabel = toUser.email || toUser.name;
  const name = (fromUser.name || '').trim();
  const email = (fromUser.email || '').trim().toLowerCase();

  const tickets = await client.query(
    `UPDATE tickets
     SET assigned_to = $1,
         updated_at = NOW()
     WHERE LOWER(status) NOT LIKE '%resolved%'
       AND (
         ($2 <> '' AND LOWER(TRIM(assigned_to)) = LOWER($2))
         OR ($3 <> '' AND LOWER(TRIM(assigned_to)) = $3)
       )
     RETURNING public_id`,
    [assigneeLabel, name, email]
  );

  // IT-queue asset requests follow the designated IT Admin flag (no assignee column).
  const requisitions = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM requisitions
     WHERE status = ANY($1::text[])`,
    [IT_PENDING_STATUSES]
  );

  return {
    tickets: tickets.rows.length,
    requisitions: requisitions.rows[0]?.c || 0,
  };
}

async function reassignPendingWork(kind, fromUser, toUser, client = null) {
  const run = async (c) => {
    if (kind === 'Approver') {
      const n = await reassignApproverPending(c, fromUser, toUser);
      return { requisitions: n, tickets: 0 };
    }
    if (kind === 'IT Admin') {
      return reassignItAdminPending(c, fromUser, toUser);
    }
    return { requisitions: 0, tickets: 0 };
  };

  if (client) return run(client);

  const owned = await db.getClient();
  try {
    await owned.query('BEGIN');
    const result = await run(owned);
    await owned.query('COMMIT');
    return result;
  } catch (err) {
    await owned.query('ROLLBACK');
    throw err;
  } finally {
    owned.release();
  }
}

/**
 * Demote current special-role holder, optionally assign role to new user, reassign pending.
 * Set `demoteOnly: true` when creating a new user (reassign after create via reassignPendingWork).
 */
async function executeTransfer({
  role,
  newUser = null,
  demotePreviousToRoleId = null,
  demoteOnly = false,
} = {}) {
  const kind = kindFromRole(role);
  if (!kind) {
    const err = new Error('Role is not IT Admin or Approver');
    err.status = 400;
    throw err;
  }

  const preview = await previewTransfer(role, {
    excludeUserId: newUser?.id || null,
  });
  if (!preview?.required || !preview.currentHolder) {
    return {
      transferred: false,
      kind,
      reassigned: { requisitions: 0, tickets: 0 },
      previousHolder: null,
      demotedToRoleId: null,
    };
  }

  const previous = preview.currentHolder;
  const fallbackRoleId = await pickFallbackRoleId(demotePreviousToRoleId, role.id);
  const fallbackRole = await Role.findById(fallbackRoleId);

  const client = await db.getClient();
  let reassigned = { requisitions: 0, tickets: 0 };
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE users SET role_id = $1, updated_at = NOW() WHERE id = $2`,
      [fallbackRoleId, previous.id]
    );

    if (!demoteOnly && newUser?.id) {
      await client.query(
        `UPDATE users SET role_id = $1, updated_at = NOW() WHERE id = $2`,
        [role.id, newUser.id]
      );
      reassigned = await reassignPendingWork(kind, previous, newUser, client);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    transferred: true,
    kind,
    reassigned,
    previousHolder: {
      id: previous.id,
      name: previous.name,
      email: previous.email,
    },
    demotedToRoleId: fallbackRoleId,
    demotedToRoleName: fallbackRole?.name || null,
  };
}

module.exports = {
  kindFromRole,
  previewTransfer,
  executeTransfer,
  reassignPendingWork,
  pickFallbackRoleId,
  IT_PENDING_STATUSES,
};
