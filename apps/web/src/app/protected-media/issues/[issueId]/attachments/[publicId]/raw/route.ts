import { serverRuntimeEnv } from '@/utils/runtimeEnv';

// A file of a private request (an issue of a participant-only project). It has a
// fixed shape for the reason the document asset route does: it forwards the session
// cookie, so an arbitrary upstream path would turn the web app into an authenticated
// API proxy. The API answers only a viewer who is in the request.
const ISSUE_ID = /^[1-9]\d*$/;
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'x-content-type-options',
  'content-security-policy',
];

type RouteParams = { issueId: string; publicId: string };

export async function GET(request: Request, { params }: { params: Promise<RouteParams> }) {
  const { issueId, publicId } = await params;
  if (!ISSUE_ID.test(issueId) || !PUBLIC_ID.test(publicId)) {
    return new Response(null, { status: 404 });
  }

  const cookie = request.headers.get('cookie');
  if (!cookie) return new Response(null, { status: 401 });

  const origin = process.env.SERVICE_URL_API || serverRuntimeEnv().apiUrl;
  const { search } = new URL(request.url);
  const headers: Record<string, string> = { cookie };
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
  const upstream = await fetch(`${origin}/issues/${issueId}/attachments/${publicId}/raw${search}`, {
    headers,
    cache: 'no-store',
    redirect: 'error',
  });

  const passed = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) passed.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: passed });
}
