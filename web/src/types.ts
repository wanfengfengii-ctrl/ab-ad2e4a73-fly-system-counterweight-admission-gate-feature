export interface BattenSummary {
  batten_id: string;
  capacity_grams: number;
  total_grams: number;
  remaining_grams: number;
  load_count?: number;
}

export interface LoadItem {
  load_id: number;
  piece_id: string;
  weight_grams: number;
  created_at: string | null;
}

export interface BattenDetail extends BattenSummary {
  loads: LoadItem[];
}

export interface LoadResult {
  accepted: boolean;
  reason?: string;
  message: string;
  batten_id?: string;
  capacity_grams?: number;
  total_grams?: number;
  remaining_grams?: number;
}

export interface BattenTotals {
  batten_id: string;
  capacity_grams: number;
  total_grams: number;
  remaining_grams: number;
}

export interface TransferResult {
  accepted: boolean;
  reason?: string;
  message: string;
  piece_id?: string;
  source_batten_id?: string;
  target_batten_id?: string;
  load?: LoadItem & { batten_id: string };
  source?: BattenTotals;
  target?: BattenTotals;
}
