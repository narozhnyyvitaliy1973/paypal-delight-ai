<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import AppIcon from './AppIcon.vue';
// Selection and preview only. The parent submits the file after explicit creation.
const props = defineProps<{ cloudflare?: boolean }>();
const emit = defineEmits<{ change: [selection: { consent: boolean; cloudflareConsent: boolean; file?: File }] }>();
const { t } = useI18n();
const consent = ref(false);
const cloudflareConsent = ref(false);
const allowed = computed(() => consent.value && (!props.cloudflare || cloudflareConsent.value));
const file = ref<File>();
const input = ref<HTMLInputElement>();
const error = ref('');
const preview = ref('');
watch(file, value => {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = value ? URL.createObjectURL(value) : '';
});
onBeforeUnmount(() => { if (preview.value) URL.revokeObjectURL(preview.value); });
function clearFile() {
  file.value = undefined;
  if (input.value) input.value.value = '';
}
watch(allowed, value => {
  if (!value) clearFile();
  error.value = '';
  emit('change', { consent: consent.value, cloudflareConsent: cloudflareConsent.value, file: file.value });
});
watch(() => props.cloudflare, () => { consent.value = false; cloudflareConsent.value = false; clearFile(); });
function choose(event: Event) {
  const candidate = (event.target as HTMLInputElement).files?.[0];
  error.value = '';
  if (!allowed.value) error.value = 'photo.required';
  else if (candidate && !['image/jpeg', 'image/png', 'image/webp'].includes(candidate.type)) error.value = 'photo.format';
  else if (candidate && (candidate.size > 5 * 1024 * 1024 || candidate.size === 0)) error.value = 'photo.size';
  if (error.value) clearFile();
  else file.value = candidate;
  emit('change', { consent: consent.value, cloudflareConsent: cloudflareConsent.value, file: file.value });
}
function withoutPhoto() {
  consent.value = false;
  cloudflareConsent.value = false;
  clearFile();
  error.value = '';
  emit('change', { consent: false, cloudflareConsent: false });
}
</script>

<template>
  <fieldset class="photo-input">
    <legend>{{ t('photo.title') }}</legend>
    <p>{{ t(cloudflare ? 'photo.cloudflarePurpose' : 'photo.purpose') }}</p>
    <details class="photo-details"><summary>{{ t('design.photoDetails') }}</summary>
      <p>{{ t(cloudflare ? 'photo.cloudflareProcessing' : 'photo.processing') }}</p>
      <p id="photo-limits">{{ t('photo.limits') }}</p>
    </details>
    <label class="photo-consent"><input v-model="consent" type="checkbox" />{{ t('photo.consent') }}</label>
    <label v-if="cloudflare" class="photo-consent"><input v-model="cloudflareConsent" type="checkbox" data-testid="cloudflare-photo-consent" />{{ t('photo.cloudflareConsent') }}</label>
    <label class="photo-picker" :class="{ 'is-disabled': !allowed }">
      <input ref="input" type="file" accept="image/jpeg,image/png,image/webp" :disabled="!allowed" :aria-label="t('photo.choose')" aria-describedby="photo-limits" @change="choose" />
      <span aria-hidden="true"><AppIcon name="image" /><strong>{{ t('photo.choose') }}</strong><small>JPEG · PNG · WebP</small></span>
    </label>
    <p v-if="file" role="status">{{ t('photo.selected') }}</p>
    <img v-if="preview" :src="preview" :alt="t('photo.preview')" class="photo-preview" />
    <p v-if="error" role="alert">{{ t(error) }}</p>
    <button type="button" class="text-button" @click="withoutPhoto">{{ t('photo.without') }}</button>
  </fieldset>
</template>
