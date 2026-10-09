import { useEffect } from 'react';
import { useGameStore } from './store/game.js';
import { ErrorToast } from './components/ErrorToast.js';
import { DebugOverlay } from './components/DebugOverlay.js';
import { Menu } from './pages/Menu.js';
import { Lobby } from './pages/Lobby.js';
import { CharacterSelect } from './pages/CharacterSelect.js';
import { GamePage } from './pages/GamePage.js';
import { GameOver } from './pages/GameOver.js';

export default function App() {
  const init = useGameStore((s) => s.init);
  const view = useGameStore((s) => s.view);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className="app">
      <ErrorToast />
      {view === 'menu' && <Menu />}
      {view === 'lobby' && <Lobby />}
      {view === 'character_select' && <CharacterSelect />}
      {view === 'game' && <GamePage />}
      {view === 'game_over' && <GameOver />}
      <DebugOverlay />
    </div>
  );
}
