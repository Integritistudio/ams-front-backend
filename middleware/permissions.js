function requirePermission(moduleSlug) {
  return (req, res, next) => {
    const permissions = req.authz?.permissions || [];
    if (!permissions.includes(moduleSlug)) {
      return res.status(403).json({
        success: false,
        message: `Access denied: missing permission for module "${moduleSlug}"`,
      });
    }
    return next();
  };
}

function canViewAll(moduleSlug) {
  return (req) =>
    (req.authz?.permissionMeta || []).some(
      (p) => p.slug === moduleSlug && p.can_view_all === true
    );
}

module.exports = { requirePermission, canViewAll };
