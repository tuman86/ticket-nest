import { describe, expect, it } from 'vitest';

import * as testing from './testing';

describe('the @ticketnest/contracts/testing entry', () => {
  it('exports the readers other workspaces use, and nothing else', () => {
    expect(Object.keys(testing).sort()).toEqual(['readGrantMatrix', 'readOpenApiOperations']);
  });
});
