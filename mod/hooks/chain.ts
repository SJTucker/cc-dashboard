// Runs work after previous settles and returns the new end of the chain. The result
// never rejects: an error from work goes to onError, so the next write on the chain
// still runs.
export function appendChain(previous: Promise<void> | undefined, work: () => Promise<void>, onError: (err: unknown) => void): Promise<void> {
  return (previous ?? Promise.resolve()).then(work).catch(onError)
}
