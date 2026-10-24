<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { legalCopy } from '../i18n/legal';
const props = defineProps<{ kind: 'legal' | 'privacy' }>();
const { t, locale } = useI18n();
const copy = computed(() => legalCopy[locale.value === 'de' ? 'de' : 'en'][props.kind]);
</script>

<template>
  <main class="legal-page">
    <h1>{{ copy.title }}</h1>
    <p class="notice legal-draft" role="note">{{ copy.notice }}</p>
    <section v-for="section in copy.sections" :key="section.title">
      <h2>{{ section.title }}</h2>
      <p v-for="paragraph in section.text" :key="paragraph">{{ paragraph }}</p>
    </section>
    <nav class="legal-sources" :aria-label="locale === 'de' ? 'Rechtsquellen und Anbieter' : 'Legal sources and providers'">
      <a href="https://www.gesetze-im-internet.de/ddg/__5.html" rel="noreferrer">§ 5 DDG</a>
      <a href="https://eur-lex.europa.eu/eli/reg/2016/679/oj" rel="noreferrer">{{ locale === 'de' ? 'DSGVO' : 'GDPR' }}</a>
      <a href="https://www.paypal.com/webapps/mpp/ua/privacy-full" rel="noreferrer">PayPal</a>
      <a href="https://www.hetzner.com/legal/privacy-policy/" rel="noreferrer">Hetzner</a>
    </nav>
    <a class="text-button" href="/">{{ t('common.back') }}</a>
  </main>
</template>
