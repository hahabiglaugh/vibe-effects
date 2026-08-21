export type QualityLevel = 'high' | 'medium' | 'low'

type MonitorOptions = {
  effectName: string
  getCanvas: () => HTMLCanvasElement | null
  onQualityChange: (quality: QualityLevel) => void
}

export class PerformanceMonitor {
  private frames = 0
  private hands = 0
  private lastSample = performance.now()
  private highSamples = 0
  private timer: number | null = null
  private quality: QualityLevel = matchMedia('(pointer: coarse)').matches ? 'medium' : 'high'

  constructor(private options: MonitorOptions) {}

  start() {
    this.options.onQualityChange(this.quality)
    this.timer = window.setInterval(() => this.sample(), 5000)
    if (import.meta.env.DEV) {
      console.debug('[Vibe Effects] Device', {
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
      })
    }
  }

  frame() { this.frames += 1 }
  handInference() { this.hands += 1 }
  get currentQuality() { return this.quality }

  destroy() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  private sample() {
    const now = performance.now()
    const seconds = Math.max(.1, (now - this.lastSample) / 1000)
    const fps = this.frames / seconds
    const handHz = this.hands / seconds
    const canvas = this.options.getCanvas()
    if (import.meta.env.DEV) {
      console.debug(`[Vibe Effects]\nEffect: ${this.options.effectName}\nFPS: ${fps.toFixed(1)}\nHands: ${handHz.toFixed(1)} Hz\nCanvas: ${canvas?.width ?? 0}x${canvas?.height ?? 0}\nQuality: ${this.quality.toUpperCase()}`)
    }
    if (!document.hidden && fps < 38) {
      this.highSamples = 0
      this.setQuality(this.quality === 'high' ? 'medium' : 'low')
    } else if (!document.hidden && fps > 52) {
      this.highSamples += 1
      if (this.highSamples >= 3) {
        this.setQuality(this.quality === 'low' ? 'medium' : 'high')
        this.highSamples = 0
      }
    } else this.highSamples = 0
    this.frames = 0
    this.hands = 0
    this.lastSample = now
  }

  private setQuality(quality: QualityLevel) {
    if (quality === this.quality) return
    this.quality = quality
    this.options.onQualityChange(quality)
  }
}
