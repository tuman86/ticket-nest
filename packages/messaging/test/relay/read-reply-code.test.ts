import { describe, expect, it } from 'vitest';

import { readReplyCode } from '@/relay/read-reply-code';

describe('readReplyCode', () => {
  it('reads the numeric code amqplib puts on the error of a close frame', () => {
    const error = Object.assign(new Error('Channel closed by server'), { code: 406 });

    expect(readReplyCode(error)).toBe(406);
  });

  it('returns undefined for a string code, as a socket error has', () => {
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    expect(readReplyCode(error)).toBeUndefined();
  });

  it('returns undefined for an error without a code', () => {
    expect(readReplyCode(new Error('message nacked'))).toBeUndefined();
  });

  it('returns undefined for something that is not an Error, even when it has a code', () => {
    expect(readReplyCode({ code: 406 })).toBeUndefined();
    expect(readReplyCode('broker closed')).toBeUndefined();
    expect(readReplyCode(undefined)).toBeUndefined();
  });
});
