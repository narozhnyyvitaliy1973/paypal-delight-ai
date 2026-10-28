<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError, type GiftInput, type GiftView, type LabRun, type Store } from '../api';
import { errorKey } from '../i18n';
import GiftFlow from './GiftFlow.vue';

interface LabState {
  runs: LabRun[];
  usage: { requests: number; neurons: number; sessionRequests: number; active: number };
  limits: { requests: number; neurons: number; sessionRequests: number; concurrent: number };
  resetsAt: number;
}
const { t, locale } = useI18n();
const emit = defineEmits<{ configuration: [store: Store] }>();
const store = ref<Store>();
const state = ref<LabState>();
const selected = ref('daybreak-mug');
const run = ref<LabRun>();
const frame = ref<GiftView>();
const busy = ref(false);
const error = ref('');
const pending = computed(() => busy.value || run.value?.status === 'STARTED');
const failed = computed(() => run.value?.status === 'REJECTED' || run.value?.status === 'UNCERTAIN');
const productName = computed(() => {
  const product = store.value?.products.find(p => p.id === selected.value);
  return (locale.value === 'de' ? product?.translations.de.name : product?.name) ?? '';
});
const resetsAt = computed(() => state.value ? new Date(state.value.resetsAt).toLocaleString(locale.value === 'de' ? 'de-DE' : 'en-GB') : '');
function fresh() {
  if (pending.value) return;
  run.value = undefined; error.value = '';
  const id = crypto.randomUUID();
  frame.value = { id, gift: { id, status: 'AVAILABLE', result: null } };
  history.replaceState(null, '', '/ai-lab');
}
function apply(value: LabRun): GiftView {
  run.value = value; selected.value = value.productId;
  history.replaceState(null, '', `/ai-lab?run=${value.id}`);
  const view: GiftView = { id: value.id, gift: { id: value.id,
    status: value.status === 'STARTED' ? 'GENERATING' : value.status === 'COMPLETED' ? 'COMPLETED' : 'REVIEW', result: value.result } };
  frame.value = view;
  return view;
}
async function loadState() { state.value = await api<LabState>('/ai-lab'); }
async function open(value: LabRun) {
  if (pending.value) return;
  busy.value = true;
  try { error.value = ''; apply(await api<LabRun>(`/ai-lab/runs/${value.id}`)); }
  catch (cause) { error.value = errorKey(cause); }
  finally { busy.value = false; }
}
const transport = {
  async read() {
    const value = await api<LabRun>(`/ai-lab/runs/${frame.value!.id}`);
    const view = apply(value); await loadState(); return view;
  },
  async create(input: GiftInput) {
    busy.value = true;
    const id = frame.value!.id;
    history.replaceState(null, '', `/ai-lab?run=${id}`);
    try { return apply(await api<LabRun>('/ai-lab/runs', { ...input, requestId: id, productId: selected.value })); }
    finally { busy.value = false; await loadState().catch(() => {}); }
  },
};
onMounted(async () => {
  busy.value = true;
  try {
    store.value = await api<Store>('/store');
    emit('configuration', store.value);
    if (!store.value.labAvailable) throw new ApiError('AI_LAB_UNAVAILABLE', '');
    await loadState();
    const id = new URLSearchParams(location.search).get('run');
    if (id) apply(await api<LabRun>(`/ai-lab/runs/${id}`));
    else { busy.value = false; fresh(); }
  } catch (cause) { error.value = errorKey(cause); }
  finally { busy.value = false; }
});
</script>

<template>
  <main class="ai-lab" tabindex="-1">
    <h1>{{ t('lab.title') }}</h1>
    <p>{{ t('lab.description') }}</p>
    <p v-if="error" class="notice" role="alert">{{ t(error) }}</p>
    <template v-if="state && store?.labAvailable">
      <div class="lab-controls">
        <label>{{ t('lab.product') }}<select v-model="selected" :disabled="pending || !!run" data-testid="lab-product">
          <option v-for="product in store.products" :key="product.id" :value="product.id">{{ locale === 'de' ? product.translations.de.name : product.name }}</option>
        </select></label>
        <button class="primary-button" type="button" :disabled="pending" @click="fresh" data-testid="lab-new">{{ t('lab.newTest') }}</button>
      </div>
      <p class="lab-budget" data-testid="lab-budget">{{ t('lab.budget', { requests: state.usage.requests, maxRequests: state.limits.requests, neurons: state.usage.neurons, maxNeurons: state.limits.neurons }) }}<br>{{ t('lab.reset', { time: resetsAt }) }}</p>
      <p class="notice">{{ t('lab.separate') }}</p>
      <div v-if="failed" class="notice" role="status" data-testid="lab-failed">{{ t(`errors.${run?.errorCode ?? 'AI_LAB_REJECTED'}`) }}</div>
      <GiftFlow v-else-if="frame" :key="frame.id" :order="frame" :product-name="productName" :is-demo="store.gifts.isDemo"
        :provider="store.gifts.provider" :ai-enabled="store.gifts.enabled" :transport="transport" lab @update="frame = $event" />
      <section v-if="state.runs.length" class="lab-history" aria-labelledby="lab-history-title">
        <h2 id="lab-history-title">{{ t('lab.history') }}</h2>
        <ul><li v-for="item in state.runs" :key="item.id"><button type="button" class="text-button" :disabled="pending" :data-testid="`lab-run-${item.id}`" @click="open(item)">
          {{ t(`gift.${item.type === 'caricature' ? 'caricature' : item.type === 'greeting-card' ? 'greeting' : 'comic'}`) }} · {{ t(`lab.status.${item.status}`) }} · {{ new Date(item.createdAt).toLocaleString(locale) }} · {{ item.id.slice(0, 8) }}
        </button></li></ul>
      </section>
    </template>
  </main>
</template>

<style scoped>
.ai-lab { padding: 3rem 0; }
.ai-lab > h1 { margin-bottom: .5rem; }
.lab-controls { display: flex; align-items: end; flex-wrap: wrap; gap: 1rem; margin-top: 1.5rem; }
.lab-controls label { display: grid; gap: .5rem; max-width: 100%; }
.lab-controls select { padding: .8rem; border: 1px solid #c8cfda; border-radius: 10px; max-width: 100%; background: white; color: #14233b; font: inherit; }
.lab-budget { line-height: 1.7; margin: 1rem 0; }
.lab-history { margin-top: 2rem; }
.lab-history ul { padding-left: 1.2rem; }
.lab-history button { text-align: left; overflow-wrap: anywhere; }
@media (max-width: 600px) { .lab-controls > * { width: 100%; } .ai-lab { padding-top: 1.5rem; } }
</style>
