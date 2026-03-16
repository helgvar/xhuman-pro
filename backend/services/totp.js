const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { encrypt, decrypt } = require('./crypto');

const APP_NAME = 'xHUMANPRO';

function generateSecret() {
  return authenticator.generateSecret();
}

function verifyToken(secret, token) {
  return authenticator.verify({ token, secret });
}

async function generateQRCodeDataURL(email, secret) {
  const otpauth = authenticator.keyuri(email, APP_NAME, secret);
  return QRCode.toDataURL(otpauth);
}

function encryptSecret(secret) {
  return encrypt(secret);
}

function decryptSecret(encrypted) {
  return decrypt(encrypted);
}

module.exports = {
  generateSecret,
  verifyToken,
  generateQRCodeDataURL,
  encryptSecret,
  decryptSecret,
};
