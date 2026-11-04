import { InvalidEventDomainError } from './invalid-event-domain.error';

const DOMAIN_PATTERN = /^[a-z][a-z_]*$/;
const EXCHANGE_SUFFIX = 'events';

/**
 * Names the topic exchange of a producing domain (`auth` gives `auth.events`, docs/architecture.md
 * section 6.1). Producers and consumers both call it so the name is spelled in one place.
 *
 * @param domain - Lower-case domain name of the producer: `auth`, `catalog`, `booking`, `payment`.
 * @returns The exchange name.
 * @throws InvalidEventDomainError when the domain is not lower-case letters and underscores.
 */
export function buildEventExchangeName(domain: string): string {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new InvalidEventDomainError(domain);
  }
  return `${domain}.${EXCHANGE_SUFFIX}`;
}
