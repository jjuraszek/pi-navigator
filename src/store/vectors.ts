// Future expansion seam (spec §5.6): summary embeddings.
// Intentionally interface-only for the PoC — no backend is wired. When summary
// embeddings land, implement this against sqlite-vec (single-store) or a LanceDB
// sidecar keyed by content_hash, without changing the core schema.

export interface VectorStore {
  /** Upsert an embedding for a file/summary keyed by its content hash. */
  upsert(contentHash: string, embedding: Float32Array): void;
  /** Return the k nearest content hashes to the query embedding. */
  query(embedding: Float32Array, k: number): { contentHash: string; score: number }[];
}

/** No vector backend in the PoC. */
export const NO_VECTORS: VectorStore | null = null;
