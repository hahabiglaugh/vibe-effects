export type RecordingResult = {
  blob: Blob
  url: string
  mimeType: string
  extension: 'webm' | 'mp4'
}

const MIME_TYPE_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1.4D401E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export class RecordingService {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private previewUrl: string | null = null
  private completionPromise: Promise<RecordingResult | null> | null = null
  private resolveCompletion: ((result: RecordingResult | null) => void) | null = null
  private rejectCompletion: ((error: unknown) => void) | null = null
  private discardResult = false

  static isSupported(canvas: HTMLCanvasElement) {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof canvas.captureStream === 'function'
    )
  }

  start(canvas: HTMLCanvasElement, frameRate = 30) {
    if (!RecordingService.isSupported(canvas)) {
      throw new Error('MediaRecorder is not supported.')
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      throw new Error('A recording is already in progress.')
    }

    this.clearPreview()
    this.chunks = []
    this.discardResult = false
    this.stream = canvas.captureStream(frameRate)

    const mimeType = MIME_TYPE_CANDIDATES.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    )
    try {
      this.recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream)
    } catch (error) {
      this.cleanupRecorder()
      throw error
    }

    const recorder = this.recorder
    this.completionPromise = new Promise<RecordingResult | null>((resolve, reject) => {
      this.resolveCompletion = resolve
      this.rejectCompletion = reject
    })

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.onstop = () => this.finishRecording(recorder)
    recorder.onerror = (event) => {
      this.rejectCompletion?.(event)
      this.cleanupRecorder()
    }
    try {
      recorder.start(1000)
    } catch (error) {
      this.cleanupRecorder()
      throw error
    }
  }

  async stop() {
    if (!this.recorder || !this.completionPromise) return null
    const completion = this.completionPromise
    if (this.recorder.state !== 'inactive') this.recorder.stop()
    return completion
  }

  async cancel() {
    this.discardResult = true
    if (this.recorder) {
      const completion = this.completionPromise
      if (this.recorder.state !== 'inactive') this.recorder.stop()
      this.stopCaptureTracks()
      if (completion) {
        try {
          await completion
        } catch {
          // Cancellation intentionally discards recorder errors and partial data.
        }
      } else {
        this.cleanupRecorder()
      }
    } else {
      this.cleanupRecorder()
    }
    this.chunks = []
    this.clearPreview()
  }

  download(filename: string) {
    if (!this.previewUrl) return
    const link = document.createElement('a')
    link.href = this.previewUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  clearPreview() {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl)
    this.previewUrl = null
  }

  async destroy() {
    await this.cancel()
    this.resolveCompletion = null
    this.rejectCompletion = null
    this.completionPromise = null
  }

  private finishRecording(recorder: MediaRecorder) {
    if (recorder !== this.recorder) return

    if (this.discardResult || this.chunks.length === 0) {
      const resolve = this.resolveCompletion
      this.cleanupRecorder()
      this.chunks = []
      resolve?.(null)
      return
    }

    const mimeType = recorder.mimeType || this.chunks[0].type || 'video/webm'
    const blob = new Blob(this.chunks, { type: mimeType })
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const url = URL.createObjectURL(blob)
    const result: RecordingResult = { blob, url, mimeType, extension }
    const resolve = this.resolveCompletion

    this.previewUrl = url
    this.cleanupRecorder()
    this.chunks = []
    resolve?.(result)
  }

  private cleanupRecorder() {
    this.stopCaptureTracks()
    if (this.recorder) {
      this.recorder.ondataavailable = null
      this.recorder.onstop = null
      this.recorder.onerror = null
    }
    this.recorder = null
    this.stream = null
    this.resolveCompletion = null
    this.rejectCompletion = null
    this.completionPromise = null
  }

  private stopCaptureTracks() {
    this.stream?.getTracks().forEach((track) => track.stop())
  }
}
