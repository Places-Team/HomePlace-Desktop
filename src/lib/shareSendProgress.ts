export function sendProgressPercent(progress: {
  transferredBytes: number; totalBytes: number; fileIndex: number; fileCount: number;
} | null) {
  if (!progress) return 0;
  const fraction = progress.totalBytes > 0 ? Math.max(0, Math.min(1, progress.transferredBytes / progress.totalBytes)) : 0;
  return Math.max(0, Math.min(100, Math.round((progress.fileIndex + fraction) / Math.max(1, progress.fileCount) * 100)));
}
