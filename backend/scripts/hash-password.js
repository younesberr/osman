#!/usr/bin/env node
/*
 * Génère un hash bcrypt à coller dans delevery_users.users_password (ou
 * delevery_customers.customers_password), par exemple pour créer le premier
 * compte administrateur directement en base.
 * Usage : node scripts/hash-password.js "MotDePasse"
 */
const { hashPassword } = require('../src/utils/password');

const plain = process.argv[2];
if (!plain) {
  console.error('Usage : node scripts/hash-password.js <mot de passe>');
  process.exit(1);
}
hashPassword(plain).then((hash) => console.log(hash));
