/** A remote response passed the size the caller is willing to hold in memory. */
export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The response exceeds ${limit} bytes.`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * `response.json()` with a ceiling: the declared length is checked first and
 * the stream is cancelled as soon as it passes `maxBytes`, so an endpoint that
 * streams hundreds of megabytes cannot exhaust the server's memory.
 */
export async function readJsonWithLimit(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  // TextDecoder drops a UTF-8 BOM, exactly like response.json().
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}
