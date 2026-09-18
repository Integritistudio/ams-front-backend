const db = require('../config/database');

async function list(req, res, next) {
  try {
    const { type } = req.query;
    if (!type) {
      return res.status(400).json({ success: false, message: 'type query parameter is required' });
    }
    const result = await db.query(
      `SELECT * FROM catalog_items
       WHERE type = $1 AND is_active = TRUE
       ORDER BY sort_order ASC, name ASC`,
      [type]
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list };
