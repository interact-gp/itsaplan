'use client';

import { usePathname } from 'next/navigation';
import { Braces, ListChecks, Server, Shield } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Project } from '@/lib/api/endpoints/projects';
import { useInstanceAdmin } from '@/hooks/useInstanceAdmin';
import { apiDocsPath, documentPath, godPath, mcpServerPath } from '@/utils/paths';
import { GOD_SECTIONS } from '@/utils/godSections';
import { useSettingsNavGroups } from '@/hooks/useSettingsNavGroups';
import { useSidebarSide } from '@/hooks/useSidebarSide';
import { usePersonalPageQuery } from '@/services/personalPage.service';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarRail,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import ProjectSwitcher from '@/components/layout/ProjectSwitcher';
import SidebarNavItem from '@/components/layout/SidebarNavItem';
import SidebarMainNav from '@/components/layout/SidebarMainNav';
import SidebarSettingsNav from '@/components/layout/SidebarSettingsNav';
import SidebarBrandFooter from '@/components/brand/SidebarBrandFooter';

// The app sidebar. It has two modes driven by the route: the main work
// navigation, and the project settings navigation reached through the "Project
// settings" entry. The project switcher header and the footer (API docs, MCP
// server, brand mark) are shared by both modes. Creating and deleting a project
// live in the team panel on Manage teams, not here.
export default function AppSidebar({
  projects,
  currentProjectKey,
  onSelectProject,
  onNewTeam,
}: {
  projects: Project[];
  currentProjectKey: string | null;
  onSelectProject: (key: string) => void;
  onNewTeam: () => void;
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const disabled = !currentProjectKey;
  const projectId = projects.find((p) => p.key === currentProjectKey)?.id ?? null;

  const { isAdmin } = useInstanceAdmin();

  // Settings mode is on whenever the route matches one of the settings nav items.
  // Members and the AI Team pages are not in those groups, so they keep the main
  // sidebar.
  const settingsNav = useSettingsNavGroups(currentProjectKey);
  const settingsMode = settingsNav.groups.some((g) => g.items.some((i) => i.active));
  const onApiDocs = pathname.endsWith('/api');
  const onMcp = pathname.endsWith('/mcp');
  const side = useSidebarSide();
  const { data: personalPage } = usePersonalPageQuery();
  const myTodoHref = personalPage
    ? documentPath(personalPage.projectKey, personalPage.documentId)
    : null;

  return (
    <Sidebar collapsible="icon" side={side}>
      <SidebarHeader>
        <ProjectSwitcher
          projects={projects}
          currentProjectKey={currentProjectKey}
          onSelectProject={onSelectProject}
          onNewTeam={onNewTeam}
        />
      </SidebarHeader>

      <SidebarContent>
        {settingsMode ? (
          <SidebarSettingsNav projectKey={currentProjectKey} />
        ) : (
          <SidebarMainNav projectKey={currentProjectKey} projectId={projectId} />
        )}
      </SidebarContent>

      <SidebarFooter>
        {!settingsMode && (
          <>
            <SidebarMenu>
              {myTodoHref && (
                <SidebarNavItem
                  href={myTodoHref}
                  icon={ListChecks}
                  label={t('myTodo')}
                  active={pathname === myTodoHref}
                  disabled={false}
                />
              )}
              <SidebarNavItem
                href={currentProjectKey ? apiDocsPath(currentProjectKey) : '#'}
                icon={Braces}
                label={t('apiDocs')}
                active={onApiDocs}
                disabled={disabled}
              />
              <SidebarNavItem
                href={currentProjectKey ? mcpServerPath(currentProjectKey) : '#'}
                icon={Server}
                label={t('mcpServer')}
                active={onMcp}
                disabled={disabled}
              />
              {isAdmin && (
                <SidebarNavItem
                  href={godPath(GOD_SECTIONS[0]!.slug)}
                  icon={Shield}
                  label={t('godMode')}
                  active={false}
                  disabled={false}
                />
              )}
            </SidebarMenu>

            <SidebarSeparator />
          </>
        )}

        <SidebarBrandFooter />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
