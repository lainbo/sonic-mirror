import { midiToFrequency, type PitchSample } from './pitchMath'

interface PhraseSegment {
  start: number
  end: number
  midi: number
  glideFrom?: number
  glideDuration?: number
  driftCents?: number
  vibratoDepth?: number
  vibratoRate?: number
}

/**
 * Generates a realistic 10-second vocal phrase (C4 -> E4 -> G4 -> A4 -> G4 -> C5 -> B4 -> A4 -> G4)
 * with subtle human portamento, vibrato, and intonation variation (including two notes held
 * between keys) so users can immediately inspect the pitch curve, 琴缝音 marks and hover
 * readout before turning on a mic.
 */
export function generateDemoVocalPhrase(a4Hz = 440): PitchSample[] {
  const segments: PhraseSegment[] = [
    { start: 0.4, end: 1.35, midi: 60, driftCents: -6, vibratoDepth: 0.08, vibratoRate: 5.2 }, // C4
    { start: 1.35, end: 2.35, midi: 64, glideFrom: 60, glideDuration: 0.18, driftCents: 4, vibratoDepth: 0.11, vibratoRate: 5.5 }, // E4
    { start: 2.35, end: 3.45, midi: 67, glideFrom: 64, glideDuration: 0.2, driftCents: 9, vibratoDepth: 0.14, vibratoRate: 5.7 }, // G4
    // Short breath
    { start: 3.9, end: 4.95, midi: 69, driftCents: 16, vibratoDepth: 0.13, vibratoRate: 5.6 }, // A4 (slightly sharp)
    { start: 4.95, end: 5.75, midi: 67, glideFrom: 69, glideDuration: 0.15, driftCents: -3, vibratoDepth: 0.09, vibratoRate: 5.3 }, // G4
    { start: 5.75, end: 7.25, midi: 72, glideFrom: 67, glideDuration: 0.24, driftCents: 2, vibratoDepth: 0.16, vibratoRate: 5.8 }, // C5 (sustained high note)
    // Short breath
    { start: 7.65, end: 8.35, midi: 71, driftCents: -42, vibratoDepth: 0.09, vibratoRate: 5.1 }, // B4 (held between A♯4 and B4)
    { start: 8.35, end: 9.05, midi: 69, glideFrom: 70.58, glideDuration: 0.14, driftCents: 3, vibratoDepth: 0.1, vibratoRate: 5.4 }, // A4 (glides down from the flat B4)
    { start: 9.05, end: 10.2, midi: 67, glideFrom: 69, glideDuration: 0.18, driftCents: 40, vibratoDepth: 0.14, vibratoRate: 5.5 }, // G4 (held between G4 and G♯4)
  ]

  const samples: PitchSample[] = []
  const dt = 1 / 45 // ~45 fps
  const totalDuration = 10.6

  for (let t = 0; t <= totalDuration; t += dt) {
    const seg = segments.find((s) => t >= s.start && t <= s.end)
    if (!seg) {
      samples.push({
        time: Number(t.toFixed(3)),
        frequency: null,
        midi: null,
        clarity: 0,
        rms: 0.002,
      })
      continue
    }

    const localT = t - seg.start
    const duration = seg.end - seg.start
    let midi = seg.midi

    // Smooth portamento glide at onset
    if (seg.glideFrom !== undefined && seg.glideDuration && localT < seg.glideDuration) {
      const p = localT / seg.glideDuration
      const eased = p * p * (3 - 2 * p)
      midi = seg.glideFrom + (seg.midi - seg.glideFrom) * eased
    }

    // Subtle human intonation drift
    const drift = ((seg.driftCents ?? 0) / 100) * (0.7 + 0.3 * Math.sin(localT * 2.1))

    // Natural vocal vibrato ramps in after ~0.22s
    const vibratoEnv = Math.max(0, Math.min(1, (localT - 0.18) / 0.3))
    const vibrato =
      vibratoEnv *
      (seg.vibratoDepth ?? 0.1) *
      Math.sin(2 * Math.PI * (seg.vibratoRate ?? 5.5) * localT)

    const finalMidi = midi + drift + vibrato
    const freq = midiToFrequency(finalMidi, a4Hz)
    const phraseEnv = Math.sin(Math.PI * Math.min(1, localT / duration))

    samples.push({
      time: Number(t.toFixed(3)),
      frequency: freq,
      midi: finalMidi,
      clarity: 0.94,
      rms: 0.08 + 0.12 * phraseEnv,
    })
  }

  return samples
}
