/**
 * Puts an email address in the form stored in `users.email`: trimmed and lower-cased.
 *
 * Provider-specific rules (Gmail dots, plus tags) are deliberately NOT applied, so two
 * addresses the mailbox provider treats alike stay two accounts.
 *
 * @param email - The address as the user typed it.
 * @returns The normalized address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
