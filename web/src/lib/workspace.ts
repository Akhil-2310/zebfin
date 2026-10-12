// Personal or team workspace. Personal hides team-only sections (payroll,
// kudos); approvals are a separate setting (see policy-presets.ts). Stored as
// an encrypted record, so our server doesn't learn which it is.

import { ofType, type Stored } from "./records";

export type WorkspaceMode = "personal" | "team";

export interface WorkspaceSettings {
  type: "workspace";
  mode: WorkspaceMode;
}

/** Workspaces created before this setting existed are teams. */
export function workspaceMode(records: Stored[]): WorkspaceMode {
  return ofType(records, "workspace")[0]?.value.mode ?? "team";
}

export function workspaceRecordId(records: Stored[]): string | undefined {
  return ofType(records, "workspace")[0]?.id;
}
