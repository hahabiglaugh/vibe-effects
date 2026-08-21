import type { CameraFacingMode } from '../../services/cameraService'
import type { TrackedHand } from '../../services/handTrackingService'
import type { QualityLevel } from '../../services/performanceMonitor'

type Bubble = {
  id: number
  x: number
  y: number
  radius: number
  vx: number
  vy: number
  phase: number
  phaseSpeed: number
  hue: number
  opacity: number
  deformation: number
  pushX: number
  pushY: number
  poppingAt: number | null
  escaped: boolean
}

type FilmParticle = {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  bornAt: number
  life: number
  hue: number
}

type PopRipple = { x: number; y: number; radius: number; bornAt: number; life: number }

type InteractionPoint = { x: number; y: number }
type IndexInteraction = InteractionPoint & {
  previousX: number
  previousY: number
  updatedAt: number
}
type PalmField = InteractionPoint & {
  id: number
  previousX: number
  previousY: number
  velocityX: number
  velocityY: number
  speed: number
  radius: number
  elapsedMs: number
}
type AirImpulse = InteractionPoint & {
  previousX: number
  previousY: number
  directionX: number
  directionY: number
  strength: number
  radius: number
  bornAt: number
  life: number
}

export type BubbleverseTuning = {
  popHitPadding: number
  touchRadius: number
  palmRadius: number
  palmPushGain: number
  sweepRadius: number
  sweepGain: number
  swipeThreshold: number
  swipeBonus: number
  bubbleDrag: number
}

export const DEFAULT_BUBBLEVERSE_TUNING: BubbleverseTuning = {
  popHitPadding: 8,
  touchRadius: 62,
  palmRadius: 2.45,
  palmPushGain: 1.25,
  sweepRadius: .13,
  sweepGain: 1.45,
  swipeThreshold: .12,
  swipeBonus: 2.35,
  bubbleDrag: .997,
}

export const BUBBLEVERSE_PRESETS: Record<'soft' | 'normal' | 'strong', BubbleverseTuning> = {
  soft: { popHitPadding: 3, touchRadius: 48, palmRadius: 2.05, palmPushGain: .72, sweepRadius: .1, sweepGain: .8, swipeThreshold: .18, swipeBonus: 1.25, bubbleDrag: .994 },
  normal: { ...DEFAULT_BUBBLEVERSE_TUNING },
  strong: { popHitPadding: 15, touchRadius: 82, palmRadius: 2.8, palmPushGain: 1.8, sweepRadius: .16, sweepGain: 2.15, swipeThreshold: .08, swipeBonus: 3.4, bubbleDrag: .998 },
}

const POP_DURATION = 240
const PARTICLE_LIFE = 420
const MIN_DESKTOP_BUBBLES = 25
const MIN_MOBILE_BUBBLES = 15

export class BubbleverseEffect {
  private canvas: HTMLCanvasElement
  private context: CanvasRenderingContext2D
  private cameraVideo: HTMLVideoElement
  private facingMode: CameraFacingMode
  private bubbles: Bubble[] = []
  private particles: FilmParticle[] = []
  private ripples: PopRipple[] = []
  private handPoints: IndexInteraction[] = []
  private pointer: IndexInteraction | null = null
  private palmFields: PalmField[] = []
  private pointerPalm: PalmField | null = null
  private airImpulses: AirImpulse[] = []
  private lastImpulseAt = new Map<number, number>()
  private pendingRespawns: number[] = []
  private animationFrame: number | null = null
  private destroyed = false
  private width = 1
  private height = 1
  private dpr = 1
  private lastTime = performance.now()
  private nextBubbleId = 1
  private targetBubbleCount = 30
  private lowFrameCount = 0
  private onInteraction?: (type: 'pop' | 'push') => void
  private reportedInteractions = new Set<'pop' | 'push'>()
  private tuning = { ...DEFAULT_BUBBLEVERSE_TUNING }
  private debugEnabled = false
  private lastHit = { x: 0, y: 0, until: 0 }
  private lastPush = { x: 0, y: 0, until: 0 }
  private quality: QualityLevel = 'high'
  private paused = false

