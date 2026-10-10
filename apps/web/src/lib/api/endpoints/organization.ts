import { request } from '@/lib/api/core/client';

export interface OrganizationAccess {
  managed: boolean;
  enabled: boolean;
  admin: boolean;
  globalAccess: boolean;
}
export const getOrganizationAccess = () => request<OrganizationAccess>('/organization/access');

export interface OrganizationUser {
  id: string;
  email: string;
  enabled: boolean;
  admin: boolean;
}

export const listOrganizationUsers = () => request<OrganizationUser[]>('/organization/users');

export const setOrganizationAccess = (input: { email: string; role: string }) =>
  request('/organization/access', { method: 'POST', body: JSON.stringify(input) });
