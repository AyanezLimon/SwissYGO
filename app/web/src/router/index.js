import { createRouter, createWebHistory } from 'vue-router';

// Code-split views. Player/auth/history routes are stubs wired in later phases.
const routes = [
  { path: '/', redirect: '/setup' },
  { path: '/setup', name: 'setup', component: () => import('@/views/SetupView.vue') },
  { path: '/round', name: 'round', component: () => import('@/views/RoundView.vue') },
  { path: '/standings', name: 'standings', component: () => import('@/views/StandingsView.vue') },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
