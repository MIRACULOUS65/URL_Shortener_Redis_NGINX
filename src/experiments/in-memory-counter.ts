// PHASE 8 — In-memory state experiment
//
// This counter intentionally lives in process memory.
// Each API container maintains its own independent value.
//
// It is NOT shared between API instances.
// We will compare this with Redis in a later phase.

let counter = 0;

export function incrementLocalCounter(): number {
  counter += 1;

  return counter;
}

export function getLocalCounter(): number {
  return counter;
}