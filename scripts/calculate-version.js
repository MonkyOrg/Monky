import { execSync } from 'child_process';
import fs from 'fs';

/**
 * Conventional-commit types we recognise. Anything else falls back to a patch,
 * which is what an untyped commit has always meant here.
 */
const COMMIT_TYPES = 'feat|feature|minor|fix|bugfix|perf|refactor|style|docs|chore|test|build|ci|revert|major';

/**
 * A single commit listed inside a squash message, as GitHub writes them:
 * `* fix: subject`. This is what lets one squashed PR still be counted as the
 * several commits it actually carried (#465).
 */
const SQUASH_ENTRY = new RegExp(`^\\s*[*-]\\s+(${COMMIT_TYPES})(?:(?:\\([^)]*\\))?!?|!\\([^)]*\\)):`, 'i');

/**
 * Splits one commit message into the commits it describes.
 *
 * Merging with squash collapses a whole PR into a single commit, but GitHub
 * keeps every original commit in the body as a bullet list. Reading only the
 * subject line meant a PR carrying three fixes moved the version by one patch
 * instead of three (#465).
 *
 * When those bullets are present the subject is *skipped*: it summarises the
 * same work the bullets already describe, so counting both would bump twice for
 * the same change. A message without bullets is a single commit, subject and
 * all.
 */
export function splitCommitEntries(message) {
  const text = String(message || '').trim();
  if (!text) return [];

  const lines = text.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (SQUASH_ENTRY.test(lines[i])) starts.push(i);
  }

  if (starts.length === 0) return [text];

  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    return lines.slice(start, end).join('\n').trim();
  });
}

/**
 * Classifies a single commit as 'major', 'minor' or 'patch'.
 */
export function bumpTypeForEntry(entry) {
  const text = String(entry || '').trim();
  if (!text) return 'patch';

  const header = text.split('\n')[0].replace(/^\s*[*-]\s+/, '').trim();

  if (
    /BREAKING[ -]CHANGE:/i.test(text) ||
    /^[a-zA-Z0-9_-]+(?:(?:\([^)]*\))?!|!\([^)]*\)):/.test(header) ||
    /^major(\([^)]*\))?:/i.test(header)
  ) {
    return 'major';
  }

  if (/^(feat|feature|minor)(\([^)]*\))?:/i.test(header)) return 'minor';

  return 'patch';
}

/**
 * Reads every commit described by the given messages and returns one bump per
 * commit, in the order they are given.
 *
 * Order matters, because the bumps are applied in sequence: a fix followed by a
 * feature lands on 1.1.0, while a feature followed by a fix lands on 1.1.1.
 * Callers must therefore pass commits oldest-first.
 */
export function collectBumps(commitMessages = []) {
  const bumps = [];
  for (const message of commitMessages) {
    if (!message || typeof message !== 'string') continue;
    for (const entry of splitCommitEntries(message)) {
      bumps.push(bumpTypeForEntry(entry));
    }
  }
  return bumps;
}

/**
 * Parses commit messages in the given range and determines the single highest
 * bump they carry: 'major', 'minor' or 'patch'.
 *
 * Kept for the release summary and for callers that only want to know how big
 * the change is. The version itself is calculated by applying *every* commit
 * (see `applyBumps`), which is not the same thing: three fixes are three
 * patches, not one.
 *
 * Rules:
 * - major: BREAKING CHANGE, BREAKING-CHANGE, commit type ending with '!' (e.g. feat!:, fix!:, refactor!:), or major: / major(...)
 * - minor: feat: / feat(...) / feature: / feature(...) / minor: / minor(...)
 * - patch: fix: / fix(...) / bugfix: / perf: / refactor: / style: / docs: / chore: / test: or default
 */
export function determineBumpType(commitMessages = []) {
  const bumps = collectBumps(commitMessages);
  if (bumps.includes('major')) return 'major';
  if (bumps.includes('minor')) return 'minor';
  return 'patch';
}

/**
 * Increments a semver string (e.g. "1.0.55" or "v1.0.55") by bumpType.
 *
 * A prerelease marker is dropped before bumping, so `1.8.0-beta` plus a patch
 * yields `1.8.1` rather than `1.8.0`. That is deliberate (#378): every beta is
 * a release people actually run, so each one gets its own number
 * describing what it carries, instead of the whole beta line sharing a single
 * target version that never moved no matter how much shipped.
 */
