export interface PitchInfo {
  frequency: number
  midi: number
  nearestMidi: number
  noteName: string
  noteLetter: string
  accidental: string
  octave: number
  fullName: string
  solfege: string
  jianpu: string
  cents: number
}

export interface PitchSample {
  time: number
  frequency: number | null
  midi: number | null
  clarity: number
  rms: number
}

// Voiced samples further apart than this belong to separate phrases
export const PHRASE_GAP_SECONDS = 0.18

/** Index of the first sample at or after `time` (samples are sorted by time). */
export function firstSampleIndexAt(samples: PitchSample[], time: number): number {
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid]!.time < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
const NOTE_NAMES_DISPLAY = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const
const SOLFEGE_NAMES = ['Do', 'Di', 'Re', 'Ri', 'Mi', 'Fa', 'Fi', 'Sol', 'Si', 'La', 'Li', 'Ti'] as const
const JIANPU_NAMES = ['1', '♯1', '2', '♯2', '3', '4', '♯4', '5', '♯5', '6', '♯6', '7'] as const
const BLACK_KEY_INDICES = new Set([1, 3, 6, 8, 10])

export function isBlackKey(midi: number): boolean {
  const index = ((Math.round(midi) % 12) + 12) % 12
  return BLACK_KEY_INDICES.has(index)
}

export function frequencyToMidi(frequency: number, a4Hz = 440): number {
  return 69 + 12 * Math.log2(frequency / a4Hz)
}

export function midiToFrequency(midi: number, a4Hz = 440): number {
  return a4Hz * Math.pow(2, (midi - 69) / 12)
}

export function midiToNoteParts(midi: number): {
  noteName: string
  noteLetter: string
  accidental: string
  displayNote: string
  octave: number
  fullName: string
  displayFullName: string
  solfege: string
  jianpu: string
} {
  const rounded = Math.round(midi)
  const pc = ((rounded % 12) + 12) % 12
  const octave = Math.floor(rounded / 12) - 1
  const noteName = NOTE_NAMES_SHARP[pc]!
  const displayNote = NOTE_NAMES_DISPLAY[pc]!
  const noteLetter = noteName[0]!
  const accidental = noteName.length > 1 ? '♯' : ''
  return {
    noteName,
    noteLetter,
    accidental,
    displayNote,
    octave,
    fullName: `${noteName}${octave}`,
    displayFullName: `${displayNote}${octave}`,
    solfege: SOLFEGE_NAMES[pc]!,
    jianpu: JIANPU_NAMES[pc]!,
  }
}

export function describePitchFromFrequency(frequency: number, a4Hz = 440): PitchInfo {
  const midi = frequencyToMidi(frequency, a4Hz)
  return describePitchFromMidi(midi, a4Hz, frequency)
}

export function describePitchFromMidi(
  midi: number,
  a4Hz = 440,
  explicitFrequency?: number,
): PitchInfo {
  const nearestMidi = Math.round(midi)
  const cents = Math.round((midi - nearestMidi) * 100)
  const frequency = explicitFrequency ?? midiToFrequency(midi, a4Hz)
  const parts = midiToNoteParts(nearestMidi)

  return {
    frequency,
    midi,
    nearestMidi,
    noteName: parts.noteName,
    noteLetter: parts.noteLetter,
    accidental: parts.accidental,
    octave: parts.octave,
    fullName: parts.fullName,
    solfege: parts.solfege,
    jianpu: parts.jianpu,
    cents,
  }
}

export function formatCents(cents: number): string {
  if (cents === 0) return '0¢'
  return cents > 0 ? `+${cents}¢` : `${cents}¢`
}

export function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  const tenths = Math.floor((safe % 1) * 10)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`
}
