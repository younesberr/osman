const crypto = require('crypto');

/*
 * Chiffrement des secrets stockés en base — jeton d'accès et clé secrète de
 * l'app Meta de l'API WhatsApp (delevery_configs, clés ortalog_whatsapp_*).
 * La base u361236224_dborta est partagée avec l'ancien système : aucun secret
 * n'y est écrit en clair.
 *
 * Clé maître : variable d'environnement WHATSAPP_SECRET_KEY (≥ 32 caractères,
 * backend/.env en local, variables Node de hPanel en production). Elle n'est
 * jamais stockée en base. Contrairement à JWT_SECRET, son absence n'arrête pas
 * le serveur : la page WhatsApp l'explique et refuse seulement d'enregistrer
 * des secrets (dégradation douce).
 *
 * Format stocké : "v1:<iv base64>:<tag base64>:<chiffré base64>" (AES-256-GCM,
 * clé = SHA-256 de la variable). Changer la clé maître rend les valeurs déjà
 * enregistrées illisibles (decryptSecret → null) : l'interface demande alors
 * de les ressaisir.
 */

const SECRET_KEY_ENV = 'WHATSAPP_SECRET_KEY';
const SECRET_KEY_MIN = 32;
const VERSION = 'v1';

function rawKey() {
  return process.env[SECRET_KEY_ENV] || '';
}

/** true si la clé maître est présente et assez longue. */
function isSecretKeyConfigured() {
  return rawKey().length >= SECRET_KEY_MIN;
}

function derivedKey() {
  return crypto.createHash('sha256').update(rawKey(), 'utf8').digest();
}

/** Chiffre un texte clair ; lève une erreur si la clé maître manque. */
function encryptSecret(plain) {
  if (!isSecretKeyConfigured()) {
    throw new Error(`${SECRET_KEY_ENV} absente ou trop courte (min ${SECRET_KEY_MIN} caractères).`);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

/** Déchiffre une valeur stockée ; null si clé absente/changée ou valeur altérée. */
function decryptSecret(stored) {
  if (!stored || !isSecretKeyConfigured()) return null;
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Aperçu non sensible d'un secret : "••••" + 4 derniers caractères. */
function maskSecret(plain) {
  const s = String(plain || '');
  return s ? `••••${s.slice(-4)}` : '';
}

module.exports = { SECRET_KEY_ENV, SECRET_KEY_MIN, isSecretKeyConfigured, encryptSecret, decryptSecret, maskSecret };
