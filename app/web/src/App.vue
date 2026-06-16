<script setup>
import { onMounted, ref } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { useTournamentStore } from '@/stores/tournament.js';

const store = useTournamentStore();
const theme = ref(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

onMounted(() => {
  // Offline by default: load the localStorage tournament (parity with legacy app).
  store.init();
});

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light';
  if (theme.value === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try {
    localStorage.setItem('ygo_theme', theme.value);
  } catch (e) {}
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <h1>SwissYGO</h1>
      <span class="mode-badge">{{ store.mode === 'connected' ? 'En línea' : 'Local' }}</span>
      <nav class="tabs">
        <RouterLink to="/setup">Registro</RouterLink>
        <RouterLink to="/round">Rondas</RouterLink>
        <RouterLink to="/standings">Standings</RouterLink>
      </nav>
      <button class="theme-switch" @click="toggleTheme" :title="theme === 'light' ? 'Tema oscuro' : 'Tema claro'">
        {{ theme === 'light' ? '🌙' : '☀️' }}
      </button>
    </header>
    <RouterView />
  </div>
</template>
