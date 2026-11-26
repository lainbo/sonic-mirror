<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  describePitchFromMidi,
  firstSampleIndexAt,
  formatCents,
  formatTimestamp,
  isBlackKey,
  midiToFrequency,
  midiToNoteParts,
  PHRASE_GAP_SECONDS,
  type PitchInfo,
  type PitchSample,
} from '../audio/pitchMath'
import { findBetweenKeyNotes } from '../audio/betweenKeyNotes'

export interface HoverInspection {
  pitch: PitchInfo
  time: number
  canvasX: number
  canvasY: number
}

interface Props {
  samples: PitchSample[]
  sampleVersion: number
  isListening: boolean
  isDemo: boolean
  currentTime: number
  windowSeconds: number
  a4Hz: number
  autoFollow: boolean
  referenceMidi: number | null
  errorMessage: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  hover: [info: { pitch: PitchInfo; time: number } | null]
  startMic: []
  loadDemo: []
  auditionMidi: [midi: number]
  'update:autoFollow': [value: boolean]
}>()

const containerRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

// Layout constants
const AXIS_WIDTH = 58
const TOP_PAD = 16
const BOTTOM_PAD = 28
const RIGHT_PAD = 18

// Viewport pitch range in MIDI units: 2 octaves + 2 while following the voice,
// smaller rows showing 3 octaves + 4 when browsing freely
const FOLLOW_SEMITONES = 26
const BROWSE_SEMITONES = 40
const MIN_MIDI_BOUND = 34 // ~A#1
const MAX_MIDI_BOUND = 90 // ~F#6

const centerMidi = ref(62) // D4 center -> ~C3 to E5 initially
const targetCenterMidi = ref(62)
const timeOffset = ref(0) // Seconds panned back from live edge (0 = live)

// Pointer & hover state
const hoveredInspection = ref<HoverInspection | null>(null)
const pointerPos = ref<{ x: number; y: number } | null>(null)
const isDraggingTime = ref(false)
const isDraggingPitch = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragStartTimeOffset = 0
let dragStartCenterMidi = 62

let canvasWidth = 800
let canvasHeight = 420
let resizeObserver: ResizeObserver | null = null
let drawRafId: number | null = null

const visibleSemitones = computed(() => (props.autoFollow ? FOLLOW_SEMITONES : BROWSE_SEMITONES))
const isEmpty = computed(() => props.samples.length === 0 && !props.isListening)
const isPannedAway = computed(() => timeOffset.value > 0.15)

const maxRecordedTime = computed(() => {
  void props.sampleVersion
  const list = props.samples
  const lastSampleT = list.length > 0 ? list[list.length - 1]!.time : 0
  return Math.max(props.currentTime, lastSampleT)
})

function getTimeBounds(): { startTime: number; endTime: number } {
  const maxT = maxRecordedTime.value
  const endTime = Math.max(props.windowSeconds, maxT - timeOffset.value)
  const startTime = endTime - props.windowSeconds
  return { startTime, endTime }
}

function getMidiBounds(): { minMidi: number; maxMidi: number } {
  const half = visibleSemitones.value / 2
  return {
    minMidi: centerMidi.value - half,
    maxMidi: centerMidi.value + half,
  }
}

function timeToX(t: number, startTime: number, endTime: number): number {
  const plotW = Math.max(1, canvasWidth - AXIS_WIDTH - RIGHT_PAD)
  return AXIS_WIDTH + ((t - startTime) / (endTime - startTime)) * plotW
}

function xToTime(x: number, startTime: number, endTime: number): number {
  const plotW = Math.max(1, canvasWidth - AXIS_WIDTH - RIGHT_PAD)
  return startTime + ((x - AXIS_WIDTH) / plotW) * (endTime - startTime)
}

function midiToY(midi: number, minMidi: number, maxMidi: number): number {
  const plotH = Math.max(1, canvasHeight - TOP_PAD - BOTTOM_PAD)
  const ratio = (midi - minMidi) / (maxMidi - minMidi)
  return TOP_PAD + (1 - ratio) * plotH
}

function yToMidi(y: number, minMidi: number, maxMidi: number): number {
  const plotH = Math.max(1, canvasHeight - TOP_PAD - BOTTOM_PAD)
  const ratio = 1 - (y - TOP_PAD) / plotH
  return minMidi + ratio * (maxMidi - minMidi)
}

const TRACE = { line: '#4FD1A5', glow: 'rgba(79, 209, 165, 0.18)', halo: 'rgba(79, 209, 165, 0.24)' }
const OFF_KEY = { line: '#EE7863', glow: 'rgba(238, 120, 99, 0.2)', halo: 'rgba(238, 120, 99, 0.26)' }

function formatOffKey(cents: number): string {
  return `${cents > 0 ? '偏高' : '偏低'} ${Math.abs(cents)}¢`
}

// 琴缝音 overlapping the visible time window
const betweenKeyNotes = computed(() => {
  void props.sampleVersion
  const { startTime, endTime } = getTimeBounds()
  return findBetweenKeyNotes(props.samples, startTime, endTime)
})

