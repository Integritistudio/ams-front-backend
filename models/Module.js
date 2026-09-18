const db = require('../config/database');

const Module = {
  async findAll() {
    const result = await db.query(
      `SELECT * FROM modules WHERE is_active = TRUE ORDER BY sort_order, name`
    );
    return result.rows;
  },

  async findBySlug(slug) {
    const result = await db.query(`SELECT * FROM modules WHERE slug = $1`, [slug]);
    return result.rows[0] || null;
  },

  async create({ slug, name, icon, sort_order = 0 }) {
    const result = await db.query(
      `INSERT INTO modules (slug, name, icon, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
      [slug, name, icon || null, sort_order]
    );
    return result.rows[0];
  },
};

module.exports = Module;
