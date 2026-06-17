/* Author-time generator for the guest-name vocabulary. NOT shipped/run at
 * runtime — it fetches public datasets ONCE and writes a static bundle at
 * app/web/js/names-data.js (window.NAMES = { NOUNS, ADJS }).
 *
 *   node app/tools/gen-names.mjs
 *
 * Sources: YGOPRODeck (Yu-Gi-Oh cards) + curated lists (videogames/objects/places/silly).
 * Names are kept single-word, ASCII (accents stripped), 3–14 chars, deduped. */
import { writeFileSync, mkdirSync } from 'node:fs';

const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

async function ygo() {
  try {
    const r = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php');
    const j = await r.json();
    const out = new Set();
    for (const c of j.data || []) {
      const n = deaccent(c.name || '');
      if (/^[A-Za-z]{3,14}$/.test(n)) out.add(n);
    }
    return [...out];
  } catch (e) { console.error('YGO fetch failed:', e.message); return []; }
}

// Curated: iconic videogame characters/places + objects + silly (single-word, ASCII).
const CURATED = [
  'Mario','Luigi','Peach','Bowser','Yoshi','Toad','Wario','Waluigi','Link','Zelda','Ganon','Kirby',
  'Sonic','Tails','Knuckles','Eggman','Samus','Megaman','Pacman','Sans','Cuphead','Steve','Creeper',
  'Enderman','Kratos','Geralt','Doomguy','Master','Cloud','Sephiroth','Tifa','Aerith','Barret','Yuna',
  'Tidus','Auron','Chocobo','Moguri','Tonberry','Cactilio','Vivi','Squall','Zidane','Crono','Lucca',
  'Frog','Magus','Ryu','Ken','Chun','Akuma','Scorpion','SubZero','Raiden',
  'Jarron','Tostadora','Calcetin','Cuchara','Tenedor','Almohada','Sarten','Croqueta','Waffle','Panqueque',
  'Burrito','Taco','Nacho','Empanada','Churro','Aguacate','Mango','Pulpo','Calamar','Capibara','Mapache',
  'Erizo','Nutria','Ajolote','Quokka','Pinguino','Morsa','Tucan','Colibri','Luciernaga','Escarabajo',
  'Pinata','Chancla','Cohete','Robot','Dinosaurio','Dragon','Fantasma','Gargola','Golem','Quimera',
  'Hyrule','Termina','Kanto','Johto','Hoenn','Sinnoh','Midgar','Zanarkand','Gerudo','Tristram','Rapture',
  'Pueblo','Bosque','Volcan','Glaciar','Castillo','Mazmorra','Galaxia','Nebulosa','Meteorito','Tornado',
];

const ADJS = [
  'Esponjoso','Brillante','Furioso','Legendario','Cosmico','Picante','Turbo','Supremo','Magico','Oscuro',
  'Veloz','Radiante','Salvaje','Mistico','Glorioso','Travieso','Imparable','Ardiente','Glacial','Funky',
  'Ninja','Pixelado','Epico','Dorado','Fugaz','Caotico','Sigiloso','Crujiente','Galactico','Rebelde',
  'Bailarin','Gigante','Diminuto','Eterno','Fantasmal','Volador','Electrico','Nuclear','Atomico','Feroz',
  'Astuto','Valiente','Tenaz','Sombrio','Lunar','Solar','Estelar','Invisible','Indomable','Relampago',
  'Vibrante','Hipnotico','Errante','Sabio','Bravo','Colosal','Poderoso','Sublime','Fenomenal','Inmortal',
  'Vengativo','Implacable','Carismatico','Explosivo','Llameante','Helado','Tropical','Volcanico','Abismal',
  'Celestial','Infernal','Sagrado','Maldito','Encantado','Hechizado','Mortal','Letal','Brutal','Veloz',
  'Chiflado','Gruñon','Dormilon','Glotón','Saltarin','Parlanchin','Curioso','Torpe','Elegante','Majestuoso',
  'Turbio','Reluciente','Centelleante','Fulgurante','Tronante','Nevado','Arcano','Rúnico','Espectral','Titanico',
];

async function main() {
  const y = await ygo();
  const seen = new Set(); const NOUNS = [];
  for (const n of [...y, ...CURATED]) {
    const key = n.toLowerCase();
    if (n && !seen.has(key)) { seen.add(key); NOUNS.push(n); }
  }
  NOUNS.sort((a, b) => a.localeCompare(b));
  const ADJ = [...new Set(ADJS.map(deaccent))].sort((a, b) => a.localeCompare(b));

  mkdirSync('app/web/js', { recursive: true });
  const out = `/* AUTO-GENERATED — do not edit by hand. Guest-name vocabulary.
   Sources: YGOPRODeck + PokeAPI + curated. Regenerate: node app/tools/gen-names.mjs
   nouns=${NOUNS.length} adjs=${ADJ.length} */
window.NAMES = ${JSON.stringify({ NOUNS, ADJS: ADJ })};
`;
  writeFileSync('app/web/js/names-data.js', out);
  console.log(`names-data.js written: ${NOUNS.length} nouns × ${ADJ.length} adjectives = ${(NOUNS.length * ADJ.length).toLocaleString()} base combos (×90 numbers)`);
  console.log('YGO:', y.length, 'curated:', CURATED.length);
}
main();
