import { getSetting } from '@repo/db';

// Where the shared "Personal Notes" workspace is, as provisioning recorded it. Read by
// the code that must treat its team and project differently from ordinary ones.
export const WORKSPACE_SETTING = 'personalNotes';

export interface PersonalWorkspace {
  systemUserId?: string;
  teamId?: number;
  roleId?: number;
  projectId?: number;
}

export async function personalWorkspace(): Promise<PersonalWorkspace> {
  return (await getSetting<PersonalWorkspace>(WORKSPACE_SETTING)) ?? {};
}
