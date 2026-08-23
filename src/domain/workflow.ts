import type { JobStatus } from "./job.js";

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ["brief_ready", "cancelled"],
  brief_ready: ["script_generating", "needs_user_input", "cancelled"],
  script_generating: ["script_review", "failed", "cancelled"],
  script_review: ["audio_generating", "script_generating", "needs_user_input", "failed", "cancelled"],
  audio_generating: ["avatar_generating", "failed", "cancelled"],
  avatar_generating: ["rendering", "failed", "cancelled"],
  rendering: ["quality_check", "failed", "cancelled"],
  quality_check: ["ready_for_approval", "rendering", "failed", "cancelled"],
  ready_for_approval: ["publishing", "script_generating", "cancelled"],
  publishing: ["published", "failed"],
  published: [],
  needs_user_input: ["brief_ready", "script_generating", "cancelled"],
  failed: ["brief_ready", "script_generating", "audio_generating", "avatar_generating", "rendering", "publishing", "cancelled"],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid workflow transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!transitions[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export const workflowTransitions = transitions;
