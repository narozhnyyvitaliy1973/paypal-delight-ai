<script setup lang="ts">
withDefaults(defineProps<{ name?: string }>(), { name: 'spark' });
const paths: Record<string, string> = {
  spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  image: 'M3 4h18v16H3V4Zm0 12 6-6 5 5 3-3 4 4M16 8h.01',
  check: 'm5 12 4 4L19 6',
  bag: 'M5 7h14l1 14H4L5 7Zm3 0V5a4 4 0 0 1 8 0v2',
  gift: 'M3 8h18v4H3V8Zm2 4v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  smile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 9h.01M16 9h.01M8 14s1 3 4 3 4-3 4-3',
};
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.spark" /></svg>
</template>
