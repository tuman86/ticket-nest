/** Turns passwords into storable hashes and checks them. The only way services touch passwords. */
export interface PasswordHasher {
  /**
   * Hashes a password with a fresh random salt.
   *
   * @param password - The plaintext password. Never stored, logged or returned.
   * @returns A self-describing hash string that is safe to store in `users.password_hash`.
   */
  hash(password: string): Promise<string>;

  /**
   * Checks a password against a stored hash.
   *
   * @param password - The plaintext password to check.
   * @param storedHash - A value previously returned by `hash`.
   * @returns True only when the password matches. A malformed or unsupported `storedHash` gives
   * false, never an error.
   */
  verify(password: string, storedHash: string): Promise<boolean>;

  /**
   * Tells whether a stored hash is weaker than what `hash` would produce today, so a successful
   * login can upgrade it.
   *
   * @param storedHash - A value previously returned by `hash`.
   * @returns True when any cost parameter of `storedHash` is below the current one. False for a
   * hash that is current or stronger, and for a malformed hash (it cannot have verified).
   */
  needsRehash(storedHash: string): boolean;
}
