/**
 * Conventional-commit rules shared by the version calculation
 * (calculate-version.js) and the technical changelog (generate-changelog.js).
 *
 * Each script used to keep its own copy, and the copies drifted: the changelog
 * never learned the `type!(scope):` form the version already counted as a
 * breaking change (#715), so such a squash bullet leaked into the notes as raw
 * text and its subject landed in "Outros".
 */

/**
 * Conventional-commit types we recognise. In the version, anything else falls
 * back to a patch, which is what an untyped commit has always meant here.
 */
export const COMMIT_TYPES = 'feat|feature|minor|fix|bugfix|perf|refactor|style|docs|chore|test|build|ci|revert|major';

/** Types that add a feature: a minor bump, listed under "Novidades". */
export const FEATURE_TYPES = new Set(['feat', 'feature', 'minor']);

/** Types that fix a bug, listed under "Correções". */
export const FIX_TYPES = new Set(['fix', 'bugfix']);

/**
 * What may come between the type and the colon: a scope, the breaking-change
 * mark, or both, written `(scope)!` or `!(scope)` (#715).
 */
const MARKS = '(?:(?:\\([^)]*\\))?!?|!\\([^)]*\\))';

/**
 * A single commit listed inside a squash message, as GitHub writes them:
 * `* fix: subject`. This is what lets one squashed PR still be counted as the
 * several commits it actually carried (#465).
 */
export const SQUASH_ENTRY = new RegExp(`^\\s*[*-]\\s+(${COMMIT_TYPES})${MARKS}:`, 'i');

const HEADER = /^([A-Za-z0-9_-]+)(?:(?:\([^)]*\))?(!)?|(!)\([^)]*\)):/;
const KNOWN_TYPES = new Set(COMMIT_TYPES.split('|'));

/**
 * Reads the `type(scope)!:` prefix that opens a commit header.
 *
 * Any word is accepted as the type, so `wip!: x` is still a breaking change;
 * `known` tells whether it is one of COMMIT_TYPES. `type` is lower-cased and
 * `length` is how much of the header the prefix takes, colon included. Returns
 * null when the header does not start with a type.
 */
export function parseCommitHeader(header) {
  const match = HEADER.exec(String(header ?? ''));
  if (!match) return null;
  const type = match[1].toLowerCase();
  return {
    type,
    known: KNOWN_TYPES.has(type),
    breaking: match[2] !== undefined || match[3] !== undefined,
    length: match[0].length,
  };
}
