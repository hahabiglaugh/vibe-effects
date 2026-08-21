export type CameraFacingMode = 'user' | 'environment'

export type CameraErrorCode =
  | 'permission-denied'
  | 'not-found'
  | 'start-failed'

export class CameraServiceError extends Error {
  code: CameraErrorCode

  constructor(code: CameraErrorCode, message: string) {
    super(message)
    this.name = 'CameraServiceError'
    this.code = code
  }
}

export class CameraService {
  private stream: MediaStream | null = null
  private videoElement: HTMLVideoElement | null = null
  private facingMode: CameraFacingMode = 'user'
  private generation = 0

  get currentFacingMode() {
    return this.facingMode
  }

  async start(
    videoElement: HTMLVideoElement,
    facingMode: CameraFacingMode = 'user',
    requireExactFacingMode = false,
  ): Promise<CameraFacingMode> {
    this.stop()
    const generation = this.generation

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraServiceError('start-failed', '当前浏览器不支持摄像头访问。')
    }

    try {
      const facingConstraint = requireExactFacingMode
        ? { exact: facingMode }
        : { ideal: facingMode }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: facingConstraint,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })

      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        throw new CameraServiceError('start-failed', 'Camera request was cancelled.')
      }

      this.stream = stream
      this.videoElement = videoElement
      this.facingMode = facingMode

      videoElement.srcObject = stream
      videoElement.muted = true
      videoElement.playsInline = true
      await videoElement.play()

      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        throw new CameraServiceError('start-failed', 'Camera request was cancelled.')
      }

      return this.facingMode
    } catch (error) {
      this.stop()
      throw this.normalizeError(error)
    }
  }

  async switchCamera(videoElement: HTMLVideoElement): Promise<CameraFacingMode> {
    const nextFacingMode: CameraFacingMode =
      this.facingMode === 'user' ? 'environment' : 'user'

    return this.start(videoElement, nextFacingMode, true)
  }

  stop() {
    this.generation += 1
    this.stream?.getTracks().forEach((track) => track.stop())

    if (this.videoElement) {
      this.videoElement.pause()
      this.videoElement.srcObject = null
    }

    this.stream = null
    this.videoElement = null
  }

  private normalizeError(error: unknown): CameraServiceError {
    if (error instanceof CameraServiceError) return error

    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        return new CameraServiceError('permission-denied', error.message)
      }

      if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
        return new CameraServiceError('not-found', error.message)
      }
    }

    return new CameraServiceError(
      'start-failed',
      error instanceof Error ? error.message : 'Unknown camera error',
    )
  }
}
