const db = require('../config/database');

async function findArticle(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM kb_articles WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM kb_articles WHERE public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function list(req, res, next) {
  try {
    const { category, search } = req.query;
    const clauses = [];
    const params = [];
    let i = 1;
    if (category && category !== 'All') {
      clauses.push(`category = $${i++}`);
      params.push(category);
    }
    if (search) {
      clauses.push(`(title ILIKE $${i} OR summary ILIKE $${i} OR content ILIKE $${i})`);
      params.push(`%${search}%`);
      i += 1;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT id, public_id, category, icon, title, summary, created_at, updated_at
       FROM kb_articles ${where}
       ORDER BY category, title`,
      params
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const article = await findArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ success: false, message: 'Article not found' });
    }
    return res.json({ success: true, data: article });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, get };
