const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { loginClient, loginEmployee, me, logout } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');

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

router.post('/login/client', loginRules, validate, loginClient);
router.post('/login/employee', loginRules, validate, loginEmployee);
router.get('/me', requireAuth, me);
router.post('/logout', requireAuth, logout);

module.exports = router;
