<script setup>
import { ref, computed } from 'vue';
import { useTournamentStore } from '@/stores/tournament.js';
import { useRouter } from 'vue-router';

const store = useTournamentStore();
const router = useRouter();

const name = ref('');
const bulk = ref('');
const rounds = ref(0);

const suggested = computed(() => store.suggestedRounds());

function add() {
  if (store.addPlayer(name.value)) name.value = '';
}
function addBulk() {
  const n = store.addPlayersBulk(bulk.value);
  if (n > 0) bulk.value = '';
}
function start() {
  store.start(rounds.value || suggested.value);
  router.push('/round');
}
function resetAll() {
  if (confirm('¿Borrar el torneo actual y empezar de cero?')) store.reset();
}
</script>

<template>
  <section class="panel" v-if="!store.started">
    <h2>Registro de jugadores</h2>
    <div class="row">
      <input class="grow" type="text" v-model="name" placeholder="Nombre del jugador" @keyup.enter="add" />
      <button class="btn-primary" @click="add">Agregar</button>
    </div>

    <div style="margin-top: 14px">
      <label>Pegar lista (un nombre por línea; tolera "1.", "2)", etc.)</label>
      <textarea v-model="bulk" placeholder="1. Alice&#10;2. Bob&#10;3. Carol"></textarea>
      <div class="row" style="margin-top: 8px">
        <button @click="addBulk">Agregar lista</button>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Jugadores ({{ store.players.length }})</h2>
    <ul class="list" v-if="store.players.length">
      <li v-for="p in store.players" :key="p.id">
        <span class="grow">{{ p.name }}</span>
        <button v-if="!store.started" class="btn-danger" @click="store.removePlayer(p.id)">Quitar</button>
      </li>
    </ul>
    <p class="muted" v-else>Aún no hay jugadores.</p>
  </section>

  <section class="panel" v-if="!store.started">
    <h2>Iniciar torneo</h2>
    <div class="row">
      <div>
        <label>Número de rondas (sugerido: {{ suggested }})</label>
        <input type="number" min="1" v-model.number="rounds" :placeholder="String(suggested)" style="width: 120px" />
      </div>
      <button class="btn-primary" :disabled="store.players.length < 2" @click="start">Iniciar</button>
    </div>
  </section>

  <section class="panel" v-else>
    <h2>Torneo en curso</h2>
    <p class="muted">Ronda {{ store.state.currentRound }} de {{ store.state.maxRounds }}.</p>
    <button class="btn-danger" @click="resetAll">Reiniciar torneo</button>
  </section>
</template>
