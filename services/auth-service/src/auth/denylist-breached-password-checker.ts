import { type BreachedPasswordChecker } from './breached-password-checker';

/**
 * A small list of the most common passwords that are at least 10 characters long (the minimum
 * length), so the length rule does not let them through. A stand-in until a real breach lookup
 * (a k-anonymity range query) replaces it behind `BreachedPasswordChecker`.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  '0123456789',
  '1234567890',
  '12345678910',
  '123456789012',
  'qwertyuiop',
  'qwerty12345',
  'qwerty123456',
  'asdfghjkl1',
  'abcdefghij',
  'abcd123456',
  'password12',
  'password123',
  'password1234',
  'password12345',
  'passw0rd123',
  'p@ssword123',
  'letmein123',
  'letmein1234',
  'welcome123',
  'welcome1234',
  'iloveyou123',
  'iloveyou1234',
  'administrator',
  'changeme123',
  'trustno1234',
  'football123',
  'baseball123',
  'superman123',
  'monkey12345',
  'dragon12345',
];

/** `BreachedPasswordChecker` backed by an in-memory list, compared ignoring letter case. */
export class DenylistBreachedPasswordChecker implements BreachedPasswordChecker {
  private readonly denied: ReadonlySet<string>;

  /**
   * @param passwords - The passwords to refuse. Defaults to `COMMON_PASSWORDS`.
   */
  constructor(passwords: readonly string[] = COMMON_PASSWORDS) {
    this.denied = new Set(passwords.map((password) => password.toLowerCase()));
  }

  /**
   * @param password - The plaintext password.
   * @returns True when the password is on the list, ignoring letter case. Spaces count, because
   * they can be part of a real password.
   */
  isBreached(password: string): Promise<boolean> {
    return Promise.resolve(this.denied.has(password.toLowerCase()));
  }
}
