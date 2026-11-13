/**
 * Shared i18n message catalog (K06-T08 / K11-T06 / AC-052).
 * Messages are keys, never prose. Arabic is mandatory, English optional.
 * RTL clients read `ar`; the API always returns `message_key`.
 */
export const MESSAGE_KEYS = {
  'errors.invalid_public_id': { ar: 'معرّف غير صالح', en: 'Invalid identifier' },
  'errors.cross_tenant_access': { ar: 'غير مصرّح بالوصول إلى هذا المورد', en: 'Access denied' },
  'errors.context_missing': { ar: 'سياق الطلب مفقود', en: 'Request context missing' },
  'errors.tx_boundary_violation': { ar: 'نداء خارجي داخل معاملة', en: 'External call inside transaction' },
  'errors.nested_transaction': { ar: 'معاملة متداخلة غير مسموحة', en: 'Nested transaction not allowed' },
  'errors.event_contract_violation': { ar: 'حدث لا يطابق العقده', en: 'Event contract violation' },
  'errors.idempotency_key_missing': { ar: 'مفتاح التكرار مطلوب', en: 'Idempotency-Key required' },
  'errors.idempotency_key_reused': { ar: 'مفتاح التكرار مستعمل بحمولة مختلفة', en: 'Idempotency key reused' },
  'errors.tenant_required': { ar: 'المستأجر مطلوب لهذه العملية', en: 'Tenant required' },
  'errors.user_required': { ar: 'المستخدم مطلوب لهذه العملية', en: 'User required' },
  'errors.not_found': { ar: 'المورد غير موجود', en: 'Not found' },
  'errors.validation_failed': { ar: 'بيانات غير صحيحة', en: 'Validation failed' },
  'errors.rate_limited': { ar: 'تجاوزت حد الطلبات', en: 'Too many requests' },
} as const;

export type MessageKey = keyof typeof MESSAGE_KEYS;

export const SUPPORTED_LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ar';

export function translate(key: MessageKey, locale: Locale = DEFAULT_LOCALE): string {
  const entry = MESSAGE_KEYS[key];
  if (!entry) return key;
  return entry[locale] ?? entry[DEFAULT_LOCALE];
}
