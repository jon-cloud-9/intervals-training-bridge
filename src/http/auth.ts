/**
 * Bearer-token gate for the public HTTP endpoint.
 *
 * The bridge writes to a calendar that syncs to a physical watch, so once the
 * endpoint is reachable from the public internet this token is the only thing
 * between an anonymous caller and `push_workout` / `delete_workout`. The
 * `dryRun: true` default is a backstop against mistakes, not against someone
 * who simply passes `dryRun: false`.
 *
 * Deliberately NOT an OAuth resource server: the 401 raised here is bare.
 * Adding `WWW-Authenticate: Bearer resource_metadata=...` is precisely what
 * tells Claude to begin OAuth discovery, and we run no authorization server —
 * advertising it would turn a wrong-credential error into a confusing OAuth
 * failure.
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getLogger } from '../logger.js';

const log = getLogger('http.auth');

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Pull the presented credential out of a request's headers.
 *
 * Accepts `Authorization: Bearer <token>` first, falling back to `X-API-Key`.
 * Both are supported because Claude's `static_headers` connector auth is in
 * beta, and the header field its UI exposes may not be `Authorization`.
 */
export function extractPresentedToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const authorization = headerValue(headers['authorization']);
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S.*)$/i.exec(authorization.trim());
    const token = match?.[1]?.trim();
    return token !== undefined && token.length > 0 ? token : null;
  }

  const apiKey = headerValue(headers['x-api-key'])?.trim();
  return apiKey !== undefined && apiKey.length > 0 ? apiKey : null;
}

/**
 * Constant-time credential comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which would leak
 * length through the error path, so the length case is handled explicitly — and
 * still burns an equivalent comparison so the reject path costs about the same.
 *
 * An empty `expected` never authenticates: a misconfigured server must not
 * accept every caller. This duplicates the fail-closed startup check on
 * purpose, since the cost is one comparison and the failure mode is total.
 */
export function tokensMatch(presented: string | null, expected: string): boolean {
  if (presented === null || presented.length === 0 || expected.length === 0) {
    return false;
  }

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Express middleware rejecting any request that does not present the token. */
export function createAuthMiddleware(expectedToken: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const presented = extractPresentedToken(req.headers);

    if (tokensMatch(presented, expectedToken)) {
      next();
      return;
    }

    // Log only whether a credential was supplied — never its value.
    // originalUrl, not path: inside a mounted middleware `req.path` is relative
    // to the mount point and logs as "/", which is useless for an audit trail.
    log.warn('rejected unauthenticated request', {
      path: req.originalUrl,
      credentialSupplied: presented !== null,
    });

    // Bare 401: no WWW-Authenticate, or Claude starts an OAuth flow we cannot serve.
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  };
}
