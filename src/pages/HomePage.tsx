import { Link } from 'react-router-dom'

const featuredEffects = [
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
    description: '用双手撕开现实，看看另一边是什么。',
    path: '/play/reality-rift',
    tone: 'rift',
  },
]

const steps = [
  { number: '01', title: '选择玩法', description: '找到一个你想玩的互动效果。' },
  { number: '02', title: '打开摄像头', description: '用手势和身体动作与画面互动。' },
  { number: '03', title: '录下这一刻', description: '录制你的互动过程并保存视频。' },
]

function HomePage() {
  return (
    <main className="page home-page">
      <header className="site-header">
        <Link className="brand" to="/" aria-label="VIBE EFFECTS 首页">
          VIBE EFFECTS<span className="brand-dot">.</span>
        </Link>
        <Link className="header-link" to="/explore">
          探索玩法
        </Link>
      </header>

      <section className="hero" aria-labelledby="home-title">
        <div className="hero-content">
          <p className="eyebrow"><span /> 互动创作游乐场</p>
          <h1 id="home-title">
            动起来，<br />
            玩起来，<br />
            <em>录下来。</em>
          </h1>
          <p className="hero-copy">让摄像头成为你的互动创作画布。</p>
          <div className="hero-actions">
            <Link className="button button-primary" to="/play/invisible-curtain">
              开始体验 <span aria-hidden="true">↗</span>
            </Link>
            <Link className="button button-secondary" to="/explore">探索玩法</Link>
          </div>
        </div>

        <div className="hero-art" aria-hidden="true">
          <div className="art-grid" />
          <div className="art-surface art-surface-back" />
          <div className="art-surface art-surface-front" />
          <div className="art-cursor"><span /></div>
          <p>移动 / 触碰 / 玩耍</p>
        </div>
      </section>

      <section className="home-section featured-section" aria-labelledby="featured-title">
        <div className="section-heading">
          <p className="section-index">01 / 精选</p>
          <h2 id="featured-title">精选玩法</h2>
          <Link to="/explore">查看全部 <span aria-hidden="true">→</span></Link>
        </div>

        <div className="effect-grid featured-grid">
          {featuredEffects.map((effect) => {
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
                    <h3>{effect.name}</h3>
                  </div>
                  <span className="effect-arrow" aria-hidden="true">{effect.path ? '↗' : '—'}</span>
                </div>
                <p className="effect-description">{effect.description}</p>
              </>
            )

            return effect.path ? (
              <Link className="effect-card" to={effect.path} key={effect.name}>{content}</Link>
            ) : (
              <article className="effect-card effect-card-disabled" key={effect.name} aria-disabled="true">{content}</article>
            )
          })}
        </div>
      </section>

      <section className="home-section steps-section" aria-labelledby="steps-title">
        <div className="section-heading steps-heading">
          <p className="section-index">02 / 三步体验</p>
          <h2 id="steps-title">三步开始</h2>
        </div>
        <div className="steps-grid">
          {steps.map((step) => (
            <article className="step" key={step.number}>
              <span>{step.number}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <footer className="site-footer">
        <span>VIBE EFFECTS</span>
        <span>数字实验场 / 2026</span>
      </footer>
    </main>
  )
}

export default HomePage