export function bumpVersion(currentVersion, bumpType = 'patch') {
  const parsed = parseVersionTag(currentVersion);
  let major = parsed ? parsed.major : 1;
  let minor = parsed ? parsed.minor : 0;
  let patch = parsed ? parsed.patch : 0;

  if (bumpType === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bumpType === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

/**
 * Applies a whole list of bumps in sequence, so a release carries the number
 * every commit in it earned (#465).
 *
 * Order is significant and callers pass commits oldest-first: a fix and then a
 * feature over 1.0.0 lands on 1.1.0, because the feature resets the patch it
 * had just raised. The reverse order lands on 1.1.1.
 *
 * An empty list still moves one patch: every release has to have a number of
 * its own, and a commit with no recognised type has always meant a patch here.
 */
export function applyBumps(currentVersion, bumps = []) {
  if (!bumps.length) return bumpVersion(currentVersion, 'patch');
  return bumps.reduce((version, bump) => bumpVersion(version, bump), String(currentVersion));
}

/**
 * Parses a release tag into its comparable parts, or returns null when the
 * string is not one of our release tags. Betas are tagged `-beta`, but the
 * numbered forms already published — `-betaNNN` and the legacy `-beta.N` — have
 * to keep parsing, otherwise the next release would ignore them when looking
 * for where to count from (#338).
 *
 * `prerelease` is what tells a beta from a stable release; `beta` only carries
 * a number when the tag has one.
 */
export function parseVersionTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-beta(?:\.?(\d+))?)?$/i.exec(String(tag || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] != null,
    beta: m[5] != null ? Number(m[5]) : null,
  };
}

/**
 * Orders two release tags by SemVer precedence, where a beta ranks *below* the
 * stable release sharing its numbers (`1.8.0-beta` < `1.8.0`).
 *
 * Sorting tags by date would not do: promoting a beta creates the stable tag on
 * the very same commit, and GitHub creates lightweight tags, whose "creator
 * date" is the commit date — so both tags would tie.
 */
export function compareVersionTags(a, b) {
  const pa = parseVersionTag(a);
  const pb = parseVersionTag(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease !== pb.prerelease) return pa.prerelease ? -1 : 1;
  if (!pa.prerelease) return 0;
  // Both are betas of the same base: an unnumbered `-beta` sorts below the
  // numbered ones, matching how SemVer compares `beta` against `beta001`.
  return (pa.beta ?? 0) - (pb.beta ?? 0);
}

/**
 * Gets the highest release tag, betas included. This is the starting point for
 * the next version: each release is numbered from the one immediately before
 * it, so a fix after a beta becomes a patch above it and a feature becomes a
 * minor above it (#378).
 *
 * A `tagList` may be injected (used by tests) to avoid shelling out to git.
 */
export function getLatestReleaseTag(tagList = null) {
  let tags = tagList;
  if (!tags) {
    try {
      tags = execSync('git tag', { encoding: 'utf8' }).split('\n');
    } catch (e) {
      return null;
    }
  }
  const releases = tags.map((t) => String(t).trim()).filter((t) => parseVersionTag(t) !== null);
  if (releases.length === 0) return null;
  return releases.sort(compareVersionTags)[releases.length - 1];
}

/**
 * Gets the latest git tag matching a *stable* SemVer (e.g. v1.0.55), ignoring
 * betas. Used when promoting a beta, so the stable release notes cover
 * everything since the previous stable rather than since the last beta.
 */
export function getLatestSemverTag(tagList = null) {
  let tags = tagList;
  if (!tags) {
    try {
      tags = execSync('git tag', { encoding: 'utf8' }).split('\n');
    } catch (e) {
      return null;
    }
  }
  const stable = tags
    .map((t) => String(t).trim())
    .filter((t) => /^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(t));
  if (stable.length === 0) return null;
  return stable.sort(compareVersionTags)[stable.length - 1];
}

/**
 * Suffix that marks a beta tag, as in `v3.1.2-beta`.
 *
 * It used to carry a zero-padded counter (`-beta001`) to keep betas *of the
 * same base* in order on GitHub's releases page, which sorts by tag name and
 * listed `beta9` after `beta14` without the padding (#338). Now that every
 * release is numbered from the one immediately before it, betas included
 * (#378), no base is ever published twice — there is nothing left for the
 * counter to disambiguate, and it never moved off 1 (#382).
 *
 * Sorting by name never ordered *different* bases correctly anyway (`v1.0.10`
 * sorts below `v1.0.9`, padded or not), which is why both update clients sort
 * releases themselves instead of trusting the order they come in.
 *
 * Dropping it also hands the `beta` channel back to electron-updater, which
 * read `beta001` as a single identifier and therefore saw a *custom channel*
 * named after it rather than the `beta` one (#354).
 */
export const BETA_SUFFIX = 'beta';

/**
 * Strips the `v` prefix and the beta suffix from a beta tag, yielding the clean
 * stable version to publish when promoting (e.g. "v1.8.0-beta" -> "1.8.0").
 * The numbered forms are accepted too, so betas published before the counter
 * was dropped can still be promoted (#338).
 */
