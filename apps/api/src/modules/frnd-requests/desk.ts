import { getSetting } from '@repo/db';

// Where the FRND Requests desk is, as provisioning recorded it, and whether enrolling
// everyone is on. Read by the code that must treat its team and project differently
// from ordinary ones.
export const DESK_SETTING = 'frndRequests';

export interface RequestDesk {
  enabled?: boolean;
  teamId?: number;
  roleId?: number;
  projectId?: number;
}

export async function requestDesk(): Promise<RequestDesk> {
  return (await getSetting<RequestDesk>(DESK_SETTING)) ?? {};
}
