const db = require('../config/database');
const Role = require('../models/Role');

/**
 * Reassign pending Approver-created requisitions to an Executive.
 * Approver must not remain the signer on their own requests.
 */
(async () => {
  const executives = await Role.findUsersWithFlag('is_executive');
  if (!executives.length) {
    console.error('No Executive users found — skip reassignment');
    process.exit(1);
  }
  // Prefer Demo Executive / lowest id that is not also an Approver-only user
  const exec = executives[0];
  console.log('Assigning to Executive:', exec.id, exec.name, exec.email);

  const result = await db.query(
    `UPDATE requisitions req
     SET approver_id = $1,
         approver_name = $2,
         updated_at = NOW()
     FROM users ru
     JOIN roles rr ON rr.id = ru.role_id
     WHERE req.requester_id = ru.id
       AND COALESCE(rr.is_approver, FALSE) = TRUE
       AND LOWER(req.status) LIKE '%pending%'
       AND (req.approver_id IS DISTINCT FROM $1)
     RETURNING req.public_id, req.requester_name, req.approver_id, req.approver_name`,
    [exec.id, exec.name]
  );

  console.log('Reassigned', result.rows.length, 'request(s):');
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
