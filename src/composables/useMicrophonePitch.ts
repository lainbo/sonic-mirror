import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import {
  describePitchFromFrequency,
  describePitchFromMidi,
  frequencyToMidi,
  type PitchInfo,
  type PitchSample,
} from '../audio/pitchMath'
import { detectPitchYin } from '../audio/yinDetector'
import { generateDemoVocalPhrase } from '../audio/demoPhrase'

const MAX_SAMPLES = 30000 // ~8 minutes at ~60Hz sampling
// One analysis and one sample per 60Hz frame; 120Hz displays analyze every other frame
const ANALYSIS_INTERVAL_MS = 15

export function useMicrophonePitch(a4Hz: Ref<number>) {
  const isListening = ref(false)
  const isDemo = ref(false)
  const errorMessage = ref<string | null>(null)
  const inputLevel = ref(0) // 0..1 normalized meter
  const clarity = ref(0)
  const currentTime = ref(0)
  const currentPitch = ref<PitchInfo | null>(null)
  const lastStablePitch = ref<PitchInfo | null>(null)

  // Raw sample array kept out of deep reactivity for smooth 60fps canvas rendering
  const samples = shallowRef<PitchSample[]>([])
  const sampleVersion = ref(0)

  let audioCtx: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let timeDomainBuffer: Float32Array<ArrayBuffer> | null = null
  let rafId: number | null = null

  let sessionBaseTime = 0
  let segmentStartPerf = 0
  let lastAnalysisPerf = 0
  let recentMidis: number[] = []
  let smoothedMidi: number | null = null
  let silenceFrames = 0

  // Recalculate MIDI/pitch description if A4 calibration changes
  watch(a4Hz, (newA4) => {
    if (samples.value.length > 0) {
      for (const s of samples.value) {
        if (s.frequency !== null) {
          s.midi = frequencyToMidi(s.frequency, newA4)
        }
      }
      sampleVersion.value++
    }
    if (currentPitch.value) {
      currentPitch.value = describePitchFromFrequency(currentPitch.value.frequency, newA4)
    }
    if (lastStablePitch.value) {
      lastStablePitch.value = describePitchFromFrequency(lastStablePitch.value.frequency, newA4)
    }
  })

  const voicedRange = computed(() => {
    // Depend on sampleVersion so it updates incrementally without deep watching
    void sampleVersion.value
    const list = samples.value
    let minMidi = Infinity
    let maxMidi = -Infinity
    let voicedCount = 0

    for (let i = 0; i < list.length; i++) {
      const m = list[i]!.midi
      if (m !== null) {
        voicedCount++
        if (m < minMidi) minMidi = m
        if (m > maxMidi) maxMidi = m
      }
    }

    if (voicedCount === 0) {
      return null
    }

    return {
      min: describePitchFromMidi(minMidi, a4Hz.value),
      max: describePitchFromMidi(maxMidi, a4Hz.value),
      semitoneSpan: Math.max(0, Math.round(maxMidi) - Math.round(minMidi)),
      voicedCount,
    }
  })

  function medianOfThree(a: number, b: number, c: number): number {
    if ((a >= b && a <= c) || (a <= b && a >= c)) return a
    if ((b >= a && b <= c) || (b <= a && b >= c)) return b
    return c
  }

  function processFrame(now: number) {
    if (!isListening.value || !analyser || !timeDomainBuffer || !audioCtx) return
    rafId = window.requestAnimationFrame(processFrame)

    const elapsed = sessionBaseTime + (now - segmentStartPerf) / 1000
    currentTime.value = elapsed

    if (now - lastAnalysisPerf < ANALYSIS_INTERVAL_MS) return
    lastAnalysisPerf = now

    analyser.getFloatTimeDomainData(timeDomainBuffer)
    const detection = detectPitchYin(timeDomainBuffer, audioCtx.sampleRate, {
      minFrequency: 65,
      maxFrequency: 1180,
      threshold: 0.14,
      rmsThreshold: 0.0085,
    })

    // Smooth VU meter visually
    const normalizedRms = Math.min(1, Math.pow(detection.rms * 6.5, 0.72))
    inputLevel.value = inputLevel.value * 0.65 + normalizedRms * 0.35

    let pitch: PitchInfo | null = null

    if (detection.frequency !== null && detection.clarity >= 0.76) {
      silenceFrames = 0
      const rawMidi = frequencyToMidi(detection.frequency, a4Hz.value)

      // Keep short 3-sample median window to suppress single-frame consonant glitches
      recentMidis.push(rawMidi)
      if (recentMidis.length > 3) recentMidis.shift()

      const filteredMidi =
        recentMidis.length === 3
          ? medianOfThree(recentMidis[0]!, recentMidis[1]!, recentMidis[2]!)
          : rawMidi

      // Smooth gently while preserving vocal vibrato and runs
      if (smoothedMidi === null || Math.abs(filteredMidi - smoothedMidi) > 1.8) {
        smoothedMidi = filteredMidi
      } else {
        smoothedMidi = smoothedMidi * 0.32 + filteredMidi * 0.68
      }

      clarity.value = detection.clarity

      // Frequency follows the smoothed pitch so Hz, cents and the drawn curve agree,
      // and A4 recalibration (which re-derives midi from frequency) keeps the filtering
      pitch = describePitchFromMidi(smoothedMidi, a4Hz.value)
      currentPitch.value = pitch
      lastStablePitch.value = pitch
    } else {
      silenceFrames++
      clarity.value = 0
      if (silenceFrames >= 3) {
        recentMidis = []
        smoothedMidi = null
        currentPitch.value = null
      }
    }

    const list = samples.value
    list.push({
      time: elapsed,
      frequency: pitch?.frequency ?? null,
      midi: pitch?.midi ?? null,
      clarity: detection.clarity,
      rms: detection.rms,
    })
    if (list.length > MAX_SAMPLES) {
      list.splice(0, list.length - MAX_SAMPLES)
    }
    sampleVersion.value++
  }

  async function start(): Promise<boolean> {
    errorMessage.value = null

    if (isListening.value) return true

    if (!navigator.mediaDevices?.getUserMedia) {
      errorMessage.value = '当前浏览器不支持麦克风访问，请在 HTTPS 或 localhost 环境下使用现代浏览器。'
      return false
    }

    try {
      // If switching from demo preview to live mic, clear demo data first
      if (isDemo.value) {
        clear()
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new AudioCtx()
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume()
      }

      mediaStream = stream
      sourceNode = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 4096
      analyser.smoothingTimeConstant = 0

      sourceNode.connect(analyser)
      timeDomainBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))

      // If resuming after a pause, add a brief silence break so curves don't connect across pause
      if (samples.value.length > 0) {
        const lastT = samples.value[samples.value.length - 1]!.time
        sessionBaseTime = lastT + 0.35
        samples.value.push({
          time: lastT + 0.12,
          frequency: null,
          midi: null,
          clarity: 0,
          rms: 0,
        })
      } else {
        sessionBaseTime = 0
      }

      segmentStartPerf = performance.now()
      lastAnalysisPerf = 0
      recentMidis = []
      smoothedMidi = null
      silenceFrames = 0
      isDemo.value = false
      isListening.value = true

      rafId = window.requestAnimationFrame(processFrame)
      return true
    } catch (err) {
      cleanupAudio()
      const domErr = err as DOMException | undefined
      if (domErr?.name === 'NotAllowedError' || domErr?.name === 'PermissionDeniedError') {
        errorMessage.value = '麦克风权限被拒绝。请在浏览器地址栏允许麦克风访问后重试。'
      } else if (domErr?.name === 'NotFoundError' || domErr?.name === 'DevicesNotFoundError') {
        errorMessage.value = '未检测到可用的麦克风设备，请检查音频输入连接。'
      } else {
        errorMessage.value = `无法启动麦克风：${domErr?.message ?? '未知音频设备错误'}`
      }
      return false
    }
  }

  function cleanupAudio() {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
    if (sourceNode) {
      sourceNode.disconnect()
      sourceNode = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop()
      }
      mediaStream = null
    }
    if (audioCtx) {
      void audioCtx.close()
      audioCtx = null
    }
    timeDomainBuffer = null
  }

  function stop() {
    if (!isListening.value) return
    isListening.value = false
    sessionBaseTime = currentTime.value
    inputLevel.value = 0
    clarity.value = 0
    currentPitch.value = null
    cleanupAudio()
  }

  function clear() {
    samples.value = []
    sampleVersion.value++
    sessionBaseTime = 0
    currentTime.value = 0
    currentPitch.value = null
    lastStablePitch.value = null
    recentMidis = []
    smoothedMidi = null
    isDemo.value = false
    errorMessage.value = null
    if (isListening.value) {
      segmentStartPerf = performance.now()
    }
  }

  function loadDemo() {
    stop()
    errorMessage.value = null
    const demoData = generateDemoVocalPhrase(a4Hz.value)
    samples.value = demoData
    sampleVersion.value++
    const last = demoData[demoData.length - 1]
    currentTime.value = last ? last.time : 0
    sessionBaseTime = currentTime.value
    // Highlight last voiced note in the readout
    for (let i = demoData.length - 1; i >= 0; i--) {
      if (demoData[i]!.midi !== null) {
        lastStablePitch.value = describePitchFromMidi(
          demoData[i]!.midi!,
          a4Hz.value,
          demoData[i]!.frequency ?? undefined,
        )
        break
      }
    }
    isDemo.value = true
  }

  onBeforeUnmount(() => {
    stop()
  })

  return {
    isListening,
    isDemo,
    errorMessage,
    inputLevel,
    clarity,
    currentTime,
    currentPitch,
    lastStablePitch,
    samples,
    sampleVersion,
    voicedRange,
    start,
    stop,
    clear,
    loadDemo,
  }
}
