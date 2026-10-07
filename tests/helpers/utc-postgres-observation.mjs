/** Syna stores timestamp-without-time-zone columns as UTC. Raw postgres.js
 * otherwise parses OID 1114 with new Date(value), which uses the observer's
 * local timezone. Override only that OID; timestamptz retains its real offset. */
export function parseUtcTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) throw new Error('Invalid UTC observation timestamp');
  const result = new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(result.getTime())) throw new Error('Invalid UTC observation timestamp');
  return result;
}

export const utcObservationTypes = {
  timestampWithoutTimeZone: {
    to: 1114,
    from: [1114],
    serialize: value => value instanceof Date ? value.toISOString().replace('T', ' ').replace(/Z$/, '') : String(value),
    parse: parseUtcTimestamp,
  },
};
