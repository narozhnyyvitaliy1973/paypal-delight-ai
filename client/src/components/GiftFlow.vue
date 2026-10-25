<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError, type Order, type GiftType } from '../api';
import { errorKey } from '../i18n';
import GiftPhotoInput from './GiftPhotoInput.vue';

const props = defineProps<{ order: Order; productName: string; isDemo: boolean }>();
const emit = defineEmits<{ update: [order: Order] }>();
const { t, locale } = useI18n();
const form = ref(false);
const mode = ref<GiftType>('caricature');
const modes: GiftType[] = ['caricature', 'greeting-card', 'mini-comic'];
const modeKeys = { caricature: 'caricature', 'greeting-card': 'greeting', 'mini-comic': 'comic' } as const;
const submitting = ref(false);
const wishes = ref('');
const recipientName = ref('');
const occasion = ref('');
const characterName = ref('');
const selection = ref<{ consent: boolean; file?: File }>({ consent: false });
const error = ref('');
const result = computed(() => props.order.gift?.result);
const generating = computed(() => submitting.value || props.order.gift?.status === 'GENERATING');
let poll: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

function clearPersonalization() {
  wishes.value = ''; recipientName.value = ''; occasion.value = ''; characterName.value = '';
  selection.value = { consent: false };
}
function choose(type: GiftType) {
  if (generating.value || props.order.gift?.status !== 'AVAILABLE') return;
  clearPersonalization();
  mode.value = type; form.value = true; error.value = '';
}
function schedule() {
  clearTimeout(poll);
  if (!disposed && props.order.gift?.status === 'GENERATING') poll = setTimeout(() => void refresh(), 1500);
}
async function refresh() {
  try {
    const order = await api<Order>(`/orders/${props.order.id}/gift`);
    if (disposed) return;
    emit('update', order);
    error.value = '';
    if (order.gift?.status === 'AVAILABLE') { form.value = true; error.value = 'errors.GIFT_RETRY'; }
    if (order.gift?.status === 'GENERATING') poll = setTimeout(() => void refresh(), 1500);
  } catch (cause) { if (!disposed) error.value = errorKey(cause); }
}
watch(() => props.order.gift?.status, status => {
  schedule();
  // Also release local selections when polling recovers a lost POST response.
  if (status === 'COMPLETED') { clearPersonalization(); form.value = false; }
});
watch([recipientName, occasion, characterName], () => {
  if (error.value === 'errors.GIFT_PERSONALIZATION_INVALID') error.value = '';
});
onMounted(schedule);
onBeforeUnmount(() => { disposed = true; clearTimeout(poll); });

function encode(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new ApiError('PHOTO_INVALID', ''));
    reader.readAsDataURL(file);
  });
}
async function create() {
  if (generating.value || props.order.gift?.status === 'COMPLETED') return;
  if ((mode.value === 'greeting-card' && (!recipientName.value.trim() || !occasion.value.trim())) ||
      (mode.value === 'mini-comic' && !characterName.value.trim())) {
    error.value = 'errors.GIFT_PERSONALIZATION_INVALID'; return;
  }
  if (selection.value.file && !selection.value.consent) { error.value = 'errors.PHOTO_CONSENT_REQUIRED'; return; }
  submitting.value = true;
  error.value = '';
  try {
    const file = mode.value === 'caricature' ? selection.value.file : undefined;
    const photo = file ? { data: await encode(file), contentType: file.type, consent: selection.value.consent } : undefined;
    const personalization = mode.value === 'greeting-card'
      ? { recipientName: recipientName.value.trim(), occasion: occasion.value.trim() }
      : mode.value === 'mini-comic' ? { characterName: characterName.value.trim() } : {};
    const order = await api<Order>(`/orders/${props.order.id}/gift`, { type: mode.value, language: locale.value, wishes: wishes.value.trim(), ...personalization, ...(photo ? { photo } : {}) });
    if (!disposed) {
      emit('update', order);
      if (order.gift?.status === 'COMPLETED') clearPersonalization();
    }
  } catch (cause) {
    if (!disposed) {
      error.value = errorKey(cause);
      // A lost response may still have committed a result. GET never starts generation.
      try {
        const recovered = await api<Order>(`/orders/${props.order.id}/gift`);
        if (!disposed) emit('update', recovered);
      } catch { /* Keep the retry action. */ }
    }
  } finally { submitting.value = false; }
}
</script>

