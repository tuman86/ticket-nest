/** Tells whether a password is known to be compromised or trivially guessable. */
export interface BreachedPasswordChecker {
  /**
   * @param password - The plaintext password. Implementations must not log or store it.
   * @returns True when the password appears in a breach or common-password list.
   */
  isBreached(password: string): Promise<boolean>;
}
