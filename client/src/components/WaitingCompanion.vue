<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const animals = ['cat', 'dog', 'bird'] as const;
const animal = animals[Math.floor(Math.random() * animals.length)]!;
const id = `companion-${useId()}`;
const fur = animal === 'dog'
  ? { light: '#ffdfad', mid: '#dca472', dark: '#98613e' }
  : animal === 'bird'
    ? { light: '#c9fcff', mid: '#69cbdc', dark: '#257990' }
    : { light: '#fff0cf', mid: '#ffc384', dark: '#cf794c' };
const fill = (name: string) => `url(#${id}-${name})`;
const paused = ref(false);
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = ref(motionPreference.matches);
const updateMotion = () => { reducedMotion.value = motionPreference.matches; };
motionPreference.addEventListener('change', updateMotion);
onBeforeUnmount(() => motionPreference.removeEventListener('change', updateMotion));
</script>

<template>
  <p class="companion-note">{{ t('gift.companionWait') }}</p>
  <Teleport to="body">
    <div class="companion-stage" :class="`companion-${animal}`" :data-paused="paused || reducedMotion"
      :data-animal="animal" data-testid="waiting-companion">
      <div class="companion-runner" aria-hidden="true">
        <div class="companion-facing">
          <!-- Original vector artwork: soft highlights and shaded volumes give the little runner a clay-toy look. -->
          <svg viewBox="0 0 220 180" class="companion-art" focusable="false">
            <defs>
              <radialGradient :id="`${id}-fur`" cx="32%" cy="22%" r="82%">
                <stop :stop-color="fur.light" /><stop offset=".52" :stop-color="fur.mid" /><stop offset="1" :stop-color="fur.dark" />
              </radialGradient>
              <radialGradient :id="`${id}-cream`" cx="32%" cy="20%" r="85%">
                <stop stop-color="#fffdf3" /><stop offset=".65" stop-color="#ffebd1" /><stop offset="1" stop-color="#d7b79a" />
              </radialGradient>
              <radialGradient :id="`${id}-dark`" cx="32%" cy="18%" r="86%">
                <stop stop-color="#a57863" /><stop offset=".55" stop-color="#76503e" /><stop offset="1" stop-color="#422d29" />
              </radialGradient>
              <radialGradient :id="`${id}-eye`" cx="35%" cy="25%" r="75%">
                <stop stop-color="#555265" /><stop offset=".6" stop-color="#262838" /><stop offset="1" stop-color="#101726" />
              </radialGradient>
              <radialGradient :id="`${id}-pink`" cx="30%" cy="20%" r="90%">
                <stop stop-color="#ffd7d7" /><stop offset="1" stop-color="#cc7f8a" />
              </radialGradient>
              <radialGradient :id="`${id}-gold`" cx="30%" cy="18%" r="80%">
                <stop stop-color="#fff1ac" /><stop offset=".55" stop-color="#ffc461" /><stop offset="1" stop-color="#da8840" />
              </radialGradient>
              <radialGradient :id="`${id}-wing`" cx="30%" cy="15%" r="90%">
                <stop stop-color="#a3eeef" /><stop offset=".55" stop-color="#47abc4" /><stop offset="1" stop-color="#27637e" />
              </radialGradient>
              <radialGradient :id="`${id}-shadow`">
                <stop stop-color="#070f20" stop-opacity=".48" /><stop offset="1" stop-color="#070f20" stop-opacity="0" />
              </radialGradient>
            </defs>
            <ellipse class="companion-shadow" cx="112" cy="166" rx="75" ry="12" :fill="fill('shadow')" />
            <g class="companion-dust" fill="#b5d6ff" opacity=".65">
              <circle cx="23" cy="153" r="3" /><circle cx="10" cy="145" r="2" /><circle cx="34" cy="161" r="2" />
            </g>
            <g class="companion-bounce">
              <template v-if="animal !== 'bird'">
                <g class="companion-tail">
                  <path v-if="animal === 'cat'" d="M56 119C24 118 17 96 22 76C25 63 40 64 40 76C40 85 29 84 29 94C29 104 41 106 58 104"
                    :stroke="fur.dark" stroke-width="13" stroke-linecap="round" fill="none" />
                  <path v-else d="M57 113C38 104 31 88 36 79C41 71 48 80 48 88C48 97 55 98 65 102"
                    :fill="fill('dark')" />
                </g>
                <g class="companion-leg far-leg stride-one">
                  <path d="M79 116Q84 133 74 151L63 153" :stroke="fur.dark" stroke-width="15" stroke-linecap="round" fill="none" />
                  <ellipse cx="65" cy="152" rx="14" ry="8" :fill="fill('fur')" />
                </g>
                <g class="companion-leg far-leg stride-two">
                  <path d="M125 117Q134 133 125 152L115 155" :stroke="fur.dark" stroke-width="14" stroke-linecap="round" fill="none" />
                  <ellipse cx="118" cy="154" rx="14" ry="8" :fill="fill('fur')" />
                </g>
                <ellipse cx="94" cy="113" rx="51" ry="34" :fill="fill('fur')" />
                <ellipse cx="116" cy="122" rx="26" ry="24" :fill="fill('cream')" />
                <path d="M56 110Q59 91 85 89" stroke="#fff9e9" stroke-width="5" opacity=".38" stroke-linecap="round" fill="none" />
                <g class="companion-leg stride-two">
                  <path d="M64 120Q55 140 70 153" :stroke="fur.mid" stroke-width="19" stroke-linecap="round" fill="none" />
                  <ellipse cx="75" cy="153" rx="17" ry="10" :fill="fill('cream')" />
                  <path d="M78 153v4m5-5v4" stroke="#c49877" opacity=".65" stroke-width="1.4" stroke-linecap="round" />
                </g>
                <g class="companion-leg stride-one">
                  <path d="M130 116Q121 139 137 153" :stroke="fur.mid" stroke-width="18" stroke-linecap="round" fill="none" />
                  <ellipse cx="141" cy="153" rx="17" ry="10" :fill="fill('cream')" />
                  <path d="M145 153v4m5-5v4" stroke="#c49877" opacity=".65" stroke-width="1.4" stroke-linecap="round" />
                </g>
                <g class="companion-head">
                  <path v-if="animal === 'cat'" d="M151 46Q168 9 177 23L188 61" :fill="fill('fur')" />
                  <path v-else d="M159 47C183 32 196 48 192 73C190 86 178 90 174 75Z" :fill="fill('dark')" />
                  <ellipse cx="148" cy="77" rx="43" ry="40" :fill="fill('fur')" />
                  <template v-if="animal === 'cat'">
                    <path d="M111 64Q99 15 111 18Q133 24 139 44Z" :fill="fill('fur')" />
                    <path d="M114 50L110 29Q122 33 128 43Z" :fill="fill('pink')" />
                    <path d="M164 42L173 28L177 49Z" :fill="fill('pink')" />
                    <path d="m142 42 2 10m9-12 1 11" :stroke="fur.dark" stroke-width="4" opacity=".4" stroke-linecap="round" />
                  </template>
                  <path v-else class="companion-ear" d="M119 42C99 35 90 50 95 77C97 92 110 95 116 81C123 66 130 49 119 42Z" :fill="fill('dark')" />
                  <ellipse cx="158" cy="97" rx="27" ry="18" :fill="fill('cream')" />
                  <g class="companion-eyes">
                    <ellipse cx="140" cy="77" rx="6.8" ry="9" :fill="fill('eye')" />
                    <ellipse cx="174" cy="75" rx="5.7" ry="8" :fill="fill('eye')" />
                    <circle cx="138" cy="74" r="2.5" fill="white" /><circle cx="172" cy="72" r="2.1" fill="white" />
                    <circle cx="142" cy="80" r="1.1" fill="#d5eaff" /><circle cx="176" cy="78" r=".9" fill="#d5eaff" />
                  </g>
                  <ellipse cx="128" cy="92" rx="7" ry="3.5" fill="#e8968d" opacity=".45" />
                  <path d="M157 90Q165 86 170 90Q173 94 165 99Q157 96 157 90" :fill="animal === 'cat' ? fill('pink') : fill('eye')" />
                  <path d="M165 99v3q-6 7-12 0m12 0q5 5 9-1" stroke="#986653" stroke-width="1.7" fill="none" stroke-linecap="round" />
                  <path v-if="animal === 'dog'" d="M158 105Q163 113 168 104L168 112Q161 123 157 112Z" :fill="fill('pink')" />
                  <path v-if="animal === 'cat'" d="m131 99-18-2m18 7-15 4m62-9 16-4m-16 9 15 3" stroke="#9f6e54" stroke-width="1.4" stroke-linecap="round" opacity=".65" />
                </g>
                <path d="M119 111Q137 122 153 111" stroke="#64cfd3" stroke-width="7" fill="none" stroke-linecap="round" />
                <circle cx="143" cy="119" r="5" :fill="fill('gold')" />
              </template>
              <template v-else>
                <path class="companion-tail" d="M72 105C37 116 27 100 31 94Q46 99 58 96C31 87 35 73 42 75L79 92Z" :fill="fill('wing')" />
                <g class="companion-leg stride-one">
                  <path d="m99 130-3 23 15 4m-15-4-9 5" stroke="#e5a052" stroke-width="6" fill="none" stroke-linecap="round" />
                </g>
                <g class="companion-leg stride-two">
                  <path d="m126 129 2 23 16 4m-16-4-8 6" stroke="#ffc36d" stroke-width="6" fill="none" stroke-linecap="round" />
                </g>
                <ellipse cx="107" cy="108" rx="42" ry="37" :fill="fill('fur')" />
                <ellipse cx="124" cy="116" rx="25" ry="27" :fill="fill('cream')" />
                <g class="companion-head">
                  <path d="M133 35Q118 8 131 14L144 29Q141 6 152 13L156 36Z" :fill="fill('wing')" />
                  <ellipse cx="144" cy="66" rx="36" ry="34" :fill="fill('fur')" />
                  <path d="M172 65Q186 58 199 72Q187 81 174 80Z" :fill="fill('gold')" />
                  <path d="m178 74 14-1" stroke="#c98547" stroke-width="1.5" fill="none" />
                  <g class="companion-eyes">
                    <ellipse cx="151" cy="64" rx="7.5" ry="10" :fill="fill('eye')" />
                    <circle cx="149" cy="61" r="3" fill="white" /><circle cx="154" cy="67" r="1.3" fill="#d7f7ff" />
                  </g>
                  <ellipse cx="144" cy="82" rx="9" ry="4.5" fill="#f7b4a6" opacity=".65" />
                  <path d="M123 50Q128 40 140 40" stroke="#ecffff" stroke-width="4" opacity=".55" fill="none" stroke-linecap="round" />
                </g>
                <g class="companion-wing">
                  <path d="M101 91C76 79 60 93 68 111C75 127 100 126 113 109Q116 99 101 91" :fill="fill('wing')" />
                  <path d="M75 102q8 12 22 12m-18-18q9 9 20 10" stroke="#b4f5f2" stroke-width="2" opacity=".5" fill="none" stroke-linecap="round" />
                </g>
              </template>
            </g>
          </svg>
        </div>
      </div>
      <button v-if="!reducedMotion" class="companion-toggle" type="button" @click="paused = !paused">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path v-if="paused" d="m7 4 9 6-9 6Z" fill="currentColor" /><path v-else d="M6 4v12M14 4v12" stroke="currentColor" stroke-width="3" stroke-linecap="round" /></svg>
        {{ t(paused ? 'gift.companionPlay' : 'gift.companionPause') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.companion-note { font-style: italic; }
.companion-stage {
  --pet-size: clamp(145px, 16vw, 205px);
  --trip: 13s;
  position: fixed; inset: 0; z-index: 40; pointer-events: none; overflow: hidden;
}
.companion-runner {
  position: absolute; left: 0; bottom: max(64px, calc(env(safe-area-inset-bottom) + 48px));
  width: var(--pet-size); transform: translate3d(16px, 0, 0);
  animation: companion-trip var(--trip) ease-in-out infinite; will-change: transform;
}
.companion-facing { animation: companion-turn var(--trip) linear infinite; }
.companion-art { display: block; width: 100%; height: auto; overflow: visible; }
.companion-bounce { animation: companion-bounce .42s ease-in-out infinite; }
.companion-leg { transform-box: fill-box; transform-origin: center top; animation: companion-stride .42s ease-in-out infinite alternate; }
.stride-two { animation-delay: -.42s; }
.far-leg { opacity: .85; }
.companion-head { transform-box: fill-box; transform-origin: center bottom; animation: companion-nod .84s ease-in-out infinite; }
.companion-tail { transform-box: fill-box; transform-origin: right bottom; animation: companion-tail .42s ease-in-out infinite alternate; }
.companion-ear { transform-box: fill-box; transform-origin: center top; animation: companion-stride .42s ease-in-out infinite alternate; }
.companion-eyes { transform-box: fill-box; transform-origin: center; animation: companion-blink 4.6s infinite; }
.companion-shadow { transform-box: fill-box; transform-origin: center; animation: companion-shadow .42s ease-in-out infinite; }
.companion-wing { transform-box: fill-box; transform-origin: right center; animation: companion-flap .32s ease-in-out infinite alternate; }
.companion-dust { animation: companion-dust .84s ease-out infinite; }
.companion-bird { --trip: 11s; }
.companion-bird .companion-bounce { animation-duration: .32s; }
.companion-bird .companion-leg { animation-duration: .32s; }
.companion-bird .stride-two { animation-delay: -.32s; }
.companion-toggle {
  pointer-events: auto; position: absolute; right: max(16px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom)); display: flex; align-items: center; gap: 7px;
  min-height: 38px; padding: 8px 13px; border: 1px solid #526881; border-radius: 24px;
  background: #152235f5; color: #e1ecfb; box-shadow: 0 4px 18px #0002; font: inherit; font-size: 12px;
}
.companion-toggle svg { width: 16px; height: 16px; }
.companion-toggle:hover { background: #263b58; }
.companion-toggle:focus-visible { outline: 2px solid #b8dcff; outline-offset: 3px; }
.companion-stage[data-paused="true"] .companion-runner,
.companion-stage[data-paused="true"] .companion-runner * { animation-play-state: paused; }
@keyframes companion-trip {
  0%, 100% { transform: translate3d(16px, 0, 0); }
  48%, 52% { transform: translate3d(calc(100vw - var(--pet-size) - 16px), 0, 0); }
}
@keyframes companion-turn {
  0%, 47%, 100% { transform: perspective(500px) rotateY(0deg); }
  52%, 97% { transform: perspective(500px) rotateY(180deg); }
}
@keyframes companion-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
@keyframes companion-stride { from { transform: rotate(-20deg); } to { transform: rotate(20deg); } }
@keyframes companion-nod { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg); } }
@keyframes companion-tail { from { transform: rotate(-10deg); } to { transform: rotate(14deg); } }
@keyframes companion-flap { from { transform: rotate(-12deg) scaleY(.9); } to { transform: rotate(23deg) scaleY(1.05); } }
@keyframes companion-blink { 0%, 43%, 47%, 100% { transform: scaleY(1); } 45% { transform: scaleY(.08); } }
@keyframes companion-shadow { 0%, 100% { transform: scaleX(1); opacity: .8; } 50% { transform: scaleX(.83); opacity: .45; } }
@keyframes companion-dust { from { transform: translateX(5px); opacity: 0; } 25% { opacity: .5; } to { transform: translateX(-9px); opacity: 0; } }
@media (max-width: 600px) {
  .companion-stage { --pet-size: 145px; --trip: 7s; }
  .companion-toggle { font-size: 11px; }
}
@media (prefers-reduced-motion: reduce) {
  .companion-runner { transform: translate3d(16px, 0, 0); }
  .companion-dust { display: none; }
}
</style>