<template>
  <div class="gift-flow">
    <div v-if="result" class="gift-result" data-testid="gift-result">
      <p class="eyebrow">{{ t('gift.readyEyebrow') }}</p>
      <h2>{{ t('gift.ready') }}</h2>
      <p class="gift-mode-label" data-testid="gift-mode">{{ t(`gift.${modeKeys[result.type]}`) }}<span v-if="result.isDemo" class="demo-badge">DEMO</span></p>
      <p v-if="result.isDemo" class="demo-note">{{ t('gift.mockNotice') }}</p>
      <p v-else>{{ result.text }}</p>
      <img :src="result.imageUrl" :alt="t(result.isDemo ? `gift.${modeKeys[result.type]}Alt` : 'gift.resultAlt')" :width="result.width" :height="result.height" class="gift-image" />
      <a class="primary-button download-button" :href="result.downloadUrl" download data-testid="gift-download">{{ t('gift.download') }} <span aria-hidden="true">↓</span></a>
      <p class="muted">{{ t('gift.saved') }}</p>
    </div>
    <template v-else>
      <p class="gift-choice-note">{{ t('gift.oneChoice') }}</p>
      <div v-if="!form && !generating" class="gift-options">
        <button v-for="(type, index) in modes" :key="type" type="button" :data-testid="`choose-${type}`" @click="choose(type)"><span>0{{ index + 1 }}</span><strong>{{ t(`gift.${modeKeys[type]}`) }}</strong><small>{{ t(`gift.${modeKeys[type]}Description`) }}</small></button>
      </div>
      <p v-if="isDemo" class="demo-note">{{ t('gift.mockNotice') }}</p>
      <form v-if="form" class="gift-form" @submit.prevent="create">
        <p class="eyebrow">{{ t(`gift.${modeKeys[mode]}`) }}<span v-if="isDemo" class="demo-badge">DEMO</span></p>
        <h2>{{ t('gift.formTitle') }}</h2>
        <fieldset :disabled="generating" class="gift-fields">
          <label>{{ t('gift.product') }}<input :value="productName" readonly /></label>
          <template v-if="mode === 'greeting-card'">
            <label>{{ t('gift.recipientName') }}<input v-model="recipientName" required maxlength="80" autocomplete="off" aria-describedby="name-hint" /></label>
            <label>{{ t('gift.occasion') }}<input v-model="occasion" required maxlength="120" :placeholder="t('gift.occasionPlaceholder')" autocomplete="off" aria-describedby="occasion-hint" /></label>
            <p id="occasion-hint" class="muted">{{ t('gift.occasionHint') }}</p>
          </template>
          <label v-if="mode === 'mini-comic'">{{ t('gift.characterName') }}<input v-model="characterName" required maxlength="80" autocomplete="off" aria-describedby="name-hint" /></label>
          <p v-if="mode !== 'caricature'" id="name-hint" class="muted">{{ t('gift.nameHint') }}</p>
          <label>{{ t(mode === 'mini-comic' ? 'gift.plotWishes' : 'gift.wishes') }}<textarea v-model="wishes" maxlength="500" rows="3" :placeholder="t(mode === 'mini-comic' ? 'gift.plotPlaceholder' : 'gift.wishesPlaceholder')" aria-describedby="wishes-limit" /></label>
          <p id="wishes-limit" class="muted">{{ t('gift.wishesLimit') }} · {{ wishes.length }}/500</p>
          <GiftPhotoInput v-if="mode === 'caricature'" @change="selection = $event" />
          <button type="submit" class="primary-button" data-testid="create-gift">{{ t('gift.generate') }} <span aria-hidden="true">✦</span></button>
          <button type="button" class="text-button" data-testid="change-gift-mode" @click="form = false; error = ''; clearPersonalization()">{{ t('gift.changeMode') }}</button>
        </fieldset>
      </form>
      <div v-if="generating" class="gift-progress" role="status" aria-live="polite" data-testid="gift-progress">
        <span class="gift-spinner" aria-hidden="true">✳</span><strong>{{ t('gift.generating') }}</strong><p>{{ t('gift.wait') }}</p>
      </div>
      <div v-if="error" class="notice" role="alert">
        <p>{{ t(error) }}</p><button v-if="error !== 'errors.GIFT_PERSONALIZATION_INVALID'" type="button" class="text-button" :disabled="submitting" @click="refresh">{{ t('gift.check') }}</button>
      </div>
    </template>
  </div>
</template>
