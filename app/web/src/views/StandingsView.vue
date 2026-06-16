<script setup>
import { computed } from 'vue';
import { useTournamentStore } from '@/stores/tournament.js';

const store = useTournamentStore();

const standings = computed(() => store.standings);
// key -> group for quick "is this row in a tie group" lookup
const tieByKey = computed(() => {
  const map = {};
  for (const g of store.tieGroups) for (const id of g.ids) map[id] = g;
  return map;
});

function seg(tieString) {
  // AA·BBB·CCC·DDD presentation split
  return `${tieString.slice(0, 2)}·${tieString.slice(2, 5)}·${tieString.slice(5, 8)}·${tieString.slice(8)}`;
}
</script>

<template>
  <section class="panel" v-if="!store.players.length">
    <p class="muted">No hay jugadores todavía.</p>
  </section>

  <template v-else>
    <section class="panel" v-if="store.finished && standings.length">
      <h2>🏆 Campeón: {{ standings[0].name }}</h2>
    </section>

    <section class="panel">
      <h2>Standings</h2>
      <table>
        <thead>
          <tr><th>#</th><th>Jugador</th><th>P-G</th><th class="mono">AA·BBB·CCC·DDD</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in standings" :key="s.id">
            <td>{{ i + 1 }}</td>
            <td>
              {{ s.name }}
              <span v-if="s.dropped" class="pill pill-drop">DROP</span>
            </td>
            <td>{{ s.wins }}-{{ s.losses }}</td>
            <td class="tie-string">{{ seg(s.tieString) }}</td>
            <td>
              <div class="row" v-if="tieByKey[s.id]">
                <button title="Subir" @click="store.moveTie(s.id, -1)">▲</button>
                <button title="Bajar" @click="store.moveTie(s.id, 1)">▼</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel" v-if="store.tieGroups.length">
      <h2>Empates exactos</h2>
      <p class="muted">
        Hay {{ store.tieGroups.length }} grupo(s) con el mismo número de desempate. Usa ▲▼ para fijar
        el orden tras tu método (volado, dado, playoff), o confírmalo tal cual.
      </p>
      <ul class="list">
        <li v-for="g in store.tieGroups" :key="g.key">
          <span class="grow">{{ g.size }} jugadores empatados</span>
          <span class="pill" :class="g.resolved ? 'pill-bye' : 'pill-pend'">{{ g.resolved ? 'Fijado' : 'Tentativo' }}</span>
          <button @click="store.confirmTieOrder(g.key)">✓ Dejar</button>
          <button v-if="g.resolved" class="btn-danger" @click="store.clearTieOrder(g.key)">Revertir</button>
        </li>
      </ul>
    </section>
  </template>
</template>
