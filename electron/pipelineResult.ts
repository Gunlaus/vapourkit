/** A readable result alongside the detailed machine-readable pipeline record. */
export function pipelineResult(frames: number | null, elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const count = frames === null ? 'Frame count unavailable' : `${frames} frames`;
  const speed = frames !== null && seconds > 0 ? ` · ${(frames / seconds).toFixed(2)} FPS average` : '';
  return `Result: ${count} · ${seconds.toFixed(2)} seconds total${speed}`;
}
