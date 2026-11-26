import { firstSampleIndexAt, PHRASE_GAP_SECONDS, type PitchSample } from './pitchMath'

/**
 * A held note whose average pitch sits in the gap between two piano keys (琴缝音).
 * Judged per held note rather than per frame: vibrato is averaged out and glides,
 * scoops and passing tones are excluded, so only notes the singer actually held
 * off-key are reported.
 */
export interface BetweenKeyNote {
  startTime: number
  endTime: number
  centerMidi: number
  nearestMidi: number
  cents: number
}

// Average offset from the nearest key at which a held note counts as 琴缝音
export const BETWEEN_KEYS_CENTS = 30

// ±90 ms moving average spans about one 5–7 Hz vibrato cycle
const TREND_HALF_WINDOW_SECONDS = 0.09
// Trend moving this far from the running note average starts a new note
const NOTE_SPLIT_SEMITONES = 0.45
// Steady core of a note: trend within this range of the note's median pitch
const CORE_SEMITONES = 0.3
const MIN_NOTE_SECONDS = 0.3
// Slower drift is intonation within a held note; faster is a slide or siren
const MAX_DRIFT_SEMITONES_PER_SECOND = 1

function continuesRun(prev: PitchSample, next: PitchSample): boolean {
  return prev.midi !== null && next.midi !== null && next.time - prev.time <= PHRASE_GAP_SECONDS
}

function movingAverage(times: number[], values: number[], halfWindow: number): number[] {
  const out: number[] = []
  let lo = 0
  let hi = 0
  let sum = 0
  for (let k = 0; k < values.length; k++) {
    while (hi < values.length && times[hi]! <= times[k]! + halfWindow) sum += values[hi++]!
    while (times[lo]! < times[k]! - halfWindow) sum -= values[lo++]!
    out.push(sum / (hi - lo))
  }
  return out
}

function splitHeldSegments(trend: number[]): Array<[number, number]> {
  const segments: Array<[number, number]> = []
  let segStart = 0
  let segSum = trend[0]!
  for (let k = 1; k < trend.length; k++) {
    if (Math.abs(trend[k]! - segSum / (k - segStart)) > NOTE_SPLIT_SEMITONES) {
      segments.push([segStart, k])
      segStart = k
      segSum = 0
    }
    segSum += trend[k]!
  }
  segments.push([segStart, trend.length])
  return segments
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function regressionSlope(xs: number[], ys: number[]): number {
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0
  let den = 0
  xs.forEach((x, k) => {
    num += (x - meanX) * (ys[k]! - meanY)
    den += (x - meanX) ** 2
  })
  return num / den
}

function judgeSegment(
  times: number[],
  trend: number[],
  from: number,
  to: number,
): BetweenKeyNote | null {
  // Median keeps glide-in tails and the next note's onset from pulling the center
  const centerMidi = median(trend.slice(from, to))
  const coreTimes: number[] = []
  const coreTrend: number[] = []
  for (let k = from; k < to; k++) {
    if (Math.abs(trend[k]! - centerMidi) > CORE_SEMITONES) continue
    coreTimes.push(times[k]!)
    coreTrend.push(trend[k]!)
  }

  const startTime = coreTimes[0] ?? 0
  const endTime = coreTimes.at(-1) ?? 0
  if (endTime - startTime < MIN_NOTE_SECONDS) return null
  if (Math.abs(regressionSlope(coreTimes, coreTrend)) > MAX_DRIFT_SEMITONES_PER_SECOND) return null

  const nearestMidi = Math.round(centerMidi)
  const cents = Math.round((centerMidi - nearestMidi) * 100)
  if (Math.abs(cents) < BETWEEN_KEYS_CENTS) return null
  return { startTime, endTime, centerMidi, nearestMidi, cents }
}

/** 琴缝音 among the held notes that overlap [startTime, endTime]. */
export function findBetweenKeyNotes(
  samples: PitchSample[],
  startTime: number,
  endTime: number,
): BetweenKeyNote[] {
  const notes: BetweenKeyNote[] = []
  let i = firstSampleIndexAt(samples, startTime)
  // Back up to the start of the phrase so notes crossing the left edge are judged in full
  while (i > 0 && i < samples.length && continuesRun(samples[i - 1]!, samples[i]!)) i--

  while (i < samples.length && samples[i]!.time <= endTime) {
    if (samples[i]!.midi === null) {
      i++
      continue
    }
    const runStart = i++
    while (i < samples.length && continuesRun(samples[i - 1]!, samples[i]!)) i++

    const run = samples.slice(runStart, i)
    const times = run.map((s) => s.time)
    const trend = movingAverage(
      times,
      run.map((s) => s.midi!),
      TREND_HALF_WINDOW_SECONDS,
    )
    for (const [from, to] of splitHeldSegments(trend)) {
      const note = judgeSegment(times, trend, from, to)
      if (note) notes.push(note)
    }
  }
  return notes
}
