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

export interface TransferResult {
  accepted: boolean;
  reason?: string;
  message: string;
  piece_id?: string;
  weight_grams?: number;
  from_batten_id?: string;
  to_batten_id?: string;
  from?: BattenSummary;
  to?: BattenSummary;
}
