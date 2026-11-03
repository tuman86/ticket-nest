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
  /** Permission keys at issue time. */
  readonly permissions: readonly string[];
  /** Set only for operator users. Taken from the token, never from a request body. */
  readonly tenantId: string | null;
  /** When the user last entered their password. */
  readonly authTime: Date;
  /** The token's `jti`. */
  readonly tokenId: string;
}
