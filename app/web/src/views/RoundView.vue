<script setup>
import { computed } from 'vue';
import { useTournamentStore } from '@/stores/tournament.js';
import { getPlayer } from '@/lib/state.js';

const store = useTournamentStore();

const round = computed(() => store.currentRound);
const roundNumbers = computed(() => store.state.rounds.map((r) => r.roundNumber));

function nameOf(id) {
  const p = getPlayer(store.state, id);
  return p ? p.name : '—';
}
function next() {
  store.generateNextRound();
}
</script>

<template>
  <section class="panel" v-if="!store.started">
    <p class="muted">El torneo aún no ha comenzado. Ve a <RouterLink to="/setup">Registro</RouterLink>.</p>
  </section>

  <template v-else>
    <section class="panel">
      <div class="row">
        <h2 style="margin: 0">Ronda {{ store.state.viewRound }} de {{ store.state.maxRounds }}</h2>
        <div class="spacer"></div>
        <button
          v-for="n in roundNumbers"
          :key="n"
          :class="{ 'btn-primary': n === store.state.viewRound }"
          @click="store.setViewRound(n)"
        >
          R{{ n }}
        </button>
      </div>
    </section>

    <section class="panel" v-if="round">
      <table>
        <thead>
          <tr><th>Mesa</th><th>Jugador 1</th><th>Jugador 2</th><th>Resultado</th></tr>
        </thead>
        <tbody>
          <tr v-for="(m, i) in round.matches" :key="m.id">
            <td>{{ i + 1 }}</td>
            <td>{{ nameOf(m.p1Id) }}</td>
            <td>
              <template v-if="m.isBye"><span class="pill pill-bye">BYE</span></template>
              <template v-else>{{ nameOf(m.p2Id) }}</template>
            </td>
            <td>
              <template v-if="m.isBye"><span class="muted">Bye (3 pts)</span></template>
              <div class="row" v-else>
                <button :class="{ 'btn-primary': m.result === 'p1' }" @click="store.reportMatch(m.id, 'p1')">Gana 1</button>
                <button :class="{ 'btn-primary': m.result === 'p2' }" @click="store.reportMatch(m.id, 'p2')">Gana 2</button>
                <button :class="{ 'btn-danger': m.result === 'doubleLoss' }" @click="store.reportMatch(m.id, 'doubleLoss')">Doble derrota</button>
                <span v-if="!m.isReported" class="pill pill-pend">Pendiente</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="row">
        <button class="btn-primary" :disabled="!store.canGenerateNext" @click="next">
          Generar siguiente ronda
        </button>
        <button v-if="!store.finished" @click="store.finishTournament" :disabled="store.canGenerateNext">
          Finalizar torneo
        </button>
        <RouterLink to="/standings"><button>Ver standings</button></RouterLink>
      </div>
      <p class="muted" v-if="round && round.rematchForced" style="margin-top: 10px">
        ⚠️ Esta ronda incluyó al menos una revancha forzada (no había emparejamiento sin repetir).
      </p>
    </section>
  </template>
</template>