  constructor(
    canvas: HTMLCanvasElement,
    cameraVideo: HTMLVideoElement,
    facingMode: CameraFacingMode,
    onInteraction?: (type: 'pop' | 'push') => void,
  ) {
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas 2D context is unavailable.')
    this.canvas = canvas
    this.context = context
    this.cameraVideo = cameraVideo
    this.facingMode = facingMode
    this.onInteraction = onInteraction
    this.canvas.style.touchAction = 'none'
    this.canvas.addEventListener('pointermove', this.handlePointerMove)
    this.canvas.addEventListener('pointerdown', this.handlePointerMove)
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave)
    this.canvas.addEventListener('pointercancel', this.handlePointerLeave)
    window.addEventListener('resize', this.handleResize)
    this.resize()
    this.populate()
    this.animate()
  }

  setHands(hands: TrackedHand[]) {
    const now = performance.now()
    this.handPoints = hands.map((hand) => ({
      x: hand.indexX,
      y: hand.indexY,
      previousX: hand.previousIndexX,
      previousY: hand.previousIndexY,
      updatedAt: now,
    }))
    this.palmFields = hands.map((hand) => ({
      id: hand.id,
      x: hand.palmX,
      y: hand.palmY,
      previousX: hand.previousPalmX,
      previousY: hand.previousPalmY,
      velocityX: hand.velocityX,
      velocityY: hand.velocityY,
      speed: hand.speed,
      radius: hand.palmRadius,
      elapsedMs: hand.trackingDeltaMs,
    }))
    for (const palm of this.palmFields) {
      this.applyPalmSweep(palm, now)
      this.maybeCreateImpulse(palm, now)
    }
  }

  setDebugEnabled(enabled: boolean) {
    if (import.meta.env.DEV) this.debugEnabled = enabled
  }

  updateTuning(next: Partial<BubbleverseTuning>) {
    this.tuning = { ...this.tuning, ...next }
  }

  setFacingMode(facingMode: CameraFacingMode) {
    this.facingMode = facingMode
  }

  setQuality(quality: QualityLevel) {
    this.quality = quality
    const base = this.width <= 800 ? 20 : 30
    const multiplier = quality === 'high' ? 1 : quality === 'medium' ? .8 : .6
    this.targetBubbleCount = Math.max(this.width <= 800 ? 12 : 18, Math.round(base * multiplier))
    if (this.bubbles.length > this.targetBubbleCount) this.bubbles = this.bubbles.slice(0, this.targetBubbleCount)
    else this.populate()
  }

  setPaused(paused: boolean) {
    if (this.paused === paused || this.destroyed) return
    this.paused = paused
    if (paused && this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    if (!paused) { this.lastTime = performance.now(); this.animate() }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerdown', this.handlePointerMove)
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave)
    this.canvas.removeEventListener('pointercancel', this.handlePointerLeave)
    window.removeEventListener('resize', this.handleResize)
    this.bubbles = []
    this.particles = []
    this.ripples = []
    this.handPoints = []
    this.pointer = null
    this.palmFields = []
    this.pointerPalm = null
    this.airImpulses = []
    this.lastImpulseAt.clear()
    this.pendingRespawns = []
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private handlePointerMove = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect()
    const now = performance.now()
    const nextPointer = {
      x: ((event.clientX - rect.left) / rect.width) * this.width,
      y: ((event.clientY - rect.top) / rect.height) * this.height,
    }
    const previous = this.pointerPalm
    const elapsed = previous ? Math.max(.012, Math.min(.08, (now - (this.lastImpulseAt.get(-2) ?? now)) / 1000)) : .033
    const rawVelocityX = previous ? (nextPointer.x - previous.x) / elapsed : 0
    const rawVelocityY = previous ? (nextPointer.y - previous.y) / elapsed : 0
    const velocityX = previous ? previous.velocityX * .48 + rawVelocityX * .52 : 0
    const velocityY = previous ? previous.velocityY * .48 + rawVelocityY * .52 : 0
    const speed = Math.min(2400, Math.hypot(velocityX, velocityY))
    this.pointer = {
      ...nextPointer,
      previousX: previous?.x ?? nextPointer.x,
      previousY: previous?.y ?? nextPointer.y,
      updatedAt: now,
    }
    const pointerPalm: PalmField = {
      id: -1,
      ...nextPointer,
      previousX: previous?.x ?? nextPointer.x,
      previousY: previous?.y ?? nextPointer.y,
      velocityX,
      velocityY,
      speed,
      radius: 92,
      elapsedMs: elapsed * 1000,
    }
    this.pointerPalm = pointerPalm
    this.lastImpulseAt.set(-2, now)
    this.applyPalmSweep(pointerPalm, now)
    this.maybeCreateImpulse(pointerPalm, now)
  }

  private handlePointerLeave = () => {
    this.pointer = null
    this.pointerPalm = null
  }

  private handleResize = () => this.resize()

  private resize() {
    const oldWidth = this.width
    const oldHeight = this.height
    this.width = Math.max(1, window.innerWidth)
    this.height = Math.max(1, window.innerHeight)
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(this.width * this.dpr)
    this.canvas.height = Math.round(this.height * this.dpr)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const base = this.width <= 800 ? 20 : 30
    this.targetBubbleCount = Math.round(base * (this.quality === 'high' ? 1 : this.quality === 'medium' ? .8 : .6))

    if (oldWidth > 1 && oldHeight > 1) {
      for (const bubble of this.bubbles) {
        bubble.x = (bubble.x / oldWidth) * this.width
        bubble.y = (bubble.y / oldHeight) * this.height
      }
      if (this.bubbles.length > this.targetBubbleCount) {
        this.bubbles = this.bubbles.slice(0, this.targetBubbleCount)
      } else {
        this.populate()
      }
    }
  }

  private populate() {
    while (this.bubbles.length < this.targetBubbleCount) {
      this.bubbles.push(this.createBubble(false))
    }
  }

  private createBubble(fromEdge: boolean): Bubble {
    const minDimension = Math.min(this.width, this.height)
    const sizeRoll = Math.random()
    const radius = sizeRoll > .9
      ? this.random(minDimension * .075, minDimension * .12)
      : sizeRoll > .42
        ? this.random(minDimension * .038, minDimension * .068)
        : this.random(minDimension * .018, minDimension * .038)
    const fromSide = fromEdge && Math.random() > .65
    const enterFromLeft = Math.random() > .5
    return {
      id: this.nextBubbleId++,
      x: fromSide ? (enterFromLeft ? -radius : this.width + radius) : this.random(radius, this.width - radius),
      y: fromEdge && !fromSide ? this.height + radius : this.random(radius, this.height - radius),
      radius,
      vx: fromSide ? (enterFromLeft ? .12 : -.12) : this.random(-.11, .11),
      vy: this.random(-.2, -.055),
      phase: Math.random() * Math.PI * 2,
      phaseSpeed: this.random(.0007, .0018),
      hue: this.random(180, 330),
      opacity: this.random(.58, .9),
      deformation: 0,
      pushX: 0,
      pushY: 0,
      poppingAt: null,
      escaped: false,
    }
  }

  private animate = (now = performance.now()) => {
    if (this.destroyed || this.paused) return
    const elapsed = Math.min(34, Math.max(8, now - this.lastTime))
    const step = elapsed / 16.67
    this.lastTime = now
    this.drawCamera()
    this.updateAirImpulses(now)
    this.updateBubbles(now, step)
    this.resolveCollisions()
    this.renderBubbles(now)
    this.renderRipples(now)
    this.updateAndRenderParticles(now, step)
    this.processRespawns(now)
    if (import.meta.env.DEV && this.debugEnabled) this.renderDebug(now)
    this.animationFrame = requestAnimationFrame(this.animate)
  }

  private drawCamera() {
    const sourceWidth = this.cameraVideo.videoWidth
    const sourceHeight = this.cameraVideo.videoHeight
    if (!sourceWidth || !sourceHeight) {
      this.context.fillStyle = '#050505'
      this.context.fillRect(0, 0, this.width, this.height)
      return
    }
    const scale = Math.max(this.width / sourceWidth, this.height / sourceHeight)
    const drawWidth = sourceWidth * scale
    const drawHeight = sourceHeight * scale
    const x = (this.width - drawWidth) / 2
    const y = (this.height - drawHeight) / 2
    this.context.save()
    if (this.facingMode === 'user') {
      this.context.translate(this.width, 0)
      this.context.scale(-1, 1)
    }
    this.context.drawImage(this.cameraVideo, x, y, drawWidth, drawHeight)
    this.context.restore()
  }

  private updateBubbles(now: number, step: number) {
    for (const bubble of this.bubbles) {
      if (bubble.poppingAt !== null || bubble.escaped) continue
      bubble.phase += bubble.phaseSpeed * step * 16.67
      bubble.vx += Math.sin(bubble.phase * 1.7 + bubble.id) * .0015 * step
      bubble.vy -= .0012 * step
      bubble.vx *= this.tuning.bubbleDrag
      bubble.vy *= .997
      bubble.vy = Math.max(-.26, bubble.vy)
      bubble.pushX *= .82
      bubble.pushY *= .82
      bubble.deformation *= .86

      for (const point of this.handPoints) this.applyIndexInteraction(bubble, point, now)
      if (this.pointer && bubble.poppingAt === null) {
        this.applyIndexInteraction(bubble, this.pointer, now)
      }
      if (bubble.poppingAt !== null) continue

      for (const palm of this.palmFields) this.applyPalmField(bubble, palm, step)
      if (this.pointerPalm) this.applyPalmField(bubble, this.pointerPalm, step)

      const velocity = Math.hypot(bubble.vx, bubble.vy)
      if (velocity > 5.5) {
        const velocityLimit = 5.5 / velocity
        bubble.vx *= velocityLimit
        bubble.vy *= velocityLimit
      }

      bubble.x += (bubble.vx + bubble.pushX) * step
      bubble.y += (bubble.vy + bubble.pushY + Math.sin(bubble.phase) * .018) * step
      this.keepInBounds(bubble)
    }
  }

  private keepInBounds(bubble: Bubble) {
    if (
      bubble.x < -bubble.radius * 2 ||
      bubble.x > this.width + bubble.radius * 2 ||
      bubble.y < -bubble.radius * 2 ||
      bubble.y > this.height + bubble.radius * 2
    ) {
      bubble.escaped = true
      this.pendingRespawns.push(performance.now() + this.random(650, 1700))
    }
  }

  private applyIndexInteraction(bubble: Bubble, point: IndexInteraction, now: number) {
    if (now - point.updatedAt > 150) return
    const dx = bubble.x - point.x
    const dy = bubble.y - point.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const dynamicPadding = Math.max(bubble.radius * .28, Math.min(this.width, this.height) * .012)
    const hitRadius = bubble.radius + dynamicPadding + this.tuning.popHitPadding
    const sweptDistance = this.distanceToSegment(
      bubble.x,
      bubble.y,
      point.previousX,
      point.previousY,
      point.x,
      point.y,
    )
    if (distance <= hitRadius || sweptDistance <= hitRadius) {
      this.lastHit = { x: bubble.x, y: bubble.y, until: now + 320 }
      this.popBubble(bubble, now, point)
      return
    }
    const touchRadius = hitRadius + this.tuning.touchRadius
    const sweptTouchDistance = this.distanceToSegment(
      bubble.x, bubble.y, point.previousX, point.previousY, point.x, point.y,
    )
    if (Math.min(distance, sweptTouchDistance) < touchRadius) {
      const strength = 1 - Math.min(distance, sweptTouchDistance) / touchRadius
      bubble.deformation = Math.max(bubble.deformation, .18 + strength * .72)
      // Index interaction signals touch without making the target run away.
      bubble.vx += (dx / distance) * strength * .004
      bubble.vy += (dy / distance) * strength * .004
      bubble.phase += strength * .08
    }
  }

  private applyPalmField(bubble: Bubble, palm: PalmField, step: number) {
    const dx = bubble.x - palm.x
    const dy = bubble.y - palm.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const shortSide = Math.min(this.width, this.height)
    const visualPalmWidth = palm.radius / .72
    const fieldRadius = Math.max(shortSide * .1, Math.min(shortSide * .28, visualPalmWidth * this.tuning.palmRadius)) + bubble.radius * .7
    if (distance >= fieldRadius) return
    const falloff = (1 - distance / fieldRadius) ** 1.6
    const nx = dx / distance
    const ny = dy / distance
    bubble.vx += nx * .018 * falloff * step
    bubble.vy += ny * .018 * falloff * step
    bubble.deformation = Math.max(bubble.deformation, falloff * .28)
    if (palm.speed > 1) {
      const motion = Math.min(1.8, palm.speed / 600)
      bubble.vx += (palm.velocityX / palm.speed) * .012 * this.tuning.palmPushGain * motion * falloff * step
      bubble.vy += (palm.velocityY / palm.speed) * .012 * this.tuning.palmPushGain * motion * falloff * step
    }
  }

  private applyPalmSweep(palm: PalmField, now: number) {
    const shortSide = Math.min(this.width, this.height)
    const capsuleRadius = Math.max(shortSide * this.tuning.sweepRadius, palm.radius * 1.1)
    const travel = Math.hypot(palm.x - palm.previousX, palm.y - palm.previousY)
    const elapsedSeconds = Math.max(.012, Math.min(.1, palm.elapsedMs / 1000))
    const motion = Math.min(1.8, travel / Math.max(18, shortSide * .08))
    if (travel < 1.5 || palm.speed < 1) return
    const directionX = palm.velocityX / palm.speed
    const directionY = palm.velocityY / palm.speed
    let pushed = 0
    for (const bubble of this.bubbles) {
      if (bubble.poppingAt !== null || bubble.escaped) continue
      const distance = this.distanceToSegment(bubble.x, bubble.y, palm.previousX, palm.previousY, palm.x, palm.y)
      const effectiveRadius = capsuleRadius + bubble.radius * .55
      if (distance > effectiveRadius) continue
      const falloff = Math.max(.35, 1 - distance / effectiveRadius)
      const sizeResponse = Math.max(.78, Math.min(1.22, 52 / Math.max(28, bubble.radius)))
      const continuousSpeed = Math.min(2.8, palm.speed / 520)
      const impulse = Math.max(.16, continuousSpeed * this.tuning.sweepGain * falloff * sizeResponse)
      bubble.vx += directionX * impulse
      bubble.vy += directionY * impulse
      bubble.deformation = Math.max(bubble.deformation, Math.min(1, .25 + motion * falloff))
      pushed += 1
      this.lastPush = { x: bubble.x, y: bubble.y, until: now + 340 }
    }
    if (pushed >= 2) this.reportInteraction('push')
    if (import.meta.env.DEV && this.debugEnabled && pushed) {
      console.debug(`[Bubbleverse] PALM CAPSULE ${pushed} · ${(elapsedSeconds * 1000).toFixed(0)}ms`)
    }
  }

  private maybeCreateImpulse(palm: PalmField, now: number) {
    const travel = Math.hypot(palm.x - palm.previousX, palm.y - palm.previousY)
    const normalizedSpeed = (travel / Math.max(320, this.width)) / Math.max(.012, palm.elapsedMs / 1000)
    if (normalizedSpeed < this.tuning.swipeThreshold) return
    const lastImpulse = this.lastImpulseAt.get(palm.id) ?? -Infinity
    if (now - lastImpulse < 105) return
    const directionX = palm.velocityX / palm.speed
    const directionY = palm.velocityY / palm.speed
    const strength = Math.max(1, Math.min(2.2, normalizedSpeed / this.tuning.swipeThreshold))
    const impulse: AirImpulse = {
      x: palm.x,
      y: palm.y,
      previousX: palm.previousX,
      previousY: palm.previousY,
      directionX,
      directionY,
      strength,
      radius: Math.max(Math.min(this.width, this.height) * this.tuning.sweepRadius, palm.radius * 1.1),
      bornAt: now,
      life: 260,
    }
    this.airImpulses.push(impulse)
    this.applySwipeImpulse(impulse, now)
    this.lastImpulseAt.set(palm.id, now)
    this.reportInteraction('push')
  }

  private updateAirImpulses(now: number) {
    this.airImpulses = this.airImpulses.filter((impulse) => now - impulse.bornAt < impulse.life)
  }

  private applySwipeImpulse(impulse: AirImpulse, now: number) {
    let pushed = 0
    for (const bubble of this.bubbles) {
      if (bubble.poppingAt !== null || bubble.escaped) continue
      const distance = this.distanceToSegment(
        bubble.x,
        bubble.y,
        impulse.previousX,
        impulse.previousY,
        impulse.x,
        impulse.y,
      )
      const effectiveRadius = impulse.radius + bubble.radius * .45
      if (distance > effectiveRadius) continue
      const falloff = Math.max(.42, 1 - distance / effectiveRadius)
      const sizeResponse = Math.max(.72, Math.min(1.38, 48 / bubble.radius))
      const velocityImpulse = this.tuning.swipeBonus * impulse.strength * falloff * sizeResponse
      bubble.vx += impulse.directionX * velocityImpulse
      bubble.vy += impulse.directionY * velocityImpulse
      bubble.deformation = Math.max(bubble.deformation, Math.min(1, impulse.strength * falloff))
      pushed += 1
      this.lastPush = { x: bubble.x, y: bubble.y, until: now + 340 }
    }
    if (import.meta.env.DEV && this.debugEnabled) {
      console.debug(`[Bubbleverse] SWIPE ${Math.round(impulse.strength * 100)}% · PUSH ${pushed}`)
    }
  }

  private distanceToSegment(
    pointX: number,
    pointY: number,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ) {
    const segmentX = endX - startX
    const segmentY = endY - startY
    const lengthSquared = segmentX * segmentX + segmentY * segmentY
    if (lengthSquared < .001) return Math.hypot(pointX - endX, pointY - endY)
    const projection = Math.max(0, Math.min(1,
      ((pointX - startX) * segmentX + (pointY - startY) * segmentY) / lengthSquared,
    ))
    return Math.hypot(
      pointX - (startX + segmentX * projection),
      pointY - (startY + segmentY * projection),
    )
  }

  private renderDebug(now: number) {
    const context = this.context
    context.save()
    context.lineWidth = 1.5
    context.font = '12px monospace'
    for (const point of this.handPoints) {
      context.strokeStyle = 'rgba(107,220,255,.9)'
      context.fillStyle = '#6bdcff'
      context.beginPath()
      context.moveTo(point.previousX, point.previousY)
      context.lineTo(point.x, point.y)
      context.stroke()
      context.beginPath()
      context.arc(point.x, point.y, 5, 0, Math.PI * 2)
      context.fill()
    }
    context.setLineDash([3, 4])
    for (const bubble of this.bubbles) {
      if (bubble.poppingAt !== null || bubble.escaped) continue
      const padding = Math.max(bubble.radius * .28, Math.min(this.width, this.height) * .012) + this.tuning.popHitPadding
      context.strokeStyle = 'rgba(102,255,190,.22)'
      context.beginPath(); context.arc(bubble.x, bubble.y, bubble.radius + padding, 0, Math.PI * 2); context.stroke()
      context.strokeStyle = 'rgba(107,220,255,.12)'
      context.beginPath(); context.arc(bubble.x, bubble.y, bubble.radius + padding + this.tuning.touchRadius, 0, Math.PI * 2); context.stroke()
    }
    context.setLineDash([])
    if (this.pointer) {
      context.strokeStyle = 'rgba(107,220,255,.7)'
      context.beginPath()
      context.moveTo(this.pointer.previousX, this.pointer.previousY)
      context.lineTo(this.pointer.x, this.pointer.y)
      context.stroke()
    }
    const palms = this.pointerPalm ? [...this.palmFields, this.pointerPalm] : this.palmFields
    for (const palm of palms) {
      const travel = Math.hypot(palm.x - palm.previousX, palm.y - palm.previousY)
      const normalizedSpeed = (travel / Math.max(320, this.width)) / Math.max(.012, palm.elapsedMs / 1000)
      const swiping = normalizedSpeed >= this.tuning.swipeThreshold
      context.strokeStyle = swiping ? 'rgba(255,170,94,.9)' : 'rgba(190,145,255,.7)'
      context.fillStyle = context.strokeStyle
      const capsuleRadius = Math.max(Math.min(this.width, this.height) * this.tuning.sweepRadius, palm.radius * 1.1)
      context.save()
      context.globalAlpha = .45
      context.lineWidth = capsuleRadius * 2
      context.lineCap = 'round'
      context.beginPath(); context.moveTo(palm.previousX, palm.previousY); context.lineTo(palm.x, palm.y); context.stroke()
      context.restore()
      context.lineWidth = 1.5
      context.beginPath()
      context.arc(palm.x, palm.y, 5, 0, Math.PI * 2)
      context.fill()
      context.beginPath()
      context.moveTo(palm.previousX, palm.previousY)
      context.lineTo(palm.x, palm.y)
      context.stroke()
      context.fillText(`${Math.round(palm.speed)} px/s ${swiping ? 'SWIPE' : ''}`, palm.x + 10, palm.y - 10)
    }
    if (this.lastHit.until > now) {
      context.fillStyle = '#7fffd4'
      context.fillText('HIT', this.lastHit.x + 8, this.lastHit.y - 8)
    }
    if (this.lastPush.until > now) {
      context.fillStyle = '#ffb36b'
      context.fillText('PUSH', this.lastPush.x + 8, this.lastPush.y - 8)
    }
    context.restore()
  }

  private resolveCollisions() {
    for (let i = 0; i < this.bubbles.length; i += 1) {
      const first = this.bubbles[i]
      if (first.poppingAt !== null || first.escaped) continue
      for (let j = i + 1; j < this.bubbles.length; j += 1) {
        const second = this.bubbles[j]
        if (second.poppingAt !== null || second.escaped) continue
        const dx = second.x - first.x
        const dy = second.y - first.y
        const distance = Math.max(.01, Math.hypot(dx, dy))
        const minimum = (first.radius + second.radius) * .9
        if (distance >= minimum) continue
        const overlap = (minimum - distance) * .32
        const nx = dx / distance
        const ny = dy / distance
        first.x -= nx * overlap
        first.y -= ny * overlap
        second.x += nx * overlap
        second.y += ny * overlap
        const relativeVelocity = (second.vx - first.vx) * nx + (second.vy - first.vy) * ny
        if (relativeVelocity < 0) {
          const impulse = -relativeVelocity * .42
          const firstWeight = second.radius / (first.radius + second.radius)
          const secondWeight = 1 - firstWeight
          first.vx -= nx * impulse * firstWeight
          first.vy -= ny * impulse * firstWeight
          second.vx += nx * impulse * secondWeight
          second.vy += ny * impulse * secondWeight
        }
      }
    }
  }

  private renderBubbles(now: number) {
    for (const bubble of this.bubbles) {
      if (bubble.escaped) continue
      if (bubble.poppingAt !== null) {
        const progress = (now - bubble.poppingAt) / POP_DURATION
        if (progress >= 1) continue
        this.drawPoppingBubble(bubble, progress)
      } else {
        this.drawBubble(bubble, now)
      }
    }
  }

  private drawBubble(bubble: Bubble, now: number) {
    const context = this.context
    const shimmer = (Math.sin(now * .00035 + bubble.phase) + 1) / 2
    const speed = Math.hypot(bubble.vx, bubble.vy)
    const motionStretch = Math.min(.085, speed * .032)
    const squeeze = bubble.deformation * .12
    context.save()
    context.translate(bubble.x, bubble.y)
    context.rotate(Math.sin(bubble.phase * .8) * .08 + Math.atan2(bubble.vy, bubble.vx) * motionStretch)
    context.scale(1 + squeeze + motionStretch, 1 - squeeze - motionStretch * .45)

    const body = context.createRadialGradient(
      -bubble.radius * .28, -bubble.radius * .34, bubble.radius * .04,
      0, 0, bubble.radius,
    )
    body.addColorStop(0, `rgba(255,255,255,${.045 + shimmer * .025})`)
    body.addColorStop(.58, `hsla(${bubble.hue + shimmer * 45},90%,78%,.018)`)
    body.addColorStop(.84, `hsla(${bubble.hue + 80},95%,72%,.075)`)
    body.addColorStop(1, `rgba(255,255,255,${.13 * bubble.opacity})`)
    context.fillStyle = body
    context.beginPath()
    context.arc(0, 0, bubble.radius, 0, Math.PI * 2)
    context.fill()

    const rim = context.createLinearGradient(-bubble.radius, -bubble.radius, bubble.radius, bubble.radius)
    rim.addColorStop(0, `hsla(${bubble.hue},100%,86%,${.72 * bubble.opacity})`)
    rim.addColorStop(.22, `rgba(255,255,255,${.16 * bubble.opacity})`)
    rim.addColorStop(.48, `hsla(${bubble.hue + 105},100%,76%,${.48 * bubble.opacity})`)
    rim.addColorStop(.72, `hsla(${bubble.hue + 210},100%,82%,${.28 * bubble.opacity})`)
    rim.addColorStop(1, `rgba(255,255,255,${.7 * bubble.opacity})`)
    context.strokeStyle = rim
    context.lineWidth = Math.max(1, bubble.radius * .025)
    context.beginPath()
    context.arc(0, 0, bubble.radius - context.lineWidth, 0, Math.PI * 2)
    context.stroke()

    context.strokeStyle = `rgba(255,255,255,${.42 * bubble.opacity})`
    context.lineWidth = Math.max(.8, bubble.radius * .018)
    context.lineCap = 'round'
    context.beginPath()
    context.arc(-bubble.radius * .08, -bubble.radius * .05, bubble.radius * .72, Math.PI * 1.04, Math.PI * 1.48)
    context.stroke()

    context.fillStyle = `rgba(255,255,255,${.34 * bubble.opacity})`
    context.beginPath()
    context.ellipse(-bubble.radius * .38, -bubble.radius * .43, bubble.radius * .11, bubble.radius * .045, -.6, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }

  private drawPoppingBubble(bubble: Bubble, progress: number) {
    const eased = 1 - (1 - progress) ** 3
    this.context.save()
    this.context.translate(bubble.x, bubble.y)
    this.context.scale(1.06 + eased * .49, 1.04 - eased * .22)
    this.context.globalAlpha = 1 - progress
    this.context.strokeStyle = `hsla(${bubble.hue + progress * 90},100%,88%,.75)`
    this.context.lineWidth = Math.max(1, bubble.radius * .035 * (1 - progress))
    this.context.setLineDash([bubble.radius * .48, bubble.radius * .16])
    this.context.lineDashOffset = progress * bubble.radius
    this.context.beginPath()
    this.context.arc(0, 0, bubble.radius, 0, Math.PI * 2)
    this.context.stroke()
    this.context.restore()
  }

  private popBubble(bubble: Bubble, now: number, point: InteractionPoint) {
    if (bubble.poppingAt !== null) return
    bubble.poppingAt = now
    bubble.pushX = (bubble.x - point.x) * .02
    bubble.pushY = (bubble.y - point.y) * .02
    bubble.deformation = 1
    this.ripples.push({ x: bubble.x, y: bubble.y, radius: bubble.radius * .65, bornAt: now, life: 290 })
    const particleScale = this.quality === 'high' ? 1 : this.quality === 'medium' ? .7 : .45
    const particleCount = Math.max(3, Math.round(this.random(6, 10) * particleScale))
    for (let index = 0; index < particleCount; index += 1) {
      const angle = (index / particleCount) * Math.PI * 2 + this.random(-.25, .25)
      const speed = this.random(.35, 1.05)
      this.particles.push({
        x: bubble.x + Math.cos(angle) * bubble.radius * .72,
        y: bubble.y + Math.sin(angle) * bubble.radius * .72,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - .15,
        size: this.random(1.2, 3.8),
        bornAt: now,
        life: PARTICLE_LIFE * this.random(.72, 1.12),
        hue: bubble.hue + this.random(-30, 80),
      })
    }
    this.pendingRespawns.push(now + this.random(500, 2000))
    this.reportInteraction('pop')
  }

  private renderRipples(now: number) {
    this.ripples = this.ripples.filter((ripple) => {
      const progress = (now - ripple.bornAt) / ripple.life
      if (progress >= 1) return false
      this.context.save()
      this.context.globalAlpha = (1 - progress) * .28
      this.context.strokeStyle = 'rgba(235,245,255,.75)'
      this.context.lineWidth = 1
      this.context.beginPath()
      this.context.arc(ripple.x, ripple.y, ripple.radius * (1 + progress * .8), 0, Math.PI * 2)
      this.context.stroke()
      this.context.restore()
      return true
    })
  }

  private updateAndRenderParticles(now: number, step: number) {
    this.particles = this.particles.filter((particle) => {
      const progress = (now - particle.bornAt) / particle.life
      if (progress >= 1) return false
      particle.x += particle.vx * step
      particle.y += particle.vy * step
      particle.vx *= .97
      particle.vy += .008 * step
      this.context.fillStyle = `hsla(${particle.hue},100%,88%,${(1 - progress) * .55})`
      this.context.beginPath()
      this.context.arc(particle.x, particle.y, particle.size * (1 - progress * .55), 0, Math.PI * 2)
      this.context.fill()
      return true
    })
  }

  private processRespawns(now: number) {
    this.bubbles = this.bubbles.filter(
      (bubble) => !bubble.escaped && (bubble.poppingAt === null || now - bubble.poppingAt < POP_DURATION),
    )
    const ready = this.pendingRespawns.filter((time) => time <= now).length
    this.pendingRespawns = this.pendingRespawns.filter((time) => time > now)
    for (let index = 0; index < ready && this.bubbles.length < this.targetBubbleCount; index += 1) {
      this.bubbles.push(this.createBubble(true))
    }
  }

  private trackPerformance(elapsed: number) {
    if (elapsed > 30) this.lowFrameCount += 1
    else this.lowFrameCount = Math.max(0, this.lowFrameCount - 1)
    if (this.lowFrameCount < 90) return
    const minimum = this.width <= 800 ? MIN_MOBILE_BUBBLES : MIN_DESKTOP_BUBBLES
    if (this.targetBubbleCount > minimum) {
      this.targetBubbleCount -= 2
      const removable = this.bubbles.filter((bubble) => bubble.poppingAt === null).slice(0, 2)
      const ids = new Set(removable.map((bubble) => bubble.id))
      this.bubbles = this.bubbles.filter((bubble) => !ids.has(bubble.id))
      if (import.meta.env.DEV) {
        console.warn(`[Bubbleverse] Low frame rate; bubble target reduced to ${this.targetBubbleCount}.`)
      }
    }
    this.lowFrameCount = 0
  }

  private reportInteraction(type: 'pop' | 'push') {
    if (this.reportedInteractions.has(type)) return
    this.reportedInteractions.add(type)
    this.onInteraction?.(type)
  }

  private random(min: number, max: number) {
    return min + Math.random() * (max - min)
  }
}
