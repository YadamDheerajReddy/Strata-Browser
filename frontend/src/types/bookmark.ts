export interface Bookmark {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  createdAt: number;
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  timestamp: number;
  faviconUrl: string | null;
}
