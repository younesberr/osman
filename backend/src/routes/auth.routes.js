const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { loginClient, loginEmployee, me, logout } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Trop de tentatives. Réessayez dans 15 minutes.' }
});

const loginRules = [
  body('identifiant').isString().trim().notEmpty().isLength({ max: 100 }).withMessage('Identifiant requis.'),
  body('password').isString().notEmpty().isLength({ max: 200 }).withMessage('Mot de passe requis.')
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ message: errors.array()[0].msg });
  }
  next();
}

router.post('/login/client', loginLimiter, loginRules, validate, loginClient);
router.post('/login/employee', loginLimiter, loginRules, validate, loginEmployee);
router.get('/me', requireAuth, me);
router.post('/logout', requireAuth, logout);

module.exports = router;
