import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import DownloadPanel from './components/DownloadPanel.vue';
import AppScreenshot from './components/AppScreenshot.vue';
import LegacyBotLinks from './components/LegacyBotLinks.vue';
import Layout from './Layout.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('DownloadPanel', DownloadPanel);
    app.component('AppScreenshot', AppScreenshot);
    app.component('LegacyBotLinks', LegacyBotLinks);
  },
} satisfies Theme;
