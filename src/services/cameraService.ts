export type CameraFacingMode = 'user' | 'environment'
export type CameraDevice = { deviceId: string; label: string; groupId?: string }
export type CameraState = { selectedCameraDeviceId: string | null; facingMode: CameraFacingMode; isCameraMirrored: boolean }
export type CameraErrorCode = 'permission-denied' | 'not-found' | 'not-readable' | 'overconstrained' | 'start-failed'
export const CAMERA_DEVICE_STORAGE_KEY = 'vibe-effects-camera-device-id'

export class CameraServiceError extends Error {
  code: CameraErrorCode
  constructor(code: CameraErrorCode, message: string) { super(message); this.name = 'CameraServiceError'; this.code = code }
}

export class CameraService {
  private stream: MediaStream | null = null
  private videoElement: HTMLVideoElement | null = null
  private state: CameraState = { selectedCameraDeviceId: null, facingMode: 'user', isCameraMirrored: true }
  private generation = 0
  get currentState() { return this.state }
  get currentDeviceId() { return this.state.selectedCameraDeviceId }
  get isMobile() { return matchMedia('(pointer: coarse)').matches }
  get isActive() { return this.stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false }

  async enumerateCameras(): Promise<CameraDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const devices = await navigator.mediaDevices.enumerateDevices()
    let index = 0
    return devices.filter((device) => device.kind === 'videoinput').map((device) => ({
      deviceId: device.deviceId,
      label: device.label || `Camera ${++index}`,
      groupId: device.groupId || undefined,
    }))
  }

  async start(videoElement: HTMLVideoElement): Promise<CameraState> {
    let remembered: string | null = null
    try { remembered = localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY) } catch { /* Optional storage. */ }
    const initial = await this.open(videoElement, this.isMobile ? { facingMode: { ideal: 'user' } } : true, 'user', null)
    const cameras = await this.enumerateCameras()
    if (!remembered || !cameras.some((camera) => camera.deviceId === remembered)) {
      if (remembered) try { localStorage.removeItem(CAMERA_DEVICE_STORAGE_KEY) } catch { /* Optional storage. */ }
      return initial
    }
    if (initial.selectedCameraDeviceId === remembered) return initial
    return this.selectDevice(videoElement, remembered)
  }

  async selectDevice(videoElement: HTMLVideoElement, deviceId: string): Promise<CameraState> {
    try {
      const state = await this.open(videoElement, { deviceId: { exact: deviceId } }, 'environment', deviceId)
      try { localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, state.selectedCameraDeviceId ?? deviceId) } catch { /* Optional storage. */ }
      return state
    } catch (error) {
      const normalized = this.normalizeError(error)
      if (normalized.code === 'permission-denied') throw normalized
      try { localStorage.removeItem(CAMERA_DEVICE_STORAGE_KEY) } catch { /* Optional storage. */ }
      return this.open(videoElement, true, 'environment', null)
    }
  }

  async switchCamera(videoElement: HTMLVideoElement, cameras: CameraDevice[]): Promise<CameraState> {
    if (!this.isMobile && cameras.length > 1) {
      const index = cameras.findIndex((camera) => camera.deviceId === this.currentDeviceId)
      return this.selectDevice(videoElement, cameras[(index + 1 + cameras.length) % cameras.length].deviceId)
    }
    const next: CameraFacingMode = this.state.facingMode === 'user' ? 'environment' : 'user'
    return this.open(videoElement, { facingMode: { exact: next } }, next, null)
  }

  stop() {
    this.generation += 1
    this.stream?.getTracks().forEach((track) => track.stop())
    if (this.videoElement) { this.videoElement.pause(); this.videoElement.srcObject = null }
    this.stream = null; this.videoElement = null
  }

  private async open(videoElement: HTMLVideoElement, constraint: boolean | MediaTrackConstraints, requestedFacingMode: CameraFacingMode, requestedDeviceId: string | null): Promise<CameraState> {
    this.stop()
    const generation = this.generation
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraServiceError('start-failed', '当前浏览器不支持摄像头访问。')
    try {
      const video = typeof constraint === 'boolean' ? constraint : { ...constraint, width: { ideal: this.isMobile ? 960 : 1280 }, height: { ideal: this.isMobile ? 540 : 720 } }
      const request = navigator.mediaDevices.getUserMedia({ audio: false, video })
      let timedOut = false
      request.then((late) => { if (timedOut) late.getTracks().forEach((track) => track.stop()) }).catch(() => {})
      let timeoutId: number | undefined
      const stream = await Promise.race([request, new Promise<never>((_, reject) => { timeoutId = window.setTimeout(() => { timedOut = true; reject(new CameraServiceError('start-failed', '摄像头启动超时。')) }, 30_000) })])
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); throw new CameraServiceError('start-failed', 'Camera request was cancelled.') }
      const settings = stream.getVideoTracks()[0].getSettings()
      const facingMode = settings.facingMode === 'user' || settings.facingMode === 'environment' ? settings.facingMode : requestedFacingMode
      const selectedCameraDeviceId = settings.deviceId || requestedDeviceId
      const isCameraMirrored = this.isMobile && facingMode === 'user'
      this.stream = stream; this.videoElement = videoElement
      this.state = { selectedCameraDeviceId, facingMode, isCameraMirrored }
      videoElement.srcObject = stream; videoElement.muted = true; videoElement.playsInline = true
      if (videoElement.readyState < HTMLMediaElement.HAVE_METADATA) await new Promise<void>((resolve) => videoElement.addEventListener('loadedmetadata', () => resolve(), { once: true }))
      await videoElement.play()
      return this.state
    } catch (error) { this.stop(); throw this.normalizeError(error) }
  }

  private normalizeError(error: unknown): CameraServiceError {
    if (error instanceof CameraServiceError) return error
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return new CameraServiceError('permission-denied', error.message)
      if (error.name === 'NotFoundError') return new CameraServiceError('not-found', error.message)
      if (error.name === 'NotReadableError') return new CameraServiceError('not-readable', error.message)
      if (error.name === 'OverconstrainedError') return new CameraServiceError('overconstrained', error.message)
    }
    return new CameraServiceError('start-failed', error instanceof Error ? error.message : 'Unknown camera error')
  }
}
