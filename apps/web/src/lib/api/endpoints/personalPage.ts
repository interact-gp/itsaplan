import { request } from '@/lib/api/core/client';

// Where the signed-in user's own "My To-do" page is. Only its owner can open it.
export interface PersonalPage {
  projectKey: string;
  documentId: number;
}

export const getPersonalPage = () => request<PersonalPage>('/account/personal-page');