const hoveredBetweenKeyNote = computed(() => {
  const h = hoveredInspection.value
  if (!h) return null
  return betweenKeyNotes.value.find((n) => h.time >= n.startTime && h.time <= n.endTime) ?? null
})

function clampCenterMidi(val: number): number {
  const half = visibleSemitones.value / 2
  return Math.max(MIN_MIDI_BOUND + half, Math.min(MAX_MIDI_BOUND - half, val))
}

function clampTimeOffset(val: number): number {
  const maxPan = Math.max(0, maxRecordedTime.value - props.windowSeconds)
  return Math.max(0, Math.min(maxPan, val))
}

function jumpToLive() {
  timeOffset.value = 0
  scheduleDraw()
}

// Reset pan & fit view when demo loads or samples clear
watch(
  () => props.isDemo,
  (demo) => {
    if (demo) {
      timeOffset.value = 0
      centerMidi.value = 66 // Center neatly around C4–C5 demo phrase
      targetCenterMidi.value = 66
      scheduleDraw()
    }
  },
)

watch(
  () => props.sampleVersion,
  () => {
    // Auto-follow vertical center gently when singing live
    if (props.autoFollow && props.isListening && props.samples.length > 0) {
      const latest = props.samples[props.samples.length - 1]!
      if (latest.midi !== null) {
        const margin = visibleSemitones.value * 0.28
        if (Math.abs(latest.midi - targetCenterMidi.value) > margin) {
          targetCenterMidi.value = clampCenterMidi(latest.midi)
        }
      }
    }
    if (props.samples.length === 0) {
      timeOffset.value = 0
      hoveredInspection.value = null
      emit('hover', null)
    }
    scheduleDraw()
  },
)

// The visible span changes with auto-follow: ease the view back inside the pitch bounds
watch(
  () => props.autoFollow,
  () => {
    targetCenterMidi.value = clampCenterMidi(targetCenterMidi.value)
    scheduleDraw()
  },
)

// Scroll the live time axis every display frame, not only when a sample lands
watch(() => props.currentTime, scheduleDraw)

watch(
  () => [props.windowSeconds, props.referenceMidi, props.a4Hz, props.isListening],
  () => {
    timeOffset.value = clampTimeOffset(timeOffset.value)
    // Also bring reference note into view if autoFollow is on and user presses a distant piano key
    if (props.referenceMidi !== null && props.autoFollow && !props.isListening) {
      const { minMidi, maxMidi } = getMidiBounds()
      if (props.referenceMidi < minMidi + 2 || props.referenceMidi > maxMidi - 2) {
        targetCenterMidi.value = clampCenterMidi(props.referenceMidi)
      }
    }
    scheduleDraw()
  },
)

function updateHoverFromPointer(x: number, y: number) {
  if (x < AXIS_WIDTH || x > canvasWidth - RIGHT_PAD || y < TOP_PAD || y > canvasHeight - BOTTOM_PAD) {
    if (hoveredInspection.value !== null) {
      hoveredInspection.value = null
      emit('hover', null)
    }
    return
  }

  const list = props.samples
  if (list.length === 0) {
    hoveredInspection.value = null
    emit('hover', null)
    return
  }

  const { startTime, endTime } = getTimeBounds()
  const { minMidi, maxMidi } = getMidiBounds()
  const cursorTime = xToTime(x, startTime, endTime)
  const plotW = Math.max(1, canvasWidth - AXIS_WIDTH - RIGHT_PAD)
  const snapSeconds = (24 / plotW) * (endTime - startTime)

  const lo = firstSampleIndexAt(list, cursorTime - snapSeconds)

  let bestSample: PitchSample | null = null
  let bestScore = Infinity

  for (let i = Math.max(0, lo - 1); i < list.length; i++) {
    const s = list[i]!
    if (s.time > cursorTime + snapSeconds) break
    if (s.midi === null) continue

    const sx = timeToX(s.time, startTime, endTime)
    const sy = midiToY(s.midi, minMidi, maxMidi)
    const dx = Math.abs(sx - x)
    const dy = Math.abs(sy - y)
    // Prioritize horizontal alignment strongly while giving vertical tie-breaking
    const score = dx + dy * 0.14
    if (score < bestScore && dx <= 24) {
      bestScore = score
      bestSample = s
    }
  }

  if (bestSample && bestSample.midi !== null) {
    const pitch = describePitchFromMidi(
      bestSample.midi,
      props.a4Hz,
      bestSample.frequency ?? undefined,
    )
    const sx = timeToX(bestSample.time, startTime, endTime)
    const sy = midiToY(bestSample.midi, minMidi, maxMidi)
    hoveredInspection.value = {
      pitch,
      time: bestSample.time,
      canvasX: sx,
      canvasY: sy,
    }
    emit('hover', { pitch, time: bestSample.time })
  } else {
    if (hoveredInspection.value !== null) {
      hoveredInspection.value = null
      emit('hover', null)
    }
  }
}

function handlePointerDown(e: PointerEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top

  if (x < AXIS_WIDTH) {
    // Clicking or dragging on the left piano-roll axis: audition note on click, or drag vertical range
    isDraggingPitch.value = true
    dragStartY = y
    dragStartCenterMidi = centerMidi.value
    canvas.setPointerCapture(e.pointerId)
    return
  }

  if (props.samples.length > 0) {
    isDraggingTime.value = true
    dragStartX = x
    dragStartTimeOffset = timeOffset.value
    canvas.setPointerCapture(e.pointerId)
  }
}

