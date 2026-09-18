<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

const props = withDefaults(defineProps<{
  src: string;
  alt: string;
  caption: string;
  width?: number;
  height?: number;
}>(), { width: 1280, height: 900 });
const { lang } = useData();
const source = computed(() => withBase(props.src));
const enlarge = computed(() => lang.value.startsWith('pt')
  ? 'Abrir captura em tamanho original (nova aba)'
  : 'Open full-size screenshot (new tab)');
</script>

<template>
  <figure class="app-screenshot">
    <a :href="source" target="_blank" rel="noopener" :aria-label="`${alt}. ${enlarge}`">
      <img :src="source" :alt="alt" :width="width" :height="height" loading="lazy" decoding="async" />
      <span class="app-screenshot-enlarge" aria-hidden="true">{{ enlarge }}</span>
    </a>
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>
