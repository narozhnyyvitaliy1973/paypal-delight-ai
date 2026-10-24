<script setup lang="ts">
defineProps<{ kind: string }>();
</script>

<template>
  <svg viewBox="0 0 320 280" fill="none" aria-hidden="true" class="product-art">
    <ellipse
      cx="160"
      cy="242"
      rx="82"
      ry="12"
      fill="currentColor"
      opacity=".08"
    />
    <g v-if="kind === 'mug'">
      <path
        d="M209 102h13c46 0 46 71 1 71h-17"
        stroke="#d88464"
        stroke-width="19"
      />
      <path d="M90 85h123v117c0 25-27 37-62 37s-61-12-61-37z" fill="#e7a181" />
      <path
        d="M91 88c26 17 95 17 121 0v22c-24 17-98 17-121 0z"
        fill="#f6bea0"
      />
      <ellipse cx="151" cy="85" rx="61" ry="17" fill="#f9d0b5" />
      <ellipse cx="151" cy="85" rx="48" ry="10" fill="#754e3e" />
      <circle cx="152" cy="163" r="23" fill="#fff2d7" />
      <path
        d="M138 163c7 12 21 12 28 0M141 151v3m22-3v3"
        stroke="#be7958"
        stroke-width="3"
        stroke-linecap="round"
      />
      <path
        d="M132 61c-15-18 15-22 1-40m35 39c-14-18 15-22 1-40"
        stroke="#fff"
        stroke-width="4"
        stroke-linecap="round"
        opacity=".8"
      />
    </g>
    <g v-else-if="kind === 'tote'">
      <path
        d="M122 99V71c0-50 76-50 76 0v28"
        stroke="#4c6653"
        stroke-width="14"
      />
      <path d="m88 88 144 0 14 144c-35 14-137 14-172 0z" fill="#79917a" />
      <path
        d="M107 89v146m106-146v146"
        stroke="#a9b9a0"
        stroke-width="3"
        opacity=".65"
      />
      <rect x="116" y="135" width="89" height="65" rx="2" fill="#efeeda" />
      <path
        d="M140 173c1-24 36-25 39 0m-40 8h41"
        stroke="#66826c"
        stroke-width="5"
        stroke-linecap="round"
      />
      <circle cx="161" cy="153" r="5" fill="#d9a462" />
    </g>
    <g v-else>
      <path
        d="M83 166V112c0-100 154-100 154 0v54"
        stroke="#38344d"
        stroke-width="29"
      />
      <path
        d="M83 128v-15c0-99 154-99 154 0v15"
        stroke="#b6aed1"
        stroke-width="16"
      />
      <rect x="64" y="125" width="56" height="102" rx="27" fill="#7f759c" />
      <rect x="77" y="129" width="45" height="94" rx="22" fill="#aaa0c6" />
      <rect x="200" y="125" width="56" height="102" rx="27" fill="#7f759c" />
      <rect x="198" y="129" width="45" height="94" rx="22" fill="#aaa0c6" />
      <path
        d="M106 149v53m108-53v53"
        stroke="#d1c9e3"
        stroke-width="3"
        stroke-linecap="round"
      />
    </g>
  </svg>
</template>
