<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useData, useRouter, withBase } from 'vitepress';
import routes from '../legacy-bot-routes.json';

const { lang } = useData();
const router = useRouter();
const english = computed(() => lang.value.startsWith('en'));
const links = computed(() => routes.filter(route => route.locale === (english.value ? 1 : 0)));
const destination = (route: string) => withBase(route.replace(/(#|$)/, '.html$1'));

function redirectLegacyAnchor() {
  const match = links.value.find(link => link.hash === window.location.hash.slice(1));
  if (match) void router.go(destination(match.route));
}

onMounted(() => {
  redirectLegacyAnchor();
  window.addEventListener('hashchange', redirectLegacyAnchor);
});
onBeforeUnmount(() => window.removeEventListener('hashchange', redirectLegacyAnchor));
</script>

<template>
  <details class="legacy-bot-links">
    <summary>{{ english ? 'Links from previous documentation versions' : 'Links de versões anteriores da documentação' }}</summary>
    <p>{{ english ? 'The developer sections now have their own pages:' : 'As seções de desenvolvimento agora têm páginas próprias:' }}</p>
    <ul>
      <li v-for="link in links" :key="link.hash">
        <a :id="link.hash" :href="destination(link.route)">{{ link.title }}</a>
      </li>
    </ul>
  </details>
</template>
