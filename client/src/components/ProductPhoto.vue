<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import ProductArt from './ProductArt.vue';
const props = defineProps<{ id?: string; kind?: string; alt?: string; eager?: boolean }>();
const { locale } = useI18n();
// Keep the original thumbnails for purchases made before the puzzle collection.
const kinds: Record<string, string> = { 'daybreak-mug': 'mug', 'weekend-tote': 'tote', 'cloud-headphones': 'headphones',
  'starry-night-puzzle': 'starry-night', 'great-wave-puzzle': 'great-wave', 'water-lilies-puzzle': 'water-lilies' };
const artwork: Record<string, { artist: string; en: string; de: string }> = {
  'starry-night': { artist: 'Vincent van Gogh', en: 'The Starry Night', de: 'Sternennacht' },
  'great-wave': { artist: 'Katsushika Hokusai', en: 'The Great Wave', de: 'Die große Welle' },
  'water-lilies': { artist: 'Claude Monet', en: 'Water Lilies', de: 'Seerosen' },
};
const kind = computed(() => props.kind ?? kinds[props.id ?? '']);
const puzzle = computed(() => artwork[kind.value ?? '']);
const patternId = `puzzle-cuts-${useId()}`;
</script>

<template>
  <div v-if="puzzle" class="product-photo puzzle-product" :class="`puzzle-${kind}`" role="img"
    :aria-label="alt || `${puzzle[locale === 'de' ? 'de' : 'en']} · ${puzzle.artist}`">
    <div class="puzzle-box" aria-hidden="true">
      <div class="puzzle-label">MUSEUM PUZZLES <span>1000</span></div>
      <div class="puzzle-surface">
        <img :src="`/media/${kind}.webp`" alt="" :loading="eager ? 'eager' : 'lazy'" decoding="async" />
        <svg viewBox="0 0 600 440" preserveAspectRatio="none" class="puzzle-cuts">
          <defs><pattern :id="patternId" width="100" height="88" patternUnits="userSpaceOnUse">
            <path d="M0 0H36C42 0 42 4 38 9C30 22 70 22 62 9C58 4 58 0 64 0H100M0 0V30C0 36 4 36 9 32C22 24 22 64 9 56C4 52 0 52 0 58V88" fill="none" />
          </pattern></defs>
          <rect width="600" height="440" :fill="`url(#${patternId})`" />
        </svg>
      </div>
      <div class="puzzle-caption"><strong>{{ puzzle[locale === 'de' ? 'de' : 'en'] }}</strong><span>{{ puzzle.artist }}</span></div>
    </div>
    <svg class="loose-piece" viewBox="0 0 90 90" aria-hidden="true"><path d="M10 10H34C38 10 38 16 33 20C20 36 70 36 57 20C52 16 52 10 56 10H80V34C80 38 74 38 70 33C54 20 54 70 70 57C74 52 80 52 80 56V80H56C52 80 52 74 57 70C70 54 20 54 33 70C38 74 38 80 34 80H10Z" /></svg>
  </div>
  <img v-else-if="kind" :src="`/media/${kind}.webp`" :alt="alt ?? ''" :loading="eager ? 'eager' : 'lazy'" decoding="async" width="1000" height="1125" class="product-photo" />
  <ProductArt v-else kind="mug" />
</template>

<style scoped>
.puzzle-product { --ink: #223950; position: relative; display: grid; place-items: center; width: 100%; height: 100%; container-type: inline-size; background: radial-gradient(ellipse at 35% 20%, #fffdf6, #e7e3d8); overflow: hidden; }
.puzzle-great-wave { --ink: #254b60; background: radial-gradient(ellipse at 35% 20%, #f5f9f9, #dae7e8); }
.puzzle-water-lilies { --ink: #425348; background: radial-gradient(ellipse at 35% 20%, #f9f7ef, #dfe6d9); }
.puzzle-box { width: 77%; max-width: 580px; border: 1px solid #fff7; border-radius: 3px; background: #fcfaf4; color: var(--ink); box-shadow: 5px 6px 0 #c6c0b0, 6px 8px 0 #a49c8d, 10px 20px 22px #172e3833; transform: rotate(-7deg); }
.puzzle-label { display: flex; justify-content: space-between; padding: 2.5% 4%; font: 650 2.3cqw/1.2 Georgia, serif; letter-spacing: .13em; }
.puzzle-label span { font-family: Arial, sans-serif; letter-spacing: .05em; }
.puzzle-surface { position: relative; margin: 0 3%; aspect-ratio: 1.36; overflow: hidden; background: var(--ink); }
.puzzle-surface img { display: block; width: 100%; height: 100%; object-fit: cover; }
.puzzle-cuts { position: absolute; inset: 0; width: 100%; height: 100%; stroke: #fff9; stroke-width: 1; filter: drop-shadow(1px 1px 0 #102033aa); }
.puzzle-caption { display: grid; gap: 2px; padding: 3% 4% 4%; font-family: Georgia, serif; }
.puzzle-caption strong { font-size: 4cqw; font-weight: 500; line-height: 1.15; }
.puzzle-caption span { font: 2.4cqw/1.5 Arial, sans-serif; letter-spacing: .04em; }
.loose-piece { position: absolute; width: 15%; right: 2%; bottom: 3%; fill: var(--ink); stroke: #fff8; stroke-width: 1; transform: rotate(18deg); filter: drop-shadow(2px 4px 2px #172e3844); }
@container (max-width: 140px) { .puzzle-label { font-size: 3cqw; }.puzzle-caption strong { font-size: 5cqw; }.puzzle-caption span { display: none; }.puzzle-box { width: 82%; box-shadow: 2px 3px 0 #bab29f, 4px 7px 6px #172e3833; } }
</style>
