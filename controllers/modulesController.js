const Module = require('../models/Module');

async function list(req, res, next) {
  try {
    const modules = await Module.findAll();
    return res.json({ success: true, data: modules });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list };
