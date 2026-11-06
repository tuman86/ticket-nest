/**
 * The caller, as proven by a verified access token. Claims are what the token said when it was
 * issued, so handlers must not return them: load the current data from the owning database by
 * `userId`.
 */
export interface AuthenticatedPrincipal {
  /** The token's `sub`: the user's id. */
  readonly userId: string;
  /** The role key at issue time (for example `CUSTOMER`). */
  readonly roleKey: string;
  /**
   * Permission keys at issue time. Plain strings, not `PermissionKey`, on purpose: a token can carry
   * keys from another catalogue version (issued before a key was removed, or by a newer
   * auth-service). A guard compares them with `includes` against a `PermissionKey` and ignores the
   * rest; narrow with `isPermissionKey` from `@ticketnest/contracts` where a catalogue key is needed.
   */
  readonly permissions: readonly string[];
  /** Set only for operator users. Taken from the token, never from a request body. */
  readonly tenantId: string | null;
  /** When the user last entered their password. */
  readonly authTime: Date;
  /** The token's `jti`. */
  readonly tokenId: string;
}
