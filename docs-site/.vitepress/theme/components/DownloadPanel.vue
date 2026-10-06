<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { data } from '../../../download.data';
import type { ReleaseAsset, ReleaseInfo } from '../../../download.data';

const props = defineProps<{ lang?: string }>();
const isEn = computed(() => props.lang === 'en');

type OsKey = 'windows' | 'mac' | 'linux';

const t = computed(() =>
  isEn.value
    ? {
        stable: 'Stable',
        beta: 'Beta',
        stableHint: 'Recommended for everyone.',
        betaHint: 'Ships earlier, may still have rough edges.',
        version: 'Version',
        released: 'released on',
        windows: 'Windows 10/11 (64-bit)',
        mac: 'macOS',
        installer: 'Installer',
        installerHint: 'Lets you pick the folder and creates shortcuts.',
        portable: 'Portable',
        portableHint: 'Installs nothing — just run the file.',
        appleSilicon: 'Apple Silicon',
        appleSiliconHint: 'M1, M2, M3 and newer.',
        intel: 'Intel',
        intelHint: 'Macs with an Intel processor.',
        recommended: 'Detected on your system',
        linuxTitle: 'On Linux?',
        linuxBody:
          'There is no desktop build for Linux yet, but the server runs there through the CLI below.',
        cliTitle: 'Server CLI',
        cliBody:
          'Host a server on a VPS or on a machine with no desktop app. Requires Node.js 22 or newer.',
        cliManual: 'Without the install script, or on Windows',
        copy: 'Copy',
        copied: 'Copied!',
        allFiles: 'See every file in this release',
        unavailableTitle: 'Download links unavailable',
        unavailableBody:
          'This page could not read the releases while it was built. Grab the files straight from GitHub:',
        openReleases: 'Open releases on GitHub',
      }
    : {
        stable: 'Estável',
        beta: 'Beta',
        stableHint: 'Recomendada para todo mundo.',
        betaHint: 'Sai antes, mas ainda pode ter arestas.',
        version: 'Versão',
        released: 'publicada em',
        windows: 'Windows 10/11 (64 bits)',
        mac: 'macOS',
        installer: 'Instalador',
        installerHint: 'Deixa escolher a pasta e cria atalhos.',
        portable: 'Portátil',
        portableHint: 'Não instala nada — é só executar.',
        appleSilicon: 'Apple Silicon',
        appleSiliconHint: 'M1, M2, M3 e mais novos.',
        intel: 'Intel',
        intelHint: 'Macs com processador Intel.',
        recommended: 'Detectado no seu sistema',
        linuxTitle: 'Está no Linux?',
        linuxBody:
          'Ainda não existe build do app para Linux, mas o servidor roda por lá através do CLI abaixo.',
        cliTitle: 'CLI do servidor',
        cliBody:
          'Para hospedar um servidor em uma VPS ou em uma máquina sem o app. Precisa do Node.js 22 ou mais novo.',
        cliManual: 'Sem o script de instalação, ou no Windows',
        copy: 'Copiar',
        copied: 'Copiado!',
        allFiles: 'Ver todos os arquivos desta release',
        unavailableTitle: 'Links de download indisponíveis',
        unavailableBody:
          'Esta página não conseguiu ler as releases enquanto foi gerada. Baixe direto do GitHub:',
        openReleases: 'Abrir as releases no GitHub',
      },
);

const channel = ref<'stable' | 'beta'>('stable');
const release = computed<ReleaseInfo | null>(() =>
  channel.value === 'beta' ? data.beta : data.stable,
);

const detectedOs = ref<OsKey | null>(null);

onMounted(() => {
  const ua = navigator.userAgent;
  // Android also carries "Linux" in the UA, so Windows and macOS are matched first.
  if (/Windows|Win32|Win64/i.test(ua)) detectedOs.value = 'windows';
  else if (/Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(ua)) detectedOs.value = 'mac';
  else if (/Linux|Android|X11|CrOS/i.test(ua)) detectedOs.value = 'linux';
});

