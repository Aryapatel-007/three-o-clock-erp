/**
 * How good a device's connection to the cafe box is. P62 network additions.
 *
 * A browser cannot read a WiFi signal in dBm; no web page can. What every
 * device can measure, and what actually decides whether a tap reaches the
 * till, is its round trip to the box: each device pings `GET /network/ping`
 * every few seconds and keeps the last twelve answers. Strength comes from
 * the median time, the jitter and how many pings got no answer at all.
 *
 * MIRRORED on the client in `client/src/utils/linkQuality.js`, which draws the
 * same bars in each device's top bar. The two must agree; a test reads both.
 */
export const LINK_THRESHOLDS = Object.freeze([
  { bars: 4, word: 'Excellent', maxMedianMs: 40, maxLossPercent: 0 },
  { bars: 3, word: 'Good', maxMedianMs: 100, maxLossPercent: 5 },
  { bars: 2, word: 'Fair', maxMedianMs: 250, maxLossPercent: 15 },
  { bars: 1, word: 'Weak', maxMedianMs: Infinity, maxLossPercent: 99 },
]);

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

/** `samples` is the last pings: a number of milliseconds each, or null for no answer. */
export function linkQuality(samples) {
  const list = Array.isArray(samples) ? samples.slice(-12) : [];
  const answered = list.filter((value) => Number.isFinite(value) && value >= 0);
  const lossPercent = list.length ? Math.round(((list.length - answered.length) / list.length) * 100) : 100;
  const medianMs = median(answered);
  let jitterMs = null;
  if (answered.length > 1) {
    let total = 0;
    for (let i = 1; i < answered.length; i += 1) total += Math.abs(answered[i] - answered[i - 1]);
    jitterMs = Math.round(total / (answered.length - 1));
  }
  if (answered.length === 0) return { bars: 0, word: 'No connection', medianMs: null, jitterMs: null, lossPercent };
  const level = LINK_THRESHOLDS.find((entry) => medianMs <= entry.maxMedianMs && lossPercent <= entry.maxLossPercent) ?? LINK_THRESHOLDS.at(-1);
  return { bars: level.bars, word: level.word, medianMs, jitterMs, lossPercent };
}
