<script setup lang="ts">
import ProductArt from './ProductArt.vue';
defineProps<{ id?: string; kind?: string; alt?: string; eager?: boolean }>();
const kinds: Record<string, string> = { 'daybreak-mug': 'mug', 'weekend-tote': 'tote', 'cloud-headphones': 'headphones' };
</script>

<template>
  <img v-if="kind || (id && kinds[id])" :src="`/media/${kind ?? kinds[id!]}.webp`" :alt="alt ?? ''" :loading="eager ? 'eager' : 'lazy'" decoding="async" width="1000" height="1125" class="product-photo" />
  <ProductArt v-else kind="mug" />
</template>
