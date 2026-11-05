import { InvalidEventDomainError } from './invalid-event-domain.error';

const DOMAIN_PATTERN = /^[a-z][a-z_]*$/;
const EXCHANGE_SUFFIX = 'events';
const UNROUTED_SUFFIX = 'unrouted';

/**
 * @param domain - A producer domain name to check.
 * @throws InvalidEventDomainError when the domain is not lower-case letters and underscores.
 */
function assertValidDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new InvalidEventDomainError(domain);
  }
}

/**
 * Names the topic exchange of a producing domain (`auth` gives `auth.events`, docs/architecture.md
 * section 6.1). Producers and consumers both call it so the name is spelled in one place.
 *
 * @param domain - Lower-case domain name of the producer: `auth`, `catalog`, `booking`, `payment`.
 * @returns The exchange name.
 * @throws InvalidEventDomainError when the domain is not lower-case letters and underscores.
 */
export function buildEventExchangeName(domain: string): string {
  assertValidDomain(domain);
  return `${domain}.${EXCHANGE_SUFFIX}`;
}

/**
 * Names the alternate exchange of a producing domain (`auth` gives `auth.events.unrouted`, ADR-0005).
 * It receives every message of the domain's topic exchange that no queue is bound for.
 *
 * @param domain - Lower-case domain name of the producer.
 * @returns The alternate exchange name.
 * @throws InvalidEventDomainError when the domain is not lower-case letters and underscores.
 */
export function buildUnroutedExchangeName(domain: string): string {
  return `${buildEventExchangeName(domain)}.${UNROUTED_SUFFIX}`;
}

/**
 * Names the catch-all queue of a producing domain (`auth` gives `auth.unrouted`, ADR-0005). It is
 * bound to the domain's alternate exchange and keeps the events no consumer has bound a queue for.
 *
 * @param domain - Lower-case domain name of the producer.
 * @returns The catch-all queue name.
 * @throws InvalidEventDomainError when the domain is not lower-case letters and underscores.
 */
export function buildUnroutedQueueName(domain: string): string {
  assertValidDomain(domain);
  return `${domain}.${UNROUTED_SUFFIX}`;
}
