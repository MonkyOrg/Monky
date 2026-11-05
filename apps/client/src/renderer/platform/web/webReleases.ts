import type { ReleaseRequest } from '@monky/shared';

/**
 * Answers the GitHub release requests of `@monky/shared`'s release notes from
 * the releases embedded in this build (#858), so the web version reads its
 * changelog with the same rules as the desktop, without calling GitHub. The
 * list is a separate chunk, loaded the first time the changelog opens.
 */
export const embeddedReleaseRequest: ReleaseRequest = async (url) => {
  const { default: releases } = await import('virtual:monky-releases');
  const parsed = new URL(url);
  const tag = /\/releases\/tags\/([^/]+)$/.exec(parsed.pathname)?.[1];
  if (tag !== undefined) {
    const release = releases.find(entry => entry.tag_name === decodeURIComponent(tag));
    return release ? Response.json(release) : new Response(null, { status: 404 });
  }
  const size = Number(parsed.searchParams.get('per_page'));
  const page = Number(parsed.searchParams.get('page'));
  if (!Number.isInteger(size) || !Number.isInteger(page) || size < 1 || page < 1) return new Response(null, { status: 400 });
  return Response.json(releases.slice((page - 1) * size, page * size));
};
