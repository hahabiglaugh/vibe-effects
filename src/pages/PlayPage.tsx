import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { InvisibleCurtainEffect } from '../effects/invisible-curtain/InvisibleCurtainEffect'
import {
  CameraService,
  CameraServiceError,
  type CameraErrorCode,
  type CameraFacingMode,
} from '../services/cameraService'
import { HandTrackingService } from '../services/handTrackingService'
import {
  RecordingService,
  type RecordingResult,
} from '../services/recordingService'
import {
  convertWebMToMp4,
  downloadBlob,
  isMp4Blob,
} from '../services/videoExportService'

type CameraStatus = 'idle' | 'requesting' | 'active' | 'switching' | 'error'
type RecordingStatus = 'idle' | 'countdown' | 'recording' | 'stopping' | 'preview'
const GESTURE_TIP_KEY = 'vibe-effects-invisible-curtain-grabbed'

const errorContent: Record<CameraErrorCode, { title: string; description?: string }> = {
  'permission-denied': {
    title: '无法访问摄像头，请在浏览器设置中允许摄像头权限。',
  },
  'not-found': {
    title: '未检测到可用摄像头',
  },
  'start-failed': {
    title: '摄像头启动失败，请稍后重试。',
  },
}

function PlayPage() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const cameraServiceRef = useRef(new CameraService())
  const handTrackingServiceRef = useRef<HandTrackingService | null>(null)
  const curtainEffectRef = useRef<InvisibleCurtainEffect | null>(null)
  const recordingServiceRef = useRef(new RecordingService())
  const mountedRef = useRef(true)
  const countdownTimerRef = useRef<number | null>(null)
  const recordingTimerRef = useRef<number | null>(null)
  const recordingLimitTimerRef = useRef<number | null>(null)
  const stoppingRecordingRef = useRef(false)
  const exportAbortControllerRef = useRef<AbortController | null>(null)
  const gestureTipTimerRef = useRef<number | null>(null)
  const performanceRef = useRef({ frames: 0, inferences: 0 })
  const [status, setStatus] = useState<CameraStatus>('idle')
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('user')
  const [cameraError, setCameraError] = useState<CameraErrorCode | null>(null)
  const [hasUploadedMedia, setHasUploadedMedia] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [handTrackingWarning, setHandTrackingWarning] = useState<string | null>(null)
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [recordingResult, setRecordingResult] = useState<RecordingResult | null>(null)
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const [exportingMp4, setExportingMp4] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [showGestureTip, setShowGestureTip] = useState(false)
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false)

  const clearRecordingTimers = () => {
    if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current)
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current)
    if (recordingLimitTimerRef.current !== null) window.clearTimeout(recordingLimitTimerRef.current)
    countdownTimerRef.current = null
    recordingTimerRef.current = null
    recordingLimitTimerRef.current = null
  }

  useEffect(() => {
    const cameraService = cameraServiceRef.current
    const recordingService = recordingServiceRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      exportAbortControllerRef.current?.abort()
      exportAbortControllerRef.current = null
      clearRecordingTimers()
      if (gestureTipTimerRef.current !== null) window.clearTimeout(gestureTipTimerRef.current)
      void recordingService.destroy()
      void handTrackingServiceRef.current?.destroy()
      handTrackingServiceRef.current = null
      curtainEffectRef.current?.destroy()
      curtainEffectRef.current = null
      cameraService.stop()
    }
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let frameId = 0
    let lastReport = performance.now()
    const countFrame = () => {
      performanceRef.current.frames += 1
      frameId = requestAnimationFrame(countFrame)
    }
    frameId = requestAnimationFrame(countFrame)
    const reportTimer = window.setInterval(() => {
      const now = performance.now()
      const seconds = (now - lastReport) / 1000
      const fps = performanceRef.current.frames / seconds
      const handHz = performanceRef.current.inferences / seconds
      console.debug(`[Vibe Effects] FPS ${fps.toFixed(1)} · Hands ${handHz.toFixed(1)} Hz`)
      performanceRef.current.frames = 0
      performanceRef.current.inferences = 0
      lastReport = now
    }, 5000)
    return () => {
      cancelAnimationFrame(frameId)
      window.clearInterval(reportTimer)
    }
  }, [])

  const markFirstHandGrab = () => {
    setShowGestureTip(false)
    if (gestureTipTimerRef.current !== null) window.clearTimeout(gestureTipTimerRef.current)
    gestureTipTimerRef.current = null
    try { window.localStorage.setItem(GESTURE_TIP_KEY, '1') } catch { /* Optional hint memory. */ }
  }

  const startHandTracking = async (
    video: HTMLVideoElement,
    activeFacingMode: CameraFacingMode,
  ) => {
    const handTrackingService = new HandTrackingService()
    handTrackingServiceRef.current = handTrackingService

    try {
      await handTrackingService.start(video, activeFacingMode, {
        onHands: (hands) => {
          performanceRef.current.inferences += 1
          curtainEffectRef.current?.setHands(hands)
        },
        onError: () => {
          if (mountedRef.current && handTrackingServiceRef.current === handTrackingService) {
            setHandTrackingWarning('手势识别暂不可用，你仍然可以使用鼠标或触摸操作。')
          }
        },
      })
      if (mountedRef.current && handTrackingServiceRef.current === handTrackingService) {
        setHandTrackingWarning(null)
      }
    } catch {
      if (handTrackingServiceRef.current === handTrackingService) {
        await handTrackingService.destroy()
        handTrackingServiceRef.current = null
        if (mountedRef.current) {
          setHandTrackingWarning('手势识别暂不可用，你仍然可以使用鼠标或触摸操作。')
        }
      }
    }
  }

  const startCamera = async () => {
    if (!videoRef.current) return

    setStatus('requesting')
    setCameraError(null)

    try {
      const activeFacingMode = await cameraServiceRef.current.start(videoRef.current, 'user')
      if (canvasRef.current) {
        curtainEffectRef.current?.destroy()
        curtainEffectRef.current = new InvisibleCurtainEffect(
          canvasRef.current,
          videoRef.current,
          activeFacingMode,
          markFirstHandGrab,
        )
      }
      setFacingMode(activeFacingMode)
      setStatus('active')
      let hasGrabbedBefore = false
      try { hasGrabbedBefore = window.localStorage.getItem(GESTURE_TIP_KEY) === '1' } catch { /* Optional hint memory. */ }
      if (!hasGrabbedBefore) {
        gestureTipTimerRef.current = window.setTimeout(() => setShowGestureTip(true), 6500)
      }
      void startHandTracking(videoRef.current, activeFacingMode)
    } catch (error) {
      void handTrackingServiceRef.current?.destroy()
      handTrackingServiceRef.current = null
      curtainEffectRef.current?.destroy()
      curtainEffectRef.current = null
      setCameraError(error instanceof CameraServiceError ? error.code : 'start-failed')
      setStatus('error')
    }
  }

  const switchCamera = async () => {
    if (!videoRef.current || status !== 'active') return

    setStatus('switching')
    await handTrackingServiceRef.current?.destroy()
    handTrackingServiceRef.current = null
    setHandTrackingWarning(null)

    try {
      const activeFacingMode = await cameraServiceRef.current.switchCamera(videoRef.current)
      curtainEffectRef.current?.setFacingMode(activeFacingMode)
      setFacingMode(activeFacingMode)
      setStatus('active')
      void startHandTracking(videoRef.current, activeFacingMode)
    } catch (error) {
      curtainEffectRef.current?.destroy()
      curtainEffectRef.current = null
      setCameraError(error instanceof CameraServiceError ? error.code : 'start-failed')
      setStatus('error')
    }
  }

  const exitExperience = () => {
    exportAbortControllerRef.current?.abort()
    exportAbortControllerRef.current = null
    clearRecordingTimers()
    void recordingServiceRef.current.destroy()
    void handTrackingServiceRef.current?.destroy()
    handTrackingServiceRef.current = null
    curtainEffectRef.current?.destroy()
    curtainEffectRef.current = null
    cameraServiceRef.current.stop()
    navigate('/explore')
  }

  const requestExit = () => {
    if (recordingStatus === 'countdown' || recordingStatus === 'recording' || recordingStatus === 'stopping') {
      setExitConfirmationOpen(true)
      return
    }
    exitExperience()
  }

  const confirmExit = async () => {
    setExitConfirmationOpen(false)
    if (recordingStatus === 'recording' || recordingStatus === 'stopping') {
      await recordingServiceRef.current.cancel()
    }
    exitExperience()
  }

  async function completeRecording() {
    if (stoppingRecordingRef.current) return
    stoppingRecordingRef.current = true
    clearRecordingTimers()
    if (mountedRef.current) setRecordingStatus('stopping')

    try {
      const result = await recordingServiceRef.current.stop()
      if (mountedRef.current && result) {
        setRecordingResult(result)
        setRecordingStatus('preview')
      } else if (mountedRef.current) {
        setRecordingStatus('idle')
      }
    } catch {
      if (mountedRef.current) {
        setRecordingError('录制启动失败，请稍后重试。')
        setRecordingStatus('idle')
      }
    } finally {
      stoppingRecordingRef.current = false
    }
  }

  function beginRecording() {
    const canvas = canvasRef.current
    if (!canvas) return

    try {
      recordingServiceRef.current.start(canvas, 30)
      setRecordingSeconds(0)
      setRecordingStatus('recording')
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((seconds) => seconds + 1)
      }, 1000)
      recordingLimitTimerRef.current = window.setTimeout(() => {
        void completeRecording()
      }, 30_000)
    } catch {
      setRecordingError('录制启动失败，请稍后重试。')
      setRecordingStatus('idle')
    }
  }

  function startCountdown() {
    const canvas = canvasRef.current
    if (!canvas || recordingStatus !== 'idle') return

    if (!RecordingService.isSupported(canvas)) {
      setRecordingError('当前浏览器暂不支持视频录制，建议使用最新版 Chrome 或 Edge。')
      return
    }

    setRecordingError(null)
    setCountdown(3)
    setRecordingStatus('countdown')
    let remainingSeconds = 3
    countdownTimerRef.current = window.setInterval(() => {
      remainingSeconds -= 1
      if (remainingSeconds <= 0) {
        if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current)
        countdownTimerRef.current = null
        setCountdown(null)
        beginRecording()
      } else {
        setCountdown(remainingSeconds)
      }
    }, 1000)
  }

  function closePreview() {
    if (exportingMp4) return
    recordingServiceRef.current.clearPreview()
    setRecordingResult(null)
    setRecordingSeconds(0)
    setRecordingStatus('idle')
    setExportProgress(0)
    setExportMessage(null)
  }

  async function saveRecording() {
    if (!recordingResult || exportingMp4) return
    setExportingMp4(true)
    setExportProgress(0)
    setExportMessage(null)
    const abortController = new AbortController()
    exportAbortControllerRef.current = abortController

    try {
      if (
        recordingResult.mimeType.includes('mp4') &&
        await isMp4Blob(recordingResult.blob)
      ) {
        downloadBlob(recordingResult.blob, createRecordingFilename('mp4'))
      } else {
        const mp4 = await convertWebMToMp4(
          recordingResult.blob,
          (progress) => {
            if (mountedRef.current) setExportProgress(progress)
          },
          abortController.signal,
        )
        downloadBlob(mp4, createRecordingFilename('mp4'))
      }
    } catch {
      if (!abortController.signal.aborted) {
        recordingServiceRef.current.download(createRecordingFilename('webm'))
        setExportMessage('MP4 生成失败，你仍然可以保存原始视频。')
      }
    } finally {
      if (exportAbortControllerRef.current === abortController) {
        exportAbortControllerRef.current = null
      }
      if (mountedRef.current) setExportingMp4(false)
    }
  }

  const uploadMedia = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !curtainEffectRef.current) return

    setMediaError(null)
    try {
      await curtainEffectRef.current.setMedia(file)
      setHasUploadedMedia(true)
    } catch {
      setHasUploadedMedia(false)
      setMediaError('这个文件暂时无法使用，请换一个试试。')
    } finally {
      event.target.value = ''
    }
  }

  const activeError = cameraError ? errorContent[cameraError] : null
  const controlsLocked =
    status === 'switching' ||
    recordingStatus === 'countdown' ||
    recordingStatus === 'recording' ||
    recordingStatus === 'stopping'

  return (
    <main className="play-page">
      <video
        ref={videoRef}
        className={`camera-feed ${facingMode === 'user' ? 'camera-feed-mirrored' : ''}`}
        autoPlay
        muted
        playsInline
        aria-label="实时摄像头画面"
      />
      <canvas
        ref={canvasRef}
        className={`curtain-canvas ${status === 'active' || status === 'switching' ? 'curtain-canvas-active' : ''}`}
        aria-label="可拖动的透明幕布互动区域"
      />
      <div className="camera-shade" aria-hidden="true" />

      <header className="play-topbar">
        <button className="play-text-button" type="button" onClick={requestExit}>
          <span aria-hidden="true">←</span> 返回
        </button>
        <p>透明幕布</p>
      </header>

      {status === 'idle' && (
        <section className="camera-dialog" aria-labelledby="camera-permission-title">
          <p className="dialog-index">摄像头 / 01</p>
          <h1 id="camera-permission-title">开启摄像头</h1>
          <p className="dialog-copy">
            Vibe Effects 需要使用摄像头，<br />才能让你的动作参与互动。
          </p>
          <ol className="quick-start" aria-label="透明幕布玩法步骤">
            <li><span>1</span>开启摄像头</li>
            <li><span>2</span>上传一张图片或视频</li>
            <li><span>3</span>拇指和食指捏合，抓住幕布</li>
            <li><span>4</span>向上甩开它</li>
          </ol>
          <button className="camera-primary-button" type="button" onClick={startCamera}>
            开启摄像头 <span aria-hidden="true">↗</span>
          </button>
          <p className="privacy-note">视频画面仅在你的浏览器中处理。</p>
        </section>
      )}

      {status === 'requesting' && (
        <section className="camera-dialog camera-loading" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" />
          <h1>正在开启摄像头</h1>
          <p className="dialog-copy">请在浏览器提示中允许摄像头权限。</p>
        </section>
      )}

      {status === 'error' && activeError && (
        <section className="camera-dialog camera-error" role="alert">
          <p className="dialog-index">摄像头 / 错误</p>
          <h1>{activeError.title}</h1>
          {activeError.description && <p className="dialog-copy">{activeError.description}</p>}
          <button className="camera-primary-button" type="button" onClick={exitExperience}>
            返回玩法 <span aria-hidden="true">→</span>
          </button>
        </section>
      )}

      {(status === 'active' || status === 'switching') && (
        <>
          {handTrackingWarning && (
            <p className="hand-tracking-warning" role="status">{handTrackingWarning}</p>
          )}
          {showGestureTip && !handTrackingWarning && (
            <p className="gesture-tip" role="status">试试用拇指和食指捏住幕布</p>
          )}
          {recordingError && (
            <p className="recording-error" role="alert">{recordingError}</p>
          )}
          {!hasUploadedMedia && (
            <p className="media-hint">{mediaError ?? '上传图片或视频，藏在幕布后面'}</p>
          )}
          <input
            ref={mediaInputRef}
            className="media-input"
            type="file"
            accept="image/*,video/mp4,video/webm,video/quicktime"
            onChange={uploadMedia}
          />
          <div className="play-controls" aria-label="体验控制栏">
            <button className={!hasUploadedMedia ? 'upload-control-primary' : undefined} type="button" onClick={() => mediaInputRef.current?.click()} disabled={controlsLocked}>
              <span className="control-icon control-icon-upload" aria-hidden="true">＋</span>
              {hasUploadedMedia ? '更换素材' : '上传素材'}
            </button>
            <span className="control-divider" aria-hidden="true" />
            <button type="button" onClick={switchCamera} disabled={controlsLocked}>
              <span className="control-icon" aria-hidden="true">↻</span>
              {status === 'switching' ? '正在切换' : '翻转镜头'}
            </button>
            <span className="control-divider" aria-hidden="true" />
            <button type="button" onClick={requestExit}>
              <span className="control-icon control-icon-exit" aria-hidden="true" />
              退出体验
            </button>
          </div>

          {recordingStatus !== 'preview' && (
            <button
              className={`record-button ${recordingStatus === 'recording' ? 'record-button-active' : ''}`}
              type="button"
              onClick={recordingStatus === 'recording' ? completeRecording : startCountdown}
              disabled={status === 'switching' || recordingStatus === 'countdown' || recordingStatus === 'stopping'}
            >
              <span aria-hidden="true" />
              {recordingStatus === 'recording' ? '停止' : recordingStatus === 'stopping' ? '处理中' : 'REC'}
            </button>
          )}
        </>
      )}

      {recordingStatus === 'countdown' && countdown !== null && (
        <div className="recording-countdown" aria-live="assertive">{countdown}</div>
      )}

      {(recordingStatus === 'recording' || recordingStatus === 'stopping') && (
        <p className="recording-time" aria-live="polite">
          <span aria-hidden="true" /> {formatRecordingTime(recordingSeconds)}
        </p>
      )}

      {recordingStatus === 'preview' && recordingResult && (
        <section className="recording-preview" aria-labelledby="preview-title">
          <div className="preview-panel">
            <div className="preview-heading">
              <p>作品 / 预览</p>
              <h2 id="preview-title">作品预览</h2>
            </div>
            <video src={recordingResult.url} controls playsInline autoPlay />
            <div className="preview-actions">
              <button type="button" onClick={closePreview} disabled={exportingMp4}>重新录制</button>
              <button className="preview-save-button" type="button" onClick={saveRecording} disabled={exportingMp4}>
                {exportingMp4 ? `正在生成 MP4… ${Math.round(exportProgress * 100)}%` : '保存 MP4'}
              </button>
              <button type="button" onClick={closePreview} disabled={exportingMp4}>继续体验</button>
            </div>
            {exportMessage && <p className="export-message" role="status">{exportMessage}</p>}
          </div>
        </section>
      )}

      {exitConfirmationOpen && (
        <section className="exit-confirmation" role="dialog" aria-modal="true" aria-labelledby="exit-confirmation-title">
          <div>
            <p>录制 / 提醒</p>
            <h2 id="exit-confirmation-title">正在录制，确定退出吗？</h2>
            <div>
              <button type="button" onClick={() => setExitConfirmationOpen(false)}>继续录制</button>
              <button className="exit-confirm-button" type="button" onClick={() => void confirmExit()}>退出</button>
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

function formatRecordingTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainingSeconds}`
}

function createRecordingFilename(extension: 'webm' | 'mp4') {
  const now = new Date()
  const pad = (value: number) => value.toString().padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `vibe-effects-invisible-curtain-${date}-${time}.${extension}`
}

export default PlayPage
