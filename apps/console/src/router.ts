import { createRouter, createWebHistory } from 'vue-router';

import AgentsView from './views/AgentsView.vue';
import BackupView from './views/BackupView.vue';
import BrainsView from './views/BrainsView.vue';
import DashboardView from './views/DashboardView.vue';
import InboxView from './views/InboxView.vue';
import MemoriesView from './views/MemoriesView.vue';

export default createRouter({
  history: createWebHistory('/console/'),
  routes: [
    { path: '/', component: DashboardView, meta: { label: 'Dashboard' } },
    { path: '/brains', component: BrainsView, meta: { label: 'Brains' } },
    { path: '/memories', component: MemoriesView, meta: { label: 'Memories' } },
    { path: '/inbox', component: InboxView, meta: { label: 'Inbox' } },
    { path: '/agents', component: AgentsView, meta: { label: 'Agents' } },
    { path: '/backup', component: BackupView, meta: { label: 'Backup' } },
  ],
});
