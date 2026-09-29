const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MD5_RE = /^[a-f0-9]{32}$/i;

function timingSafeHexEqual(computedHex, storedHex) {
  const a = Buffer.from(computedHex, 'utf8');
  const b = Buffer.from(storedHex.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Vérifie un mot de passe contre un hash stocké.
 * Supporte bcrypt ($2...) et les hashes legacy 32 hex déjà présents en base :
 * l'ancien système PHP stocke MD5(SHA1(motdepasse)) ; on accepte aussi MD5 simple.
 */
async function verifyPassword(plain, storedHash) {
  if (!plain || !storedHash) return false;

  if (storedHash.startsWith('$2')) {
    return bcrypt.compare(plain, storedHash);
  }

  if (MD5_RE.test(storedHash)) {
    const sha1 = crypto.createHash('sha1').update(plain, 'utf8').digest('hex');
    const md5OfSha1 = crypto.createHash('md5').update(sha1, 'utf8').digest('hex');
    const md5Plain = crypto.createHash('md5').update(plain, 'utf8').digest('hex');
    const okSha1 = timingSafeHexEqual(md5OfSha1, storedHash);
    const okMd5 = timingSafeHexEqual(md5Plain, storedHash);
    return okSha1 || okMd5;
  }

  return false;
}

/** Hash bcrypt pour les nouveaux mots de passe. */
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

/** Un hash MD5 est considéré legacy (à migrer vers bcrypt si activé). */
function isLegacyHash(storedHash) {
  return MD5_RE.test(storedHash || '');
}

module.exports = { verifyPassword, hashPassword, isLegacyHash };