function handlePointerMove(e: PointerEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  pointerPos.value = { x, y }

  if (isDraggingPitch.value) {
    const dy = y - dragStartY
    const plotH = Math.max(1, canvasHeight - TOP_PAD - BOTTOM_PAD)
    const deltaSemitones = (dy / plotH) * visibleSemitones.value
    if (Math.abs(dy) > 4 && props.autoFollow) {
      emit('update:autoFollow', false)
    }
    const nextCenter = clampCenterMidi(dragStartCenterMidi + deltaSemitones)
    centerMidi.value = nextCenter
    targetCenterMidi.value = nextCenter
    scheduleDraw()
    return
  }

  if (isDraggingTime.value) {
    const dx = x - dragStartX
    const plotW = Math.max(1, canvasWidth - AXIS_WIDTH - RIGHT_PAD)
    const deltaSeconds = (dx / plotW) * props.windowSeconds
    timeOffset.value = clampTimeOffset(dragStartTimeOffset + deltaSeconds)
    updateHoverFromPointer(x, y)
    scheduleDraw()
    return
  }

  updateHoverFromPointer(x, y)
  scheduleDraw()
}

function handlePointerUp(e: PointerEvent) {
  const canvas = canvasRef.value
  if (isDraggingPitch.value && canvas) {
    const rect = canvas.getBoundingClientRect()
    const y = e.clientY - rect.top
    if (Math.abs(y - dragStartY) < 4) {
      // Short click on piano-roll axis auditions that exact pitch
      const { minMidi, maxMidi } = getMidiBounds()
      const clickedMidi = Math.round(yToMidi(y, minMidi, maxMidi))
      emit('auditionMidi', clickedMidi)
    }
  }
  isDraggingPitch.value = false
  isDraggingTime.value = false
}

function handlePointerLeave() {
  pointerPos.value = null
  isDraggingPitch.value = false
  isDraggingTime.value = false
  if (hoveredInspection.value !== null) {
    hoveredInspection.value = null
    emit('hover', null)
  }
  scheduleDraw()
}

function handleWheel(e: WheelEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
  // The wheel pans time while following the voice and scrolls pitch when browsing freely;
  // Shift switches to the other axis, and the key column always scrolls pitch
  const scrollPitch =
    x < AXIS_WIDTH || (props.autoFollow ? e.shiftKey : !e.shiftKey && !horizontal)

  if (scrollPitch) {
    // Vertical pitch range scroll
    e.preventDefault()
    if (props.autoFollow) emit('update:autoFollow', false)
    const step = (e.deltaY / 100) * 1.4
    const next = clampCenterMidi(centerMidi.value - step)
    centerMidi.value = next
    targetCenterMidi.value = next
    scheduleDraw()
    return
  }

  if (horizontal || props.samples.length > 0) {
    e.preventDefault()
    const delta = horizontal ? e.deltaX : e.deltaY
    const secondsDelta = (delta / 360) * props.windowSeconds
    timeOffset.value = clampTimeOffset(timeOffset.value - secondsDelta)
    if (pointerPos.value) {
      updateHoverFromPointer(pointerPos.value.x, pointerPos.value.y)
    }
    scheduleDraw()
  }
}

function scheduleDraw() {
  if (drawRafId !== null) return
  drawRafId = window.requestAnimationFrame(renderCanvas)
}