export function promoteBetaTag(betaTag) {
  return String(betaTag || '')
    .replace(/^v/, '')
    .replace(/-beta\.?\d*$/i, '')
    .trim();
}

/**
 * Gets commit messages between a tag and HEAD, oldest first.
 *
 * The order is not cosmetic: bumps are applied in sequence, so reading the log
 * newest-first would let an older fix land *after* a newer feature and add a
 * patch on top of the minor it should have been folded into (#465).
 */
export function getGitCommitsSinceTag(tag) {
  try {
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const DELIMITER = '---__COMMIT_DELIMITER__---';
    const output = execSync(`git log --reverse ${range} --pretty=format:"%B${DELIMITER}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output
      .split(DELIMITER)
      .map((c) => c.trim())
      .filter(Boolean);
  } catch (e) {
    try {
      return [execSync('git log -1 --pretty=format:"%B"', { encoding: 'utf8' }).trim()];
    } catch {
      return [];
    }
  }
}

/**
 * Main function to calculate next version.
 *
 * The starting point is the latest release tag of any kind, betas included, and
 * only the commits made since it are read. Numbering from the last *stable* tag
 * instead meant the whole beta line aimed at one version: 1.0.0 plus a feature
 * became 1.1.0-beta001, and every later beta — features and fixes alike — kept
 * that same 1.1.0, so promoting after dozens of changes still published 1.1.0
 * (#378).
 *
 * Every commit in the range moves the number, one bump each. Taking only the
 * highest type meant a release carrying three fixes moved a single patch, and a
 * squashed PR carrying three of them moved one no matter how much it held
 * (#465).
 */
export function calculateNextVersion(options = {}) {
  const channel = options.channel === 'beta' ? 'beta' : 'stable';
  const prevTag = options.prevTag || getLatestReleaseTag() || 'v1.0.55';
  const commits = options.commits || getGitCommitsSinceTag(prevTag);
  const bumps = options.bumpType ? [options.bumpType] : collectBumps(commits);
  const bumpType = options.bumpType || determineBumpType(commits);
  const baseVersion = applyBumps(prevTag, bumps);

  if (channel === 'beta') {
    const nextVersion = `${baseVersion}-${BETA_SUFFIX}`;
    return {
      prevTag,
      bumpType,
      channel,
      prerelease: true,
      baseVersion,
      nextVersion,
      nextTag: `v${nextVersion}`,
      commitsCount: commits.length,
      bumps,
    };
  }

  return {
    prevTag,
    bumpType,
    channel,
    prerelease: false,
    baseVersion,
    nextVersion: baseVersion,
    nextTag: `v${baseVersion}`,
    commitsCount: commits.length,
    bumps,
  };
}

// If executed directly from Node CLI
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('calculate-version.js') || 
  process.argv[1].endsWith('calculate-version.mjs')
);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const promoteTag = getFlag('--promote') || process.env.PROMOTE_TAG || '';
  const channelArg = (getFlag('--channel') || process.env.RELEASE_CHANNEL || 'stable').toLowerCase();

  let version, prevTag, bumpType, channel, prerelease;

  if (promoteTag) {
    // Promotion: republish a validated beta as a clean stable release.
    version = promoteBetaTag(promoteTag);
    prevTag = getLatestSemverTag() || '';
    bumpType = 'promote';
    channel = 'stable';
    prerelease = false;
    console.log(`[Version] Promote ${promoteTag} -> stable v${version} | Prev: ${prevTag || '<none>'}`);
  } else {
    const result = calculateNextVersion({ channel: channelArg === 'beta' ? 'beta' : 'stable' });
    version = result.nextVersion;
    prevTag = result.prevTag;
    bumpType = result.bumpType;
    channel = result.channel;
    prerelease = result.prerelease;
    const tally = ['major', 'minor', 'patch']
      .map((type) => `${type}=${result.bumps.filter((b) => b === type).length}`)
      .join(' ');
    console.log(
      `[Version] Previous tag: ${result.prevTag} | Bumps: ${result.bumps.length} (${tally}) | Highest: ${result.bumpType} | Channel: ${channel} | Next version: ${version}`
    );
  }

  // Write to GitHub Actions GITHUB_OUTPUT if available
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(
      githubOutput,
      `version=${version}\nprev_tag=${prevTag}\nbump_type=${bumpType}\nchannel=${channel}\nprerelease=${prerelease}\n`
    );
    console.log(
      `[Version] Written to $GITHUB_OUTPUT: version=${version} channel=${channel} prerelease=${prerelease}`
    );
  }
}
