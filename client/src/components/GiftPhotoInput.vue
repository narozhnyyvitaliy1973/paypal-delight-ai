<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
// Prepared for the next stage. This component never performs a network request.
const emit = defineEmits<{ change: [selection: { consent: boolean; file?: File }] }>();
const { t } = useI18n();
const consent = ref(false);
const file = ref<File>();
const input = ref<HTMLInputElement>();
const error = ref('');
function clearFile() {
  file.value = undefined;
  if (input.value) input.value.value = '';
}
watch(consent, value => {
  if (!value) clearFile();
  error.value = '';
  emit('change', { consent: value, file: file.value });
});
function choose(event: Event) {
  const candidate = (event.target as HTMLInputElement).files?.[0];
  error.value = '';
  if (!consent.value) error.value = 'photo.required';
  else if (candidate && !['image/jpeg', 'image/png', 'image/webp'].includes(candidate.type)) error.value = 'photo.format';
  else if (candidate && (candidate.size > 5 * 1024 * 1024 || candidate.size === 0)) error.value = 'photo.size';
  if (error.value) clearFile();
  else file.value = candidate;
  emit('change', { consent: consent.value, file: file.value });
}
function withoutPhoto() {
  consent.value = false;
  clearFile();
  error.value = '';
  emit('change', { consent: false });
}
</script>

<template>
  <fieldset class="photo-input">
    <legend>{{ t('photo.title') }}</legend>
    <p>{{ t('photo.purpose') }}</p>
    <p>{{ t('photo.processing') }}</p>
    <p id="photo-limits">{{ t('photo.limits') }}</p>
    <label class="photo-consent"><input v-model="consent" type="checkbox" />{{ t('photo.consent') }}</label>
    <label>{{ t('photo.choose') }}
      <input ref="input" type="file" accept="image/jpeg,image/png,image/webp" :disabled="!consent" aria-describedby="photo-limits" @change="choose" />
    </label>
    <p v-if="file" role="status">{{ t('photo.selected') }}</p>
    <p v-if="error" role="alert">{{ t(error) }}</p>
    <button type="button" class="text-button" @click="withoutPhoto">{{ t('photo.without') }}</button>
  </fieldset>
</template>
