export interface LatencySummary {
  count: number;
  median: number | null;
  p90: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}
