const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');

/*
 * Messagerie client <-> admin (delevery_chat + delevery_chat_msg).
 * - Le client ouvre des discussions et échange avec les employés (texte,
 *   emojis, photo, audio). Les colonnes texte sont en utf8mb4 (emojis OK).
 * - Côté admin, les discussions de tous les clients sont visibles par tous
 *   les employés ; une discussion est affectée au premier employé qui la lit
 *   (chat_user), sans jamais en bloquer l'accès aux autres.
 * - Statut : 'nouveau' (jamais traité), 'en_cours' (prise en charge),
 *   'termine' (clôturée). « Lu / Non lu » est dérivé de msg_read.
 * Pièces jointes stockées dans backend/uploads/messages (servies via /uploads).
 */

const MESSAGE_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'messages');

function ensureMessageUploadDir() {
  fs.mkdirSync(MESSAGE_UPLOAD_DIR, { recursive: true });
  return MESSAGE_UPLOAD_DIR;
}

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const AUDIO_EXT = ['.webm', '.ogg', '.mp3', '.m4a', '.wav'];

/** Type de pièce jointe ('image' | 'audio') d'après l'extension du fichier. */
function fileTypeOf(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

/** Supprime le fichier uploadé si l'insertion échoue (pas de fichier orphelin). */
function dropUploadedFile(file) {
  if (file) fs.promises.unlink(file.path).catch(() => {});
}

const STATUTS = ['nouveau', 'en_cours', 'termine'];

/** Ligne message -> objet API (URL publique de la pièce jointe incluse). */
function toMessage(row) {
  return {
    id: row.msg_id,
    from: row.msg_from,
    senderName: row.sender_name || null,
    text: row.msg_text || '',
    fileUrl: row.msg_file ? `/uploads/messages/${row.msg_file}` : null,
    fileType: row.msg_file_type || null,
    date: row.msg_date,
    read: Number(row.msg_read) === 1
  };
}

const MESSAGES_SQL = `
  SELECT m.msg_id, m.msg_from, m.msg_text, m.msg_file, m.msg_file_type,
         m.msg_date, m.msg_read,
         CASE WHEN m.msg_from = 'user'
              THEN u.users_name
              ELSE COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name)
         END AS sender_name
    FROM delevery_chat_msg m
    LEFT JOIN delevery_users u ON m.msg_from = 'user' AND u.users_id = m.msg_sender
    LEFT JOIN delevery_customers c ON m.msg_from = 'client' AND c.customers_id = m.msg_sender
   WHERE m.msg_chat = ?
   ORDER BY m.msg_id ASC`;

/* Aperçu du dernier message dans les listes ('📷 Photo' / '🎤 Audio' si pièce jointe). */
const LAST_MSG_SQL = `
  (SELECT COALESCE(NULLIF(m.msg_text, ''),
                   CASE m.msg_file_type WHEN 'image' THEN '📷 Photo'
                                        WHEN 'audio' THEN '🎤 Audio'
                                        ELSE '' END)
     FROM delevery_chat_msg m
    WHERE m.msg_chat = ch.chat_id
    ORDER BY m.msg_id DESC LIMIT 1)`;

/** Charge une discussion et vérifie qu'elle appartient au client connecté. */
async function getOwnChat(chatId, customerId) {
  if (!Number.isInteger(chatId) || chatId <= 0) return null;
  const [rows] = await pool.query(
    'SELECT * FROM delevery_chat WHERE chat_id = ? AND chat_customer = ? LIMIT 1',
    [chatId, customerId]
  );
  return rows[0] || null;
}

/* ------------------------------------------------------------------ */
/* Dashboard client                                                    */
/* ------------------------------------------------------------------ */

/** GET /api/messages/client/chats — discussions du client (unread = messages admin non lus). */
async function listClientChats(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT ch.chat_id AS id, ch.chat_subject AS subject, ch.chat_statut AS statut,
              ch.chat_last_at AS lastAt,
              ${LAST_MSG_SQL} AS lastText,
              (SELECT COUNT(*) FROM delevery_chat_msg m
                WHERE m.msg_chat = ch.chat_id AND m.msg_from = 'user' AND m.msg_read = 0) AS unread
         FROM delevery_chat ch
        WHERE ch.chat_customer = ?
        ORDER BY ch.chat_last_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** POST /api/messages/client/chats — nouvelle discussion { subject, text }. */
async function createClientChat(req, res, next) {
  try {
    const subject = String(req.body?.subject || '').trim().slice(0, 255);
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ message: 'Le message est obligatoire.' });
    }
    const [chatResult] = await pool.query(
      `INSERT INTO delevery_chat (chat_customer, chat_subject, chat_statut, chat_created_at, chat_last_at)
       VALUES (?, ?, 'nouveau', NOW(), NOW())`,
      [req.user.id, subject || null]
    );
    // msg_member : membre d'équipe du client à l'origine du message (NULL sinon).
    await pool.query(
      `INSERT INTO delevery_chat_msg (msg_chat, msg_from, msg_sender, msg_member, msg_text, msg_date, msg_read)
       VALUES (?, 'client', ?, ?, ?, NOW(), 0)`,
      [chatResult.insertId, req.user.id, Number(req.user?.memberId) || null, text]
    );
    res.status(201).json({ id: chatResult.insertId });
  } catch (err) {
    next(err);
  }
}

