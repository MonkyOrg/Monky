import { net } from 'electron';

/** Chromium's fetch rejects manual redirects; expose each hop so shared can validate its host. */
export const requestUpdateMetadata: typeof fetch = (input, init) => new Promise((resolve, reject) => {
  const signal = init?.signal;
  if (signal?.aborted) { reject(signal.reason); return; }
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  const request = net.request({ url, method: 'GET', redirect: 'manual' });
  let settled = false;
  const finish = (response: Response | null, error?: unknown): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', abort);
    if (response) resolve(response);
    else reject(error);
  };
  const abort = (): void => {
    finish(null, signal?.reason ?? new Error('Update metadata request cancelled.'));
    request.abort();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const headers = new Headers(init?.headers);
  headers.forEach((value, name) => request.setHeader(name, value));
  request.on('redirect', (status, _method, location) => {
    finish(new Response(null, { status, headers: { location } }));
    request.abort();
  });
  request.on('response', response => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > 16 * 1024) {
        finish(null, new Error('Update metadata exceeds its size limit.'));
        request.abort();
      } else chunks.push(chunk);
    });
    response.on('error', (error: Error) => finish(null, error));
    response.on('end', () => {
      if (settled) return;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const body = [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks);
      finish(new Response(body, { status: response.statusCode, headers: responseHeaders }));
    });
    response.on('aborted', () => finish(null, new Error('Update metadata response interrupted.')));
  });
  request.on('error', error => finish(null, error));
  request.end();
});
