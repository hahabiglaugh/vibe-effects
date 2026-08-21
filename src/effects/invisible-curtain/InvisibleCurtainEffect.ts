import type { CameraFacingMode } from '../../services/cameraService'
import type { TrackedHand } from '../../services/handTrackingService'
import type { QualityLevel } from '../../services/performanceMonitor'

type Point = {
  x: number
  y: number
  oldX: number
  oldY: number
  origBaseX: number
  origBaseY: number
  randomOffsetX: number
  randomOffsetY: number
  edgeSeed: number
  pinned: boolean
  wasGrabbed: boolean
}

type Stick = { p1: Point; p2: Point; length: number }
type Ripple = { x: number; y: number; radius: number; maxRadius: number; alpha: number }
type MediaType = 'image' | 'video' | null

const CLOTH_COLS = 38
const CLOTH_ROWS = 35
const ITERATIONS = 12
const GRAVITY = 0.12
const FRICTION = 0.92
const INTERACTION_RADIUS = 150

export class InvisibleCurtainEffect {
  private canvas: HTMLCanvasElement
  private context: CanvasRenderingContext2D
  private cameraVideo: HTMLVideoElement
  private facingMode: CameraFacingMode
  private points: Point[] = []
  private sticks: Stick[] = []
  private perimeter: Array<{ x: number; y: number }> = []
  private ripples: Ripple[] = []
  private grabbedPoint: Point | null = null
  private activeHands: TrackedHand[] = []
  private handGrabbedPoints = new Map<number, Point>()
  private pointerDown = false
  private pointerX = 0
  private pointerY = 0
  private isCurtainThrown = false
  private spacingX = 0
  private spacingY = 0
  private baseMediaWidth = 0
  private baseMediaHeight = 0
  private mediaSourceWidth = 0
  private mediaSourceHeight = 0
  private mediaType: MediaType = null
  private uploadedImage: HTMLImageElement | null = null
  private uploadedVideo: HTMLVideoElement | null = null
  private objectUrl: string | null = null
  private animationFrame: number | null = null
  private destroyed = false
  private frame = 0
  private width = 0
  private height = 0
  private onFirstHandGrab?: () => void
  private onFirstCurtainMove?: () => void
  private hasReportedHandGrab = false
  private hasReportedCurtainMove = false
  private firstGrabPosition: { x: number; y: number } | null = null
  private quality: QualityLevel = 'high'
  private paused = false

  constructor(
    canvas: HTMLCanvasElement,
    cameraVideo: HTMLVideoElement,
    facingMode: CameraFacingMode,
    onFirstHandGrab?: () => void,
    onFirstCurtainMove?: () => void,
  ) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context is unavailable.')

    this.canvas = canvas
    this.context = context
    this.cameraVideo = cameraVideo
    this.facingMode = facingMode
    this.onFirstHandGrab = onFirstHandGrab
    this.onFirstCurtainMove = onFirstCurtainMove

    this.canvas.style.touchAction = 'none'
    this.canvas.addEventListener('pointerdown', this.handlePointerDown)
    this.canvas.addEventListener('pointermove', this.handlePointerMove)
    this.canvas.addEventListener('pointerup', this.handlePointerUp)
    this.canvas.addEventListener('pointercancel', this.handlePointerUp)
    window.addEventListener('resize', this.handleResize)

