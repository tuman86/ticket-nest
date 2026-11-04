import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { limitBodySize } from '@/proxy/limit-body-size';

describe('limitBodySize', () => {
  it('passes a body within the limit through unchanged', async () => {
    const body = limitBodySize(Readable.from([Buffer.from('hello '), Buffer.from('world')]), 11);

    await expect(text(body)).resolves.toBe('hello world');
  });

  it('fails with a 413 once more bytes than the limit have passed', async () => {
    const body = limitBodySize(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 11);

    await expect(text(body)).rejects.toMatchObject({ status: 413, code: 'REQUEST_REJECTED' });
  });

  it('fails on a single chunk that is over the limit', async () => {
    const body = limitBodySize(Readable.from([Buffer.alloc(100)]), 10);

    await expect(text(body)).rejects.toMatchObject({ status: 413 });
  });

  it('reads the rest of the client body after refusing, so the 413 can still be sent', async () => {
    const source = Readable.from([Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)]);
    const wasFullyRead = new Promise<void>((resolve) => source.once('end', resolve));
    const body = limitBodySize(source, 8);

    await expect(text(body)).rejects.toMatchObject({ status: 413 });
    await wasFullyRead;
  });
});