function renderCanvas() {
  drawRafId = null
  const canvas = canvasRef.value
  if (!canvas) return

  // Smooth vertical auto-follow easing
  const diff = targetCenterMidi.value - centerMidi.value
  if (Math.abs(diff) > 0.02) {
    centerMidi.value += diff * 0.14
    scheduleDraw()
  } else {
    centerMidi.value = targetCenterMidi.value
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const targetW = Math.floor(canvasWidth * dpr)
  const targetH = Math.floor(canvasHeight * dpr)
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW
    canvas.height = targetH
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.save()
  ctx.scale(dpr, dpr)

  const { startTime, endTime } = getTimeBounds()
  const { minMidi, maxMidi } = getMidiBounds()
  const plotW = Math.max(1, canvasWidth - AXIS_WIDTH - RIGHT_PAD)
  const plotH = Math.max(1, canvasHeight - TOP_PAD - BOTTOM_PAD)
  const semitonePx = plotH / (maxMidi - minMidi)

  // 1. Background well
  ctx.fillStyle = '#0B0F14'
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)

  // 2. Horizontal piano-roll pitch lanes (clipped to plot area)
  ctx.save()
  ctx.beginPath()
  ctx.rect(AXIS_WIDTH, TOP_PAD, plotW, plotH)
  ctx.clip()

  const lowNote = Math.floor(minMidi) - 1
  const highNote = Math.ceil(maxMidi) + 1

  for (let m = lowNote; m <= highNote; m++) {
    const yCenter = midiToY(m, minMidi, maxMidi)
    const yTop = yCenter - semitonePx / 2
    const black = isBlackKey(m)
    const isC = ((m % 12) + 12) % 12 === 0

    ctx.fillStyle = black ? '#0A0E13' : '#0F151D'
    ctx.fillRect(AXIS_WIDTH, yTop, plotW, semitonePx)

    // Semitone center hairline
    ctx.beginPath()
    ctx.moveTo(AXIS_WIDTH, yCenter)
    ctx.lineTo(AXIS_WIDTH + plotW, yCenter)
    if (isC) {
      ctx.strokeStyle = 'rgba(228, 182, 83, 0.24)'
      ctx.lineWidth = 1
    } else {
      ctx.strokeStyle = black ? 'rgba(255, 255, 255, 0.025)' : 'rgba(255, 255, 255, 0.055)'
      ctx.lineWidth = 1
    }
    ctx.stroke()
  }

  // 3. Vertical time grid lines
  const gridStep = props.windowSeconds <= 6 ? 1 : props.windowSeconds <= 12 ? 2 : 4
  const firstGridT = Math.ceil(startTime / gridStep) * gridStep
  ctx.strokeStyle = 'rgba(165, 178, 194, 0.09)'
  ctx.lineWidth = 1
  for (let t = firstGridT; t <= endTime; t += gridStep) {
    if (t < 0) continue
    const gx = Math.round(timeToX(t, startTime, endTime)) + 0.5
    ctx.beginPath()
    ctx.moveTo(gx, TOP_PAD)
    ctx.lineTo(gx, TOP_PAD + plotH)
    ctx.stroke()
  }

  // 4. Reference piano target band & dashed guide line
  if (props.referenceMidi !== null) {
    const refY = midiToY(props.referenceMidi, minMidi, maxMidi)
    if (refY >= TOP_PAD - 20 && refY <= TOP_PAD + plotH + 20) {
      const corridorH = semitonePx * 0.24 // ±12 cents sweet spot
      ctx.fillStyle = 'rgba(228, 182, 83, 0.10)'
      ctx.fillRect(AXIS_WIDTH, refY - corridorH / 2, plotW, corridorH)

      ctx.save()
      ctx.setLineDash([6, 5])
      ctx.strokeStyle = 'rgba(228, 182, 83, 0.85)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(AXIS_WIDTH, refY)
      ctx.lineTo(AXIS_WIDTH + plotW, refY)
      ctx.stroke()
      ctx.restore()

      // Reference badge on right edge
      const refParts = midiToNoteParts(props.referenceMidi)
      const refFreq = midiToFrequency(props.referenceMidi, props.a4Hz).toFixed(0)
      const label = `目标 ${refParts.displayFullName} · ${refFreq}Hz`
      ctx.font = '600 11px "Plus Jakarta Sans", -apple-system, sans-serif'
      const tw = ctx.measureText(label).width
      const bx = AXIS_WIDTH + plotW - tw - 18
      const by = Math.max(TOP_PAD + 4, Math.min(TOP_PAD + plotH - 22, refY - 22))
      ctx.fillStyle = 'rgba(23, 31, 40, 0.92)'
      ctx.strokeStyle = 'rgba(228, 182, 83, 0.7)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(bx, by, tw + 14, 20, 5)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#E4B653'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, bx + 7, by + 10.5)
    }
  }

  // 5. Pitch trajectory curve
  const list = props.samples
  if (list.length > 0) {
    const startIdx = firstSampleIndexAt(list, startTime - 0.3)

    // Group into continuous voiced phrases
    type Pt = { x: number; y: number; midi: number; time: number }
    const phrases: Pt[][] = []
    let currentPhrase: Pt[] = []
    let prevSample: PitchSample | null = null

    for (let i = Math.max(0, startIdx - 1); i < list.length; i++) {
      const s = list[i]!
      if (s.time > endTime + 0.3) break

      if (s.midi === null) {
        if (currentPhrase.length > 0) {
          phrases.push(currentPhrase)
          currentPhrase = []
        }
        prevSample = s
        continue
      }

      const broken =
        prevSample !== null &&
        prevSample.midi !== null &&
        (s.time - prevSample.time > PHRASE_GAP_SECONDS || Math.abs(s.midi - prevSample.midi) > 9)

      if (broken && currentPhrase.length > 0) {
        phrases.push(currentPhrase)
        currentPhrase = []
      }

      const x = timeToX(s.time, startTime, endTime)
      const y = midiToY(s.midi, minMidi, maxMidi)
      currentPhrase.push({ x, y, midi: s.midi, time: s.time })
      prevSample = s
    }

    if (currentPhrase.length > 0) {
      phrases.push(currentPhrase)
    }

    // Build each phrase as a smooth quadratic spline once; single samples become dots
    const tracePaths: Path2D[] = []
    for (const phrase of phrases) {
      if (phrase.length === 1) {
        const p = phrase[0]!
        ctx.fillStyle = TRACE.line
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
        ctx.fill()
        continue
      }

      const path = new Path2D()
      path.moveTo(phrase[0]!.x, phrase[0]!.y)
      for (let i = 1; i < phrase.length; i++) {
        const prev = phrase[i - 1]!
        const curr = phrase[i]!
        path.quadraticCurveTo(prev.x, prev.y, (prev.x + curr.x) / 2, (prev.y + curr.y) / 2)
      }
      const last = phrase[phrase.length - 1]!
      path.lineTo(last.x, last.y)
      tracePaths.push(path)
    }

    const strokeTrace = (palette: typeof TRACE) => {
      for (const path of tracePaths) {
        ctx.strokeStyle = palette.glow
        ctx.lineWidth = 8
        ctx.stroke(path)
        ctx.strokeStyle = palette.line
        ctx.lineWidth = 2.6
        ctx.stroke(path)
      }
    }

    // 琴缝音: shade the gap between the nearest key and the sung pitch, dash the key line
    const offKeyNotes = betweenKeyNotes.value
    const offKeySpans = new Path2D()
    for (const note of offKeyNotes) {
      const x0 = timeToX(note.startTime, startTime, endTime)
      const x1 = timeToX(note.endTime, startTime, endTime)
      const keyY = midiToY(note.nearestMidi, minMidi, maxMidi)
      const sungY = midiToY(note.centerMidi, minMidi, maxMidi)
      offKeySpans.rect(x0, TOP_PAD, x1 - x0, plotH)

      ctx.fillStyle = 'rgba(238, 120, 99, 0.16)'
      ctx.fillRect(x0, Math.min(keyY, sungY), x1 - x0, Math.abs(sungY - keyY))

      ctx.save()
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = 'rgba(238, 120, 99, 0.75)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x0, keyY)
      ctx.lineTo(x1, keyY)
      ctx.stroke()
      ctx.restore()
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Regular trace everywhere except 琴缝音 spans, which are stroked in the warning color
    const outsideOffKey = new Path2D()
    outsideOffKey.rect(AXIS_WIDTH, TOP_PAD, plotW, plotH)
    outsideOffKey.addPath(offKeySpans)
    ctx.save()
    ctx.clip(outsideOffKey, 'evenodd')
    strokeTrace(TRACE)
    ctx.restore()

    if (offKeyNotes.length > 0) {
      ctx.save()
      ctx.clip(offKeySpans)
      strokeTrace(OFF_KEY)
      ctx.restore()

      // Offset badge on the far side of the curve from the key line, skipped when crowded
      ctx.font = '600 10.5px "Plus Jakarta Sans", -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const badgeH = 18
      const clearance = semitonePx * 0.6 + 4
      let lastBadgeRight = -Infinity
      for (const note of offKeyNotes) {
        const x0 = timeToX(note.startTime, startTime, endTime)
        const x1 = timeToX(note.endTime, startTime, endTime)
        const sungY = midiToY(note.centerMidi, minMidi, maxMidi)
        if (x1 < AXIS_WIDTH || x0 > AXIS_WIDTH + plotW || sungY < TOP_PAD || sungY > TOP_PAD + plotH) {
          continue
        }

        const label = formatOffKey(note.cents)
        const badgeW = ctx.measureText(label).width + 12
        const bx = Math.max(
          AXIS_WIDTH + 2,
          Math.min(AXIS_WIDTH + plotW - badgeW - 2, (x0 + x1) / 2 - badgeW / 2),
        )
        if (bx < lastBadgeRight + 4) continue
        const by = note.cents > 0 ? sungY - clearance - badgeH : sungY + clearance

        ctx.fillStyle = 'rgba(23, 31, 40, 0.92)'
        ctx.strokeStyle = OFF_KEY.line
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(bx, by, badgeW, badgeH, 5)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = OFF_KEY.line
        ctx.fillText(label, bx + badgeW / 2, by + badgeH / 2 + 0.5)
        lastBadgeRight = bx + badgeW
      }
    }

    // Live playhead beacon on the latest voiced point, in the warning color while held off-key
    if (props.isListening && timeOffset.value < 0.1) {
      const tail = list[list.length - 1]
      if (tail && tail.midi !== null) {
        const lx = timeToX(tail.time, startTime, endTime)
        const ly = midiToY(tail.midi, minMidi, maxMidi)
        const palette = offKeyNotes.at(-1)?.endTime === tail.time ? OFF_KEY : TRACE

        ctx.beginPath()
        ctx.arc(lx, ly, 9, 0, Math.PI * 2)
        ctx.fillStyle = palette.halo
        ctx.fill()

        ctx.beginPath()
        ctx.arc(lx, ly, 4.2, 0, Math.PI * 2)
        ctx.fillStyle = '#F2EDE4'
        ctx.fill()
        ctx.lineWidth = 2
        ctx.strokeStyle = palette.line
        ctx.stroke()
      }
    }
  }

  // 6. Hover inspection crosshair & active curve beacon
  const hover = hoveredInspection.value
  if (hover) {
    // Recompute coordinates in case of pan/scroll while hovering
    const hx = timeToX(hover.time, startTime, endTime)
    const hy = midiToY(hover.pitch.midi, minMidi, maxMidi)

    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(228, 182, 83, 0.55)'
    ctx.lineWidth = 1

    // Vertical crosshair
    ctx.beginPath()
    ctx.moveTo(hx, TOP_PAD)
    ctx.lineTo(hx, TOP_PAD + plotH)
    ctx.stroke()

    // Horizontal crosshair
    ctx.beginPath()
    ctx.moveTo(AXIS_WIDTH, hy)
    ctx.lineTo(AXIS_WIDTH + plotW, hy)
    ctx.stroke()
    ctx.restore()

    // Highlighted point ring
    const palette = hoveredBetweenKeyNote.value ? OFF_KEY : TRACE
    ctx.beginPath()
    ctx.arc(hx, hy, 10, 0, Math.PI * 2)
    ctx.fillStyle = palette.halo
    ctx.fill()

    ctx.beginPath()
    ctx.arc(hx, hy, 4.8, 0, Math.PI * 2)
    ctx.fillStyle = '#F2EDE4'
    ctx.fill()
    ctx.lineWidth = 2.2
    ctx.strokeStyle = palette.line
    ctx.stroke()
  }

  ctx.restore() // end plot clip

  // 7. Left vertical piano-roll axis
  ctx.save()
  ctx.fillStyle = '#141B23'
  ctx.fillRect(0, 0, AXIS_WIDTH, canvasHeight)

  ctx.beginPath()
  ctx.rect(0, TOP_PAD, AXIS_WIDTH, plotH)
  ctx.clip()

  const inspectedMidi = hover ? hover.pitch.nearestMidi : null
  const refMidi = props.referenceMidi

  for (let m = lowNote; m <= highNote; m++) {
    const yCenter = midiToY(m, minMidi, maxMidi)
    const yTop = yCenter - semitonePx / 2
    const black = isBlackKey(m)
    const pc = ((m % 12) + 12) % 12
    const isC = pc === 0
    const isInspected = inspectedMidi === m
    const isRef = refMidi === m

    // Key block
    if (isInspected) {
      ctx.fillStyle = 'rgba(79, 209, 165, 0.30)'
    } else if (isRef) {
      ctx.fillStyle = 'rgba(228, 182, 83, 0.28)'
    } else {
      ctx.fillStyle = black ? '#10151C' : '#1A232E'
    }
    ctx.fillRect(0, yTop + 0.5, black ? AXIS_WIDTH - 10 : AXIS_WIDTH - 1, Math.max(1, semitonePx - 1))

    // Subtle key divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, yTop)
    ctx.lineTo(AXIS_WIDTH, yTop)
    ctx.stroke()

    // Labels: Always label C notes, plus E/G/A when spacious, plus inspected/ref note
    // Avoid drawing clipped labels within 8px of top/bottom edges
    const inLabelBounds = yCenter >= TOP_PAD + 8 && yCenter <= TOP_PAD + plotH - 8
    const showLabel =
      inLabelBounds &&
      (isC ||
        isInspected ||
        isRef ||
        (semitonePx >= 15 && (pc === 4 || pc === 7 || pc === 9)))

    if (showLabel) {
      const parts = midiToNoteParts(m)
      ctx.font = isC || isInspected || isRef
        ? '600 11px "Plus Jakarta Sans", -apple-system, sans-serif'
        : '500 10px "Plus Jakarta Sans", -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      if (isInspected) {
        ctx.fillStyle = '#4FD1A5'
      } else if (isRef) {
        ctx.fillStyle = '#E4B653'
      } else if (isC) {
        ctx.fillStyle = '#F2EDE4'
      } else {
        ctx.fillStyle = '#8091A3'
      }
      ctx.fillText(parts.displayFullName, AXIS_WIDTH - 8, yCenter + 0.5)
    }
  }
  ctx.restore()

  // Axis right divider
  ctx.strokeStyle = '#273240'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(AXIS_WIDTH + 0.5, 0)
  ctx.lineTo(AXIS_WIDTH + 0.5, canvasHeight)
  ctx.stroke()

  // 8. Bottom time axis bar
  ctx.fillStyle = '#11161C'
  ctx.fillRect(AXIS_WIDTH + 1, TOP_PAD + plotH, canvasWidth - AXIS_WIDTH, BOTTOM_PAD)
  ctx.strokeStyle = '#273240'
  ctx.beginPath()
  ctx.moveTo(AXIS_WIDTH, TOP_PAD + plotH + 0.5)
  ctx.lineTo(canvasWidth, TOP_PAD + plotH + 0.5)
  ctx.stroke()

  ctx.font = '500 11px "Plus Jakarta Sans", -apple-system, sans-serif'
  ctx.fillStyle = '#8596A8'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let t = firstGridT; t <= endTime; t += gridStep) {
    if (t < 0) continue
    const gx = timeToX(t, startTime, endTime)
    if (gx < AXIS_WIDTH + 22 || gx > canvasWidth - 22) continue
    ctx.fillText(formatTimestamp(t).slice(0, 5), gx, TOP_PAD + plotH + BOTTOM_PAD / 2 + 1)
  }

  ctx.restore()
}

