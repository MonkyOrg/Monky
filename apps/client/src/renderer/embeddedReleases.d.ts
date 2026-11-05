declare module 'virtual:monky-releases' {
  /** GitHub releases embedded in the web build (scripts/embeddedReleases.mjs). */
  const releases: ReadonlyArray<{ tag_name: string; body: string; draft: false; published_at: string | null }>;
  export default releases;
}
