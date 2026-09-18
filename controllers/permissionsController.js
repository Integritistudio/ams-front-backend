async function myPermissions(req, res, next) {
  try {
    return res.json({
      success: true,
      data: {
        permissions: req.authz?.permissions || [],
        permissionMeta: req.authz?.permissionMeta || [],
        role: req.authz?.role || null,
        user: req.authz?.user || null,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { myPermissions };