// Smart tooltip placement inside canvas bounds
const tooltipStyle = computed(() => {
  const h = hoveredInspection.value
  if (!h) return {}
  const tipW = 198
  const tipH = hoveredBetweenKeyNote.value ? 113 : 82
  const flipLeft = h.canvasX + tipW + 20 > canvasWidth
  const left = flipLeft
    ? Math.max(AXIS_WIDTH + 8, h.canvasX - tipW - 14)
    : Math.min(canvasWidth - tipW - 8, h.canvasX + 14)
  const flipUp = h.canvasY + tipH + 16 > canvasHeight - BOTTOM_PAD
  const top = flipUp
    ? Math.max(TOP_PAD + 6, h.canvasY - tipH - 12)
    : Math.max(TOP_PAD + 6, h.canvasY - tipH / 2)
  return {
    transform: `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`,
  }
})

onMounted(() => {
  const container = containerRef.value
  if (!container) return

  const updateSize = () => {
    const rect = container.getBoundingClientRect()
    canvasWidth = Math.max(300, Math.floor(rect.width))
    canvasHeight = Math.max(220, Math.floor(rect.height))
    scheduleDraw()
  }

  updateSize()
  resizeObserver = new ResizeObserver(updateSize)
  resizeObserver.observe(container)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (drawRafId !== null) {
    window.cancelAnimationFrame(drawRafId)
  }
})
</script>

