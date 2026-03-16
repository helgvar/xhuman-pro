const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const {
  generateAccessToken,
  generateRefreshToken,
  generateTempToken,
  verifyTempToken,
} = require('../middleware/auth');
const totp = require('../services/totp');

const router = express.Router();

// Rate limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimit(req, res, next) {
  const key = req.ip + ':' + req.path;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (entry && now - entry.start < RATE_LIMIT_WINDOW) {
    if (entry.count >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Troppi tentativi, riprova tra qualche minuto' });
    }
    entry.count++;
  } else {
    rateLimitMap.set(key, { count: 1, start: now });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW) rateLimitMap.delete(key);
  }
}, 60000);

router.use(rateLimit);

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { rows } = await pool.query(
      'SELECT id, email, password_hash, name, role, tenant_id, totp_enabled, totp_secret, status FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account disabled' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    if (user.totp_enabled) {
      const tempToken = generateTempToken(user.id, '2fa_verify');
      return res.json({ requires2FA: true, tempToken });
    }

    if (!user.totp_enabled) {
      const tempToken = generateTempToken(user.id, '2fa_setup');
      return res.json({ requires2FASetup: true, tempToken });
    }
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/totp/setup
router.post('/totp/setup', async (req, res) => {
  try {
    const { tempToken } = req.body;
    if (!tempToken) {
      return res.status(400).json({ error: 'Temp token required' });
    }

    const payload = verifyTempToken(tempToken, '2fa_setup');
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [payload.sub]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    const secret = totp.generateSecret();
    const qrCodeUrl = await totp.generateQRCodeDataURL(user.email, secret);

    const encryptedSecret = totp.encryptSecret(secret);
    await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [encryptedSecret, user.id]);

    const verifyToken = generateTempToken(user.id, '2fa_confirm');

    res.json({ qrCodeUrl, secret, tempToken: verifyToken });
  } catch (err) {
    console.error('[Auth] TOTP setup error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/totp/verify
router.post('/totp/verify', async (req, res) => {
  try {
    const { tempToken, totpCode } = req.body;
    if (!tempToken || !totpCode) {
      return res.status(400).json({ error: 'Temp token and TOTP code required' });
    }

    let payload = verifyTempToken(tempToken, '2fa_verify');
    let isSetup = false;
    if (!payload) {
      payload = verifyTempToken(tempToken, '2fa_confirm');
      isSetup = true;
    }
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { rows } = await pool.query(
      'SELECT id, email, name, role, tenant_id, totp_secret, totp_enabled FROM users WHERE id = $1',
      [payload.sub]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    if (!user.totp_secret) {
      return res.status(400).json({ error: '2FA not configured' });
    }

    const secret = totp.decryptSecret(user.totp_secret);
    const valid = totp.verifyToken(secret, totpCode);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid TOTP code' });
    }

    if (isSetup && !user.totp_enabled) {
      await pool.query('UPDATE users SET totp_enabled = TRUE, updated_at = NOW() WHERE id = $1', [user.id]);
    }

    const accessToken = generateAccessToken(user);
    const refreshTokenId = crypto.randomUUID();
    const refreshToken = generateRefreshToken(user, refreshTokenId);

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [refreshTokenId, user.id, tokenHash, expiresAt]
    );

    await pool.query(
      'INSERT INTO audit_log (tenant_id, user_id, action, ip_address) VALUES ($1, $2, $3, $4)',
      [user.tenant_id, user.id, 'login', req.ip]
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenant_id,
      },
    });
  } catch (err) {
    console.error('[Auth] TOTP verify error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const jwt = require('jsonwebtoken');
    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const { rows: tokenRows } = await pool.query(
      'SELECT id FROM refresh_tokens WHERE id = $1 AND token_hash = $2 AND expires_at > NOW()',
      [payload.jti, tokenHash]
    );
    if (tokenRows.length === 0) {
      return res.status(401).json({ error: 'Refresh token revoked or expired' });
    }

    const { rows: userRows } = await pool.query(
      'SELECT id, email, name, role, tenant_id, status FROM users WHERE id = $1',
      [payload.sub]
    );
    if (userRows.length === 0 || userRows[0].status !== 'active') {
      return res.status(401).json({ error: 'User not found or disabled' });
    }

    const user = userRows[0];
    const accessToken = generateAccessToken(user);

    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenant_id,
      },
    });
  } catch (err) {
    console.error('[Auth] Refresh error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.json({ ok: true });
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[Auth] Logout error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
