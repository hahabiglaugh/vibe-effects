import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { InvisibleCurtainEffect } from '../effects/invisible-curtain/InvisibleCurtainEffect'
import {
  BubbleverseEffect,
  BUBBLEVERSE_PRESETS,
  DEFAULT_BUBBLEVERSE_TUNING,
  type BubbleverseTuning,
} from '../effects/bubbleverse/BubbleverseEffect'
import {
  RealityRiftEffect,
  DEFAULT_REALITY_RIFT_TUNING,
  type RealityRiftTuning,
} from '../effects/reality-rift/RealityRiftEffect'
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
import { PerformanceMonitor, type QualityLevel } from '../services/performanceMonitor'

type CameraStatus = 'idle' | 'requesting' | 'active' | 'switching' | 'error'
type RecordingStatus = 'idle' | 'countdown' | 'recording' | 'stopping' | 'preview'
const GESTURE_TIP_KEY = 'vibe-effects-invisible-curtain-grabbed'

const errorContent: Record<CameraErrorCode, { title: string; description?: string }> = {
  'permission-denied': {
    title: '需要摄像头权限才能使用手势互动',
    description: '请在浏览器设置中允许摄像头权限，然后重新尝试。',
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
  const location = useLocation()
  const isBubbleverse = location.pathname.endsWith('/bubbleverse')
  const isRealityRift = location.pathname.endsWith('/reality-rift')
  const isInvisibleCurtain = !isBubbleverse && !isRealityRift
  const effectId = isBubbleverse ? 'bubbleverse' : isRealityRift ? 'reality-rift' : 'invisible-curtain'
  const tutorialKey = `vibe-effects-tutorial-${effectId}`
  const effectName = isBubbleverse ? '泡泡宇宙' : isRealityRift ? '空间裂缝' : '透明幕布'
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const cameraServiceRef = useRef(new CameraService())
  const handTrackingServiceRef = useRef<HandTrackingService | null>(null)
  const curtainEffectRef = useRef<InvisibleCurtainEffect | null>(null)
  const bubbleverseEffectRef = useRef<BubbleverseEffect | null>(null)
  const realityRiftEffectRef = useRef<RealityRiftEffect | null>(null)
  const recordingServiceRef = useRef(new RecordingService())
  const mountedRef = useRef(true)
  const countdownTimerRef = useRef<number | null>(null)
  const recordingTimerRef = useRef<number | null>(null)
  const recordingLimitTimerRef = useRef<number | null>(null)
  const stoppingRecordingRef = useRef(false)
  const exportAbortControllerRef = useRef<AbortController | null>(null)
  const gestureTipTimerRef = useRef<number | null>(null)
  const performanceMonitorRef = useRef<PerformanceMonitor | null>(null)
  const performanceFrameRef = useRef<number | null>(null)
  const qualityRef = useRef<QualityLevel>(matchMedia('(pointer: coarse)').matches ? 'medium' : 'high')
  const bubbleTutorialPopRef = useRef(false)
  const tutorialCompletedRef = useRef(false)
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
  const [showBubbleHint, setShowBubbleHint] = useState(true)
  const [showRiftHint, setShowRiftHint] = useState(true)
  const [riftGrabState, setRiftGrabState] = useState<'idle' | 'armed' | 'dual_locked' | 'closing'>('idle')
  const [riftDebugEnabled, setRiftDebugEnabled] = useState(false)
  const [riftPanelOpen, setRiftPanelOpen] = useState(false)
  const [riftTuning, setRiftTuning] = useState<RealityRiftTuning>(() => ({ ...DEFAULT_REALITY_RIFT_TUNING }))
  const [coachStep, setCoachStep] = useState<0 | 1 | 2 | null>(null)
  const [mediaToast, setMediaToast] = useState(false)
  const [riftSuccessToast, setRiftSuccessToast] = useState(false)
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const [showPermissionReminder, setShowPermissionReminder] = useState(false)
  const [cameraPaused, setCameraPaused] = useState(false)
  const [capabilityWarning] = useState(() => getCapabilityWarning())
  const [bubbleHintClosing, setBubbleHintClosing] = useState(false)
  const bubbleHintTimerRef = useRef<number | null>(null)
  const [bubbleDebugEnabled, setBubbleDebugEnabled] = useState(false)
  const [bubblePanelOpen, setBubblePanelOpen] = useState(false)
  const [bubbleTuning, setBubbleTuning] = useState<BubbleverseTuning>(
    () => ({ ...DEFAULT_BUBBLEVERSE_TUNING }),
  )

  const clearRecordingTimers = () => {
    if (countdownTimerRef.current !== null) window.clearInterval(countdownTimerRef.current)
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current)
    if (recordingLimitTimerRef.current !== null) window.clearTimeout(recordingLimitTimerRef.current)
    countdownTimerRef.current = null
    recordingTimerRef.current = null
    recordingLimitTimerRef.current = null
  }

  const showTutorialIfNeeded = () => {
    let completed = false
    try { completed = window.localStorage.getItem(tutorialKey) === '1' } catch { /* Optional memory. */ }
    tutorialCompletedRef.current = completed
    if (!completed && !isRealityRift) setCoachStep(0)
  }

  const completeTutorial = () => {
    tutorialCompletedRef.current = true
    setCoachStep(null)
    try { window.localStorage.setItem(tutorialKey, '1') } catch { /* Optional memory. */ }
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
      if (bubbleHintTimerRef.current !== null) window.clearTimeout(bubbleHintTimerRef.current)
      performanceMonitorRef.current?.destroy()
      if (performanceFrameRef.current !== null) cancelAnimationFrame(performanceFrameRef.current)
      void recordingService.destroy()
      void handTrackingServiceRef.current?.destroy()
      handTrackingServiceRef.current = null
      curtainEffectRef.current?.destroy()
      curtainEffectRef.current = null
      bubbleverseEffectRef.current?.destroy()
      bubbleverseEffectRef.current = null
      realityRiftEffectRef.current?.destroy()
      realityRiftEffectRef.current = null
      cameraService.stop()
    }
  }, [])

  useEffect(() => {
    const applyQuality = (quality: QualityLevel) => {
      qualityRef.current = quality
      curtainEffectRef.current?.setQuality(quality)
      bubbleverseEffectRef.current?.setQuality(quality)
      realityRiftEffectRef.current?.setQuality(quality)
    }
    const monitor = new PerformanceMonitor({
      effectName,
      getCanvas: () => canvasRef.current,
      onQualityChange: applyQuality,
    })
    performanceMonitorRef.current = monitor
    monitor.start()
    const countFrame = () => {
      monitor.frame()
      performanceFrameRef.current = requestAnimationFrame(countFrame)
    }
    performanceFrameRef.current = requestAnimationFrame(countFrame)
    return () => {
      monitor.destroy()
      if (performanceFrameRef.current !== null) cancelAnimationFrame(performanceFrameRef.current)
      performanceMonitorRef.current = null
      performanceFrameRef.current = null
    }
  }, [effectName])

  useEffect(() => {
    const handleVisibility = () => {
      const paused = document.hidden
      curtainEffectRef.current?.setPaused(paused)
      bubbleverseEffectRef.current?.setPaused(paused)
      realityRiftEffectRef.current?.setPaused(paused)
      if (paused) handTrackingServiceRef.current?.pause()
      else if (cameraServiceRef.current.isActive) handTrackingServiceRef.current?.resume()
      else if (status === 'active' || status === 'switching') {
        setCameraPaused(true)
        setStatus('idle')
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [status])

  useEffect(() => {
    if (status !== 'requesting') { setShowPermissionReminder(false); return }
    const timer = window.setTimeout(() => setShowPermissionReminder(true), 5000)
    return () => window.clearTimeout(timer)
  }, [status])

  useEffect(() => {
    if (!import.meta.env.DEV || !isBubbleverse) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select')) return
      if (event.key.toLowerCase() === 'd') {
        setBubbleDebugEnabled((enabled) => {
          bubbleverseEffectRef.current?.setDebugEnabled(!enabled)
          return !enabled
        })
      }
      if (event.key.toLowerCase() === 'p') setBubblePanelOpen((open) => !open)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBubbleverse])

  useEffect(() => {
    if (!import.meta.env.DEV || !isRealityRift) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select')) return
      if (event.key.toLowerCase() === 'd') {
        setRiftDebugEnabled((enabled) => {
          realityRiftEffectRef.current?.setDebugEnabled(!enabled)
          return !enabled
        })
      }
      if (event.key.toLowerCase() === 'p') setRiftPanelOpen((open) => !open)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isRealityRift])

  const markFirstHandGrab = () => {
    setShowGestureTip(false)
    if (gestureTipTimerRef.current !== null) window.clearTimeout(gestureTipTimerRef.current)
    gestureTipTimerRef.current = null
    try { window.localStorage.setItem(GESTURE_TIP_KEY, '1') } catch { /* Optional hint memory. */ }
  }

  const dismissBubbleHint = (type?: 'pop' | 'push') => {
    if (type === 'pop') {
      bubbleTutorialPopRef.current = true
      setCoachStep(1)
    }
    if (type === 'push' && bubbleTutorialPopRef.current) completeTutorial()
    if (!showBubbleHint || bubbleHintClosing) return
    setBubbleHintClosing(true)
    bubbleHintTimerRef.current = window.setTimeout(() => {
      setShowBubbleHint(false)
      setBubbleHintClosing(false)
      bubbleHintTimerRef.current = null
    }, 360)
  }

  const dismissRiftHint = () => {
    setShowRiftHint(false)
    const wasCompleted = tutorialCompletedRef.current
    completeTutorial()
    if (!wasCompleted) {
      setRiftSuccessToast(true)
      window.setTimeout(() => mountedRef.current && setRiftSuccessToast(false), 800)
    }
  }

  const handleRiftGrabState = (state: 'idle' | 'armed' | 'dual_locked' | 'closing') => {
    setRiftGrabState(state)
    if (!tutorialCompletedRef.current && state === 'armed') setCoachStep(1)
    if (!tutorialCompletedRef.current && state === 'dual_locked') setCoachStep(2)
  }

  const handleCurtainGrab = () => {
    markFirstHandGrab()
    setCoachStep(1)
  }

  const replayTutorial = () => {
    setCoachStep(0)
    window.setTimeout(() => mountedRef.current && setCoachStep(1), 1600)
    window.setTimeout(() => mountedRef.current && setCoachStep(null), 3400)
  }

  const playRiftDemo = () => {
    setHelpMenuOpen(false)
    setCoachStep(0)
    window.setTimeout(() => mountedRef.current && setCoachStep(2), 1700)
    window.setTimeout(() => mountedRef.current && setCoachStep(null), 3800)
  }

  const updateRiftParameter = (key: keyof RealityRiftTuning, value: number) => {
    setRiftTuning((current) => {
      const next = { ...current, [key]: value }
      realityRiftEffectRef.current?.updateTuning(next)
      return next
    })
  }

  const updateBubbleParameter = (key: keyof BubbleverseTuning, value: number) => {
    setBubbleTuning((current) => {
      const next = { ...current, [key]: value }
      bubbleverseEffectRef.current?.updateTuning(next)
      return next
    })
  }

  const applyBubblePreset = (preset: keyof typeof BUBBLEVERSE_PRESETS) => {
    const next = { ...BUBBLEVERSE_PRESETS[preset] }
    setBubbleTuning(next)
    bubbleverseEffectRef.current?.updateTuning(next)
  }

  const startHandTracking = async (
    video: HTMLVideoElement,
    activeFacingMode: CameraFacingMode,
  ) => {
    await handTrackingServiceRef.current?.destroy()
    const handTrackingService = new HandTrackingService()
    handTrackingServiceRef.current = handTrackingService

    try {
      await handTrackingService.start(video, activeFacingMode, {
        onHands: (hands) => {
          performanceMonitorRef.current?.handInference()
          curtainEffectRef.current?.setHands(hands)
          bubbleverseEffectRef.current?.setHands(hands)
          realityRiftEffectRef.current?.setHands(hands)
        },
        onError: () => {
          if (mountedRef.current && handTrackingServiceRef.current === handTrackingService) {
            setHandTrackingWarning('手势识别暂时无法加载，你仍然可以使用鼠标或触摸操作。')
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
          setHandTrackingWarning('手势识别暂时无法加载，你仍然可以使用鼠标或触摸操作。')
        }
      }
    }
  }

  const startCamera = async () => {
    if (!videoRef.current) return

    setStatus('requesting')
    setCameraPaused(false)
    setCameraError(null)

    try {
      const activeFacingMode = await cameraServiceRef.current.start(videoRef.current, 'user')
      if (canvasRef.current && isBubbleverse) {
        bubbleverseEffectRef.current?.destroy()
        bubbleverseEffectRef.current = new BubbleverseEffect(
          canvasRef.current,
          videoRef.current,
          activeFacingMode,
          dismissBubbleHint,
        )
        bubbleverseEffectRef.current.updateTuning(bubbleTuning)
        bubbleverseEffectRef.current.setDebugEnabled(bubbleDebugEnabled)
        bubbleverseEffectRef.current.setQuality(qualityRef.current)
      } else if (canvasRef.current && isRealityRift) {
        realityRiftEffectRef.current?.destroy()
        realityRiftEffectRef.current = new RealityRiftEffect(
          canvasRef.current,
          videoRef.current,
          activeFacingMode,
          dismissRiftHint,
          handleRiftGrabState,
        )
        realityRiftEffectRef.current.updateTuning(riftTuning)
        realityRiftEffectRef.current.setDebugEnabled(riftDebugEnabled)
        realityRiftEffectRef.current.setQuality(qualityRef.current)
      } else if (canvasRef.current) {
        curtainEffectRef.current?.destroy()
        curtainEffectRef.current = new InvisibleCurtainEffect(
          canvasRef.current,
          videoRef.current,
          activeFacingMode,
          handleCurtainGrab,
          completeTutorial,
        )
        curtainEffectRef.current.setQuality(qualityRef.current)
      }
      setFacingMode(activeFacingMode)
      setStatus('active')
      if (import.meta.env.DEV) {
        console.debug(`[Vibe Effects] Camera: ${videoRef.current.videoWidth}x${videoRef.current.videoHeight}`)
      }
      showTutorialIfNeeded()
      if (isInvisibleCurtain) {
        let hasGrabbedBefore = false
        try { hasGrabbedBefore = window.localStorage.getItem(GESTURE_TIP_KEY) === '1' } catch { /* Optional hint memory. */ }
        if (!hasGrabbedBefore) {
          gestureTipTimerRef.current = window.setTimeout(() => setShowGestureTip(true), 6500)
        }
      }
      void startHandTracking(videoRef.current, activeFacingMode)
    } catch (error) {
      void handTrackingServiceRef.current?.destroy()
      handTrackingServiceRef.current = null
      curtainEffectRef.current?.destroy()
      curtainEffectRef.current = null
      bubbleverseEffectRef.current?.destroy()
      bubbleverseEffectRef.current = null
      realityRiftEffectRef.current?.destroy()
      realityRiftEffectRef.current = null
      setCameraError(error instanceof CameraServiceError ? error.code : 'start-failed')
      setStatus('error')
    }
  }

  const startBubbleverseMousePreview = () => {
    if (!isBubbleverse || !canvasRef.current || !videoRef.current) return
    bubbleverseEffectRef.current?.destroy()
    bubbleverseEffectRef.current = new BubbleverseEffect(
      canvasRef.current,
      videoRef.current,
      'user',
      dismissBubbleHint,
    )
    bubbleverseEffectRef.current.updateTuning(bubbleTuning)
    bubbleverseEffectRef.current.setDebugEnabled(bubbleDebugEnabled)
    bubbleverseEffectRef.current.setQuality(qualityRef.current)
    setFacingMode('user')
    setCameraError(null)
    setStatus('active')
  }

  const startRealityRiftMousePreview = () => {
    if (!isRealityRift || !canvasRef.current || !videoRef.current) return
    realityRiftEffectRef.current?.destroy()
    realityRiftEffectRef.current = new RealityRiftEffect(
      canvasRef.current,
      videoRef.current,
      'user',
      dismissRiftHint,
      handleRiftGrabState,
    )
    realityRiftEffectRef.current.updateTuning(riftTuning)
    realityRiftEffectRef.current.setDebugEnabled(riftDebugEnabled)
    realityRiftEffectRef.current.setQuality(qualityRef.current)
    setFacingMode('user')
    setCameraError(null)
    setStatus('active')
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
      bubbleverseEffectRef.current?.setFacingMode(activeFacingMode)
      realityRiftEffectRef.current?.setFacingMode(activeFacingMode)
      setFacingMode(activeFacingMode)
      setStatus('active')
      void startHandTracking(videoRef.current, activeFacingMode)
    } catch (error) {
      curtainEffectRef.current?.destroy()
      curtainEffectRef.current = null
      bubbleverseEffectRef.current?.destroy()
      bubbleverseEffectRef.current = null
      realityRiftEffectRef.current?.destroy()
      realityRiftEffectRef.current = null
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
    bubbleverseEffectRef.current?.destroy()
    bubbleverseEffectRef.current = null
    realityRiftEffectRef.current?.destroy()
    realityRiftEffectRef.current = null
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
    let exportTimedOut = false
    const exportTimeout = window.setTimeout(() => {
      exportTimedOut = true
      abortController.abort()
    }, 120_000)
    exportAbortControllerRef.current = abortController

    try {
      if (
        recordingResult.mimeType.includes('mp4') &&
        await isMp4Blob(recordingResult.blob)
      ) {
        downloadBlob(recordingResult.blob, createRecordingFilename('mp4', isBubbleverse, isRealityRift))
        setExportMessage('视频已保存')
      } else {
        const mp4 = await convertWebMToMp4(
          recordingResult.blob,
          (progress) => {
            if (mountedRef.current) setExportProgress(progress)
          },
          abortController.signal,
        )
        downloadBlob(mp4, createRecordingFilename('mp4', isBubbleverse, isRealityRift))
        setExportMessage('视频已保存')
      }
    } catch {
      if (!abortController.signal.aborted || exportTimedOut) {
        recordingServiceRef.current.download(createRecordingFilename('webm', isBubbleverse, isRealityRift))
        setExportMessage('MP4 生成失败，已保留原始视频')
      }
    } finally {
      window.clearTimeout(exportTimeout)
      if (exportAbortControllerRef.current === abortController) {
        exportAbortControllerRef.current = null
      }
      if (mountedRef.current) setExportingMp4(false)
    }
  }

  const uploadMedia = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const mediaEffect = isRealityRift ? realityRiftEffectRef.current : curtainEffectRef.current
    if (!file || !mediaEffect) return

    setMediaError(null)
    try {
      await mediaEffect.setMedia(file)
      setHasUploadedMedia(true)
      setMediaToast(true)
      if (isRealityRift) {
        let completed = false
        try { completed = window.localStorage.getItem(tutorialKey) === '1' } catch { /* Optional memory. */ }
        tutorialCompletedRef.current = completed
        if (!completed) setCoachStep(0)
      }
      window.setTimeout(() => mountedRef.current && setMediaToast(false), 1500)
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
    <main className={`play-page ${isBubbleverse ? 'bubbleverse-page' : ''} ${isRealityRift ? 'reality-rift-page' : ''} ${recordingStatus === 'recording' || recordingStatus === 'stopping' ? 'play-page-recording' : ''}`}>
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
        aria-label={isBubbleverse ? '可交互的泡泡宇宙画面' : isRealityRift ? '可用双手撕开的空间裂缝画面' : '可拖动的透明幕布互动区域'}
      />
      <div className="camera-shade" aria-hidden="true" />

      <header className="play-topbar">
        <button className="play-text-button" type="button" onClick={requestExit}>
          <span aria-hidden="true">←</span> 返回
        </button>
        <p>{effectName}</p>
      </header>

      {status === 'idle' && (
        <section className="camera-dialog" aria-labelledby="camera-permission-title">
          <p className="dialog-index">摄像头 / 01</p>
          <h1 id="camera-permission-title">{cameraPaused ? '摄像头已暂停' : '开启摄像头'}</h1>
          <p className="dialog-copy">
            {cameraPaused
              ? '摄像头连接已被系统暂停，请重新开启。'
              : 'Vibe Effects 需要使用摄像头，才能让你的动作参与互动。'}
          </p>
          {!cameraPaused && <p className="play-intro-line">{getPreflightCopy(effectId)}</p>}
          {capabilityWarning && <p className="capability-warning">当前浏览器可能无法完整运行 Vibe Effects。<br />建议使用最新版 Chrome 或 Edge。</p>}
          <button className="camera-primary-button" type="button" onClick={startCamera}>
            {cameraPaused ? '重新开启' : '开启摄像头'} <span aria-hidden="true">↗</span>
          </button>
          {import.meta.env.DEV && isBubbleverse && (
            <button className="dev-preview-button" type="button" onClick={startBubbleverseMousePreview}>
              鼠标预览（开发）
            </button>
          )}
          {import.meta.env.DEV && isRealityRift && (
            <button className="dev-preview-button" type="button" onClick={startRealityRiftMousePreview}>
              鼠标预览（开发）
            </button>
          )}
          <p className="privacy-note">视频画面仅在你的浏览器中处理。</p>
        </section>
      )}

      {status === 'requesting' && (
        <section className="camera-dialog camera-loading" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" />
          <h1>正在开启摄像头</h1>
          <p className="dialog-copy">{showPermissionReminder ? '请允许摄像头权限' : '正在启动摄像头…'}</p>
        </section>
      )}

      {status === 'error' && activeError && (
        <section className="camera-dialog camera-error" role="alert">
          <p className="dialog-index">摄像头 / 错误</p>
          <h1>{activeError.title}</h1>
          {activeError.description && <p className="dialog-copy">{activeError.description}</p>}
          <button className="camera-primary-button" type="button" onClick={startCamera}>
            重新尝试 <span aria-hidden="true">↗</span>
          </button>
        </section>
      )}

      {(status === 'active' || status === 'switching') && (
        <>
          {handTrackingWarning && (
            <p className="hand-tracking-warning" role="status">{handTrackingWarning}</p>
          )}
          {recordingError && (
            <p className="recording-error" role="alert">{recordingError}</p>
          )}
          {coachStep !== null && (
            isRealityRift
              ? <RiftGestureCoach step={coachStep} />
              : <div className="gesture-coach" role="status">
                  <span aria-hidden="true">{getCoachContent(effectId, coachStep).symbol}</span>
                  <p>{getCoachContent(effectId, coachStep).text}</p>
                </div>
          )}
          <button className="play-help-button" type="button" aria-label="重新查看玩法提示" onClick={isRealityRift ? () => setHelpMenuOpen((open) => !open) : replayTutorial}>?</button>
          {isRealityRift && helpMenuOpen && (
            <div className="play-help-menu"><button type="button" onClick={playRiftDemo}>查看操作演示</button></div>
          )}
          {mediaToast && <p className="media-loaded-toast" role="status">{isRealityRift ? '现在用双手撕开现实' : '素材已加载'}</p>}
          {riftSuccessToast && <p className="rift-success-toast" role="status">就是这样</p>}
          {!isBubbleverse && !hasUploadedMedia && (
            <p className="media-hint">{mediaError ?? (isRealityRift ? '先选择裂缝另一边的世界' : '上传图片或视频，藏在幕布后面')}</p>
          )}
          {!isBubbleverse && <input
            ref={mediaInputRef}
            className="media-input"
            type="file"
            accept="image/*,video/mp4,video/webm,video/quicktime"
            onChange={uploadMedia}
          />}
          <div className="play-controls" aria-label="体验控制栏">
            {!isBubbleverse && <>
              <button className={!hasUploadedMedia ? 'upload-control-primary' : undefined} type="button" onClick={() => mediaInputRef.current?.click()} disabled={controlsLocked}>
                <span className="control-icon control-icon-upload" aria-hidden="true">＋</span>
                {isRealityRift
                  ? hasUploadedMedia ? '更换另一个世界' : '选择另一个世界'
                  : hasUploadedMedia ? '更换素材' : '选择隐藏素材'}
              </button>
              <span className="control-divider" aria-hidden="true" />
            </>}
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
              <button type="button" onClick={closePreview} disabled={exportingMp4}>再录一次</button>
              <button className="preview-save-button" type="button" onClick={saveRecording} disabled={exportingMp4}>
                {exportingMp4 ? `正在生成 MP4… ${Math.round(exportProgress * 100)}%` : '保存 MP4'}
              </button>
              <button type="button" onClick={closePreview} disabled={exportingMp4}>返回玩法</button>
            </div>
            {exportMessage && <p className="export-message" role="status">{exportMessage}</p>}
            {exportMessage === '视频已保存' && (
              <button className="preview-explore-button" type="button" onClick={() => navigate('/explore')}>试试其他玩法</button>
            )}
          </div>
        </section>
      )}

      {import.meta.env.DEV && isBubbleverse && bubblePanelOpen && (
        <aside className="bubble-dev-panel" aria-label="Bubbleverse 参数调节">
          <div>
            <strong>Bubbleverse Interaction</strong>
            <span>D 调试 · P 关闭</span>
          </div>
          <div className="bubble-presets">
            <span>Sensitivity Preset</span>
            <button type="button" onClick={() => applyBubblePreset('soft')}>Soft</button>
            <button type="button" onClick={() => applyBubblePreset('normal')}>Normal</button>
            <button type="button" onClick={() => applyBubblePreset('strong')}>Strong</button>
            <button type="button" onClick={() => applyBubblePreset('normal')}>Reset</button>
          </div>
          {BUBBLE_TUNING_CONTROLS.map((control) => (
            <label key={control.key}>
              <span>{control.label}</span>
              <input
                type="range"
                min={control.min}
                max={control.max}
                step={control.step}
                value={bubbleTuning[control.key]}
                onChange={(event) => updateBubbleParameter(control.key, Number(event.target.value))}
              />
              <output>{bubbleTuning[control.key]}</output>
            </label>
          ))}
        </aside>
      )}

      {import.meta.env.DEV && isRealityRift && riftPanelOpen && (
        <aside className="bubble-dev-panel rift-dev-panel" aria-label="Reality Rift 参数调节">
          <div><strong>Reality Rift Interaction</strong><span>D 调试 · P 关闭</span></div>
          {RIFT_TUNING_CONTROLS.map((control) => (
            <label key={control.key}>
              <span>{control.label}</span>
              <input type="range" min={control.min} max={control.max} step={control.step} value={riftTuning[control.key]}
                onChange={(event) => updateRiftParameter(control.key, Number(event.target.value))} />
              <output>{riftTuning[control.key]}</output>
            </label>
          ))}
        </aside>
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

const BUBBLE_TUNING_CONTROLS: Array<{
  key: keyof BubbleverseTuning
  label: string
  min: number
  max: number
  step: number
}> = [
  { key: 'popHitPadding', label: 'POP hit padding', min: 0, max: 80, step: 1 },
  { key: 'touchRadius', label: 'Touch radius', min: 20, max: 140, step: 2 },
  { key: 'palmRadius', label: 'Palm radius', min: 1.5, max: 3.5, step: .05 },
  { key: 'palmPushGain', label: 'Palm push gain', min: .3, max: 2.8, step: .05 },
  { key: 'sweepRadius', label: 'Sweep radius', min: .06, max: .22, step: .005 },
  { key: 'sweepGain', label: 'Sweep gain', min: .3, max: 3.2, step: .05 },
  { key: 'swipeBonus', label: 'Swipe bonus', min: .5, max: 4.5, step: .05 },
  { key: 'bubbleDrag', label: 'Bubble drag', min: .96, max: .999, step: .001 },
]

const RIFT_TUNING_CONTROLS: Array<{ key: keyof RealityRiftTuning; label: string; min: number; max: number; step: number }> = [
  { key: 'grabTriggerMultiplier', label: 'Grab Trigger', min: .8, max: 2, step: .02 },
  { key: 'grabReleaseMultiplier', label: 'Grab Release', min: 1.5, max: 3.5, step: .05 },
  { key: 'trackingGracePeriod', label: 'Tracking Grace', min: 250, max: 900, step: 10 },
  { key: 'handSmoothing', label: 'Position Smoothing', min: .02, max: .4, step: .01 },
  { key: 'edgeFollowStrength', label: 'Edge Follow Strength', min: .5, max: 1, step: .01 },
  { key: 'openingGain', label: 'Opening Gain', min: .5, max: 1.2, step: .01 },
  { key: 'minimumOpening', label: 'Minimum Opening', min: 4, max: 40, step: 1 },
  { key: 'maxRiftWidth', label: 'Max rift width', min: .4, max: .9, step: .01 },
  { key: 'heightGain', label: 'Height Gain', min: .6, max: 1.3, step: .01 },
  { key: 'dualGrabWindow', label: 'Dual grab window (ms)', min: 600, max: 2000, step: 50 },
  { key: 'riftDamping', label: 'Rift damping', min: .12, max: .6, step: .01 },
  { key: 'stretchStrength', label: 'Stretch strength', min: 0, max: 2.5, step: .05 },
  { key: 'glowStrength', label: 'Glow strength', min: 0, max: 2.5, step: .05 },
]

function formatRecordingTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainingSeconds}`
}

function RiftGestureCoach({ step }: { step: 0 | 1 | 2 }) {
  const text = step === 0 ? '双手捏住现实' : step === 1 ? '再用另一只手捏住' : '向两边拉开'
  return (
    <div className={`gesture-coach rift-gesture-coach rift-coach-step-${step}`} role="status">
      <div className="rift-coach-motion" aria-hidden="true">
        <i className="rift-coach-hand rift-coach-hand-left"><b /><em /></i>
        <span className="rift-coach-seam" />
        <i className="rift-coach-hand rift-coach-hand-right"><b /><em /></i>
      </div>
      <p>{text}</p>
    </div>
  )
}

function getCoachContent(effectId: string, step: 0 | 1 | 2) {
  if (effectId === 'bubbleverse') {
    return step === 0
      ? { symbol: '☝', text: '用食指戳破泡泡' }
      : { symbol: '✋', text: '挥动手掌试试看' }
  }
  if (effectId === 'reality-rift') {
    return step === 0
      ? { symbol: '🤏  🤏', text: '双手捏住现实' }
      : { symbol: '←   →', text: '向两边撕开' }
  }
  return step === 0
    ? { symbol: '🤏', text: '捏住幕布' }
    : { symbol: '↕', text: '拖动它，看看后面藏着什么' }
}

function getPreflightCopy(effectId: string) {
  if (effectId === 'bubbleverse') return '伸手触碰、戳破或挥开泡泡。'
  if (effectId === 'reality-rift') return '用双手捏住现实，再向两边撕开。'
  return '用双手捏住幕布，再把它掀开。'
}

function getCapabilityWarning() {
  const canvas = document.createElement('canvas')
  return !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === 'undefined' ||
    typeof canvas.captureStream !== 'function' ||
    typeof WebAssembly === 'undefined'
}

function createRecordingFilename(extension: 'webm' | 'mp4', isBubbleverse: boolean, isRealityRift: boolean) {
  const now = new Date()
  const pad = (value: number) => value.toString().padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const effectSlug = isBubbleverse ? 'bubbleverse' : isRealityRift ? 'reality-rift' : 'invisible-curtain'
  return `vibe-effects-${effectSlug}-${date}-${time}.${extension}`
}

export default PlayPage