/** GET /api/messages/client/chats/:id — messages ; marque les messages admin comme lus. */
async function getClientChat(req, res, next) {
  try {
    const chat = await getOwnChat(Number(req.params.id), req.user.id);
    if (!chat) return res.status(404).json({ message: 'Discussion introuvable.' });

    await pool.query(
      `UPDATE delevery_chat_msg SET msg_read = 1
        WHERE msg_chat = ? AND msg_from = 'user' AND msg_read = 0`,
      [chat.chat_id]
    );
    const [rows] = await pool.query(MESSAGES_SQL, [chat.chat_id]);
    res.json({
      chat: { id: chat.chat_id, subject: chat.chat_subject, statut: chat.chat_statut },
      messages: rows.map(toMessage)
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Insère un message (texte et/ou pièce jointe) et met à jour la discussion.
 * from = 'client' | 'user' ; senderId = customers_id ou users_id ;
 * memberId = membre d'équipe du client à l'origine du message (NULL sinon).
 */
async function insertMessage(chat, from, senderId, text, file, memberId = null) {
  const fileType = file ? fileTypeOf(file.filename) : null;
  await pool.query(
    `INSERT INTO delevery_chat_msg (msg_chat, msg_from, msg_sender, msg_member, msg_text, msg_file, msg_file_type, msg_date, msg_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 0)`,
    [chat.chat_id, from, senderId, memberId, text || null, file ? file.filename : null, fileType]
  );
  /* Une réponse d'employé fait passer la discussion « nouveau » -> « en cours ». */
  const statut = from === 'user' && chat.chat_statut === 'nouveau' ? 'en_cours' : chat.chat_statut;
  await pool.query('UPDATE delevery_chat SET chat_last_at = NOW(), chat_statut = ? WHERE chat_id = ?', [
    statut,
    chat.chat_id
  ]);
}

/** POST /api/messages/client/chats/:id/messages — multipart : text et/ou file. */
async function sendClientMessage(req, res, next) {
  try {
    const chat = await getOwnChat(Number(req.params.id), req.user.id);
    if (!chat) {
      dropUploadedFile(req.file);
      return res.status(404).json({ message: 'Discussion introuvable.' });
    }
    const text = String(req.body?.text || '').trim();
    if (!text && !req.file) {
      return res.status(400).json({ message: 'Message vide.' });
    }
    await insertMessage(chat, 'client', req.user.id, text, req.file, Number(req.user?.memberId) || null);
    res.status(201).json({ ok: true });
  } catch (err) {
    dropUploadedFile(req.file);
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard admin                                                     */
/* ------------------------------------------------------------------ */

/**
 * GET /api/messages/chats — toutes les discussions, tous clients confondus.
 * Filtres : lu ('lu' | 'non_lu'), statut ('en_cours' | 'termine'),
 * magasin (customers_id), user (users_id affecté).
 */
async function listAdminChats(req, res, next) {
  try {
    const where = [];
    const params = [];

    const statut = String(req.query.statut || '');
    if (statut === 'termine') where.push(`ch.chat_statut = 'termine'`);
    else if (statut === 'en_cours') where.push(`ch.chat_statut <> 'termine'`);

    const magasin = parseInt(req.query.magasin, 10) || 0;
    if (magasin) {
      where.push('ch.chat_customer = ?');
      params.push(magasin);
    }
    const user = parseInt(req.query.user, 10) || 0;
    if (user) {
      where.push('ch.chat_user = ?');
      params.push(user);
    }

    /* Le filtre Lu / Non lu porte sur l'alias unread -> HAVING. */
    const lu = String(req.query.lu || '');
    const having = lu === 'non_lu' ? 'HAVING unread > 0' : lu === 'lu' ? 'HAVING unread = 0' : '';

    const [rows] = await pool.query(
      `SELECT ch.chat_id AS id, ch.chat_subject AS subject, ch.chat_statut AS statut,
              ch.chat_customer AS clientId, ch.chat_last_at AS lastAt,
              COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name) AS magasin,
              ch.chat_user AS assignedId, u.users_name AS assignedName,
              ${LAST_MSG_SQL} AS lastText,
              (SELECT COUNT(*) FROM delevery_chat_msg m
                WHERE m.msg_chat = ch.chat_id AND m.msg_from = 'client' AND m.msg_read = 0) AS unread
         FROM delevery_chat ch
         LEFT JOIN delevery_customers c ON c.customers_id = ch.chat_customer
         LEFT JOIN delevery_users u ON u.users_id = ch.chat_user
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ${having}
        ORDER BY ch.chat_last_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** GET /api/messages/filters — magasins et employés pour les listes déroulantes. */
async function listAdminFilters(req, res, next) {
  try {
    const [[magasins], [users]] = await Promise.all([
      pool.query(
        `SELECT DISTINCT c.customers_id AS id,
                COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name) AS label
           FROM delevery_chat ch
           JOIN delevery_customers c ON c.customers_id = ch.chat_customer
          ORDER BY label`
      ),
      pool.query(
        `SELECT DISTINCT u.users_id AS id, u.users_name AS label
           FROM delevery_chat ch
           JOIN delevery_users u ON u.users_id = ch.chat_user
          ORDER BY label`
      )
    ]);
    res.json({ magasins, users });
  } catch (err) {
    next(err);
  }
}

/** Charge une discussion (admin, sans restriction de client). */
async function getChatById(chatId) {
  if (!Number.isInteger(chatId) || chatId <= 0) return null;
  const [rows] = await pool.query('SELECT * FROM delevery_chat WHERE chat_id = ? LIMIT 1', [chatId]);
  return rows[0] || null;
}

/**
 * GET /api/messages/chats/:id — messages ; marque les messages client comme
 * lus et affecte la discussion au premier employé qui la lit (chat_user).
 */
async function getAdminChat(req, res, next) {
  try {
    const chat = await getChatById(Number(req.params.id));
    if (!chat) return res.status(404).json({ message: 'Discussion introuvable.' });

    if (!chat.chat_user) {
      await pool.query('UPDATE delevery_chat SET chat_user = ? WHERE chat_id = ? AND chat_user IS NULL', [
        req.user.id,
        chat.chat_id
      ]);
    }
    await pool.query(
      `UPDATE delevery_chat_msg SET msg_read = 1
        WHERE msg_chat = ? AND msg_from = 'client' AND msg_read = 0`,
      [chat.chat_id]
    );

    const [[chatRows], [msgRows]] = await Promise.all([
      pool.query(
        `SELECT ch.chat_id, ch.chat_subject, ch.chat_statut, ch.chat_user,
                COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name) AS magasin,
                u.users_name AS assignedName
           FROM delevery_chat ch
           LEFT JOIN delevery_customers c ON c.customers_id = ch.chat_customer
           LEFT JOIN delevery_users u ON u.users_id = ch.chat_user
          WHERE ch.chat_id = ?`,
        [chat.chat_id]
      ),
      pool.query(MESSAGES_SQL, [chat.chat_id])
    ]);
    const info = chatRows[0];
    res.json({
      chat: {
        id: info.chat_id,
        subject: info.chat_subject,
        statut: info.chat_statut,
        magasin: info.magasin,
        assignedName: info.assignedName
      },
      messages: msgRows.map(toMessage)
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/messages/chats/:id/messages — réponse d'un employé (multipart : text et/ou file). */
async function sendAdminMessage(req, res, next) {
  try {
    const chat = await getChatById(Number(req.params.id));
    if (!chat) {
      dropUploadedFile(req.file);
      return res.status(404).json({ message: 'Discussion introuvable.' });
    }
    const text = String(req.body?.text || '').trim();
    if (!text && !req.file) {
      return res.status(400).json({ message: 'Message vide.' });
    }
    await insertMessage(chat, 'user', req.user.id, text, req.file);
    res.status(201).json({ ok: true });
  } catch (err) {
    dropUploadedFile(req.file);
    next(err);
  }
}

/** PATCH /api/messages/chats/:id/statut — { statut: 'en_cours' | 'termine' }. */
async function setChatStatut(req, res, next) {
  try {
    const chat = await getChatById(Number(req.params.id));
    if (!chat) return res.status(404).json({ message: 'Discussion introuvable.' });
    const statut = String(req.body?.statut || '');
    if (!STATUTS.includes(statut)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }
    await pool.query('UPDATE delevery_chat SET chat_statut = ? WHERE chat_id = ?', [statut, chat.chat_id]);
    res.json({ id: chat.chat_id, statut });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  ensureMessageUploadDir,
  IMAGE_EXT,
  AUDIO_EXT,
  listClientChats,
  createClientChat,
  getClientChat,
  sendClientMessage,
  listAdminChats,
  listAdminFilters,
  getAdminChat,
  sendAdminMessage,
  setChatStatut
};