<template>
  <section
    id="pitch-stage"
    ref="containerRef"
    class="pitch-canvas-stage"
    aria-label="实时人声音高曲线画布"
  >
    <canvas
      ref="canvasRef"
      class="pitch-canvas"
      :class="{ 'is-dragging': isDraggingTime || isDraggingPitch }"
      aria-label="人声音高随时间变化的实时曲线图，悬停曲线可查看具体音名、频率与音分偏差"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerUp"
      @pointerleave="handlePointerLeave"
      @wheel="handleWheel"
    ></canvas>

    <!-- Error alert banner -->
    <div v-if="errorMessage" role="alert" class="error-banner">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4" />
        <path d="M8 4.6v4.2M8 11.2v.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <span>{{ errorMessage }}</span>
    </div>

    <!-- Floating Hover Inspection Readout -->
    <div
      v-if="hoveredInspection"
      class="hover-tooltip"
      :style="tooltipStyle"
      role="status"
      aria-live="off"
    >
      <div class="tip-top">
        <div class="tip-note">
          <span class="tip-letter">{{ hoveredInspection.pitch.noteLetter }}</span>
          <span v-if="hoveredInspection.pitch.accidental" class="tip-acc">
            {{ hoveredInspection.pitch.accidental }}
          </span>
          <span class="tip-oct tabular">{{ hoveredInspection.pitch.octave }}</span>
          <span class="tip-solfege">
            {{ hoveredInspection.pitch.solfege }} · {{ hoveredInspection.pitch.jianpu }}
          </span>
        </div>
        <span class="tip-time tabular">{{ formatTimestamp(hoveredInspection.time) }}</span>
      </div>
      <div class="tip-bottom tabular">
        <span class="tip-freq">{{ hoveredInspection.pitch.frequency.toFixed(1) }} Hz</span>
        <span class="tip-cents">{{ formatCents(hoveredInspection.pitch.cents) }}</span>
      </div>
      <div v-if="hoveredBetweenKeyNote" class="tip-off-key">
        <span class="tip-off-key-tag">琴缝音</span>
        <span>
          平均比 {{ midiToNoteParts(hoveredBetweenKeyNote.nearestMidi).displayFullName }}
          {{ formatOffKey(hoveredBetweenKeyNote.cents) }}
        </span>
      </div>
    </div>

    <!-- Return to live pill when panned into history -->
    <button
      v-if="isPannedAway"
      type="button"
      class="live-return-btn"
      @click="jumpToLive"
    >
      回到最新时刻
    </button>

    <!-- Subtle interaction hint when curve has data -->
    <div v-if="!isEmpty && !hoveredInspection" class="canvas-hint" aria-hidden="true">
      悬停曲线查看音高 · 拖动回看历史 · 点击左侧音阶试听 · 红色段为琴缝音
    </div>

    <!-- Inviting empty state -->
    <div v-if="isEmpty" class="empty-overlay">
      <div class="empty-card">
        <h2 class="empty-title">准备聆听你的声音</h2>
        <p class="empty-desc">
          点击开始后对着麦克风哼唱或发声，画面将实时绘制音高曲线；悬停曲线任意位置可回看当时的准确音名与音分偏差，下方钢琴随时弹奏标准参考音。
        </p>
        <div class="empty-actions">
          <button type="button" class="empty-cta-primary" @click="emit('startMic')">
            开启麦克风开始检测
          </button>
          <button type="button" class="empty-cta-secondary" @click="emit('loadDemo')">
            查看示例曲线
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pitch-canvas-stage {
  position: relative;
  flex: 1 1 auto;
  min-inline-size: 0;
  min-block-size: 260px;
  background-color: var(--surface-well);
  overflow: hidden;
  user-select: none;
}

