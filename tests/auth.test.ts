import { describe, expect, it } from 'vitest';
import { extractPresentedToken, tokensMatch } from '../src/http/auth.js';

describe('extractPresentedToken', () => {
  it('reads a bearer token from the Authorization header', () => {
    expect(extractPresentedToken({ authorization: 'Bearer abc123' })).toBe('abc123');
  });

  it('is case-insensitive on the Bearer scheme', () => {
    expect(extractPresentedToken({ authorization: 'bearer abc123' })).toBe('abc123');
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractPresentedToken({ authorization: '  Bearer   abc123  ' })).toBe('abc123');
  });

  // Supported because Claude's static_headers connector auth is in beta and the
  // header field it exposes may not be Authorization.
  it('reads x-api-key as an alternative', () => {
    expect(extractPresentedToken({ 'x-api-key': 'abc123' })).toBe('abc123');
  });

  it('prefers Authorization when both are present', () => {
    expect(
      extractPresentedToken({ authorization: 'Bearer from-auth', 'x-api-key': 'from-key' }),
    ).toBe('from-auth');
  });

  it('takes the first value when a header is repeated', () => {
    expect(extractPresentedToken({ authorization: ['Bearer first', 'Bearer second'] })).toBe(
      'first',
    );
  });

  it('returns null when nothing usable is presented', () => {
    expect(extractPresentedToken({})).toBeNull();
    expect(extractPresentedToken({ authorization: 'Basic abc' })).toBeNull();
    expect(extractPresentedToken({ authorization: 'Bearer' })).toBeNull();
    expect(extractPresentedToken({ authorization: 'Bearer   ' })).toBeNull();
    expect(extractPresentedToken({ 'x-api-key': '' })).toBeNull();
  });
});

describe('tokensMatch', () => {
  it('accepts an exact match', () => {
    expect(tokensMatch('s3cret', 's3cret')).toBe(true);
  });

  it('rejects a mismatch of the same length', () => {
    expect(tokensMatch('s3cret', 's3cr3t')).toBe(false);
  });

  // timingSafeEqual throws on length mismatch; that must not surface as an
  // exception, which would itself leak length through the error path.
  it('rejects a mismatch of different length without throwing', () => {
    expect(() => tokensMatch('short', 'much-longer-token')).not.toThrow();
    expect(tokensMatch('short', 'much-longer-token')).toBe(false);
    expect(tokensMatch('much-longer-token', 'short')).toBe(false);
  });

  it('rejects null', () => {
    expect(tokensMatch(null, 's3cret')).toBe(false);
  });

  // A misconfigured server with an empty expected token must not accept every
  // caller. Belt-and-braces with the fail-closed startup check.
  it('never authenticates against an empty expected token', () => {
    expect(tokensMatch('', '')).toBe(false);
    expect(tokensMatch('anything', '')).toBe(false);
    expect(tokensMatch('', 'expected')).toBe(false);
  });

  it('handles multibyte characters without throwing', () => {
    expect(() => tokensMatch('café', 'café')).not.toThrow();
    expect(tokensMatch('café', 'café')).toBe(true);
    expect(tokensMatch('café', 'cafe')).toBe(false);
  });
});
