export interface DownloadEntry {
  id: string;
  url: string;
  filePath: string;
  fileName: string;
  sizeBytes: number | null;
  status: "in_progress" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
}
