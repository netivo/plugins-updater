/**
 * Netivo WordPress Plugin Repository - Cloudflare Worker
 *
 * Serves the global catalog (/index.json) and individual plugin manifests (/<slug>/info.json)
 * directly from Cloudflare R2 storage, with edge caching, URL rewriting, CORS, and 304 ETag support.
 */

export interface Env {
  BUCKET: R2Bucket;
  ENVIRONMENT?: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Max-Age': '86400',
};

const DEFAULT_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 2. Only allow GET and HEAD requests
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(
        { error: 'Method Not Allowed', message: `Method ${request.method} is not supported.` },
        405,
        { Allow: 'GET, HEAD, OPTIONS' }
      );
    }

    let pathname = url.pathname.replace(/\/+/g, '/');

    // 3. Health check endpoint
    if (pathname === '/health' || pathname === '/healthz') {
      return jsonResponse({
        status: 'ok',
        service: 'netivo-plugin-repository',
        timestamp: new Date().toISOString(),
      });
    }

    // 4. Resolve R2 key from URL path
    let r2Key: string;

    if (pathname === '/' || pathname === '' || pathname === '/index.json') {
      r2Key = 'index.json';
    } else if (pathname.startsWith('/schemas/')) {
      r2Key = pathname.slice(1); // e.g. schemas/repository.v1.json
    } else {
      // Normalize /<slug>/ to /<slug>/info.json
      if (pathname.endsWith('/')) {
        pathname = `${pathname}info.json`;
      } else if (!pathname.endsWith('.json')) {
        pathname = `${pathname}/info.json`;
      }
      r2Key = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    }

    // 5. If R2 bucket is bound, fetch object from R2
    if (!env.BUCKET) {
      return jsonResponse(
        {
          error: 'Configuration Error',
          message: 'Cloudflare R2 BUCKET binding is missing.',
        },
        500
      );
    }

    try {
      const ifNoneMatch = request.headers.get('if-none-match');
      const object = await env.BUCKET.get(r2Key, {
        onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch } : undefined,
      });

      if (object === null) {
        return jsonResponse(
          {
            error: 'Not Found',
            message: `The requested path '${pathname}' (R2 key '${r2Key}') was not found.`,
            catalog_url: 'https://updates.netivo.pl/index.json',
          },
          404
        );
      }

      // Check for 304 Not Modified
      if ('body' in object && object.body === null) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: object.httpEtag,
            'Cache-Control': DEFAULT_CACHE_CONTROL,
            ...CORS_HEADERS,
          },
        });
      }

      const headers = new Headers();
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/json; charset=utf-8');
      headers.set('Cache-Control', object.httpMetadata?.cacheControl || DEFAULT_CACHE_CONTROL);
      headers.set('ETag', object.httpEtag);
      headers.set('X-Content-Type-Options', 'nosniff');

      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        headers.set(k, v);
      }

      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }

      return new Response(object.body, { status: 200, headers });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return jsonResponse(
        {
          error: 'Internal Server Error',
          message: errorMessage,
        },
        500
      );
    }
  },
};