.pitch-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
}

.pitch-canvas.is-dragging {
  cursor: grabbing;
}

/* Error Banner */
.error-banner {
  position: absolute;
  top: 12px;
  left: 72px;
  right: 16px;
  z-index: 12;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.65rem 0.9rem;
  border-radius: var(--radius-sm);
  background-color: color-mix(in oklab, var(--pitch-sharp) 18%, var(--surface-panel));
  border: 1px solid var(--pitch-sharp);
  color: var(--ink-ivory);
  font-size: 0.85rem;
}

/* Floating Hover Tooltip */
.hover-tooltip {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 10;
  width: 198px;
  padding: 0.58rem 0.72rem;
  border-radius: var(--radius-md);
  background-color: color-mix(in oklab, var(--surface-panel) 94%, transparent);
  border: 1px solid var(--border-strong);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  backdrop-filter: blur(8px);
}

.tip-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.4rem;
}

.tip-note {
  display: inline-flex;
  align-items: baseline;
  gap: 0.08rem;
}

.tip-letter {
  font-family: var(--font-display);
  font-size: 1.45rem;
  font-weight: 500;
  line-height: 1;
  color: var(--ink-ivory);
}

.tip-acc {
  font-family: var(--font-display);
  font-size: 0.95rem;
  color: var(--accent-brass);
  transform: translateY(-0.35em);
}

