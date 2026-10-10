import type { NoteBoard } from '@/lib/api/endpoints/noteBoards';
import { useSession } from '@/lib/auth-client';
import { usePermissions } from '@/hooks/usePermissions';
import { useOrganizationAccessQuery } from '@/services/organization.service';

export function useNoteBoardAccess(board: NoteBoard | null | undefined) {
  const { can } = usePermissions();
  const access = useOrganizationAccessQuery();
  const { data: session } = useSession();
  const canEdit = can('note_boards', 'edit');
  const isCreator = board?.createdByUserId != null && board.createdByUserId === session?.user.id;
  const admin = !access.isError && access.data?.globalAccess === true;
  return { canEdit, canChangeVisibility: canEdit && (isCreator || admin) };
}
