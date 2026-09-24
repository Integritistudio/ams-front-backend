const express = require('express');
const multer = require('multer');
const db = require('../config/database');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { encryptBuffer, decryptBuffer } = require('../services/fileCrypto');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/|application\/pdf|application\/msword|application\/vnd\.|text\/)/.test(file.mimetype)
      || /\.(png|jpe?g|gif|webp|avif|pdf|doc|docx|txt)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

router.use(authenticate, attachPermissions);

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'file is required' });
    }

    const { iv, authTag, ciphertext } = await encryptBuffer(req.file.buffer);
    const result = await db.query(
      `INSERT INTO file_attachments (
         original_name, mime_type, size_bytes, iv, auth_tag, ciphertext, uploaded_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, original_name, mime_type, size_bytes, created_at`,
      [
        req.file.originalname || 'file',
        req.file.mimetype || 'application/octet-stream',
        req.file.size,
        iv,
        authTag,
        ciphertext,
        req.authz?.user?.id || null,
      ]
    );

    const row = result.rows[0];
    return res.status(201).json({
      success: true,
      data: {
        id: row.id,
        url: `/api/uploads/${row.id}/download`,
        name: row.original_name,
        size: row.size_bytes,
        mime: row.mime_type,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/download', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid attachment id' });
    }

    const result = await db.query(
      `SELECT id, original_name, mime_type, size_bytes, iv, auth_tag, ciphertext
       FROM file_attachments WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ success: false, message: 'Attachment not found' });
    }

    const plain = await decryptBuffer(row.iv, row.auth_tag, row.ciphertext);
    const safeName = String(row.original_name || 'file').replace(/[^\w.\- ()]/g, '_');

    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', plain.length);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(plain);
  } catch (err) {
    console.error('Attachment decrypt failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not decrypt attachment' });
  }
});

module.exports = router;
