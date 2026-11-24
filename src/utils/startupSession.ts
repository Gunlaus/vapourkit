export function freshSessionOnStartup(): boolean {
  try { return localStorage.getItem('freshSessionOnStartup') === 'true'; }
  catch { return false; }
}
