<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError, type GiftView, type GiftInput, type GiftType } from '../api';
import { errorKey } from '../i18n';
import GiftPhotoInput from './GiftPhotoInput.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ order: GiftView; productName: string; isDemo: boolean; provider?: string; aiEnabled?: boolean;
  lab?: boolean; transport?: { read: () => Promise<GiftView>; create: (input: GiftInput) => Promise<GiftView> } }>();
const emit = defineEmits<{ update: [order: GiftView] }>();
const { t, locale, te } = useI18n();
const form = ref(false);
const mode = ref<GiftType>('caricature');
const modes: GiftType[] = ['caricature', 'greeting-card', 'mini-comic'];
const modeKeys = { caricature: 'caricature', 'greeting-card': 'greeting', 'mini-comic': 'comic' } as const;
const submitting = ref(false);
const wishes = ref('');
const recipientName = ref('');
const occasion = ref('');
const characterName = ref('');
const selection = ref<{ consent: boolean; cloudflareConsent?: boolean; file?: File }>({ consent: false });
const error = ref('');
const shownError = computed(() => props.lab && te(`lab.${error.value}`) ? `lab.${error.value}` : error.value);
const result = computed(() => props.order.gift?.result);
const generating = computed(() => submitting.value || props.order.gift?.status === 'GENERATING');
const review = computed(() => props.order.gift?.status === 'REVIEW');
const disabled = computed(() => !props.isDemo && props.aiEnabled === false);
const flowElement = ref<HTMLElement>();
// Keep keyboard users at the next visible step when its triggering button disappears.
watch([form, result, review], async () => {
  await nextTick();
  const heading = flowElement.value?.querySelector<HTMLElement>('h2');
  heading?.focus();
});
let poll: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

