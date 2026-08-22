import type { CameraFacingMode } from '../../services/cameraService'
import type { TrackedHand } from '../../services/handTrackingService'
import type { QualityLevel } from '../../services/performanceMonitor'

type MediaType = 'image' | 'video' | null
type Point = { x: number; y: number }
type Shape = { left: Point[]; right: Point[]; polygon: Point[] }
type GripAnchor = {
  handId: number
  initialX: number
  initialY: number
  x: number
  y: number
  smoothedX: number
  smoothedY: number
  lastValidX: number
  lastValidY: number
  grabbedAt: number
  pinchDistance: number
  lostSince: number | null
  releaseSince: number | null
}

export type RealityRiftTuning = {
  grabTriggerMultiplier: number
  grabReleaseMultiplier: number
  dualGrabWindow: number
  trackingGracePeriod: number
  handSmoothing: number
  edgeFollowStrength: number
  openingGain: number
  minimumOpening: number
  maxRiftWidth: number
  heightGain: number
  riftDamping: number
  stretchStrength: number
  glowStrength: number
}

export const DEFAULT_REALITY_RIFT_TUNING: RealityRiftTuning = {
  grabTriggerMultiplier: 1.35,
  grabReleaseMultiplier: 3.3,
  dualGrabWindow: 1400,
  trackingGracePeriod: 850,
  handSmoothing: .04,
  edgeFollowStrength: .98,
  openingGain: .94,
  minimumOpening: 16,
  maxRiftWidth: .84,
  heightGain: 1.08,
  riftDamping: .82,
  stretchStrength: 1.35,
  glowStrength: 1,
}

const BASE_TRIGGER = .05
const RELEASE_DELAY = 110
const EDGE_SAMPLES = 23
const RIFT_EDGE_CORE = 'rgba(10, 16, 20, .72)'
const RIFT_EDGE_LIGHT = 'rgba(241, 247, 248, .92)'
const RIFT_EDGE_COOL = 'rgba(190, 224, 229, .32)'
const RIFT_EDGE_LAVENDER = 'rgba(220, 218, 231, .18)'
const RIFT_GLOW = 'rgba(184, 224, 229, .24)'

export class RealityRiftEffect {
  private context: CanvasRenderingContext2D
  private cameraBuffer = document.createElement('canvas')
  private cameraContext: CanvasRenderingContext2D
  private hands: TrackedHand[] = []
  private mediaType: MediaType = null
  private image: HTMLImageElement | null = null
  private video: HTMLVideoElement | null = null
  private objectUrl: string | null = null
  private width = 0
  private height = 0
  private animationFrame: number | null = null
  private destroyed = false
  private frame = 0
  private tuning = { ...DEFAULT_REALITY_RIFT_TUNING }
  private pending = new Map<number, GripAnchor>()
  private left: GripAnchor | null = null
  private right: GripAnchor | null = null
  private state: 'idle' | 'armed' | 'dual_locked' | 'closing' = 'idle'
  private initialSeparation = 0
  private currentSeparation = 0
  private targetCenterX = 0
  private targetCenterY = 0
  private targetWidth = 0
  private centerX = 0
  private centerY = 0
  private openWidth = 0
  private previousSeparation = 0
  private previousSeparationAt = 0
  private tearImpulse = 0
  private pointerActive = false
  private pointerStartX = 0
  private pointerStartY = 0
  private pointerX = 0
  private debugEnabled = false
  private leftSeeds = this.createSeeds(11.7)
  private rightSeeds = this.createSeeds(73.4)
  private hasReportedOpen = false
  private seamFadeUntil = 0
  private quality: QualityLevel = 'high'
  private paused = false

  constructor(
    private canvas: HTMLCanvasElement,
    private cameraVideo: HTMLVideoElement,
    private facingMode: CameraFacingMode,
    private onFirstOpen?: () => void,
    private onGrabStateChange?: (state: 'idle' | 'armed' | 'dual_locked' | 'closing') => void,
  ) {
    const context = canvas.getContext('2d')
    const cameraContext = this.cameraBuffer.getContext('2d')
    if (!context || !cameraContext) throw new Error('Canvas 2D context is unavailable.')
    this.context = context
    this.cameraContext = cameraContext
    canvas.style.touchAction = 'none'
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerup', this.handlePointerUp)
    canvas.addEventListener('pointercancel', this.handlePointerUp)
    window.addEventListener('resize', this.handleResize)
    this.resize()
    this.animate()
  }

