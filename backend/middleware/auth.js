const jwt = require('jsonwebtoken');

function getJwtSecret() {
  return process.env.JWT_SECRET;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, getJwtSecret());
    req.user = {
      id: payload.sub,
      tenantId: payload.tenantId || null,
      role: payload.role,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      tenantId: user.tenant_id || null,
      role: user.role,
    },
    getJwtSecret(),
    { expiresIn: '15m' }
  );
}

function generateRefreshToken(user, tokenId) {
  return jwt.sign(
    {
      sub: user.id,
      jti: tokenId,
    },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

function generateTempToken(userId, purpose) {
  return jwt.sign(
    {
      sub: userId,
      purpose,
    },
    getJwtSecret(),
    { expiresIn: '5m' }
  );
}

function verifyTempToken(token, expectedPurpose) {
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (payload.purpose !== expectedPurpose) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  authMiddleware,
  generateAccessToken,
  generateRefreshToken,
  generateTempToken,
  verifyTempToken,
};
