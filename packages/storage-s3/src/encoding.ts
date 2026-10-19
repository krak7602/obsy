/**
 * Percent-encodes one URI component the way SigV4 canonical requests need:
 * every byte except the unreserved characters `A-Z a-z 0-9 - . _ ~`.
 * `encodeURIComponent` leaves `! ' ( ) *` alone, so encode them as well.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes an object key for a URL path. Each segment is encoded; `/` stays. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

/**
 * Builds a query string with every name and value encoded per RFC 3986, so
 * that the string on the wire equals the SigV4 canonical query string.
 */
export function encodeQuery(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * Decodes a value from a ListObjectsV2 response with `encoding-type=url`.
 * AWS encodes a space as `+` in this mode and a literal `+` as `%2B`.
 */
export function decodeListValue(value: string): string {
  return decodeURIComponent(value.replaceAll('+', ' '));
}

/** Removes the quotes (and a weak `W/` marker) around an HTTP etag. */
export function unquoteEtag(value: string): string {
  const trimmed = value.trim().replace(/^W\//, '');
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** Quotes an etag for `If-Match`, unless it is already quoted. */
export function quoteEtag(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}
