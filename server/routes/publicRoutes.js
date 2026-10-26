/**
 * The public page. P23 (M14), API-CONTRACT M14 section 2.
 *
 * Never behind `authenticate`. The order on every route: a public limiter,
 * then `resolvePublicSite`, which sets the tenant from the page address, then
 * validation, then the controller. The general limiter skips these paths.
 */
import { Router } from 'express';

import { getLogo } from '../controllers/brandController.js';
import { getPublicPhoto, postBookingPaymentReturn, postOrderPaymentReturn, postWebhook } from '../controllers/paymentController.js';
import {
  getMenu,
  getOrder,
  getReservation,
  getSite,
  getSlots,
  postCancelOrder,
  postCancelReservation,
  postOrder,
  postQuote,
  postReservation,
} from '../controllers/publicController.js';
import { publicPhoneLimiter, publicReadLimiter, publicWriteLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { resolvePublicSite } from '../services/publicSiteService.js';
import { INTAKE_SOURCES } from '../models/IntakeItem.js';
import { getIntakeStatus, intakeOnMirror, razorpayWebhookOnMirror } from '../services/intake/intakeRoute.js';
import {
  publicLogoSchema,
  publicPlaceOrderSchema,
  publicQuoteSchema,
  publicRequestReservationSchema,
  publicSiteSchema,
  publicSlotsSchema,
  publicStatusSchema,
} from '../validators/onlineValidators.js';
import { paymentReturnSchema, publicPhotoSchema } from '../validators/paymentValidators.js';

const router = Router();

const read = [publicReadLimiter, resolvePublicSite];
const write = [publicWriteLimiter, resolvePublicSite];
const place = [publicWriteLimiter, publicPhoneLimiter, resolvePublicSite];

router.get('/public/:slug', ...read, validate(publicSiteSchema), getSite);
router.get('/public/:slug/menu', ...read, validate(publicSiteSchema), getMenu);
router.get('/public/:slug/logo/:slot', ...read, validate(publicLogoSchema), getLogo);
// A quote writes nothing, so it counts as a read.
router.post('/public/:slug/quote', ...read, validate(publicQuoteSchema), postQuote);

router.post('/public/:slug/orders', ...place, validate(publicPlaceOrderSchema), intakeOnMirror(INTAKE_SOURCES.ONLINE_ORDER), postOrder);
router.get('/public/:slug/orders/:id', ...read, validate(publicStatusSchema), getOrder);
router.post('/public/:slug/orders/:id/cancel', ...write, validate(publicStatusSchema), intakeOnMirror(INTAKE_SOURCES.ONLINE_ORDER_CANCEL), postCancelOrder);

router.get('/public/:slug/reservations/slots', ...read, validate(publicSlotsSchema), getSlots);
router.post('/public/:slug/reservations', ...place, validate(publicRequestReservationSchema), intakeOnMirror(INTAKE_SOURCES.RESERVATION), postReservation);
router.get('/public/:slug/reservations/:id', ...read, validate(publicStatusSchema), getReservation);
router.post('/public/:slug/reservations/:id/cancel', ...write, validate(publicStatusSchema), intakeOnMirror(INTAKE_SOURCES.RESERVATION_CANCEL), postCancelReservation);

// P24. Advance payment: the guest's return, the webhook, and dish photos.
router.post('/public/:slug/orders/:id/payment-return', ...write, validate(paymentReturnSchema), intakeOnMirror(INTAKE_SOURCES.ONLINE_ORDER_PAYMENT_RETURN), postOrderPaymentReturn);
router.post('/public/:slug/reservations/:id/payment-return', ...write, validate(paymentReturnSchema), intakeOnMirror(INTAKE_SOURCES.RESERVATION_PAYMENT_RETURN), postBookingPaymentReturn);
// Razorpay's servers, not a guest: their own limiter would be wrong, the read one is generous.
router.post('/public/:slug/payments/webhook', ...read, razorpayWebhookOnMirror, postWebhook);
router.get('/public/:slug/photos/:itemId', ...read, validate(publicPhotoSchema), getPublicPhoto);

// P62. On the cloud mirror, a guest asks what the cafe box made of their request.
router.get('/public/:slug/intake/:id', ...read, getIntakeStatus);

export default router;
