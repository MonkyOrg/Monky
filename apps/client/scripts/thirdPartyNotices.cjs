'use strict';

// @ts-check
const fs = require('node:fs');
const path = require('node:path');

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice|patents|authors)(?:[-_.].*)?$/i;
const RULE = '='.repeat(80);

/**
 * Package directory of a bundled module, or null for first-party and virtual modules.
 * @param {string} id Rollup module id, possibly with a query or a virtual-module prefix.
 * @returns {string | null}
 */
function packageRootOf(id) {
  const file = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const marker = '/node_modules/';
  const index = file.lastIndexOf(marker);
  if (index < 0) return null;
  const segments = file.slice(index + marker.length).split('/');
  const nameLength = segments[0].startsWith('@') ? 2 : 1;
  if (segments.length <= nameLength) return null;
  return file.slice(0, index + marker.length) + segments.slice(0, nameLength).join('/');
}

/** @param {unknown} manifest */
function licenseOf(manifest) {
  if (typeof manifest !== 'object' || manifest === null) return 'UNKNOWN';
  const { license, licenses } = /** @type {{ license?: unknown, licenses?: unknown }} */ (manifest);
  if (typeof license === 'string') return license;
  if (typeof license === 'object' && license !== null && 'type' in license && typeof license.type === 'string') return license.type;
  if (Array.isArray(licenses)) {
    const types = licenses.flatMap(entry => typeof entry?.type === 'string' ? [entry.type] : []);
    if (types.length) return types.join(' OR ');
  }
  return 'UNKNOWN';
}

/**
 * Name, version, license and notice texts of an installed package.
 * @param {string} root
 */
function readPackageNotice(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && NOTICE_FILE.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .map(name => ({ name, text: fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n?/g, '\n').trim() }));
  return {
    name: typeof manifest.name === 'string' ? manifest.name : path.basename(root),
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    license: licenseOf(manifest),
    files,
  };
}

/**
 * Renders the notices of every package that contributed a module to the bundle,
 * or an empty string when the bundle holds no third-party code.
 * @param {Iterable<string>} moduleIds
 */
function renderNotices(moduleIds) {
  const roots = new Set();
  for (const id of moduleIds) {
    const root = packageRootOf(id);
    if (root) roots.add(root);
  }
  if (!roots.size) return '';
  const notices = new Map();
  for (const root of roots) {
    const notice = readPackageNotice(root);
    notices.set(`${notice.name}@${notice.version}`, notice);
  }
  const sorted = [...notices.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
  const sections = sorted.map(notice => [
    RULE,
    `${notice.name} ${notice.version}`,
    `License: ${notice.license}`,
    RULE,
    ...(notice.files.length
      ? notice.files.flatMap(file => ['', `--- ${file.name} ---`, '', file.text])
      : ['', `The package ships no license file; it declares the ${notice.license} license.`]),
    '',
  ].join('\n'));
  return [
    'Third-party software in the Monky interface',
    '',
    'The Monky interface (dist) bundles the open-source packages listed below.',
    'Each one is distributed under its own license, reproduced here.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Writes the licenses of the npm packages bundled into the renderer.
 *
 * Those packages are devDependencies, so electron-builder does not copy them —
 * nor their license files — into the application; this file carries the notices
 * their licenses require. Workers are separate Rollup builds, so their modules
 * are collected by `workerPlugins` and joined with the page's before writing.
 * CSS `@import`s (the fonts) are not modules: Vite reports them as watch files.
 * @param {{ fileName?: string }} [options]
 */
function thirdPartyNotices({ fileName = 'THIRD_PARTY_NOTICES.txt' } = {}) {
  /** @type {Set<string>} */
  const moduleIds = new Set();
  let root = process.cwd();
  /** @param {{ root: string }} config */
  const configResolved = config => {
    root = config.root;
  };
  /** @param {{ getModuleIds(): IterableIterator<string>, getWatchFiles(): string[] }} context */
  const collect = context => {
    for (const id of context.getModuleIds()) moduleIds.add(id);
    // Assets emitted from CSS and `?url` imports are watched relative to the Vite root.
    for (const id of context.getWatchFiles()) moduleIds.add(id.startsWith('\0') ? id : path.resolve(root, id));
  };
  const collector = {
    name: 'monky-third-party-notices-worker',
    apply: /** @type {const} */ ('build'),
    configResolved,
    /** @this {{ getModuleIds(): IterableIterator<string>, getWatchFiles(): string[] }} */
    buildEnd() {
      collect(this);
    },
  };
  return {
    workerPlugins: () => [collector],
    plugin: {
      name: 'monky-third-party-notices',
      apply: /** @type {const} */ ('build'),
      configResolved,
      /** @this {{ getModuleIds(): IterableIterator<string>, getWatchFiles(): string[], emitFile(file: { type: 'asset', fileName: string, source: string }): string }} */
      generateBundle() {
        collect(this);
        const source = renderNotices(moduleIds);
        if (source) this.emitFile({ type: 'asset', fileName, source });
      },
    },
  };
}

module.exports = { packageRootOf, readPackageNotice, renderNotices, thirdPartyNotices };
