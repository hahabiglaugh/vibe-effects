import { useState } from 'react'
import { Link } from 'react-router-dom'
import { APP_VERSION } from '../config'

const effects = [
  {
    number: '01',
    name: '透明幕布',
    status: '立即体验',
    description: '用双手抓住、拉动和抛起虚拟幕布，揭开幕布后的画面。',
    path: '/play/invisible-curtain',
    tone: 'violet',
  },
  {
    number: '02',
    name: '泡泡宇宙',
    status: '立即体验',
    description: '碰它、戳破它，让整个泡泡世界回应你的动作。',
    path: '/play/bubbleverse',
    tone: 'blue',
  },
  {
    number: '03',
    name: '空间裂缝',
    status: '立即体验',
    description: '上传一个世界，再用双手把现实撕开。',
    path: '/play/reality-rift',
    tone: 'rift',
  },
]

function ExplorePage() {
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackEffect, setFeedbackEffect] = useState('透明幕布')
  const [feedbackIssue, setFeedbackIssue] = useState('')
  const [feedbackRating, setFeedbackRating] = useState('4')
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null)

  const copyFeedback = async () => {
    const device = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop'
    const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : /Safari\//.test(navigator.userAgent) ? 'Safari' : 'Other'
    const text = [
      'Vibe Effects Test Feedback',
      '',
      `玩法：${feedbackEffect}`,
      `评分：${feedbackRating}/5`,
      `问题：${feedbackIssue.trim() || '未填写'}`,
      `设备：${device} ${browser}`,
      `Viewport：${window.innerWidth}×${window.innerHeight}`,
      `Version：${APP_VERSION}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setFeedbackStatus('反馈已复制')
    } catch {
      setFeedbackStatus('复制失败，请手动复制后重试。')
    }
  }

  const resetTutorials = () => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('vibe-effects-tutorial-')) localStorage.removeItem(key)
    }
    setFeedbackStatus('玩法提示已重置')
  }

  const resetExperience = () => {
    if (!window.confirm('确定重置 Vibe Effects 的本地体验数据吗？')) return
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('vibe-effects-')) localStorage.removeItem(key)
    }
    setFeedbackStatus('体验数据已重置')
  }
  return (
    <main className="page explore-page">
      <header className="site-header">
        <Link className="brand" to="/" aria-label="VIBE EFFECTS 首页">
          VIBE EFFECTS<span className="brand-dot">.</span>
        </Link>
        <Link className="header-link" to="/">
          首页
        </Link>
      </header>

      <section className="explore-intro">
        <p className="eyebrow"><span /> 选择你的玩法</p>
        <h1>探索玩法</h1>
        <p className="explore-lead">选择一个互动效果，让镜头开始回应你的动作。</p>
      </section>

      <section className="effect-grid explore-grid" aria-label="互动玩法">
        {effects.map((effect) => {
          const content = (
            <>
              <div className={`effect-visual effect-visual-${effect.tone}`}>
                <span>{effect.number}</span>
                {effect.tone === 'violet' ? (
                  <div className="curtain-preview" aria-hidden="true">
                    <div className="curtain-preview-media" />
                    <div className="curtain-preview-cloth" />
                    <i className="curtain-preview-grab" />
                  </div>
                ) : effect.tone === 'blue' ? (
                  <div className="bubble-card-preview" aria-hidden="true">
                    <i /><i /><i /><i /><i />
                  </div>
                ) : effect.tone === 'rift' ? (
                  <div className="rift-card-preview" aria-hidden="true"><i /><span /></div>
                ) : <div className="effect-shape" />}
                <p className="visual-label">玩法 / {effect.number}</p>
              </div>
              <div className="effect-meta">
                <div>
                  <p className="effect-status">{effect.status}</p>
                  <h2>{effect.name}</h2>
                </div>
                <span className="effect-arrow" aria-hidden="true">
                  {effect.path ? '↗' : '—'}
                </span>
              </div>
              <p className="effect-description">{effect.description}</p>
            </>
          )

          return effect.path ? (
            <Link className="effect-card" to={effect.path} key={effect.name}>
              {content}
            </Link>
          ) : (
            <article className="effect-card effect-card-disabled" key={effect.name} aria-disabled="true">
              {content}
            </article>
          )
        })}
      </section>
      <footer className="explore-footer">
        <span>Vibe Effects · Beta v0.1</span>
        <div>
          <button type="button" onClick={() => setFeedbackOpen(true)}>反馈</button>
          <button type="button" onClick={resetTutorials}>重新查看玩法提示</button>
          <button type="button" onClick={resetExperience}>重置体验</button>
        </div>
        {feedbackStatus && <p role="status">{feedbackStatus}</p>}
      </footer>

      {feedbackOpen && (
        <section className="feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
          <div>
            <button className="feedback-close" type="button" aria-label="关闭反馈" onClick={() => setFeedbackOpen(false)}>×</button>
            <p>Beta / {APP_VERSION}</p>
            <h2 id="feedback-title">测试反馈</h2>
            <label>你刚才玩了哪个玩法？
              <select value={feedbackEffect} onChange={(event) => setFeedbackEffect(event.target.value)}>
                <option>透明幕布</option><option>泡泡宇宙</option><option>空间裂缝</option>
              </select>
            </label>
            <label>哪里不好用？
              <textarea rows={4} value={feedbackIssue} onChange={(event) => setFeedbackIssue(event.target.value)} />
            </label>
            <label>整体体验
              <select value={feedbackRating} onChange={(event) => setFeedbackRating(event.target.value)}>
                {[1, 2, 3, 4, 5].map((rating) => <option value={rating} key={rating}>{rating} / 5</option>)}
              </select>
            </label>
            <button className="feedback-copy" type="button" onClick={() => void copyFeedback()}>复制反馈</button>
            {feedbackStatus && <p role="status">{feedbackStatus}</p>}
          </div>
        </section>
      )}
    </main>
  )
}

export default ExplorePage