// macOS architecture is not exposed outside Chromium, so both Macs are always
// offered instead of guessing and sending half the users the wrong file.
const platforms = computed(() => {
  const current = release.value;
  if (!current) return [];

  return [
    {
      key: 'windows' as OsKey,
      icon: '\u{1F5A5}\uFE0F',
      title: t.value.windows,
      options: [
        {
          asset: current.winSetup,
          label: t.value.installer,
          hint: t.value.installerHint,
          primary: true,
        },
        {
          asset: current.winPortable,
          label: t.value.portable,
          hint: t.value.portableHint,
          primary: false,
        },
      ],
    },
    {
      key: 'mac' as OsKey,
      icon: '\u{1F34E}',
      title: t.value.mac,
      options: [
        {
          asset: current.macArm64,
          label: t.value.appleSilicon,
          hint: t.value.appleSiliconHint,
          primary: true,
        },
        { asset: current.macX64, label: t.value.intel, hint: t.value.intelHint, primary: false },
      ],
    },
  ]
    .map((platform) => ({
      ...platform,
      options: platform.options.filter(
        (option): option is typeof option & { asset: ReleaseAsset } => option.asset !== null,
      ),
      detected: detectedOs.value === platform.key,
    }))
    .filter((platform) => platform.options.length > 0)
    .sort((a, b) => Number(b.detected) - Number(a.detected));
});

// The install script resolves the newest release on its own, so it never goes
// stale; the npm URL is the fallback for machines without bash.
const cliScript = computed(() =>
  channel.value === 'beta'
    ? 'curl -fsSL https://monkyorg.github.io/install.sh | bash -s -- --beta'
    : 'curl -fsSL https://monkyorg.github.io/install.sh | bash',
);

// `--allow-scripts=mediasoup` releases the postinstall that builds the SFU
// worker, which npm 12 blocks by default.
const cliNpm = computed(() =>
  release.value?.cli ? `npm install -g --allow-scripts=mediasoup ${release.value.cli.url}` : '',
);

const copied = ref('');

async function copyCommand(key: string, command: string) {
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    copied.value = key;
    setTimeout(() => {
      if (copied.value === key) copied.value = '';
    }, 2000);
  } catch {
    copied.value = '';
  }
}

function formatSize(asset: ReleaseAsset) {
  return `${(asset.size / 1024 / 1024).toFixed(1)} MB`;
}