function clearPersonalization() {
  wishes.value = ''; recipientName.value = ''; occasion.value = ''; characterName.value = '';
  selection.value = { consent: false };
}
function choose(type: GiftType) {
  if (generating.value || disabled.value || props.order.gift?.status !== 'AVAILABLE') return;
  clearPersonalization();
  mode.value = type; form.value = true; error.value = '';
}
function schedule() {
  clearTimeout(poll);
  if (!disposed && props.order.gift?.status === 'GENERATING') poll = setTimeout(() => void refresh(), 1500);
}
async function refresh() {
  try {
    const order = await (props.transport?.read() ?? api<GiftView>(`/orders/${props.order.id}/gift`));
    if (disposed) return;
    emit('update', order);
    error.value = '';
    if (order.gift?.status === 'AVAILABLE') { form.value = true; error.value = 'errors.GIFT_RETRY'; }
    if (order.gift?.status === 'GENERATING') poll = setTimeout(() => void refresh(), 1500);
  } catch (cause) { if (!disposed) error.value = props.lab && cause instanceof ApiError && cause.code === 'NETWORK_ERROR' ? 'errors.AI_LAB_NETWORK' : errorKey(cause); }
}
watch(() => props.order.gift?.status, status => {
  schedule();
  // Also release local selections when polling recovers a lost POST response.
  if (status === 'COMPLETED' || status === 'REVIEW') { clearPersonalization(); form.value = false; }
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
  if (generating.value || disabled.value || props.order.gift?.status !== 'AVAILABLE') return;
  if ((mode.value === 'greeting-card' && (!recipientName.value.trim() || !occasion.value.trim())) ||
      (mode.value === 'mini-comic' && !characterName.value.trim())) {
    error.value = 'errors.GIFT_PERSONALIZATION_INVALID'; return;
  }
  if (selection.value.file && !selection.value.consent) { error.value = 'errors.PHOTO_CONSENT_REQUIRED'; return; }
  submitting.value = true;
  error.value = '';
  try {
    const file = mode.value === 'caricature' ? selection.value.file : undefined;
    const photo = file ? { data: await encode(file), contentType: file.type, consent: selection.value.consent,
      ...(props.provider === 'cloudflare' ? { cloudflareConsent: selection.value.cloudflareConsent === true } : {}) } : undefined;
    const personalization = mode.value === 'greeting-card'
      ? { recipientName: recipientName.value.trim(), occasion: occasion.value.trim() }
      : mode.value === 'mini-comic' ? { characterName: characterName.value.trim() } : {};
    const input = { type: mode.value, language: locale.value, wishes: wishes.value.trim(), ...personalization, ...(photo ? { photo } : {}) };
    const order = await (props.transport?.create(input) ?? api<GiftView>(`/orders/${props.order.id}/gift`, input));
    if (!disposed) {
      emit('update', order);
      if (order.gift?.status === 'COMPLETED') clearPersonalization();
    }
  } catch (cause) {
    if (!disposed) {
      error.value = props.lab && cause instanceof ApiError && cause.code === 'NETWORK_ERROR' ? 'errors.AI_LAB_NETWORK' : errorKey(cause);
      // A lost response may still have committed a result. GET never starts generation.
      try {
        const recovered = await (props.transport?.read() ?? api<GiftView>(`/orders/${props.order.id}/gift`));
        if (!disposed) emit('update', recovered);
      } catch { /* Keep the retry action. */ }
    }
  } finally { submitting.value = false; }
}
</script>

<template>
  <div ref="flowElement" class="gift-flow">
    <div v-if="result" class="gift-result" :class="`mode-${result.type}`" data-testid="gift-result">
      <div class="result-copy">
        <p class="gift-mode-label" data-testid="gift-mode">{{ t(`gift.${modeKeys[result.type]}`) }}<span v-if="result.isDemo" class="demo-badge">DEMO</span></p>
        <h2 tabindex="-1">{{ t(lab ? 'lab.resultTitle' : 'gift.ready') }}</h2>
        <p class="result-intro">{{ t('design.resultIntro') }}</p>
        <p v-if="!result.isDemo">{{ result.text }}</p>
        <a class="primary-button download-button" :href="result.downloadUrl" download data-testid="gift-download">{{ t('gift.download') }}<AppIcon name="download" /></a>
        <p class="saved-title"><AppIcon name="check" />{{ t(lab ? 'lab.resultSaved' : 'design.resultSaved') }}</p>
        <details class="result-details"><summary>{{ t(result.isDemo ? 'design.demoDetails' : 'gift.aiDetails') }}</summary><p v-if="result.isDemo" class="demo-note">{{ t('gift.mockNotice') }}</p><p class="muted saved-copy">{{ t(lab ? 'lab.saved' : 'gift.saved') }}</p></details>
        <div class="result-signature"><span><AppIcon name="gift" /></span><p>{{ t('design.giftBranding') }}<strong>Delight AI</strong></p></div>
      </div>
      <div class="result-art">
        <div class="result-frame"><img :src="result.imageUrl" :alt="t(result.isDemo ? `gift.${modeKeys[result.type]}Alt` : 'gift.resultAlt')" :width="result.width" :height="result.height" class="gift-image" /></div>
        <p class="result-art-caption">{{ t('design.resultFormat') }}</p>
      </div>
    </div>
    <template v-else>
      <div v-if="review" class="notice" role="status" data-testid="gift-review"><h2 tabindex="-1">{{ t('gift.reviewTitle') }}</h2><p>{{ t('errors.AI_REVIEW_REQUIRED') }}</p><button class="text-button" type="button" @click="refresh">{{ t('gift.check') }}</button></div>
      <p v-if="disabled && !review" class="notice" role="status">{{ t(lab ? 'lab.errors.AI_DISABLED' : 'errors.AI_DISABLED') }}</p>
      <div v-if="!form && !generating && !review" class="gift-choice">
        <div class="gift-section-heading"><h2 tabindex="-1">{{ t('design.giftSelection') }}</h2><p>{{ t(lab ? 'lab.description' : 'design.selectionDescription') }}</p></div>
        <div class="gift-options">
          <button v-for="type in modes" :key="type" type="button" :disabled="disabled" :class="`mode-${type}`" :data-testid="`choose-${type}`" @click="choose(type)">
            <span class="gift-option-art"><span class="demo-badge">{{ isDemo ? 'DEMO' : t('gift.sample') }}</span><img :src="`/media/demo-${type}.webp`" alt="" width="600" height="600" /></span>
            <span class="gift-option-copy"><strong>{{ t(`gift.${modeKeys[type]}`) }}</strong><small>{{ t(`gift.${modeKeys[type]}Description`) }}</small><span class="gift-option-cta">{{ t(`design.createModes.${modeKeys[type]}`) }}<AppIcon name="arrow" /></span></span>
          </button>
        </div>
        <p class="gift-choice-note"><AppIcon name="shield" />{{ t(lab ? 'lab.separate' : 'gift.oneChoice') }}</p>
      </div>
      <div v-if="!review && (form || generating)" class="studio" :class="[`mode-${mode}`, { 'is-generating': generating, 'resume-progress': generating && !form }]">
        <div class="studio-layout">
          <form v-if="form" class="gift-form" @submit.prevent="create">
            <button type="button" class="studio-back" :disabled="generating" data-testid="change-gift-mode" @click="form = false; error = ''; clearPersonalization()"><AppIcon name="back" />{{ t('gift.changeMode') }}</button>
            <h2 tabindex="-1"><AppIcon name="spark" />{{ t(`design.studioTitles.${modeKeys[mode]}`) }}</h2>
            <p class="studio-description">{{ t(`design.studioDescriptions.${modeKeys[mode]}`) }}</p>
            <p v-if="!isDemo" class="studio-description">{{ t(lab ? 'lab.aiProcessing' : 'gift.aiProcessing') }}</p>
            <fieldset :disabled="generating || disabled" class="gift-fields">
              <label class="purchased-field">{{ t(lab ? 'lab.product' : 'gift.product') }}<input :value="productName" readonly /></label>
              <GiftPhotoInput v-if="mode === 'caricature'" :cloudflare="provider === 'cloudflare'" @change="selection = $event" />
              <template v-if="mode === 'greeting-card'">
                <label>{{ t('gift.recipientName') }}<input v-model="recipientName" required maxlength="80" autocomplete="off" aria-describedby="name-hint" /></label>
                <label>{{ t('gift.occasion') }}<input v-model="occasion" required maxlength="120" :placeholder="t('gift.occasionPlaceholder')" autocomplete="off" aria-describedby="occasion-hint" /></label><p id="occasion-hint" class="muted field-hint">{{ t('gift.occasionHint') }}</p>
              </template>
              <label v-if="mode === 'mini-comic'">{{ t('gift.characterName') }}<input v-model="characterName" required maxlength="80" autocomplete="off" aria-describedby="name-hint" /></label>
              <p v-if="mode !== 'caricature'" id="name-hint" class="muted field-hint">{{ t(isDemo ? 'gift.nameHint' : 'gift.aiNameHint') }}</p>
              <label>{{ t(mode === 'mini-comic' ? 'gift.plotWishes' : 'gift.wishes') }}<textarea v-model="wishes" maxlength="500" rows="3" :placeholder="t(mode === 'mini-comic' ? 'gift.plotPlaceholder' : 'gift.wishesPlaceholder')" aria-describedby="wishes-limit" /></label>
              <p id="wishes-limit" class="muted field-hint character-count">{{ t('gift.wishesLimit') }} · {{ wishes.length }}/500</p>
              <button type="submit" class="primary-button" data-testid="create-gift">{{ t('gift.generate') }}<AppIcon name="arrow" /></button>
            </fieldset>
            <p class="studio-right-note"><AppIcon name="shield" />{{ t(lab ? 'lab.separate' : 'design.oneGift') }}</p>
          </form>
          <div class="studio-preview">
            <div class="preview-heading"><span><AppIcon name="image" />{{ t('design.studioPreview') }}</span><span class="demo-badge">{{ isDemo ? 'DEMO' : t('gift.sample') }}</span></div>
            <div class="preview-canvas">
              <img v-if="form" :src="`/media/demo-${mode}.webp`" :alt="t(`gift.${modeKeys[mode]}Alt`)" width="600" height="600" />
              <div v-if="generating" class="gift-progress" role="status" aria-live="polite" data-testid="gift-progress"><span class="gift-spinner" aria-hidden="true"><AppIcon /></span><strong>{{ t('gift.generating') }}</strong><p>{{ t('gift.wait') }}</p><div class="progress-dots" aria-hidden="true"><i></i><i></i><i></i></div></div>
            </div>
            <div class="preview-meta"><span>{{ t(isDemo ? 'design.studioMock' : 'gift.aiPreview') }}</span><span>{{ locale.toUpperCase() }} · PNG</span></div>
            <p class="preview-caption">{{ t(isDemo ? 'gift.mockNotice' : 'gift.aiNotice') }}</p>
          </div>
        </div>
      </div>
      <p v-if="isDemo && !form && !generating" class="demo-note mock-explanation">{{ t('gift.mockNotice') }}</p>
      <div v-if="error && !review" class="notice" role="alert"><p>{{ t(shownError) }}</p><button v-if="error !== 'errors.GIFT_PERSONALIZATION_INVALID'" type="button" class="text-button" :disabled="submitting" @click="refresh">{{ t('gift.check') }}</button></div>
    </template>
  </div>
</template>
