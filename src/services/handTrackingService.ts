import type {
  Hands as MediaPipeHands,
  HandsConfig,
  NormalizedLandmark,
  NormalizedLandmarkList,
  Results,
} from '@mediapipe/hands'

type MediaPipeHandsConstructor = new (config?: HandsConfig) => MediaPipeHands

declare global {
  interface Window {
    Hands?: MediaPipeHandsConstructor
  }
}

const MEDIAPIPE_HANDS_VERSION = '0.4.1675469240'
const MEDIAPIPE_HANDS_SCRIPT =
  `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_HANDS_VERSION}/hands.js`

let mediaPipeLoader: Promise<MediaPipeHandsConstructor> | null = null

function loadMediaPipeHands() {
  if (window.Hands) return Promise.resolve(window.Hands)
  if (mediaPipeLoader) return mediaPipeLoader

  mediaPipeLoader = new Promise<MediaPipeHandsConstructor>((resolve, reject) => {
    const script = document.createElement('script')
    const timeout = window.setTimeout(() => reject(new Error('MediaPipe Hands load timed out.')), 15_000)
    script.src = MEDIAPIPE_HANDS_SCRIPT
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      window.clearTimeout(timeout)
      if (window.Hands) resolve(window.Hands)
      else reject(new Error('MediaPipe Hands did not initialize.'))
    }
    script.onerror = () => {
      window.clearTimeout(timeout)
      reject(new Error('MediaPipe Hands failed to load.'))
    }
    document.head.appendChild(script)
  }).catch((error) => {
    mediaPipeLoader = null
    throw error
  })

  return mediaPipeLoader
}

export type HandPoint = { x: number; y: number; z: number }

export type TrackedHand = {
  id: number
  thumbTip: HandPoint
  indexTip: HandPoint
  pinchCenter: HandPoint
  pinchDistance: number
  isPinching: boolean
  justStartedPinching: boolean
  x: number
  y: number
  indexX: number
  indexY: number
  previousIndexX: number
  previousIndexY: number
  palmCenter: HandPoint
  palmX: number
  palmY: number
  previousPalmX: number
  previousPalmY: number
  velocityX: number
  velocityY: number
  speed: number
  palmRadius: number
  trackingDeltaMs: number
  landmarks: NormalizedLandmarkList
}

type PreviousHand = Pick<
  TrackedHand,
  'id' | 'x' | 'y' | 'isPinching' | 'indexX' | 'indexY' | 'palmX' | 'palmY' | 'velocityX' | 'velocityY'
> & { updatedAt: number }

type HandTrackingCallbacks = {
  onHands: (hands: TrackedHand[]) => void
  onError: () => void
}

const PREVIOUS_HAND_MATCH_RADIUS = 200
const PALM_POSITION_SMOOTHING = 0.55
const PALM_VELOCITY_SMOOTHING = 0.42
const PALM_LANDMARKS = [0, 5, 9, 13, 17]

export class HandTrackingService {
  private hands: MediaPipeHands | null = null
  private video: HTMLVideoElement | null = null
  private mirrored = true
  private callbacks: HandTrackingCallbacks | null = null
  private previousHands: PreviousHand[] = []
  private animationFrame: number | null = null
  private inferencePromise: Promise<void> | null = null
  private inferenceInProgress = false
  private running = false
  private failed = false
  private lastVideoTime = -1
  private nextHandId = 1
  private generation = 0

