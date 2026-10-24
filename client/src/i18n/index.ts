import { watch } from 'vue';
import { createI18n } from 'vue-i18n';
import en from './en';
import de from './de';

export type Locale = 'en' | 'de';
const preferenceKey = 'delight-language';
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (saved === 'de' || saved === 'en') return saved;
  } catch { /* Storage is optional. */ }
  for (const language of navigator.languages ?? [navigator.language]) {
    const base = language.toLowerCase().split('-')[0];
    if (base === 'de' || base === 'en') return base;
  }
  return 'en';
}
export const i18n = createI18n({
  legacy: false, locale: initialLocale(), fallbackLocale: 'en', messages: { en, de },
});
watch(i18n.global.locale, locale => { document.documentElement.lang = locale; }, { immediate: true });
export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  try { localStorage.setItem(preferenceKey, locale); } catch { /* Storage is optional. */ }
}
export function errorKey(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  return typeof code === 'string' && Object.hasOwn(en.errors, code) ? `errors.${code}` : 'errors.GENERIC';
}
