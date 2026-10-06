<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import DefaultTheme from 'vitepress/theme';
import { useData, useRoute } from 'vitepress';
import { SERVER_INVITE_FRAGMENT_PREFIX } from '../../../packages/shared/src/serverInvites';
import ServerInvite from './components/ServerInvite.vue';

const DefaultLayout = DefaultTheme.Layout;
const { frontmatter, lang } = useData();
const route = useRoute();
const hash = ref('');
const invitation = computed(() => frontmatter.value.layout === 'home'
  && hash.value.startsWith(`#${SERVER_INVITE_FRAGMENT_PREFIX}`));
const english = computed(() => lang.value.startsWith('en'));
const updateHash = () => { hash.value = typeof window === 'undefined' ? '' : window.location.hash; };

watch(() => route.path, updateHash);
onMounted(() => {
  updateHash();
  window.addEventListener('hashchange', updateHash);
});
onBeforeUnmount(() => window.removeEventListener('hashchange', updateHash));
</script>

<template>
  <main v-if="invitation" class="invite-landing">
    <h1>{{ english ? 'Monky invitation' : 'Convite para o Monky' }}</h1>
    <ServerInvite :lang="english ? 'en' : 'pt-BR'" />
  </main>
  <DefaultLayout v-else />
</template>

<style scoped>
.invite-landing {
  max-width: 800px;
  min-height: 100vh;
  margin: 0 auto;
  padding: 32px 24px;
}
.invite-landing h1 {
  margin-bottom: 24px;
  font-size: 28px;
  line-height: 1.3;
  font-weight: 700;
}
</style>
