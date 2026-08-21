import { Link } from 'react-router-dom'

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
    name: '延迟镜像',
    status: '即将上线',
    description: '镜头里的你，会比现实慢几秒。',
    tone: 'blue',
  },
  {
    number: '03',
    name: '传送门',
    status: '即将上线',
    description: '在现实画面中打开通往另一个世界的入口。',
    tone: 'orange',
  },
]

function ExplorePage() {
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
    </main>
  )
}

export default ExplorePage
