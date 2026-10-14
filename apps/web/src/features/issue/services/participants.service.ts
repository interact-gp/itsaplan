// The people added to a private request. Only its creator or its current assignee
// changes the list; the response carries the new list, which replaces the cache.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addIssueParticipant,
  getIssueParticipants,
  removeIssueParticipant,
} from '@/lib/api/endpoints/issues';
import { qk } from '@/services/queryKeys';

export function useIssueParticipantsQuery(issueId: number, enabled: boolean) {
  return useQuery({
    queryKey: qk.issueParticipants(issueId),
    queryFn: () => getIssueParticipants(issueId),
    enabled,
  });
}

export function useSetIssueParticipant(issueId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, added }: { userId: string; added: boolean }) =>
      added ? addIssueParticipant(issueId, userId) : removeIssueParticipant(issueId, userId),
    onSuccess: (participants) => qc.setQueryData(qk.issueParticipants(issueId), participants),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.issue(issueId) }),
  });
}
