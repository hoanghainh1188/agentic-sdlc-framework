// Runs this runner process holds (ADR-M25 §2.8): from just before the workspace is reserved until
// `releaseSandbox`, or until provisioning fails. The sweep never touches a held run, and a second
// provisioning of a held run in the same process is refused before it reaches Docker.
export class HeldRuns {
  readonly #runs = new Set<string>();

  /** Holds a run. Returns false when this process already holds it. */
  hold(runId: string): boolean {
    if (this.#runs.has(runId)) return false;
    this.#runs.add(runId);
    return true;
  }

  release(runId: string): void {
    this.#runs.delete(runId);
  }

  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  get size(): number {
    return this.#runs.size;
  }
}
