import { useState } from 'react';
import { freshSessionOnStartup } from '../utils/startupSession';
export function StartupSessionSettings() {
  const [fresh, setFresh] = useState(freshSessionOnStartup);
  return <label className="block p-4 text-xs"><input type="checkbox" checked={fresh} onChange={event => { const value = event.target.checked; localStorage.setItem('freshSessionOnStartup', String(value)); setFresh(value); }} /> Start with a fresh session on next launch (saved queue jobs and exported workflows are kept)</label>;
}
