// Embeds the published GitHub releases in the web build (#858): the site
// shows "what's new" from the releases that existed when it was built, the
// same notes the desktop app downloads at runtime.
const MODULE_ID = 'virtual:monky-releases';
const RESOLVED_ID = `\0${MODULE_ID}`;
const REPOSITORY = 'MonkyOrg/Monky';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

async function fetchReleases() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Monky-Web-Build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const releases = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=${PAGE_SIZE}&page=${page}`,
      { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error('Unexpected GitHub release response');
    for (const release of list) {
      if (!release || typeof release !== 'object' || release.draft === true || typeof release.tag_name !== 'string') continue;
      releases.push({
        tag_name: release.tag_name,
        body: typeof release.body === 'string' ? release.body : '',
        draft: false,
        published_at: typeof release.published_at === 'string' ? release.published_at : null,
      });
    }
    if (list.length < PAGE_SIZE) break;
  }
  return releases;
}

/**
 * A published build must carry the notes (`MONKY_REQUIRE_RELEASES=1`, set by
 * the deploy workflow); a local build without network embeds none and the
 * changelog says it could not load them.
 */
export function embeddedReleasesPlugin({ embed = true } = {}) {
  let releases = null;
  return {
    name: 'monky-embedded-releases',
    resolveId(id) {
      return id === MODULE_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      // The desktop build never reaches the web bridge that imports this; it only has to resolve.
      if (!embed) return 'export default [];';
      if (!releases) {
        try {
          releases = await fetchReleases();
        } catch (error) {
          if (process.env.MONKY_REQUIRE_RELEASES === '1') throw error;
          this.warn(`Release notes were not embedded: ${error instanceof Error ? error.message : String(error)}`);
          releases = [];
        }
      }
      return `export default ${JSON.stringify(releases)};`;
    },
  };
}