.tip-oct {
  font-family: var(--font-display);
  font-size: 0.98rem;
  color: var(--ink-secondary);
}

.tip-solfege {
  margin-inline-start: 0.42rem;
  font-size: 0.78rem;
  color: var(--ink-secondary);
}

.tip-time {
  font-size: 0.74rem;
  color: var(--ink-muted);
}

.tip-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.35rem;
  padding-top: 0.35rem;
  border-top: 1px solid var(--border-hairline);
  font-size: 0.78rem;
}

.tip-freq {
  color: var(--ink-ivory);
  font-weight: 600;
}

.tip-cents {
  color: var(--ink-secondary);
  font-weight: 600;
}

.tip-off-key {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.35rem;
  padding-top: 0.35rem;
  border-top: 1px solid var(--border-hairline);
  font-size: 0.76rem;
  color: var(--pitch-sharp);
}

.tip-off-key-tag {
  padding: 0.04rem 0.36rem;
  border-radius: var(--radius-sm);
  background-color: var(--pitch-sharp-soft);
  border: 1px solid color-mix(in oklab, var(--pitch-sharp) 50%, transparent);
  font-weight: 600;
}

/* Return to live pill */
.live-return-btn {
  position: absolute;
  right: 18px;
  bottom: 38px;
  z-index: 8;
  min-block-size: 2rem;
  padding: 0.32rem 0.85rem;
  border-radius: var(--radius-pill);
  border: 1px solid var(--accent-brass);
  background-color: var(--surface-panel);
  color: var(--accent-brass);
  font-size: 0.8rem;
  font-weight: 600;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.canvas-hint {
  position: absolute;
  left: 70px;
  bottom: 36px;
  z-index: 4;
  padding: 0.22rem 0.6rem;
  border-radius: var(--radius-sm);
  background-color: rgba(11, 15, 20, 0.72);
  color: var(--ink-muted);
  font-size: 0.74rem;
  pointer-events: none;
}

/* Empty State Overlay */
.empty-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.25rem;
  background: radial-gradient(
    ellipse at center,
    rgba(11, 15, 20, 0.78) 0%,
    rgba(11, 15, 20, 0.32) 100%
  );
  pointer-events: none;
}

.empty-card {
  position: fixed;
  inset-block-start: 50%;
  inset-inline-start: 50%;
  translate: -50% -50%;
  inline-size: min(460px, 100vw - 2.5rem);
  padding: 1.5rem 1.7rem;
  border-radius: var(--radius-lg);
  background-color: color-mix(in oklab, var(--surface-panel) 94%, transparent);
  border: 1px solid var(--border-strong);
  box-shadow: 0 20px 44px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(10px);
  pointer-events: auto;
}

.empty-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(1.3rem, 1.15rem + 0.5vw, 1.65rem);
  font-weight: 500;
  color: var(--ink-ivory);
}

.empty-desc {
  margin: 0.6rem 0 1.2rem;
  font-size: 0.88rem;
  line-height: 1.6;
  color: var(--ink-secondary);
}

.empty-actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-wrap: wrap;
}

.empty-cta-primary {
  min-block-size: 2.45rem;
  padding: 0.5rem 1.25rem;
  border-radius: var(--radius-pill);
  border: 1px solid var(--accent-brass);
  background-color: var(--accent-brass);
  color: var(--accent-brass-ink);
  font-weight: 600;
  font-size: 0.88rem;
}

.empty-cta-secondary {
  min-block-size: 2.45rem;
  padding: 0.5rem 1.05rem;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background-color: var(--surface-raised);
  color: var(--ink-ivory);
  font-weight: 500;
  font-size: 0.88rem;
}

@media (hover: hover) {
  .empty-cta-primary:hover {
    filter: brightness(1.07);
  }
  .empty-cta-secondary:hover,
  .live-return-btn:hover {
    background-color: var(--surface-hover);
  }
}

/* The page scrolls in the stacked layout, so the card stays inside the chart there */
@media (max-width: 900px) {
  .empty-card {
    position: static;
    translate: none;
  }
}

@media (max-width: 640px) {
  .canvas-hint {
    display: none;
  }
}
</style>
