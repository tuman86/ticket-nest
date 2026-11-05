import { describe, expect, it } from 'vitest';

import { TopologyDeclarationError } from '@/relay/topology-declaration.error';

const OBJECT_NAME = 'auth.events';
const REPLY_CODE = 406;
const BROKER_REPLY =
  "PRECONDITION_FAILED - inequivalent arg 'alternate-exchange' for exchange 'auth.events' in vhost '/'";

/**
 * @param cause - The driver error behind it, if any.
 * @returns An error for a refused declaration of `OBJECT_NAME`.
 */
function buildError(cause?: unknown): TopologyDeclarationError {
  return new TopologyDeclarationError({
    objectName: OBJECT_NAME,
    replyCode: REPLY_CODE,
    brokerReply: BROKER_REPLY,
    cause,
  });
}

describe('TopologyDeclarationError', () => {
  it('is a 500 with its own machine code', () => {
    const error = buildError();

    expect(error.status).toBe(500);
    expect(error.code).toBe('TOPOLOGY_DECLARATION_FAILED');
  });

  it('names the object and the reply code in its detail', () => {
    const error = buildError();

    expect(error.detail).toContain(OBJECT_NAME);
    expect(error.detail).toContain(String(REPLY_CODE));
    expect(error.objectName).toBe(OBJECT_NAME);
    expect(error.replyCode).toBe(REPLY_CODE);
  });

  it("keeps the broker's reply text in brokerReply and out of the detail", () => {
    const error = buildError();

    expect(error.brokerReply).toBe(BROKER_REPLY);
    expect(error.detail).not.toContain(BROKER_REPLY);
  });

  it('keeps the driver error as its cause', () => {
    const cause = new Error('Channel closed by server');

    expect(buildError(cause).cause).toBe(cause);
  });
});
