<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

interface FaqNoticeContent {
  title: string;
  details: string;
  link: string;
  linkText: string;
  hookLink: string;
  hookText: string;
}

const { frontmatter } = useData();
const notice = computed(() => frontmatter.value.faqNotice as FaqNoticeContent | undefined);

/** Mesmo formato dos links do tema (`cleanUrls` desligado): `/faq#x` vira `/Monky/faq.html#x`. */
function pageHref(link: string): string {
  const [path, hash] = link.split('#');
  const page = path.endsWith('/') || /\.\w+$/.test(path) ? path : `${path}.html`;
  return withBase(page) + (hash ? `#${hash}` : '');
}
</script>

<template>
  <section v-if="notice" class="FaqNotice" aria-labelledby="faq-notice-title">
    <div class="container">
      <div class="card">
        <div class="text">
          <h2 id="faq-notice-title" class="title">{{ notice.title }}</h2>
          <p class="details">{{ notice.details }}</p>
        </div>
        <div class="links">
          <a class="link" :href="pageHref(notice.link)">
            {{ notice.linkText }}<span class="vpi-arrow-right link-icon" aria-hidden="true" />
          </a>
          <a class="hook" :href="pageHref(notice.hookLink)">{{ notice.hookText }}</a>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Mesmas medidas do VPFeatures: o card fica alinhado à grade dos cards acima. */
.FaqNotice {
  padding: 16px 24px 0;
}

@media (min-width: 640px) {
  .FaqNotice { padding: 16px 48px 0; }
}

@media (min-width: 960px) {
  .FaqNotice { padding: 16px 64px 0; }
}

.container {
  margin: 0 auto;
  max-width: 1152px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  border: 1px solid var(--vp-c-bg-soft);
  border-radius: 12px;
  background-color: var(--vp-c-bg-soft);
}

@media (min-width: 768px) {
  .card {
    flex-direction: row;
    align-items: center;
    gap: 32px;
  }
  .text { flex: 1; }
  .links { flex-shrink: 0; align-items: flex-end; }
}

.title {
  margin: 0;
  line-height: 24px;
  font-size: 16px;
  font-weight: 600;
}

.details {
  margin: 0;
  padding-top: 8px;
  line-height: 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}

.links {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.link,
.hook {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
  line-height: 24px;
  border-radius: 4px;
}

.link {
  color: var(--vp-c-brand-1);
}

.hook {
  color: var(--vp-c-text-2);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.link:hover,
.hook:hover {
  color: var(--vp-c-brand-2);
}

.link:focus-visible,
.hook:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}

.link-icon {
  margin-left: 6px;
}
</style>
