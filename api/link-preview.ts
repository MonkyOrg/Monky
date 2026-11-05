import { fetchLinkPreview } from '../apps/client/src/main/linkPreview';

/**
 * Link previews for the web version (#858). A page cannot read other sites'
 * HTML, so this Vercel Function does what the desktop's main process does,
 * with the very same code: public hosts only (checked on the address actually
 * dialled), a small body prefix, and a short timeout.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url).searchParams.get('url');
  if (!url || url.length > 2048) return Response.json(null, { status: 400 });
  const preview = await fetchLinkPreview(url);
  return Response.json(preview, {
    headers: {
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
