export class VerifiedCache {
  private map = new Map<string, string>(); // absPath -> content_hash

  get(absPath: string): string | undefined {
    return this.map.get(absPath);
  }

  set(absPath: string, hash: string): void {
    this.map.set(absPath, hash);
  }

  /** Returns true if the stored hash for absPath equals hash. */
  has(absPath: string, hash: string): boolean {
    return this.map.get(absPath) === hash;
  }
}
