<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

type ConnectionState = 'loading' | 'connected' | 'error';

const connection = ref<ConnectionState>('loading');
let activeRequest: AbortController | undefined;

const connectionText = computed(() => {
  if (connection.value === 'connected') return 'Service is connected';
  if (connection.value === 'error') return 'Service is unavailable';
  return 'Connecting to the service…';
});

async function checkHealth(): Promise<void> {
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  connection.value = 'loading';
  const timeout = window.setTimeout(() => request.abort(), 8_000);

  try {
    const response = await fetch('/api/health', {
      signal: request.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Health request failed');

    const data: unknown = await response.json();
    if (
      typeof data !== 'object' ||
      data === null ||
      !('status' in data) ||
      data.status !== 'ok' ||
      !('service' in data) ||
      data.service !== 'paypal-delight-ai'
    ) {
      throw new Error('Unexpected health response');
    }

    if (activeRequest === request) connection.value = 'connected';
  } catch {
    if (activeRequest === request) connection.value = 'error';
  } finally {
    window.clearTimeout(timeout);
    if (activeRequest === request) activeRequest = undefined;
  }
}

onMounted(() => void checkHealth());
onBeforeUnmount(() => {
  const request = activeRequest;
  activeRequest = undefined;
  request?.abort();
});
</script>

<template>
  <div class="page-shell">
    <header class="site-header">
      <a class="brand" href="/" aria-label="PayPal Delight AI home">
        <span class="brand-mark" aria-hidden="true">D</span>
        <span>PayPal Delight <span class="brand-ai">AI</span></span>
      </a>
      <span class="demo-label">Hackathon demo</span>
    </header>

    <main>
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-copy">
          <p class="eyebrow">A purchase. A personal surprise.</p>
          <h1 id="hero-title">A little more<br /><span>delight.</span></h1>
          <p class="hero-description">
            Turn a purchase into something personal. After a confirmed PayPal Sandbox
            payment, create one AI gift inspired by you and what you bought.
          </p>
          <p class="availability">Coming soon · Checkout and gift creation are in development.</p>
        </div>
        <div class="gift-art" aria-hidden="true">
          <svg viewBox="0 0 280 280" fill="none">
            <circle cx="140" cy="140" r="119" fill="#E6EEFF" />
            <path d="M71 131h138v91a12 12 0 0 1-12 12H83a12 12 0 0 1-12-12z" fill="#003087" />
            <rect x="59" y="109" width="162" height="36" rx="9" fill="#0070E0" />
            <path d="M126 109h28v125h-28z" fill="#9DCEFF" />
            <path d="M140 109c-32 0-59-13-59-33 0-13 9-22 21-22 23 0 38 33 38 55Z" stroke="#0070E0" stroke-width="13" stroke-linejoin="round" />
            <path d="M140 109c32 0 59-13 59-33 0-13-9-22-21-22-23 0-38 33-38 55Z" stroke="#0070E0" stroke-width="13" stroke-linejoin="round" />
            <path d="m227 55 5 14 14 5-14 5-5 14-5-14-14-5 14-5z" fill="#F6AF4E" />
            <path d="m39 168 4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="#F6AF4E" />
            <circle cx="223" cy="203" r="6" fill="#0070E0" />
            <circle cx="49" cy="73" r="5" fill="#9DCEFF" />
          </svg>
          <span class="gift-note">Made just for you</span>
        </div>
      </section>

      <section class="gift-options" aria-labelledby="gifts-title">
        <div class="section-heading">
          <h2 id="gifts-title">Three ways to make it yours</h2>
          <span class="upcoming-label">Planned gift modes</span>
        </div>
        <div class="gift-grid">
          <article class="gift-card">
            <span class="card-number" aria-hidden="true">01</span>
            <h3>Caricature</h3>
            <p>A friendly caricature of you with your new purchase. Bring a photo, or just your imagination.</p>
          </article>
          <article class="gift-card">
            <span class="card-number" aria-hidden="true">02</span>
            <h3>Greeting Card</h3>
            <p>A personal card for a celebration, a thank-you, or someone who deserves a smile.</p>
          </article>
          <article class="gift-card">
            <span class="card-number" aria-hidden="true">03</span>
            <h3>Mini Comic</h3>
            <p>You and your purchase, starring in a short comic with a story all your own.</p>
          </article>
        </div>
      </section>

      <section class="service-panel" aria-label="Service connection">
        <div class="service-message" role="status" aria-live="polite" aria-atomic="true">
          <span class="status-dot" :class="connection" aria-hidden="true"></span>
          <div>
            <p class="status-title">{{ connectionText }}</p>
            <p v-if="connection === 'error'" class="status-detail">
              The connection check did not succeed. Please try again.
            </p>
            <p v-else-if="connection === 'connected'" class="status-detail">
              The demo service is responding.
            </p>
            <p v-else class="status-detail">Checking availability…</p>
          </div>
        </div>
        <button type="button" :disabled="connection === 'loading'" @click="checkHealth">
          {{ connection === 'error' ? 'Try again' : 'Check connection' }}
        </button>
      </section>
    </main>

    <footer>PayPal Delight AI <span aria-hidden="true">·</span> Hackathon 2026 prototype</footer>
  </div>
</template>
