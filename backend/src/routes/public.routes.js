const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { track, contact, register, tarifsVilles, tarifs } = require('../controllers/public.controller');

/* Endpoints publics (page d'accueil) : limites par IP plus strictes que la limite globale. */

const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'طلبات كثيرة، يرجى الانتظار قليلاً.' }
});

// L'ancien site limitait à 3 messages / heure par session ; ici par IP (non contournable).
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    message: 'لقد تجاوزت الحد المسموح به من الرسائل (3 رسائل/ساعة). يرجى المحاولة لاحقاً.'
  }
});

const contactRules = [
  body('name').trim().notEmpty().withMessage('الاسم الكامل مطلوب.').bail()
    .isLength({ max: 100 }).withMessage('الاسم طويل جداً (100 حرف كحد أقصى).'),
  body('city').optional({ values: 'falsy' }).trim()
    .isLength({ max: 100 }).withMessage('اسم المدينة طويل جداً (100 حرف كحد أقصى).'),
  body('email').trim().isEmail().withMessage('البريد الإلكتروني غير صالح.').bail()
    .isLength({ max: 100 }).withMessage('البريد الإلكتروني طويل جداً (100 حرف كحد أقصى).'),
  body('phone').trim().notEmpty().withMessage('رقم الهاتف مطلوب.').bail()
    .isLength({ max: 50 }).withMessage('رقم الهاتف طويل جداً (50 حرفاً كحد أقصى).'),
  body('message').trim().notEmpty().withMessage('الرسالة مطلوبة.').bail()
    .isLength({ max: 5000 }).withMessage('الرسالة طويلة جداً (5000 حرف كحد أقصى).')
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ message: errors.array()[0].msg });
  }
  next();
}

// L'ancien site bloquait après 3 inscriptions par session ; ici 3 / heure / IP.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    message: 'لقد تجاوزت الحد المسموح به من الطلبات (3 طلبات/ساعة). يرجى المحاولة لاحقاً.'
  }
});

/*
 * Mêmes champs obligatoires que l'ancien formulaire (register.php). Longueurs
 * max alignées sur les colonnes des DEUX tables : delevery_new_customers pour
 * la demande et delevery_customers pour la recopie à l'acceptation (ex. ville
 * varchar(25) et RIB varchar(25) côté demande).
 */
const registerRules = [
  body('fullname').trim().notEmpty().withMessage('الاسم الكامل مطلوب.').bail()
    .isLength({ max: 100 }).withMessage('الاسم طويل جداً (100 حرف كحد أقصى).'),
  body('storename').optional({ values: 'falsy' }).trim()
    .isLength({ max: 100 }).withMessage('اسم المتجر طويل جداً (100 حرف كحد أقصى).'),
  body('cin').trim().notEmpty().withMessage('رقم بطاقة التعريف مطلوب.').bail()
    .isLength({ max: 100 }).withMessage('رقم بطاقة التعريف طويل جداً (100 حرف كحد أقصى).'),
  body('email').trim().isEmail().withMessage('البريد الإلكتروني غير صالح.').bail()
    .isLength({ max: 100 }).withMessage('البريد الإلكتروني طويل جداً (100 حرف كحد أقصى).'),
  // Même règle que le checkPhone legacy : 10 chiffres, 05/06/07/08.
  body('phone').trim().matches(/^0[5-8][0-9]{8}$/)
    .withMessage('يرجى إدخال رقم هاتف صحيح (10 أرقام يبدأ بـ 05، 06، 07 أو 08).'),
  body('phonePersonal').optional({ values: 'falsy' }).trim()
    .isLength({ max: 50 }).withMessage('رقم الهاتف الشخصي طويل جداً (50 حرفاً كحد أقصى).'),
  body('city').trim().notEmpty().withMessage('المدينة مطلوبة.').bail()
    .isLength({ max: 25 }).withMessage('اسم المدينة طويل جداً (25 حرفاً كحد أقصى).'),
  body('address').trim().notEmpty().withMessage('العنوان مطلوب.').bail()
    .isLength({ max: 250 }).withMessage('العنوان طويل جداً (250 حرفاً كحد أقصى).'),
  body('password').isLength({ min: 8 }).withMessage('كلمة السر يجب أن تحتوي على 8 أحرف على الأقل.').bail()
    .isLength({ max: 100 }).withMessage('كلمة السر طويلة جداً (100 حرف كحد أقصى).'),
  body('passwordConfirm').custom((value, { req }) => value === req.body.password)
    .withMessage('تأكيد كلمة السر غير مطابق.'),
  body('website').optional({ values: 'falsy' }).trim()
    .isLength({ max: 50 }).withMessage('عنوان الموقع طويل جداً (50 حرفاً كحد أقصى).'),
  body('rib').optional({ values: 'falsy' }).trim()
    .isLength({ max: 25 }).withMessage('رقم الحساب البنكي طويل جداً (25 حرفاً كحد أقصى).'),
  body('acceptTerms').equals('true')
    .withMessage('يجب الموافقة على شروط الاستخدام وسياسة الخصوصية.'),
  body('acceptCndp').equals('true')
    .withMessage('يجب الإقرار بإشعار CNDP وفقاً للقانون 09-08.')
];

const tarifsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'طلبات كثيرة، يرجى الانتظار قليلاً.' }
});

router.get('/track', trackLimiter, track);
router.post('/contact', contactLimiter, contactRules, validate, contact);
router.post('/register', registerLimiter, registerRules, validate, register);
router.get('/tarifs/villes', tarifsLimiter, tarifsVilles);
router.get('/tarifs', tarifsLimiter, tarifs);

module.exports = router;