// A fixed time zone keeps the server-rendered HTML identical to what the
// browser renders, which would otherwise break hydration.
function formatDate(iso: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(isEn.value ? 'en-US' : 'pt-BR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
</script>

<template>
  <div v-if="!data.stable" class="dl-unavailable">
    <strong>{{ t.unavailableTitle }}</strong>
    <p>{{ t.unavailableBody }}</p>
    <a class="dl-button dl-primary" :href="data.releasesUrl">{{ t.openReleases }}</a>
  </div>

  <template v-else>
    <div v-if="data.beta" class="dl-channels">
      <button
        type="button"
        :class="['dl-channel', { 'dl-active': channel === 'stable' }]"
        :aria-pressed="channel === 'stable'"
        @click="channel = 'stable'"
      >
        {{ t.stable }}
      </button>
      <button
        type="button"
        :class="['dl-channel', { 'dl-active': channel === 'beta' }]"
        :aria-pressed="channel === 'beta'"
        @click="channel = 'beta'"
      >
        {{ t.beta }}
      </button>
    </div>

    <p v-if="release" class="dl-meta">
      {{ channel === 'beta' ? t.betaHint : t.stableHint }}
      <span class="dl-version">
        {{ t.version }} <a :href="release.url">{{ release.tag }}</a>
        <template v-if="release.publishedAt">
          — {{ t.released }} {{ formatDate(release.publishedAt) }}</template
        >
      </span>
    </p>

    <div class="dl-grid">
      <section v-for="platform in platforms" :key="platform.key" class="dl-card">
        <header class="dl-card-head">
          <span class="dl-icon" aria-hidden="true">{{ platform.icon }}</span>
          <h3>{{ platform.title }}</h3>
          <span v-if="platform.detected" class="dl-badge">{{ t.recommended }}</span>
        </header>

        <a
          v-for="option in platform.options"
          :key="option.asset.name"
          class="dl-button"
          :class="option.primary ? 'dl-primary' : 'dl-secondary'"
          :href="option.asset.url"
        >
          <span class="dl-button-label">{{ option.label }}</span>
          <span class="dl-button-hint">{{ option.hint }} · {{ formatSize(option.asset) }}</span>
        </a>
      </section>
    </div>

    <div v-if="detectedOs === 'linux'" class="dl-note">
      <strong>{{ t.linuxTitle }}</strong>
      <p>{{ t.linuxBody }}</p>
    </div>

    <section class="dl-cli">
      <h3>{{ t.cliTitle }}</h3>
      <p>{{ t.cliBody }}</p>
      <div class="dl-command">
        <code>{{ cliScript }}</code>
        <button type="button" class="dl-copy" @click="copyCommand('script', cliScript)">
          {{ copied === 'script' ? t.copied : t.copy }}
        </button>
      </div>

      <details v-if="cliNpm" class="dl-manual">
        <summary>{{ t.cliManual }}</summary>
        <div class="dl-command">
          <code>{{ cliNpm }}</code>
          <button type="button" class="dl-copy" @click="copyCommand('npm', cliNpm)">
            {{ copied === 'npm' ? t.copied : t.copy }}
          </button>
        </div>
      </details>
    </section>

    <p class="dl-links">
      <a :href="release?.url || data.releasesUrl">{{ t.allFiles }}</a>
    </p>
  </template>
</template>

<style scoped>
.dl-channels {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  margin: 24px 0 12px;
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}

.dl-channel {
  padding: 6px 18px;
  border-radius: 7px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  transition:
    color 0.2s,
    background-color 0.2s;
}

.dl-channel.dl-active {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.dl-meta {
  margin: 0 0 24px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.dl-version {
  display: block;
  margin-top: 2px;
}

.dl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
}

.dl-card {
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.dl-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.dl-card-head h3 {
  margin: 0;
  border: 0;
  padding: 0;
  font-size: 17px;
  line-height: 1.3;
}

.dl-icon {
  font-size: 20px;
}

.dl-badge {
  padding: 2px 8px;
  border-radius: 20px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.dl-button {
  display: block;
  margin-bottom: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-weight: 600;
  text-decoration: none;
  transition:
    opacity 0.2s,
    border-color 0.2s;
}

.dl-button:last-child {
  margin-bottom: 0;
}

.dl-button:hover {
  opacity: 0.88;
  text-decoration: none;
}

.dl-primary {
  background: var(--vp-c-brand-3);
  color: var(--vp-c-white);
}

.dl-secondary {
  border-color: var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

.dl-secondary:hover {
  border-color: var(--vp-c-brand-1);
}

.dl-button-label {
  display: block;
  font-size: 15px;
}

.dl-button-hint {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
  opacity: 0.85;
}

.dl-note,
.dl-unavailable {
  margin-top: 24px;
  padding: 16px 20px;
  border-radius: 10px;
  border-left: 4px solid var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}

.dl-note p,
.dl-unavailable p {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.dl-unavailable .dl-button {
  margin-top: 14px;
  max-width: 260px;
  text-align: center;
}

.dl-cli {
  margin-top: 32px;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}

.dl-cli h3 {
  margin: 0 0 6px;
  border: 0;
  padding: 0;
  font-size: 17px;
}

.dl-cli p {
  margin: 0 0 14px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.dl-command {
  display: flex;
  align-items: stretch;
  gap: 8px;
  margin-bottom: 12px;
}

.dl-command code {
  flex: 1;
  overflow-x: auto;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  white-space: nowrap;
}

.dl-copy {
  flex-shrink: 0;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--vp-c-brand-3);
  color: var(--vp-c-white);
  font-size: 13px;
  font-weight: 600;
}

.dl-copy:hover {
  opacity: 0.88;
}

.dl-manual {
  margin-bottom: 12px;
}

.dl-manual summary {
  margin-bottom: 10px;
  cursor: pointer;
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.dl-links {
  margin-top: 28px;
  font-size: 14px;
}

@media (max-width: 640px) {
  .dl-command {
    flex-direction: column;
  }

  .dl-copy {
    padding: 10px 16px;
  }
}
</style>
