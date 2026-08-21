import type {
  Hands as MediaPipeHands,
  HandsConfig,
  NormalizedLandmark,
  NormalizedLandmarkList,
  Results,
} from '@mediapipe/hands'
import type { CameraFacingMode } from './cameraService'

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
    script.src = MEDIAPIPE_HANDS_SCRIPT
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      if (window.Hands) resolve(window.Hands)
      else reject(new Error('MediaPipe Hands did not initialize.'))
    }
    script.onerror = () => reject(new Error('MediaPipe Hands failed to load.'))
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
  landmarks: NormalizedLandmarkList
}

type PreviousHand = Pick<TrackedHand, 'id' | 'x' | 'y' | 'isPinching'>

type HandTrackingCallbacks = {
  onHands: (hands: TrackedHand[]) => void
  onError: () => void
}

const PREVIOUS_HAND_MATCH_RADIUS = 200

export class HandTrackingService {
  private hands: MediaPipeHands | null = null
  private video: HTMLVideoElement | null = null
  private facingMode: CameraFacingMode = 'user'
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
    facingMode: CameraFacingMode,
    callbacks: HandTrackingCallbacks,
  ) {
    await this.destroy()
    const generation = ++this.generation

    this.video = video
    this.facingMode = facingMode
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
    await hands.initialize()

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
        const previousHand = this.findPreviousHand(screenPosition.x, screenPosition.y, usedPreviousHands)
        if (previousHand) usedPreviousHands.add(previousHand.id)

        const wasPinching = previousHand?.isPinching ?? false
        const isPinching = pinchDistance < (wasPinching ? 0.08 : 0.05)

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
          landmarks,
        }
      })

    this.previousHands = nextHands.map(({ id, x, y, isPinching }) => ({
      id,
      x,
      y,
      isPinching,
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
    const normalizedX = this.facingMode === 'user' ? 1 - point.x : point.x

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
