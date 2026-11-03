import { UserResponse } from '@ticketnest/contracts';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRegisterTestApp,
  type RegisterTestApp,
} from '../../support/create-register-test-app';
import { EmailAlreadyRegisteredError } from '@/users/email-already-registered.error';

const REGISTER_PATH = '/v1/auth/register';
const PROBLEM_BASE = 'https://api.ticketnest.example/problems/';
const PASSWORD = 'correct-horse-battery';

const validBody = {
  email: 'Asha.Rao@Example.com',
  password: PASSWORD,
  name: 'Asha Rao',
  phone: '+919876543210',
};

let testApp: RegisterTestApp;

beforeEach(() => {
  testApp = createRegisterTestApp();
});

/**
 * @param body - The JSON body to send.
 * @returns The Supertest request, ready to await.
 */
function register(body: unknown): request.Test {
  return request(testApp.app)
    .post(REGISTER_PATH)
    .send(body as object);
}

describe('POST /v1/auth/register: success', () => {
  it('creates a customer and answers 201 with the User and a Location header', async () => {
    const response = await register(validBody);

    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    const user = UserResponse.parse(response.body);
    expect(response.headers.location).toBe(`/v1/users/${user.id}`);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(user).toMatchObject({
      email: 'asha.rao@example.com',
      emailVerified: false,
      name: 'Asha Rao',
      phone: '+919876543210',
      role: { key: 'CUSTOMER', name: 'Customer' },
      tenantId: null,
      status: 'ACTIVE',
    });
  });

  it('stores the normalized email and an argon2id hash that verifies the password', async () => {
    await register(validBody);

    const [stored, ...others] = testApp.users.all();
    expect(others).toHaveLength(0);
    expect(stored?.email).toBe('asha.rao@example.com');
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(await testApp.hasher.verify(PASSWORD, stored?.passwordHash ?? '')).toBe(true);
  });

  it('answers phone null when none was sent', async () => {
    const withoutPhone = { email: validBody.email, password: PASSWORD, name: validBody.name };

    const response = await register(withoutPhone);

    expect(response.status).toBe(201);
    expect((response.body as { phone: unknown }).phone).toBeNull();
  });

  it('never returns the password or any hash, in the body or the headers', async () => {
    const response = await register(validBody);

    const everything = JSON.stringify([response.body, response.headers, response.text]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('argon2');
    expect(everything.toLowerCase()).not.toContain('passwordhash');
    expect(everything.toLowerCase()).not.toContain('password');
  });

  it('logs the registration by user id and never logs the password, a hash or the email', async () => {
    const response = await register(validBody);

    const logged = JSON.stringify(testApp.lines);
    expect(testApp.lines.some((line) => line.msg === 'user registered')).toBe(true);
    expect(logged).toContain((response.body as { id: string }).id);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('argon2');
    expect(logged.toLowerCase()).not.toContain('asha.rao@example.com');
  });
});

describe('POST /v1/auth/register: duplicate email', () => {
  it('answers 409 email-already-registered as application/problem+json', async () => {
    await register(validBody);

    const response = await register(validBody);

    expect(response.status).toBe(409);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({
      type: `${PROBLEM_BASE}email-already-registered`,
      status: 409,
      code: 'EMAIL_ALREADY_REGISTERED',
      instance: REGISTER_PATH,
    });
    expect(testApp.users.all()).toHaveLength(1);
  });

  it('treats a different letter case as the same email', async () => {
    await register(validBody);

    const response = await register({ ...validBody, email: 'ASHA.RAO@EXAMPLE.COM' });

    expect(response.status).toBe(409);
    expect(testApp.users.all()).toHaveLength(1);
  });

  it('rejects before the expensive hash, so duplicates cannot be used to burn CPU', async () => {
    await register(validBody);
    testApp.hashSpy.mockClear();

    await register(validBody);

    expect(testApp.hashSpy).not.toHaveBeenCalled();
  });

  it('answers 409 when two requests race past the lookup and the database refuses the second', async () => {
    await register(validBody);
    vi.spyOn(testApp.users, 'findByEmail').mockResolvedValueOnce(null);

    const response = await register(validBody);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
    expect(testApp.users.all()).toHaveLength(1);
  });

  it('does not echo or log the email, the password or a hash on the 409 path', async () => {
    await register(validBody);
    testApp.lines.length = 0;

    const response = await register(validBody);

    const everything = JSON.stringify([response.body, testApp.lines]).toLowerCase();
    expect(everything).not.toContain('asha.rao@example.com');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('argon2');
  });

  it('lets unexpected repository errors become a generic 500', async () => {
    vi.spyOn(testApp.users, 'findByEmail').mockRejectedValueOnce(new Error('connection lost'));

    const response = await register(validBody);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('connection lost');
  });

  it('keeps the domain error a 409 conflict', () => {
    const error = new EmailAlreadyRegisteredError();

    expect(error.status).toBe(409);
    expect(error.problemType).toBe('email-already-registered');
  });
});

describe('POST /v1/auth/register: weak password', () => {
  function expectRejectedPassword(response: request.Response, code: string): void {
    expect(response.status).toBe(422);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({
      type: `${PROBLEM_BASE}validation-error`,
      status: 422,
      errors: [{ pointer: '#/password', code }],
    });
    expect(testApp.users.all()).toHaveLength(0);
    expect(testApp.hashSpy).not.toHaveBeenCalled();
  }

  it('rejects a password of 9 characters', async () => {
    const response = await register({ ...validBody, password: 'a'.repeat(9) });

    expectRejectedPassword(response, 'TOO_SHORT');
  });

  it('accepts a password of exactly 10 characters', async () => {
    const response = await register({ ...validBody, password: 'k7#Qw!9zXp' });

    expect(response.status).toBe(201);
  });

  it('rejects a password of 129 characters', async () => {
    const response = await register({ ...validBody, password: 'a'.repeat(129) });

    expectRejectedPassword(response, 'TOO_LONG');
  });

  it.each(['password123', 'PASSWORD123', '1234567890'])(
    'rejects the breached password %s',
    async (password) => {
      const response = await register({ ...validBody, password });

      expectRejectedPassword(response, 'BREACHED_PASSWORD');
    },
  );

  it('rejects a password that is not a string', async () => {
    const response = await register({ ...validBody, password: 1234567890 });

    expectRejectedPassword(response, 'INVALID_TYPE');
  });

  it('never echoes the submitted password back', async () => {
    const response = await register({ ...validBody, password: 'password123' });

    expect(JSON.stringify(response.body)).not.toContain('password123');
    expect(JSON.stringify(testApp.lines)).not.toContain('password123');
  });
});

describe('POST /v1/auth/register: invalid body', () => {
  it('lists every missing required field', async () => {
    const response = await register({});

    expect(response.status).toBe(422);
    const errors = (response.body as { errors: { pointer: string; code: string }[] }).errors;
    expect(errors.map((error) => error.pointer).sort()).toEqual([
      '#/email',
      '#/name',
      '#/password',
    ]);
    expect(errors.every((error) => error.code === 'REQUIRED')).toBe(true);
    expect(testApp.users.all()).toHaveLength(0);
  });

  it.each([
    ['a malformed email', { email: 'not-an-email' }, '#/email'],
    ['an empty name', { name: '' }, '#/name'],
    ['a blank name', { name: '   ' }, '#/name'],
    ['a phone without the plus', { phone: '9876543210' }, '#/phone'],
  ])('rejects %s', async (_label, change, pointer) => {
    const response = await register({ ...validBody, ...change });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ errors: [{ pointer }] });
    expect(testApp.users.all()).toHaveLength(0);
  });

  it.each([
    ['role', { role: 'ADMIN' }],
    ['tenantId', { tenantId: '4b0d2f0e-8f0c-4d0e-9a6f-0c2f6a5d1e11' }],
    ['passwordHash', { passwordHash: '$argon2id$x' }],
    ['status', { status: 'DISABLED' }],
  ])('rejects the unknown field %s instead of ignoring it', async (_key, extra) => {
    const response = await register({ ...validBody, ...extra });

    expect(response.status).toBe(422);
    expect(testApp.users.all()).toHaveLength(0);
  });

  it('answers 400 malformed-request for JSON that does not parse', async () => {
    const response = await request(testApp.app)
      .post(REGISTER_PATH)
      .set('Content-Type', 'application/json')
      .send('{"email": ');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ type: `${PROBLEM_BASE}malformed-request` });
    expect(testApp.users.all()).toHaveLength(0);
  });

  it.each([
    ['an array', '[]', 'application/json'],
    ['a request with no body', '', 'application/json'],
    ['a text/plain body', 'hello', 'text/plain'],
  ])('answers 422 for %s', async (_label, payload, contentType) => {
    const response = await request(testApp.app)
      .post(REGISTER_PATH)
      .set('Content-Type', contentType)
      .send(payload);

    expect(response.status).toBe(422);
    expect(testApp.users.all()).toHaveLength(0);
  });

  it('answers 413 for a body over the size limit, before any work is done', async () => {
    const response = await register({ ...validBody, name: 'n'.repeat(5_000) });

    expect(response.status).toBe(413);
    expect(testApp.hashSpy).not.toHaveBeenCalled();
  });

  it('answers 404 for other methods on the path', async () => {
    const response = await request(testApp.app).get(REGISTER_PATH);

    expect(response.status).toBe(404);
  });
});
