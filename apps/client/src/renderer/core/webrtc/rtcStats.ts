/**
 * Reads the ICE route of a link out of `getStats()`, the same way for every
 * link a call holds: P2P peer connections and SFU transports alike.
 *
 * `transport.selectedCandidatePairId` is the authoritative answer to "which
 * pair carries the media". The first `succeeded` pair is not: with host and
 * srflx candidates, or UDP and TCP towards the SFU, several pairs succeed and
 * only one is in use, so reading the first one reported the round trip — or
 * the relay — of a path that carried nothing (#466).
 */

/** What `getStats()` resolves to, reduced to the reads made here. */
export interface StatsReportLike {
  get(id: string): unknown;
  forEach(callback: (value: unknown) => void): void;
}

type StatsRecord = Readonly<Record<string, unknown>>;

export interface CandidateEndpoint {
  /** `host`, `srflx`, `prflx` or `relay`. */
  readonly type: string | null;
  readonly address: string | null;
  readonly port: number | null;
  readonly protocol: string | null;
}

export interface CandidateRoute {
  /** Current round trip of the pair in whole milliseconds, or null until one is measured. */
  readonly rttMs: number | null;
  /** Either end goes through a TURN relay. */
  readonly relayed: boolean;
  readonly local: CandidateEndpoint | null;
  readonly remote: CandidateEndpoint | null;
}

function isRecord(value: unknown): value is StatsRecord {
  return typeof value === 'object' && value !== null;
}

function readString(record: StatsRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: StatsRecord, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function records(stats: StatsReportLike, type: string): StatsRecord[] {
  const matching: StatsRecord[] = [];
  stats.forEach(value => {
    if (isRecord(value) && value.type === type) matching.push(value);
  });
  return matching;
}

/** The candidate pair carrying the media, or null while ICE has not settled on one. */
export function selectedCandidatePair(stats: StatsReportLike): StatsRecord | null {
  for (const transport of records(stats, 'transport')) {
    const id = readString(transport, 'selectedCandidatePairId');
    const pair = id ? stats.get(id) : undefined;
    if (isRecord(pair) && pair.type === 'candidate-pair') return pair;
  }
  // Engines without `selectedCandidatePairId` flag the pair instead. Nomination
  // is the weaker signal: it shows up at different moments on each side of the
  // same link (#466).
  return records(stats, 'candidate-pair').find(pair => pair.state === 'succeeded'
    && (pair.selected === true || pair.nominated === true)) ?? null;
}

function endpoint(stats: StatsReportLike, id: string | null): CandidateEndpoint | null {
  const candidate = id ? stats.get(id) : undefined;
  if (!isRecord(candidate)) return null;
  return {
    type: readString(candidate, 'candidateType'),
    address: readString(candidate, 'address') ?? readString(candidate, 'ip'),
    port: readNumber(candidate, 'port'),
    protocol: readString(candidate, 'protocol'),
  };
}

function routeOf(stats: StatsReportLike, pair: StatsRecord): CandidateRoute {
  const local = endpoint(stats, readString(pair, 'localCandidateId'));
  const remote = endpoint(stats, readString(pair, 'remoteCandidateId'));
  const seconds = readNumber(pair, 'currentRoundTripTime') ?? readNumber(pair, 'roundTripTime');
  return {
    rttMs: seconds !== null && seconds >= 0 ? Math.round(seconds * 1000) : null,
    relayed: local?.type === 'relay' || remote?.type === 'relay',
    local,
    remote,
  };
}

/** Route of the pair carrying the media, or null while ICE has not settled on one. */
export function candidateRoute(stats: StatsReportLike): CandidateRoute | null {
  const pair = selectedCandidatePair(stats);
  return pair ? routeOf(stats, pair) : null;
}

/**
 * The route worth reporting for a link that may have failed: the one in use,
 * else the one ICE nominated, else one it reached, else one it gave up on. The
 * order is what makes the report describe the path actually tried, instead of
 * whichever pair the engine happened to list first.
 */
export function diagnosticCandidateRoute(stats: StatsReportLike): CandidateRoute | null {
  const selected = selectedCandidatePair(stats);
  if (selected) return routeOf(stats, selected);
  const pairs = records(stats, 'candidate-pair');
  const attempted = pairs.find(pair => pair.nominated === true)
    ?? pairs.find(pair => pair.state === 'succeeded')
    ?? pairs.find(pair => pair.state === 'failed');
  return attempted ? routeOf(stats, attempted) : null;
}

/** Mean of the round trips that were measured, or null when none was. */
export function averageRoundTrip(values: readonly (number | null)[]): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length ? Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length) : null;
}
