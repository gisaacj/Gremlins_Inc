import { useEffect } from 'react';
import { useGameStore } from '../store/game.js';

export function ErrorToast() {
  const error = useGameStore((s) => s.error);
  const setError = useGameStore((s) => s.setError);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3500);
    return () => clearTimeout(t);
  }, [error, setError]);

  if (!error) return null;
  return <div className="error-toast">{error.message}</div>;
}
