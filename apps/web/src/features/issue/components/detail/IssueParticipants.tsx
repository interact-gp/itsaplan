import { Check, LoaderCircle, Lock, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Assignee } from '@/lib/api/endpoints/projects';
import type { Issue } from '@/lib/api/endpoints/issues';
import { useSession } from '@/lib/auth-client';
import Avatar from '@/components/common/Avatar';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  useIssueParticipantsQuery,
  useSetIssueParticipant,
} from '../../services/participants.service';

// Who can see a private request: its creator, its assignee and the people added here.
// Only the creator or the current assignee adds or removes people.
export default function IssueParticipants({
  issue,
  members,
}: {
  issue: Pick<Issue, 'id' | 'createdByUserId' | 'assigneeUserId'>;
  members: Assignee[];
}) {
  const t = useTranslations('issue.participants');
  const { data: session } = useSession();
  const currentUserId = session?.user.id ?? null;
  const { data: participants = [] } = useIssueParticipantsQuery(issue.id, true);
  const setParticipant = useSetIssueParticipant(issue.id);
  const canManage =
    currentUserId !== null &&
    (currentUserId === issue.createdByUserId || currentUserId === issue.assigneeUserId);
  const addedIds = new Set(participants.map((p) => p.userId));
  // The creator and the assignee see the request already.
  const candidates = members.filter(
    (m) => m.userId !== issue.createdByUserId && m.userId !== issue.assigneeUserId,
  );

  const stack = (
    <span className="flex items-center -space-x-1.5 rtl:space-x-reverse">
      {participants.slice(0, 4).map((p) => (
        <Tooltip key={p.userId}>
          <TooltipTrigger asChild>
            <Avatar name={p.name} image={p.image} className="size-5 ring-2 ring-card" />
          </TooltipTrigger>
          <TooltipContent>{p.name}</TooltipContent>
        </Tooltip>
      ))}
      {participants.length > 4 && (
        <span className="relative z-10 flex size-5 items-center justify-center rounded-full bg-muted text-[10px] ring-2 ring-card">
          +{participants.length - 4}
        </span>
      )}
    </span>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {canManage ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 min-w-7 gap-1 px-1.5 hover:bg-muted"
                aria-label={t('manage')}
                title={t('manage')}
              >
                {stack}
                {setParticipant.isPending ? (
                  <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <UserPlus className="size-3.5 text-muted-foreground" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-0">
              <Command>
                <CommandInput aria-label={t('search')} placeholder={t('search')} />
                <CommandList>
                  <CommandEmpty>{t('empty')}</CommandEmpty>
                  <CommandGroup heading={t('manage')}>
                    {candidates.map((member) => {
                      const added = addedIds.has(member.userId);
                      return (
                        <CommandItem
                          key={member.userId}
                          value={`${member.name} ${member.email}`}
                          aria-label={
                            added
                              ? t('remove', { name: member.name })
                              : t('add', { name: member.name })
                          }
                          disabled={setParticipant.isPending}
                          onSelect={() =>
                            setParticipant.mutate({ userId: member.userId, added: !added })
                          }
                        >
                          <Avatar name={member.name} image={member.image} className="size-6" />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate" dir="auto">
                              {member.name}
                            </span>
                            <span className="truncate text-xs text-muted-foreground" dir="ltr">
                              {member.email}
                            </span>
                          </span>
                          <Check className={added ? 'opacity-100' : 'opacity-0'} />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : participants.length > 0 ? (
          <span className="flex h-7 items-center px-1">{stack}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('none')}</span>
        )}
      </div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Lock className="size-3" aria-hidden />
        {t('audience')}
      </p>
    </div>
  );
}
