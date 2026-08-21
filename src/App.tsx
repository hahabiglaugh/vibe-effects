import { Navigate, Route, Routes } from 'react-router-dom'
import ExplorePage from './pages/ExplorePage'
import HomePage from './pages/HomePage'
import PlayPage from './pages/PlayPage'

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/explore" element={<ExplorePage />} />
      <Route path="/play/invisible-curtain" element={<PlayPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