    this.resize()
    this.animate()
  }

  setFacingMode(facingMode: CameraFacingMode) {
    this.facingMode = facingMode
  }

  setQuality(quality: QualityLevel) { this.quality = quality }

  setPaused(paused: boolean) {
    if (this.paused === paused || this.destroyed) return
    this.paused = paused
    if (paused && this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    if (!paused) this.animate()
  }

  setHands(hands: TrackedHand[]) {
    this.activeHands = hands
    const activePinchingIds = new Set(
      hands.filter((hand) => hand.isPinching).map((hand) => hand.id),
    )

    for (const handId of this.handGrabbedPoints.keys()) {
      if (!activePinchingIds.has(handId)) this.handGrabbedPoints.delete(handId)
    }

    for (const hand of hands) {
      if (hand.justStartedPinching) {
        this.ripples.push({
          x: hand.x,
          y: hand.y,
          radius: 0,
          maxRadius: 100,
          alpha: 200,
        })
      }
    }
  }

  async setMedia(file: File) {
    this.releaseMedia()
    const objectUrl = URL.createObjectURL(file)
    this.objectUrl = objectUrl

    if (file.type.startsWith('image/')) {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => {
          this.releaseMedia()
          reject(new Error('图片加载失败'))
        }
        image.src = objectUrl
      })

      if (this.destroyed) return
      this.uploadedImage = image
      this.mediaType = 'image'
      this.mediaSourceWidth = image.naturalWidth
      this.mediaSourceHeight = image.naturalHeight
    } else if (file.type.startsWith('video/')) {
      const video = document.createElement('video')
      video.loop = true
      video.muted = true
      video.playsInline = true
      video.preload = 'metadata'
      video.src = objectUrl

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => {
          this.releaseMedia()
          reject(new Error('视频加载失败'))
        }
      })

      if (this.destroyed) return
      this.uploadedVideo = video
      this.mediaType = 'video'
      this.mediaSourceWidth = video.videoWidth
      this.mediaSourceHeight = video.videoHeight
      await video.play()
    } else {
      this.releaseMedia()
      throw new Error('不支持的素材类型')
    }

    this.updateMediaDimensions()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true

    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    window.removeEventListener('resize', this.handleResize)
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp)

    this.releaseMedia()
    this.points = []
    this.sticks = []
    this.perimeter = []
    this.ripples = []
    this.grabbedPoint = null
    this.activeHands = []
    this.handGrabbedPoints.clear()
    this.context.clearRect(0, 0, this.width, this.height)
  }

  private handleResize = () => this.resize()

  private handlePointerDown = (event: PointerEvent) => {
    event.preventDefault()
    const position = this.getPointerPosition(event)
    this.pointerDown = true
    this.pointerX = position.x
    this.pointerY = position.y
    this.ripples.push({
      x: position.x,
      y: position.y,
      radius: 0,
      maxRadius: 80,
      alpha: 200,
    })
    this.canvas.setPointerCapture(event.pointerId)
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.pointerDown) return
    event.preventDefault()
    const position = this.getPointerPosition(event)
    this.pointerX = position.x
    this.pointerY = position.y
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (!this.pointerDown) return
    event.preventDefault()
    this.pointerDown = false
    this.grabbedPoint = null
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId)
    }
  }

  private getPointerPosition(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private resize() {
    this.width = window.innerWidth
    this.height = window.innerHeight
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(this.width * pixelRatio)
    this.canvas.height = Math.round(this.height * pixelRatio)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    this.updateMediaDimensions()
  }

  private updateMediaDimensions() {
    const maxWidth = this.width * 0.85
    const maxHeight = this.height * 0.55

    if (!this.mediaType || this.mediaSourceWidth === 0 || this.mediaSourceHeight === 0) {
      this.baseMediaWidth = this.width * 0.7
      this.baseMediaHeight = this.height * 0.5
    } else {
      const mediaAspect = this.mediaSourceWidth / this.mediaSourceHeight
      const maxAspect = maxWidth / maxHeight

      if (mediaAspect > maxAspect) {
        this.baseMediaWidth = maxWidth
        this.baseMediaHeight = maxWidth / mediaAspect
      } else {
        this.baseMediaHeight = maxHeight
        this.baseMediaWidth = maxHeight * mediaAspect
      }
    }

    this.initCloth()
  }

  private initCloth() {
    this.points = []
    this.sticks = []
    this.grabbedPoint = null
    this.handGrabbedPoints.clear()

    const clothWidth = this.baseMediaWidth
    const clothHeight = this.baseMediaHeight * 1.25
    const startX = (this.width - clothWidth) / 2
    const startY = 100
    this.spacingX = clothWidth / (CLOTH_COLS - 1)
    this.spacingY = clothHeight / (CLOTH_ROWS - 1)

    for (let y = 0; y < CLOTH_ROWS; y += 1) {
      for (let x = 0; x < CLOTH_COLS; x += 1) {
        const pointX = startX + x * this.spacingX
        const pointY = startY + y * this.spacingY
        this.points.push({
          x: pointX,
          y: pointY,
          oldX: pointX,
          oldY: pointY,
          origBaseX: pointX,
          origBaseY: pointY,
          randomOffsetX: Math.random() * 40 - 20,
          randomOffsetY: Math.random() * 40 - 35,
          edgeSeed: Math.random() * Math.PI * 2,
          pinned: y === 0,
          wasGrabbed: false,
        })
      }
    }

    for (let y = 0; y < CLOTH_ROWS; y += 1) {
      for (let x = 0; x < CLOTH_COLS; x += 1) {
        const point = this.points[y * CLOTH_COLS + x]
        if (x < CLOTH_COLS - 1) {
          this.sticks.push({
            p1: point,
            p2: this.points[y * CLOTH_COLS + x + 1],
            length: this.spacingX,
          })
        }
        if (y < CLOTH_ROWS - 1) {
          this.sticks.push({
            p1: point,
            p2: this.points[(y + 1) * CLOTH_COLS + x],
            length: this.spacingY,
          })
        }
      }
    }
  }

  private animate = () => {
    if (this.destroyed || this.paused) return
    this.frame += 1
    this.updatePhysics()
    this.calculatePerimeter()
    this.render()
    this.animationFrame = requestAnimationFrame(this.animate)
  }

  private updatePhysics() {
    const grabbedPoints: Point[] = []
    const windX = Math.sin(this.frame * 0.007) * 0.04
    const windY = Math.sin(this.frame * 0.006 + 2.4) * 0.04
    const pointsHeldByHands = new Set(this.handGrabbedPoints.values())

    if (this.pointerDown) {
      if (!this.grabbedPoint) {
        let closestDistance = INTERACTION_RADIUS
        for (const point of this.points) {
          const distance = Math.hypot(this.pointerX - point.x, this.pointerY - point.y)
          if (distance < closestDistance && !point.pinned && !pointsHeldByHands.has(point)) {
            closestDistance = distance
            this.grabbedPoint = point
          }
        }
      }

      if (this.grabbedPoint) {
        this.grabbedPoint.oldX = this.grabbedPoint.x
        this.grabbedPoint.oldY = this.grabbedPoint.y
        this.grabbedPoint.x = this.pointerX
        this.grabbedPoint.y = this.pointerY
        grabbedPoints.push(this.grabbedPoint)

      }
    }

    for (const hand of this.activeHands) {
      if (!hand.isPinching) {
        this.handGrabbedPoints.delete(hand.id)
        continue
      }

      let handPoint = this.handGrabbedPoints.get(hand.id)
      if (!handPoint) {
        let closestDistance = INTERACTION_RADIUS
        const reservedPoints = new Set(this.handGrabbedPoints.values())
        for (const point of this.points) {
          const distance = Math.hypot(hand.x - point.x, hand.y - point.y)
          if (
            distance < closestDistance &&
            !point.pinned &&
            point !== this.grabbedPoint &&
            !reservedPoints.has(point)
          ) {
            closestDistance = distance
            handPoint = point
          }
        }
        if (handPoint) {
          this.handGrabbedPoints.set(hand.id, handPoint)
          if (!this.hasReportedHandGrab) {
            this.hasReportedHandGrab = true
            this.firstGrabPosition = { x: hand.x, y: hand.y }
            this.onFirstHandGrab?.()
          }
        }
      }

      if (handPoint) {
        if (
          !this.hasReportedCurtainMove &&
          this.firstGrabPosition &&
          Math.hypot(hand.x - this.firstGrabPosition.x, hand.y - this.firstGrabPosition.y) > 36
        ) {
          this.hasReportedCurtainMove = true
          this.onFirstCurtainMove?.()
        }
        handPoint.oldX = handPoint.x
        handPoint.oldY = handPoint.y
        handPoint.x = hand.x
        handPoint.y = hand.y
        grabbedPoints.push(handPoint)
      }
    }

    for (const point of grabbedPoints) {
      if (this.isCurtainThrown && point.y > 280) this.isCurtainThrown = false
      if (!this.isCurtainThrown && point.y < 90) this.isCurtainThrown = true
    }

    for (const point of this.points) {
      const grabbed = grabbedPoints.includes(point)
      if (!point.pinned && !grabbed) {
        const velocityX = (point.x - point.oldX) * FRICTION
        const velocityY = (point.y - point.oldY) * FRICTION

        if (point.wasGrabbed) {
          if (velocityY < -15) this.isCurtainThrown = true
          if (velocityY > 15) this.isCurtainThrown = false
        }

        let targetX = point.origBaseX
        let targetY = point.origBaseY
        if (this.isCurtainThrown) {
          targetX += point.randomOffsetX
          targetY = 85 + point.randomOffsetY
        }

        const restoreForce = this.isCurtainThrown ? 0.025 : 0.0015
        const restoreX = (targetX - point.x) * restoreForce
        const restoreY = (targetY - point.y) * restoreForce

        point.oldX = point.x
        point.oldY = point.y
        point.x += velocityX + windX + restoreX
        point.y += velocityY + windY + restoreY + GRAVITY
      }
      point.wasGrabbed = grabbed
    }

    const constraintIterations = this.quality === 'high' ? ITERATIONS : this.quality === 'medium' ? 8 : 5
    for (let iteration = 0; iteration < constraintIterations; iteration += 1) {
      for (const stick of this.sticks) {
        const deltaX = stick.p2.x - stick.p1.x
        const deltaY = stick.p2.y - stick.p1.y
        const distance = Math.hypot(deltaX, deltaY)
        if (distance === 0) continue
        const percent = ((stick.length - distance) / distance / 2) * 0.4
        const offsetX = deltaX * percent
        const offsetY = deltaY * percent

        if (!stick.p1.pinned && !grabbedPoints.includes(stick.p1)) {
          stick.p1.x -= offsetX
          stick.p1.y -= offsetY
        }
        if (!stick.p2.pinned && !grabbedPoints.includes(stick.p2)) {
          stick.p2.x += offsetX
          stick.p2.y += offsetY
        }
      }
    }
  }

  private calculatePerimeter() {
    this.perimeter = []
    const addPoint = (point: Point) => {
      const edgeMotion = this.frame * 0.035
      this.perimeter.push({
        x: point.x + Math.sin(point.edgeSeed + edgeMotion) * 3,
        y: point.y + Math.sin(point.edgeSeed * 1.7 + edgeMotion) * 3,
      })
    }

    for (let x = 0; x < CLOTH_COLS; x += 1) addPoint(this.points[x])
    for (let y = 1; y < CLOTH_ROWS; y += 1) addPoint(this.points[y * CLOTH_COLS + CLOTH_COLS - 1])
    for (let x = CLOTH_COLS - 2; x >= 0; x -= 1) addPoint(this.points[(CLOTH_ROWS - 1) * CLOTH_COLS + x])
    for (let y = CLOTH_ROWS - 2; y > 0; y -= 1) addPoint(this.points[y * CLOTH_COLS])
  }

  private render() {
    const context = this.context
    context.clearRect(0, 0, this.width, this.height)

    this.drawCameraCover()
    if (this.mediaType) this.drawUploadedMedia()

    context.save()
    this.tracePerimeter()
    context.clip()
    this.drawCameraCover()
    context.restore()

    this.renderClothVisuals()
    this.renderRipples()
  }

  private drawUploadedMedia() {
    const x = (this.width - this.baseMediaWidth) / 2
    const y = 100

    if (this.mediaType === 'image' && this.uploadedImage) {
      this.drawCover(
        this.uploadedImage,
        this.uploadedImage.naturalWidth,
        this.uploadedImage.naturalHeight,
        x,
        y,
        this.baseMediaWidth,
        this.baseMediaHeight,
      )
    }

    if (this.mediaType === 'video' && this.uploadedVideo && this.uploadedVideo.readyState >= 2) {
      this.drawCover(
        this.uploadedVideo,
        this.uploadedVideo.videoWidth,
        this.uploadedVideo.videoHeight,
        x,
        y,
        this.baseMediaWidth,
        this.baseMediaHeight,
      )
    }
  }

  private drawCover(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    const sourceAspect = sourceWidth / sourceHeight
    const destinationAspect = width / height
    let sx = 0
    let sy = 0
    let sw = sourceWidth
    let sh = sourceHeight

    if (sourceAspect > destinationAspect) {
      sw = sourceHeight * destinationAspect
      sx = (sourceWidth - sw) / 2
    } else {
      sh = sourceWidth / destinationAspect
      sy = (sourceHeight - sh) / 2
    }

    this.context.drawImage(source, sx, sy, sw, sh, x, y, width, height)
  }

  private drawCameraCover() {
    if (this.cameraVideo.readyState < 2 || !this.cameraVideo.videoWidth) return

    const videoAspect = this.cameraVideo.videoWidth / this.cameraVideo.videoHeight
    let drawWidth = this.height * videoAspect
    let drawHeight = this.height
    if (drawWidth < this.width) {
      drawWidth = this.width
      drawHeight = this.width / videoAspect
    }
    const drawX = (this.width - drawWidth) / 2
    const drawY = (this.height - drawHeight) / 2

    this.context.save()
    if (this.facingMode === 'user') {
      this.context.translate(this.width, 0)
      this.context.scale(-1, 1)
    }
    this.context.drawImage(this.cameraVideo, drawX, drawY, drawWidth, drawHeight)
    this.context.restore()
  }

  private tracePerimeter() {
    const context = this.context
    if (!this.perimeter.length) return
    context.beginPath()
    context.moveTo(this.perimeter[0].x, this.perimeter[0].y)
    for (let index = 1; index < this.perimeter.length; index += 1) {
      context.lineTo(this.perimeter[index].x, this.perimeter[index].y)
    }
    context.closePath()
  }

  private renderClothVisuals() {
    const context = this.context
    const visualStep = this.quality === 'low' ? 2 : 1
    for (let y = 0; y < CLOTH_ROWS - 1; y += visualStep) {
      for (let x = 0; x < CLOTH_COLS - 1; x += visualStep) {
        const p1 = this.points[y * CLOTH_COLS + x]
        const p2 = this.points[y * CLOTH_COLS + x + 1]
        const p3 = this.points[(y + 1) * CLOTH_COLS + x + 1]
        const p4 = this.points[(y + 1) * CLOTH_COLS + x]
        const currentWidth = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        const currentHeight = Math.hypot(p4.x - p1.x, p4.y - p1.y)
        const ratio = (currentWidth * currentHeight) / (this.spacingX * this.spacingY)

        if (ratio < 0.95) {
          const alpha = this.mapClamped(ratio, 0.3, 0.95, 180, 0)
          this.fillQuad(p1, p2, p3, p4, `rgba(0, 0, 0, ${alpha / 255})`)
          if (ratio < 0.7) {
            const colorAlpha = this.mapClamped(ratio, 0.3, 0.7, 140, 0)
            this.fillQuad(p1, p2, p3, p4, `rgba(20, 30, 80, ${colorAlpha / 255})`)
          }
        } else if (ratio > 1.05) {
          const alpha = this.mapClamped(ratio, 1.05, 1.5, 0, 90)
          this.fillQuad(p1, p2, p3, p4, `rgba(255, 245, 230, ${alpha / 255})`)
        }
      }
    }

    context.save()
    this.traceSmoothPerimeter()
    context.shadowBlur = 0
    context.strokeStyle = 'rgba(0, 0, 0, .3)'
    context.lineWidth = 4
    context.stroke()

    this.traceSmoothPerimeter()
    context.shadowBlur = this.quality === 'high' ? 12 : this.quality === 'medium' ? 8 : 3
    context.shadowColor = 'rgba(255, 255, 255, .8)'
    context.strokeStyle = 'rgba(255, 255, 255, .7)'
    context.lineWidth = 1.5
    context.stroke()
    context.restore()
  }

  private traceSmoothPerimeter() {
    const context = this.context
    const points = this.perimeter
    if (!points.length) return
    const last = points[points.length - 1]
    const first = points[0]
    context.beginPath()
    context.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2)
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      const next = points[(index + 1) % points.length]
      context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
    }
    context.closePath()
  }

  private fillQuad(p1: Point, p2: Point, p3: Point, p4: Point, fillStyle: string) {
    const context = this.context
    context.beginPath()
    context.moveTo(p1.x, p1.y)
    context.lineTo(p2.x, p2.y)
    context.lineTo(p3.x, p3.y)
    context.lineTo(p4.x, p4.y)
    context.closePath()
    context.fillStyle = fillStyle
    context.fill()
  }

  private renderRipples() {
    const context = this.context
    context.save()
    context.lineWidth = 2.5

    for (let index = this.ripples.length - 1; index >= 0; index -= 1) {
      const ripple = this.ripples[index]
      context.beginPath()
      context.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2)
      context.strokeStyle = `rgba(255, 255, 255, ${ripple.alpha / 255})`
      context.stroke()
      ripple.radius += (ripple.maxRadius - ripple.radius) * 0.1 + 1
      ripple.alpha -= 8
      if (ripple.alpha <= 0) this.ripples.splice(index, 1)
    }

    context.restore()
  }

  private mapClamped(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
    const progress = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)))
    return outMin + (outMax - outMin) * progress
  }

  private releaseMedia() {
    if (this.uploadedVideo) {
      this.uploadedVideo.pause()
      this.uploadedVideo.removeAttribute('src')
      this.uploadedVideo.load()
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)

    this.uploadedImage = null
    this.uploadedVideo = null
    this.objectUrl = null
    this.mediaType = null
    this.mediaSourceWidth = 0
    this.mediaSourceHeight = 0
  }
}