  setFacingMode(mode: CameraFacingMode) { this.facingMode = mode }
  setHands(hands: TrackedHand[]) { this.hands = hands }
  setDebugEnabled(enabled: boolean) { this.debugEnabled = enabled }
  updateTuning(tuning: RealityRiftTuning) { this.tuning = { ...tuning } }
  setQuality(quality: QualityLevel) { this.quality = quality }
  setPaused(paused: boolean) {
    if (this.paused === paused || this.destroyed) return
    this.paused = paused
    if (paused && this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    if (!paused) this.animate()
  }

  async setMedia(file: File) {
    this.releaseMedia()
    this.objectUrl = URL.createObjectURL(file)
    if (file.type.startsWith('image/')) {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => { this.releaseMedia(); reject(new Error('图片加载失败')) }
        image.src = this.objectUrl!
      })
      if (!this.destroyed) { this.image = image; this.mediaType = 'image' }
      return
    }
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video')
      video.loop = true; video.muted = true; video.playsInline = true; video.preload = 'metadata'; video.src = this.objectUrl
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => { this.releaseMedia(); reject(new Error('视频加载失败')) }
      })
      if (!this.destroyed) { this.video = video; this.mediaType = 'video'; await video.play() }
      return
    }
    this.releaseMedia()
    throw new Error('不支持的素材类型')
  }

  destroy() {
    if (this.destroyed || this.paused) return
    this.destroyed = true
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    window.removeEventListener('resize', this.handleResize)
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp)
    this.releaseMedia(); this.hands = []; this.pending.clear(); this.left = null; this.right = null
    this.context.clearRect(0, 0, this.width, this.height)
    this.cameraBuffer.width = this.cameraBuffer.height = 1
  }

  private handleResize = () => this.resize()
  private handlePointerDown = (event: PointerEvent) => {
    event.preventDefault(); const point = this.pointerPosition(event)
    this.pointerActive = true; this.pointerStartX = point.x; this.pointerStartY = point.y; this.pointerX = point.x
    this.canvas.setPointerCapture(event.pointerId)
  }
  private handlePointerMove = (event: PointerEvent) => {
    if (!this.pointerActive) return
    event.preventDefault(); this.pointerX = this.pointerPosition(event).x
  }
  private handlePointerUp = (event: PointerEvent) => {
    if (!this.pointerActive) return
    event.preventDefault(); this.pointerActive = false
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
  }
  private pointerPosition(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private resize() {
    this.width = window.innerWidth; this.height = window.innerHeight
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(this.width * ratio); this.canvas.height = Math.round(this.height * ratio)
    this.canvas.style.width = `${this.width}px`; this.canvas.style.height = `${this.height}px`
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0)
    this.cameraBuffer.width = Math.max(1, Math.round(this.width)); this.cameraBuffer.height = Math.max(1, Math.round(this.height))
    if (!this.centerX) { this.centerX = this.targetCenterX = this.width / 2; this.centerY = this.targetCenterY = this.height / 2 }
  }

  private animate = () => {
    if (this.destroyed) return
    this.frame += 1; this.update(performance.now()); this.render()
    this.animationFrame = requestAnimationFrame(this.animate)
  }

  private update(now: number) {
    if (!this.mediaType) { this.pending.clear(); this.releaseGrab() }
    else if (!this.pointerActive) this.updateHandGrab(now)
    if (this.pointerActive) {
      this.targetCenterX = this.pointerStartX; this.targetCenterY = this.pointerStartY
      this.targetWidth = Math.min(this.width * this.tuning.maxRiftWidth, Math.abs(this.pointerX - this.pointerStartX) * 2)
    }
    const damping = this.targetWidth > this.openWidth ? this.tuning.riftDamping : Math.max(.24, this.tuning.riftDamping * .58)
    this.openWidth += (this.targetWidth - this.openWidth) * damping
    if (this.openWidth < .25 && this.targetWidth === 0) {
      this.openWidth = 0
      if (this.state === 'closing') {
        this.seamFadeUntil = performance.now() + 170
        this.setState('idle')
      }
    }
    const speed = Math.hypot(this.targetCenterX - this.centerX, this.targetCenterY - this.centerY)
    const adaptive = Math.min(.94, (1 - this.tuning.handSmoothing) + speed / 500)
    this.centerX += (this.targetCenterX - this.centerX) * adaptive
    this.centerY += (this.targetCenterY - this.centerY) * adaptive
    this.tearImpulse *= .9
    if (!this.hasReportedOpen && this.openWidth > this.width * .28) { this.hasReportedOpen = true; this.onFirstOpen?.() }
  }

  private updateHandGrab(now: number) {
    const trigger = BASE_TRIGGER * this.tuning.grabTriggerMultiplier
    const release = trigger * this.tuning.grabReleaseMultiplier
    if (this.state !== 'dual_locked') {
      for (const hand of this.hands) {
        const existing = this.pending.get(hand.id)
        if (!existing && hand.pinchDistance <= trigger) this.pending.set(hand.id, this.createAnchor(hand, now))
        else if (existing) {
          if (hand.pinchDistance > release) this.pending.delete(hand.id)
          else this.followAnchor(existing, hand)
        }
      }
      for (const [id, grab] of this.pending) {
        if (this.hands.some((hand) => hand.id === id)) { grab.lostSince = null; continue }
        grab.lostSince ??= now
        if (now - grab.lostSince > this.tuning.trackingGracePeriod) this.pending.delete(id)
      }
      this.setState(this.pending.size ? 'armed' : this.state === 'closing' ? 'closing' : 'idle')
      const grabs = [...this.pending.values()].sort((a, b) => a.x - b.x)
      if (grabs.length >= 2) this.beginHold(grabs[0], grabs[grabs.length - 1], now)
    }
    if (this.state !== 'dual_locked' || !this.left || !this.right) return
    const used = new Set<number>()
    if (!this.updateControl(this.left, now, release, used) || !this.updateControl(this.right, now, release, used)) { this.releaseGrab(); return }
    this.currentSeparation = Math.abs(this.right.smoothedX - this.left.smoothedX)
    this.targetCenterX = (this.left.smoothedX + this.right.smoothedX) / 2
    this.targetCenterY = (this.left.smoothedY + this.right.smoothedY) / 2
    // Direct manipulation: rendered edges derive from the current grip distance, not a delta dead zone.
    this.targetWidth = Math.min(
      this.width * this.tuning.maxRiftWidth,
      Math.max(this.tuning.minimumOpening, this.currentSeparation * this.tuning.openingGain),
    )
    if (this.previousSeparationAt) {
      const velocity = (this.currentSeparation - this.previousSeparation) / Math.max(.016, (now - this.previousSeparationAt) / 1000)
      if (velocity > this.width * 1.1) this.tearImpulse = Math.min(1, velocity / (this.width * 2.8))
    }
    this.previousSeparation = this.currentSeparation; this.previousSeparationAt = now
  }

  private beginHold(left: GripAnchor, right: GripAnchor, now: number) {
    this.left = left
    this.right = right
    this.initialSeparation = Math.max(1, right.x - left.x); this.currentSeparation = this.previousSeparation = this.initialSeparation
    this.previousSeparationAt = now; this.targetCenterX = (left.x + right.x) / 2; this.targetCenterY = (left.y + right.y) / 2
    this.tearImpulse = Math.max(this.tearImpulse, .5)
    this.setState('dual_locked'); this.pending.clear()
  }

  private updateControl(control: GripAnchor, now: number, release: number, used: Set<number>) {
    let hand = this.hands.find((candidate) => candidate.id === control.handId && !used.has(candidate.id))
    if (!hand) {
      hand = this.hands.filter((candidate) => !used.has(candidate.id)).sort((a, b) => Math.hypot(a.x - control.x, a.y - control.y) - Math.hypot(b.x - control.x, b.y - control.y))[0]
      if (hand && Math.hypot(hand.x - control.x, hand.y - control.y) > Math.max(180, this.width * .2)) hand = undefined
    }
    if (!hand) { control.lostSince ??= now; return now - control.lostSince <= this.tuning.trackingGracePeriod }
    used.add(hand.id); control.handId = hand.id; control.lostSince = null; control.pinchDistance = hand.pinchDistance
    if (hand.pinchDistance > release) { control.releaseSince ??= now; if (now - control.releaseSince > RELEASE_DELAY) return false }
    else control.releaseSince = null
    this.followAnchor(control, hand)
    return true
  }

  private createAnchor(hand: TrackedHand, now: number): GripAnchor {
    return {
      handId: hand.id,
      initialX: hand.x,
      initialY: hand.y,
      x: hand.x,
      y: hand.y,
      smoothedX: hand.x,
      smoothedY: hand.y,
      lastValidX: hand.x,
      lastValidY: hand.y,
      grabbedAt: now,
      pinchDistance: hand.pinchDistance,
      lostSince: null,
      releaseSince: null,
    }
  }

  private followAnchor(anchor: GripAnchor, hand: TrackedHand) {
    anchor.x = hand.x
    anchor.y = hand.y
    anchor.lastValidX = hand.x
    anchor.lastValidY = hand.y
    anchor.pinchDistance = hand.pinchDistance
    const motion = Math.hypot(hand.x - anchor.smoothedX, hand.y - anchor.smoothedY)
    const follow = Math.min(.98, this.tuning.edgeFollowStrength + motion / 500)
    anchor.smoothedX += (hand.x - anchor.smoothedX) * follow
    anchor.smoothedY += (hand.y - anchor.smoothedY) * follow
  }

  private releaseGrab() {
    if (this.state === 'dual_locked') this.setState('closing')
    this.left = null; this.right = null; this.targetWidth = 0; this.previousSeparationAt = 0
  }

  private render() {
    this.context.clearRect(0, 0, this.width, this.height)
    this.renderCameraBuffer(); this.context.drawImage(this.cameraBuffer, 0, 0)
    const shape = this.buildShape()
    if (this.openWidth > .5) {
      this.drawStretch(shape)
      this.context.save(); this.trace(shape.polygon); this.context.clip(); this.drawWorld(); this.context.restore()
      this.drawCracks(shape); this.drawEdge(shape); this.drawGripTension(shape)
    }
    else this.drawClosingSeam()
    this.drawPendingFeedback()
    if (this.debugEnabled) this.drawDebug()
  }

  private buildShape(): Shape {
    const openness = Math.min(1, this.openWidth / Math.max(1, this.width * this.tuning.maxRiftWidth))
    const totalHeight = Math.min(this.height * .85, this.height * (.3 + openness * .5) * this.tuning.heightGain)
    const top = this.centerY - totalHeight * (.48 + Math.sin(this.frame * .004) * .012)
    const left: Point[] = [], right: Point[] = []
    const closingNoise = this.state === 'closing' ? (1 - openness) * 4 : 0
    const leftGripX = this.left?.smoothedX ?? this.centerX - this.openWidth / 2
    const rightGripX = this.right?.smoothedX ?? this.centerX + this.openWidth / 2
    const leftGripY = this.left?.smoothedY ?? this.centerY
    const rightGripY = this.right?.smoothedY ?? this.centerY
    const gripDistance = Math.max(0, rightGripX - leftGripX)
    const inset = gripDistance * Math.max(0, (1 - this.tuning.openingGain) / 2)
    const renderedLeftEdge = leftGripX + inset
    const renderedRightEdge = rightGripX - inset
    const renderedWidth = Math.min(
      this.width * this.tuning.maxRiftWidth,
      Math.max(this.tuning.minimumOpening, renderedRightEdge - renderedLeftEdge),
    )
    const renderedCenterX = (leftGripX + rightGripX) / 2
    for (let index = 0; index < EDGE_SAMPLES; index += 1) {
      const t = index / (EDGE_SAMPLES - 1)
      const leftProfile = Math.pow(Math.sin(Math.PI * t), .7) * (1 + Math.sin(t * 8.2) * .035)
      const rightProfile = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.015)), .78) * (1 + Math.cos(t * 7.1) * .045)
      const leftNoise = this.leftSeeds[index] * (3 + openness * 11) + Math.sin(this.frame * .014 + index * 1.41) * (1.1 + closingNoise)
      const rightNoise = this.rightSeeds[index] * (3 + openness * 10) + Math.sin(this.frame * .012 + index * 1.73) * (1 + closingNoise * .8)
      const y = top + t * totalHeight + Math.sin(index * 2.17) * openness * 2.4
      const gripInfluence = Math.pow(Math.sin(Math.PI * t), .8)
      left.push({
        x: renderedCenterX - renderedWidth * .5 * leftProfile + leftNoise,
        y: y + (leftGripY - this.centerY) * gripInfluence,
      })
      right.push({
        x: renderedCenterX + renderedWidth * .5 * rightProfile + rightNoise,
        y: y + (rightGripY - this.centerY) * gripInfluence + Math.cos(index * 1.37) * openness * 2.2,
      })
    }
    return { left, right, polygon: [...left, ...[...right].reverse()] }
  }

  private drawStretch(shape: Shape) {
    const openness = Math.min(1, this.openWidth / (this.width * .45))
    const strength = this.tuning.stretchStrength * .58 * (1 + this.tearImpulse * 1.15)
    this.context.save(); this.context.globalAlpha = .18 + openness * .2
    const sliceStep = this.quality === 'high' ? 2 : this.quality === 'medium' ? 3 : 5
    for (let index = 2; index < EDGE_SAMPLES - 2; index += sliceStep) {
      const left = shape.left[index], right = shape.right[index]
      const sliceHeight = Math.max(8, (shape.left[index + 2]?.y ?? left.y + 20) - left.y + 3)
      const pull = (2 + openness * 7) * strength, band = 24 + openness * 24
      this.context.drawImage(this.cameraBuffer, Math.max(0, left.x - band), left.y, band, sliceHeight, left.x - band - pull, left.y, band + pull, sliceHeight)
      this.context.drawImage(this.cameraBuffer, right.x, right.y, band, sliceHeight, right.x, right.y, band + pull, sliceHeight)
    }
    this.context.restore()
  }

  private drawEdge(shape: Shape) {
    const glow = this.tuning.glowStrength * (1 + this.tearImpulse * 1.6)
    this.context.save(); this.context.lineJoin = 'round'; this.context.lineCap = 'round'
    this.trace(shape.polygon); this.context.strokeStyle = RIFT_EDGE_CORE; this.context.lineWidth = Math.max(1.2, Math.min(2.4, this.openWidth * .007)); this.context.stroke()
    const qualityGlow = this.quality === 'high' ? 1 : this.quality === 'medium' ? .65 : .25
    this.trace(shape.polygon); this.context.shadowBlur = 5 * glow * qualityGlow; this.context.shadowColor = RIFT_GLOW; this.context.strokeStyle = RIFT_EDGE_COOL; this.context.lineWidth = 2.2; this.context.stroke()
    this.trace(shape.polygon); this.context.shadowBlur = 1.5 * glow; this.context.strokeStyle = RIFT_EDGE_LIGHT; this.context.lineWidth = 1.15; this.context.stroke()
    this.context.globalAlpha = .34
    this.context.setLineDash([18, 34, 8, 42])
    this.context.lineDashOffset = this.frame * .12
    this.trace(shape.polygon); this.context.strokeStyle = RIFT_EDGE_LAVENDER; this.context.lineWidth = .75; this.context.stroke()
    this.context.setLineDash([])
    this.context.restore()
  }

  private drawGripTension(shape: Shape) {
    if (this.state !== 'dual_locked' || !this.left || !this.right) return
    const middle = Math.floor(EDGE_SAMPLES / 2)
    const pairs: Array<[GripAnchor, Point]> = [
      [this.left, shape.left[middle]],
      [this.right, shape.right[middle]],
    ]
    this.context.save()
    this.context.lineWidth = .7
    this.context.strokeStyle = 'rgba(228,220,255,.22)'
    for (const [grip, edge] of pairs) {
      this.context.beginPath()
      this.context.moveTo(grip.smoothedX, grip.smoothedY)
      this.context.quadraticCurveTo(
        (grip.smoothedX + edge.x) / 2,
        grip.smoothedY + (edge.y - grip.smoothedY) * .2,
        edge.x,
        edge.y,
      )
      this.context.stroke()
    }
    this.context.restore()
  }

  private drawClosingSeam() {
    const remaining = this.seamFadeUntil - performance.now()
    if (remaining <= 0) return
    const alpha = Math.min(1, remaining / 170)
    const halfHeight = this.height * .12
    this.context.save()
    this.context.globalAlpha = alpha
    this.context.strokeStyle = RIFT_EDGE_LIGHT
    this.context.shadowBlur = 3
    this.context.shadowColor = RIFT_GLOW
    this.context.lineWidth = .75
    this.context.beginPath()
    this.context.moveTo(this.centerX, this.centerY - halfHeight)
    this.context.lineTo(this.centerX + Math.sin(this.frame * .4) * .7, this.centerY)
    this.context.lineTo(this.centerX, this.centerY + halfHeight)
    this.context.stroke()
    this.context.restore()
  }

  private drawCracks(shape: Shape) {
    const openness = Math.min(1, this.openWidth / (this.width * .45))
    if (openness < .34 || this.quality === 'low') return
    this.context.save(); this.context.lineWidth = .75; this.context.strokeStyle = `rgba(192,185,226,${(openness - .34) * .42})`
    const crackIndices = this.quality === 'medium' ? [5, 11, 17] : [4, 7, 10, 13, 16, 19]
    ;crackIndices.forEach((edgeIndex, crackIndex) => {
      const fromLeft = crackIndex % 2 === 0, start = fromLeft ? shape.left[edgeIndex] : shape.right[edgeIndex]
      const direction = fromLeft ? -1 : 1, length = (12 + (crackIndex % 3) * 7) * openness
      this.context.beginPath(); this.context.moveTo(start.x, start.y); this.context.lineTo(start.x + direction * length * .58, start.y + (crackIndex % 2 ? 5 : -7)); this.context.lineTo(start.x + direction * length, start.y + (crackIndex % 3 - 1) * 10); this.context.stroke()
    })
    this.context.restore()
  }

  private drawPendingFeedback() {
    if (this.state !== 'armed') return
    this.context.save()
    for (const grab of this.pending.values()) {
      this.context.beginPath(); this.context.arc(grab.x, grab.y, 15 + Math.sin(this.frame * .09) * 2, 0, Math.PI * 2)
      this.context.strokeStyle = 'rgba(210,201,243,.58)'; this.context.lineWidth = 1.2; this.context.shadowBlur = 8; this.context.shadowColor = 'rgba(155,122,239,.45)'; this.context.stroke()
      this.context.beginPath()
      this.context.moveTo(grab.x - 2, grab.y - 18)
      this.context.lineTo(grab.x + 1, grab.y - 7)
      this.context.lineTo(grab.x - 1, grab.y + 5)
      this.context.lineTo(grab.x + 2, grab.y + 18)
      this.context.strokeStyle = 'rgba(239,236,255,.7)'
      this.context.lineWidth = .8
      this.context.stroke()
    }
    this.context.restore()
  }

  private drawDebug() {
    this.context.save(); this.context.font = '11px monospace'; this.context.textBaseline = 'top'
    this.hands.forEach((hand, index) => {
      this.context.strokeStyle = index ? '#77d7ff' : '#d5a0ff'; this.context.fillStyle = this.context.strokeStyle
      const thumb = this.landmarkToScreen(hand.thumbTip), pointer = this.landmarkToScreen(hand.indexTip)
      for (const point of [thumb, pointer, { x: hand.x, y: hand.y }]) { this.context.beginPath(); this.context.arc(point.x, point.y, 6, 0, Math.PI * 2); this.context.stroke() }
      const status = this.left?.handId === hand.id || this.right?.handId === hand.id
        ? 'DUAL_LOCKED'
        : this.pending.has(hand.id) ? 'TRIGGERED' : 'IDLE'
      this.context.fillText(`H${index + 1} ${status} id:${hand.id} pinch:${hand.pinchDistance.toFixed(3)} trigger:${hand.pinchDistance <= BASE_TRIGGER * this.tuning.grabTriggerMultiplier}`, 14, 90 + index * 18)
    })
    const lostLeft = this.left?.lostSince ? Math.round(performance.now() - this.left.lostSince) : 0
    const lostRight = this.right?.lostSince ? Math.round(performance.now() - this.right.lostSince) : 0
    this.context.fillStyle = '#fff'
    this.context.fillText(`dual:${this.state === 'dual_locked'} state:${this.state} assignment L:${this.left?.handId ?? '-'} R:${this.right?.handId ?? '-'}`, 14, 18)
    this.context.fillText(`initial:${this.initialSeparation.toFixed(1)} current:${this.currentSeparation.toFixed(1)} openness:${(this.openWidth / Math.max(1, this.width * this.tuning.maxRiftWidth)).toFixed(2)}`, 14, 36)
    this.context.fillText(`lost L:${lostLeft}ms R:${lostRight}ms release:${(BASE_TRIGGER * this.tuning.grabTriggerMultiplier * this.tuning.grabReleaseMultiplier).toFixed(3)}`, 14, 54)
    if (this.left && this.right) {
      const shape = this.buildShape()
      const middle = Math.floor(EDGE_SAMPLES / 2)
      this.context.setLineDash([4, 4])
      this.context.strokeStyle = '#d5a0ff'
      this.context.beginPath(); this.context.moveTo(this.left.x, this.left.y); this.context.lineTo(shape.left[middle].x, shape.left[middle].y); this.context.stroke()
      this.context.strokeStyle = '#77d7ff'
      this.context.beginPath(); this.context.moveTo(this.right.x, this.right.y); this.context.lineTo(shape.right[middle].x, shape.right[middle].y); this.context.stroke()
      this.context.setLineDash([])
      this.context.fillStyle = '#fff'
      this.context.fillText(`leftGrip:${this.left.smoothedX.toFixed(0)},${this.left.smoothedY.toFixed(0)} edge:${shape.left[middle].x.toFixed(0)},${shape.left[middle].y.toFixed(0)}`, 14, 72)
      this.context.fillText(`rightGrip:${this.right.smoothedX.toFixed(0)},${this.right.smoothedY.toFixed(0)} edge:${shape.right[middle].x.toFixed(0)},${shape.right[middle].y.toFixed(0)}`, 14, 90)
    }
    this.context.restore()
  }

  private landmarkToScreen(point: { x: number; y: number }) { return { x: (this.facingMode === 'user' ? 1 - point.x : point.x) * this.width, y: point.y * this.height } }

  private renderCameraBuffer() {
    this.cameraContext.clearRect(0, 0, this.width, this.height)
    if (this.cameraVideo.readyState < 2 || !this.cameraVideo.videoWidth) { this.cameraContext.fillStyle = '#080809'; this.cameraContext.fillRect(0, 0, this.width, this.height); return }
    this.drawCover(this.cameraContext, this.cameraVideo, this.cameraVideo.videoWidth, this.cameraVideo.videoHeight, this.facingMode === 'user', 0, 0)
  }

  private drawWorld() {
    const offsetX = -(this.centerX - this.width / 2) * .035, offsetY = -(this.centerY - this.height / 2) * .025
    if (this.mediaType === 'image' && this.image) this.drawCover(this.context, this.image, this.image.naturalWidth, this.image.naturalHeight, false, offsetX, offsetY)
    else if (this.mediaType === 'video' && this.video?.readyState && this.video.videoWidth) this.drawCover(this.context, this.video, this.video.videoWidth, this.video.videoHeight, false, offsetX, offsetY)
  }

  private drawCover(context: CanvasRenderingContext2D, source: CanvasImageSource, sourceWidth: number, sourceHeight: number, mirror: boolean, offsetX: number, offsetY: number) {
    const targetWidth = this.width * 1.04, targetHeight = this.height * 1.04
    const sourceAspect = sourceWidth / sourceHeight, targetAspect = targetWidth / targetHeight
    let sx = 0, sy = 0, sw = sourceWidth, sh = sourceHeight
    if (sourceAspect > targetAspect) { sw = sourceHeight * targetAspect; sx = (sourceWidth - sw) / 2 }
    else { sh = sourceWidth / targetAspect; sy = (sourceHeight - sh) / 2 }
    context.save(); if (mirror) { context.translate(this.width, 0); context.scale(-1, 1); offsetX *= -1 }
    context.drawImage(source, sx, sy, sw, sh, (this.width - targetWidth) / 2 + offsetX, (this.height - targetHeight) / 2 + offsetY, targetWidth, targetHeight); context.restore()
  }

  private trace(points: Point[]) {
    if (!points.length) return
    this.context.beginPath(); this.context.moveTo(points[0].x, points[0].y)
    for (let index = 1; index < points.length; index += 1) this.context.lineTo(points[index].x, points[index].y)
    this.context.closePath()
  }

  private setState(state: 'idle' | 'armed' | 'dual_locked' | 'closing') {
    if (this.state === state) return
    this.state = state
    this.onGrabStateChange?.(state)
  }

  private createSeeds(seed: number) { return Array.from({ length: EDGE_SAMPLES }, (_, index) => Math.sin(index * 91.731 + seed) * .55 + Math.sin(index * 17.13 + seed * .31) * .45) }

  private releaseMedia() {
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load() }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.image = null; this.video = null; this.objectUrl = null; this.mediaType = null
  }
}