  async start(
    video: HTMLVideoElement,
    mirrored: boolean,
    callbacks: HandTrackingCallbacks,
  ) {
    await this.destroy()
    const generation = ++this.generation

    this.video = video
    this.mirrored = mirrored
    this.callbacks = callbacks
    this.failed = false
    this.previousHands = []
    this.lastVideoTime = -1

    const HandsConstructor = await loadMediaPipeHands()
    if (generation !== this.generation) return

    const hands = new HandsConstructor({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_HANDS_VERSION}/${file}`,
    })

    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    hands.onResults(this.handleResults)

    this.hands = hands
    await Promise.race([
      hands.initialize(),
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error('MediaPipe Hands initialization timed out.')),
        20_000,
      )),
    ])

    if (this.hands !== hands) {
      await hands.close()
      return
    }

    this.running = true
    this.processNextFrame()
  }

  async destroy() {
    this.generation += 1
    this.running = false
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null

    const activeInference = this.inferencePromise
    if (activeInference) {
      try {
        await activeInference
      } catch {
        // The service is already stopping; inference errors can be ignored here.
      }
    }

    const hands = this.hands
    this.hands = null
    if (hands) {
      try {
        await hands.close()
      } catch {
        // MediaPipe may already be closed after an initialization failure.
      }
    }

    this.video = null
    this.callbacks?.onHands([])
    this.callbacks = null
    this.previousHands = []
    this.inferencePromise = null
    this.inferenceInProgress = false
    this.lastVideoTime = -1
  }

  pause() {
    this.running = false
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
  }

  resume() {
    if (this.running || !this.hands || !this.video) return
    this.running = true
    this.lastVideoTime = -1
    this.processNextFrame()
  }

  private processNextFrame = () => {
    if (!this.running) return

    const video = this.video
    const hands = this.hands
    if (
      video &&
      hands &&
      video.readyState >= 2 &&
      video.currentTime !== this.lastVideoTime &&
      !this.inferenceInProgress
    ) {
      this.lastVideoTime = video.currentTime
      this.inferenceInProgress = true
      const inference = hands.send({ image: video })
      this.inferencePromise = inference

      void inference
        .catch(() => this.reportFailure())
        .finally(() => {
          if (this.inferencePromise === inference) this.inferencePromise = null
          this.inferenceInProgress = false
        })
    }

    this.animationFrame = requestAnimationFrame(this.processNextFrame)
  }

  private handleResults = (results: Results) => {
    if (!this.running || !this.video) return

    const now = performance.now()
    const usedPreviousHands = new Set<number>()
    const nextHands: TrackedHand[] = results.multiHandLandmarks
      .slice(0, 2)
      .map((landmarks) => {
        const thumbTip = landmarks[4]
        const indexTip = landmarks[8]
        const pinchDistance = Math.hypot(
          indexTip.x - thumbTip.x,
          indexTip.y - thumbTip.y,
        )
        const pinchCenter = {
          x: (thumbTip.x + indexTip.x) / 2,
          y: (thumbTip.y + indexTip.y) / 2,
          z: (thumbTip.z + indexTip.z) / 2,
        }
        const screenPosition = this.toScreenPosition(pinchCenter)
        const indexScreenPosition = this.toScreenPosition(indexTip)
        const previousHand = this.findPreviousHand(screenPosition.x, screenPosition.y, usedPreviousHands)
        if (previousHand) usedPreviousHands.add(previousHand.id)

        const wasPinching = previousHand?.isPinching ?? false
        const isPinching = pinchDistance < (wasPinching ? 0.08 : 0.05)
        const palmCenter = PALM_LANDMARKS.reduce(
          (center, index) => {
            center.x += landmarks[index].x / PALM_LANDMARKS.length
            center.y += landmarks[index].y / PALM_LANDMARKS.length
            center.z += landmarks[index].z / PALM_LANDMARKS.length
            return center
          },
          { x: 0, y: 0, z: 0 },
        )
        const rawPalmPosition = this.toScreenPosition(palmCenter)
        const palmX = previousHand
          ? previousHand.palmX + (rawPalmPosition.x - previousHand.palmX) * PALM_POSITION_SMOOTHING
          : rawPalmPosition.x
        const palmY = previousHand
          ? previousHand.palmY + (rawPalmPosition.y - previousHand.palmY) * PALM_POSITION_SMOOTHING
          : rawPalmPosition.y
        const elapsedSeconds = previousHand
          ? Math.max(.016, Math.min(.1, (now - previousHand.updatedAt) / 1000))
          : .033
        const rawVelocityX = previousHand ? (palmX - previousHand.palmX) / elapsedSeconds : 0
        const rawVelocityY = previousHand ? (palmY - previousHand.palmY) / elapsedSeconds : 0
        let velocityX = previousHand
          ? previousHand.velocityX + (rawVelocityX - previousHand.velocityX) * PALM_VELOCITY_SMOOTHING
          : 0
        let velocityY = previousHand
          ? previousHand.velocityY + (rawVelocityY - previousHand.velocityY) * PALM_VELOCITY_SMOOTHING
          : 0
        let speed = Math.hypot(velocityX, velocityY)
        if (speed < 32) {
          velocityX = 0
          velocityY = 0
          speed = 0
        } else if (speed > 2400) {
          const limit = 2400 / speed
          velocityX *= limit
          velocityY *= limit
          speed = 2400
        }
        const palmLeft = this.toScreenPosition(landmarks[5])
        const palmRight = this.toScreenPosition(landmarks[17])
        const palmRadius = Math.max(64, Math.min(170, Math.hypot(
          palmRight.x - palmLeft.x,
          palmRight.y - palmLeft.y,
        ) * .72))

        return {
          id: previousHand?.id ?? this.nextHandId++,
          thumbTip: this.copyPoint(thumbTip),
          indexTip: this.copyPoint(indexTip),
          pinchCenter,
          pinchDistance,
          isPinching,
          justStartedPinching: isPinching && !wasPinching,
          x: screenPosition.x,
          y: screenPosition.y,
          indexX: indexScreenPosition.x,
          indexY: indexScreenPosition.y,
          previousIndexX: previousHand?.indexX ?? indexScreenPosition.x,
          previousIndexY: previousHand?.indexY ?? indexScreenPosition.y,
          palmCenter,
          palmX,
          palmY,
          previousPalmX: previousHand?.palmX ?? palmX,
          previousPalmY: previousHand?.palmY ?? palmY,
          velocityX,
          velocityY,
          speed,
          palmRadius,
          trackingDeltaMs: elapsedSeconds * 1000,
          landmarks,
        }
      })

    this.previousHands = nextHands.map(({ id, x, y, isPinching, indexX, indexY, palmX, palmY, velocityX, velocityY }) => ({
      id,
      x,
      y,
      isPinching,
      indexX,
      indexY,
      palmX,
      palmY,
      velocityX,
      velocityY,
      updatedAt: now,
    }))
    this.callbacks?.onHands(nextHands)
  }

  private findPreviousHand(x: number, y: number, usedHands: Set<number>) {
    let closestHand: PreviousHand | undefined
    let closestDistance = PREVIOUS_HAND_MATCH_RADIUS

    for (const hand of this.previousHands) {
      if (usedHands.has(hand.id)) continue
      const distance = Math.hypot(hand.x - x, hand.y - y)
      if (distance < closestDistance) {
        closestDistance = distance
        closestHand = hand
      }
    }

    return closestHand
  }

  private toScreenPosition(point: HandPoint) {
    const video = this.video
    if (!video?.videoWidth || !video.videoHeight) return { x: 0, y: 0 }

    const screenWidth = window.innerWidth
    const screenHeight = window.innerHeight
    const videoAspect = video.videoWidth / video.videoHeight
    let drawWidth = screenHeight * videoAspect
    let drawHeight = screenHeight
    if (drawWidth < screenWidth) {
      drawWidth = screenWidth
      drawHeight = screenWidth / videoAspect
    }

    const offsetX = (screenWidth - drawWidth) / 2
    const offsetY = (screenHeight - drawHeight) / 2
    const normalizedX = this.mirrored ? 1 - point.x : point.x

    return {
      x: offsetX + normalizedX * drawWidth,
      y: offsetY + point.y * drawHeight,
    }
  }

  private copyPoint(point: NormalizedLandmark): HandPoint {
    return { x: point.x, y: point.y, z: point.z }
  }

  private reportFailure() {
    if (this.failed) return
    this.failed = true
    this.running = false
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
    this.previousHands = []
    this.callbacks?.onHands([])
    this.callbacks?.onError()
  }
}
