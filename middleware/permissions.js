function requirePermission(moduleSlug) {
  return (req, res, next) => {
    // Super Admin bypasses module checks
    if (req.authz?.is_super_admin || req.authz?.user?.is_super_admin) {
      return next();
    }
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

function requireAny(...moduleSlugs) {
  return (req, res, next) => {
    if (req.authz?.is_super_admin || req.authz?.user?.is_super_admin) {
      return next();
    }
    const permissions = req.authz?.permissions || [];
    if (!moduleSlugs.some((s) => permissions.includes(s))) {
      return res.status(403).json({
        success: false,
        message: `Access denied: missing permission for modules "${moduleSlugs.join(', ')}"`,
      });
    }
    return next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.authz?.is_super_admin || req.authz?.user?.is_super_admin) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Access denied: Super Admin only',
  });
}

function canViewAll(moduleSlug) {
  return (req) => {
    if (req.authz?.is_super_admin || req.authz?.user?.is_super_admin) return true;
    return (req.authz?.permissionMeta || []).some(
      (p) => p.slug === moduleSlug && p.can_view_all === true
    );
  };
}

module.exports = { requirePermission, requireAny, requireSuperAdmin, canViewAll };
