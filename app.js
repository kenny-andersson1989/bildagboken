// Bildagboken — delad bilapp för ett hushåll. Data synkas via Firebase (Firestore + inloggning med Google eller Apple).
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  linkWithPopup, linkWithRedirect, onAuthStateChanged, signOut, reauthenticateWithPopup, deleteUser
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp, arrayUnion, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { MAPKIT_TOKEN } from "./maps-config.js";

const VERSION = "2.8";

/* ---------------------------------------------------------------- språk */

// Svenska är grundspråket. Med engelska översätts allt som visas på skärmen när det ritas (se trTree längre ner).
const LANG = (() => { try { return localStorage.getItem("bildagboken.lang") === "en" ? "en" : "sv"; } catch { return "sv"; } })();
let EN = null, EN_RULES = [];
if (LANG === "en") {
  try { ({ EN, EN_RULES } = await import("./en.js")); } catch (e) { console.error("Kunde inte ladda engelska", e); }
}
document.documentElement.lang = LANG;

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
let db;
try {
  db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  db = initializeFirestore(fb, {});
}

/* ------------------------------------------------------------------ state */

const S = {
  user: null,
  hid: null,
  house: null,
  cars: [],
  carId: null,
  entries: [],
  view: "oversikt",
  filter: "alla",
  loaded: { house: false, cars: false, entries: false },
  unsubs: [],
  screen: "",
  pending: { cars: 0, entries: 0 },
};

/* ---------------------------------------------------------------- helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = [0, 1, 2].map((d) => new Intl.NumberFormat("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : nf[d].format(n));
// Belopp i kronor: med ören bara när beloppet har ören (612,50 kr men 600 kr).
const fmtKr = (n) => fmt(n, n != null && Math.round(n * 100) % 100 !== 0 ? 2 : 0);
const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/\s/g, "").replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const parseDate = (s) => {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  return y ? new Date(y, (m || 1) - 1, d || 1) : null;
};
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const daysUntil = (d) => Math.round((d - today0()) / 864e5);
const addMonths = (d, m) => { const r = new Date(d); r.setMonth(r.getMonth() + m); return r; };
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"];
if (EN) {
  MONTHS.splice(0, 12, "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December");
  MONTHS_SHORT.splice(0, 12, "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec");
}
const fmtDate = (s) => {
  const d = typeof s === "string" ? parseDate(s) : s;
  if (!d) return "–";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const fmtDateShort = (s) => {
  const d = typeof s === "string" ? parseDate(s) : s;
  if (!d) return "–";
  const base = `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
};
const tsMs = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : 0);
const timeAgo = (ms) => {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "Nyss";
  if (min < 60) return `${min} min sedan`;
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.floor((today0() - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (days === 0) return `I dag ${hm}`;
  if (days === 1) return `I går ${hm}`;
  return fmtDateShort(d);
};
const daysText = (d) => {
  if (d < 0) return d === -1 ? "1 dag sen" : `${-d} dagar sen`;
  if (d === 0) return "I dag";
  if (d < 60) return d === 1 ? "1 dag" : `${d} dagar`;
  const m = Math.round(d / 30.4);
  return m >= 18 ? `${fmt(m / 12, 1)} år` : `${m} mån`;
};
const icon = (name, size = 22) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const uid = () => S.user?.uid;
const randomId = (len = 8, alphabet = "abcdefghijkmnpqrstuvwxyz23456789") => {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => alphabet[x % alphabet.length]).join("");
};
const clean = (o) => {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
  return r;
};
const pref = {
  get(k) { try { return localStorage.getItem("bildagboken." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("bildagboken." + k, v); } catch { /* ingen lagring */ } },
};

const housePath = (...p) => ["households", S.hid, ...p];
const col = (...p) => collection(db, ...housePath(...p));
const ref = (...p) => doc(db, ...housePath(...p));

/* ------------------------------------------------------------- domain data */

const TYPE = {
  tank: { label: "Tankning", icon: "fuel" },
  matare: { label: "Mätarställning", icon: "gauge" },
  service: { label: "Service", icon: "wrench" },
  eget: { label: "Eget jobb", icon: "hand" },
  dack: { label: "Däck", icon: "tire" },
  tvatt: { label: "Tvätt", icon: "wash" },
  parkering: { label: "Parkering", icon: "parking" },
  kostnad: { label: "Kostnad", icon: "receipt" },
};
const FUELS = ["Bensin", "Diesel", "Flexifuel (bensin/E85)", "Laddhybrid", "Hybrid", "El"];
const COST_CATS = ["Försäkring", "Skatt", "Besiktning", "Parkering", "Tvätt", "Tillbehör", "Övrigt"];
// Vid ett byte vet appen vilka däck det gäller, så frågan "Vilka däck?" behövs bara för övriga däckposter.
const isSwap = (a) => a === "till_vinter" || a === "till_sommar";
const TIRE_ACTIONS = {
  till_vinter: "Bytte till vinterdäck",
  till_sommar: "Bytte till sommardäck",
  monster: "Mätte mönsterdjup",
  nya: "Köpte nya däck",
  forvaring: "Däckförvaring",
  ovrigt: "Övrigt",
};
// Hur däckposter beskrivs i Senaste och Aviseringar ("Du bytte till vinterdäck").
const TIRE_ACTIVITY = {
  till_vinter: "bytte till vinterdäck",
  till_sommar: "bytte till sommardäck",
  monster: "mätte mönsterdjupet",
  nya: "köpte nya däck",
  forvaring: "betalade för däckförvaring",
  ovrigt: "loggade något om däcken",
};
const BOOK_KINDS = { service: "Service", reparation: "Reparation", besiktning: "Besiktning", dack: "Däckbyte", annat: "Annat" };
const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
if (EN) WEEKDAYS.splice(0, 7, "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday");

// Översättning av en text: hela texten om den finns, annars mönster med siffror och sedan kända fraser, längst först.
const reEsc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trRe = EN ? new RegExp(`(?<![\\p{L}\\d])(?:${Object.keys(EN).sort((a, b) => b.length - a.length).map(reEsc).join("|")})(?![\\p{L}])`, "gu") : null;
function tr(s) {
  if (!EN || !s || !/[A-Za-zÅÄÖåäö]/.test(s)) return s;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const core = m[2];
  if (EN[core] != null) return m[1] + EN[core] + m[3];
  let out = core;
  for (const [re, to] of EN_RULES) out = out.replace(re, to);
  out = out.replace(trRe, (k) => EN[k] ?? k);
  return m[1] + out + m[3];
}
// Det man själv har skrivit (namn, anteckningar, att göra) översätts inte.
const NO_TR = "script, style, textarea, [data-notr], .todo-t, .plate, .code, .share-url";
const TR_ATTRS = ["placeholder", "aria-label", "title", "alt"];
function trTree(root) {
  if (!EN || !root) return;
  const one = (n) => {
    if (n.nodeType === 3) {
      if (n.parentElement?.closest(NO_TR)) return;
      const t = tr(n.data);
      if (t !== n.data) n.data = t;
    } else if (n.nodeType === 1) {
      for (const a of TR_ATTRS) {
        const v = n.getAttribute(a);
        if (v) { const t = tr(v); if (t !== v) n.setAttribute(a, t); }
      }
    }
  };
  one(root);
  if (root.nodeType !== 1) return;
  // Fält och eget innehåll hoppas över, men fältens platshållare översätts.
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
    if (n.nodeType !== 1 || !n.matches(NO_TR)) return NodeFilter.FILTER_ACCEPT;
    if (n.matches("textarea")) one(n);
    return NodeFilter.FILTER_REJECT;
  } });
  let x;
  while ((x = w.nextNode())) one(x);
}
if (EN) {
  trTree(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "childList") m.addedNodes.forEach(trTree);
      else trTree(m.target);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: TR_ATTRS });
}
const SPEC_TEMPLATE = "Motorolja: \nOljemängd: \nDäckdimension: \nLufttryck fram/bak: \nTorkarblad: \nBatteri: \nGlödlampor: ";

const isFlex = (c) => /flex|e85/i.test(c?.fuel || "") || /\d[.,]\d\s*f\b/i.test(c?.engine || "");
const isElectric = (c) => /^el$/i.test(c?.fuel || "");
const isDiesel = (c) => /diesel/i.test(c?.fuel || "");

function fuelOptions(c) {
  if (isElectric(c)) return ["El (kWh)"];
  if (isDiesel(c)) return ["Diesel", "HVO100"];
  if (isFlex(c)) return ["E85", "Bensin 95", "Bensin 98"];
  if (/laddhybrid/i.test(c?.fuel || "")) return ["Bensin 95", "Bensin 98", "El (kWh)"];
  return ["Bensin 95", "Bensin 98"];
}

// Bilmodeller med kända saker att hålla koll på. Texterna är generella råd, inte en verkstadsdiagnos.
const PROFILES = [
  {
    test: (c) => /volvo/i.test(c.make || "") && /\b(v50|s40|c30|c70)\b/i.test(c.model || "") && /1[.,]8/.test(c.engine || ""),
    chain: true,
    tips: [
      { sev: "high", when: (m) => m >= 10 || m <= 2, flex: true, title: "Vinterstart på E85", text: "Etanol startar sämre i kyla. Använd motorvärmaren och tanka gärna bensin när det är riktigt kallt." },
      { sev: "mid", flex: true, title: "Tändstift", text: "Slits fortare när man kör mycket E85. Följ intervallet under Underhåll." },
      { sev: "low", title: "Kamkedja", text: "1,8-motorn har kamkedja, inte kamrem. Lyssna efter rassel de första sekunderna vid kallstart." },
      { sev: "low", title: "Bakre bromsok", text: "Kärvar gärna på äldre bilar av den här modellen. Känn efter om en fälg blir varmare än de andra efter körning." },
      { sev: "low", title: "Främre bussningar", text: "Länkarmsbussningar slits med åren. Knackljud över gupp eller vag styrning är tecken att låta kolla." },
    ],
  },
];
const isHybrid = (c) => /hybrid/i.test(c?.fuel || "");
const isPlugin = (c) => /laddhybrid/i.test(c?.fuel || "");
const carAge = (c) => (Number(c?.year) > 1900 ? new Date().getFullYear() - Number(c.year) : null);
const winter = (m) => m >= 11 || m <= 2;
// Tips efter drivmedel, ålder och mätarställning. fit avgör om tipset passar bilen, when vilka månader det visas.
const GENERIC_TIPS = [
  // Elbil
  { sev: "mid", fit: isElectric, when: winter, title: "Räckvidd i kyla", text: "Räckvidden kan bli en tredjedel kortare när det är kallt. Förvärm bilen medan den står på laddning, så går värmen på elnätet i stället för batteriet." },
  { sev: "mid", fit: (c) => isElectric(c) || isHybrid(c), title: "12-voltsbatteriet", text: "Bilen har också ett vanligt 12-voltsbatteri som startar elektroniken. Det kan ta slut även när det stora batteriet är fullt. Låt testa det om bilen har några år." },
  { sev: "low", fit: (c) => isElectric(c) || isHybrid(c), title: "Bromsarna rostar", text: "Bilen bromsar mest med motorn, så skivorna används lite och rostar lätt. Bromsa ordentligt några gånger då och då, och låt kolla bromsarna vid service." },
  { sev: "low", fit: isElectric, title: "Däcken slits fortare", text: "Elbilar är tunga och drar snabbt, så däcken slits fortare. Kolla mönsterdjupet oftare och skifta fram och bak vid hjulbyte." },
  { sev: "low", fit: isPlugin, title: "Kör på bensin ibland", text: "Kör ni mest på el kan bensinen bli gammal och motorn sällan bli varm. Kör en längre sträcka på bensin någon gång i månaden." },
  // Diesel
  { sev: "mid", fit: isDiesel, title: "Partikelfiltret", text: "Partikelfiltret rensar sig själv vid jämn landsvägskörning. Kör ni mest korta sträckor, ta en tur på 20 minuter i jämn fart ibland, så att det inte sätter igen." },
  { sev: "mid", fit: isDiesel, when: winter, title: "Diesel i kyla", text: "Diesel kan tjockna i sträng kyla. Tanka vid en mack med vinterdiesel och använd motorvärmaren." },
  { sev: "low", fit: (c) => isDiesel(c) && (carAge(c) ?? 99) <= 10, title: "AdBlue", text: "Nyare dieslar behöver AdBlue. Fyll på i tid när varningen kommer, annars kan bilen till slut vägra starta." },
  // Förbränningsmotor
  { sev: "mid", fit: (c) => !isElectric(c), when: winter, title: "Motorvärmaren", text: "Med motorvärmare på en timme före start slits motorn mindre och bilen drar mindre bränsle. Koppla in den när det är under noll." },
  { sev: "low", fit: (c) => !isElectric(c), title: "Oljenivån", text: "Dra oljestickan med jämna mellanrum, till exempel varannan tankning. Äldre motorer kan dra lite olja." },
  { sev: "low", fit: (c) => !isElectric(c) && !profileFor(c) && (odoOf(c) ?? 0) >= 8000, title: "Kamrem eller kamkedja", text: "Ta reda på vilket er motor har. En kamrem byts ofta vid 10 000 till 20 000 mil eller efter ett antal år, och går den av kan motorn förstöras. Lägg in den under Underhåll." },
  { sev: "low", fit: (c) => !isElectric(c) && (carAge(c) ?? 0) >= 6, title: "Kylarvätskan", text: "Kylarvätskan tappar sitt skydd med åren. Byt den ungefär vart femte år och kolla nivån i behållaren när motorn är kall." },
  // Ålder och mätarställning
  { sev: "mid", fit: (c) => (carAge(c) ?? 0) >= 10, when: (m) => m >= 9 || m <= 4, title: "Rostskydd", text: "Vägsalt äter på underredet. Spola underredet efter saltade vägar och rostskyddsbehandla bilen vart annat eller vart tredje år." },
  { sev: "low", fit: (c) => (carAge(c) ?? 0) >= 8 || (odoOf(c) ?? 0) >= 15000, title: "Stötdämpare", text: "Slitna stötdämpare ger gungig gång och längre bromssträcka. Gungar bilen efter gupp eller drar den åt sidan vid inbromsning, låt kolla dem." },
  { sev: "low", fit: (c) => carAge(c) != null && carAge(c) <= 3, title: "Garantin", text: "Följ tillverkarens serviceprogram och spara kvittona, så behåller ni garantin. Logga servicen här, så finns allt samlat." },
  // Alla bilar
  { sev: "mid", when: (m) => m >= 10 || m <= 1, title: "Batteriet inför vintern", text: "Kyla tar hårt på startbatteriet. Är det äldre än fem år, låt testa det innan det blir riktigt kallt." },
  { sev: "low", title: "Lufttryck", text: "Kolla lufttrycket en gång i månaden och före långresor. Rätt tryck sparar bränsle och däck." },
];

function profileFor(c) {
  return PROFILES.find((p) => p.test(c)) || null;
}

function defaultItems(c) {
  const el = isElectric(c), diesel = isDiesel(c), flex = isFlex(c);
  const p = profileFor(c);
  const items = [];
  if (!el) items.push({ id: "olja", name: "Motorolja och oljefilter", mil: 2000, months: 12 });
  if (!el) items.push({ id: "luftfilter", name: "Luftfilter", mil: 4000, months: 48 });
  items.push({ id: "kupefilter", name: "Kupéfilter", mil: 2000, months: 24 });
  if (!el && !diesel) items.push({ id: "tandstift", name: "Tändstift", mil: flex ? 3000 : 6000, months: 72 });
  items.push({ id: "bromsvatska", name: "Bromsvätska", mil: null, months: 24 });
  items.push({ id: "torkare", name: "Torkarblad", mil: null, months: 12 });
  if (!el && !(p && p.chain)) items.push({ id: "kamrem", name: "Kamrem", mil: 12000, months: 120 });
  return items;
}

/* -------------------------------------------------------- derived values */

const car = () => S.cars.find((c) => c.id === S.carId) || null;
// Samma namn på bilen överallt, till exempel "Volvo V50 1.8F".
const carName = (c) => [c?.make, c?.model, c?.engine].filter(Boolean).join(" ") || "Bilen";

// Mätarställningen bestäms av loggen: den senaste posten (efter datum) som har en mätarställning.
// Äldre bilar utan sådana poster faller tillbaka på värdet som sparades på bilen.
function latestOdoEntry(carId, excludeId = null) {
  let best = null;
  for (const e of S.entries) {
    if (e.carId !== carId || e.odometer == null || e.id === excludeId) continue;
    if (!best || (e.date || "") > (best.date || "") || ((e.date || "") === (best.date || "") && tsMs(e.createdAt) > tsMs(best.createdAt))) best = e;
  }
  return best;
}
function odoOf(c) {
  if (!c) return null;
  const best = latestOdoEntry(c.id);
  return best ? best.odometer : c.odometer ?? null;
}
const carEntries = () => {
  const c = car();
  const own = S.entries.filter((e) => e.carId === S.carId);
  return c?.recurring?.length ? sortEntries([...own, ...recurringEntries(c)]) : own;
};

// Återkommande kostnader (till exempel en hyrd parkeringsplats) sparas som en regel på bilen.
// Varje betalning fram till i dag (eller slutdatumet) räknas fram som en post, så att den syns i loggen och Ekonomi.
const PERIODS = { 1: "Varje månad", 3: "Var tredje månad", 12: "Varje år" };
function addMonthsKeepDay(d, m) {
  const y = d.getFullYear(), mm = d.getMonth() + m;
  const last = new Date(y, mm + 1, 0).getDate();
  return new Date(y, mm, Math.min(d.getDate(), last));
}
function recurringEntries(c) {
  const out = [];
  const today = todayStr();
  for (const r of c?.recurring || []) {
    const start = parseDate(r.start);
    if (!start || !r.period) continue;
    for (let i = 0; i < 1200; i++) {
      const ds = ymd(addMonthsKeepDay(start, i * r.period));
      if (ds > today || (r.end && ds > r.end)) break;
      out.push({ id: `rec:${r.id}:${ds}`, carId: c.id, type: r.type || "parkering", date: ds, amount: r.amount, place: r.place || null, note: r.note || null, createdBy: r.createdBy, createdAt: 0, recurringId: r.id });
    }
  }
  return out;
}
const memberName = (u) => S.house?.memberInfo?.[u]?.name || "Någon";
const whoName = (u) => (u === uid() ? "Du" : memberName(u));
const myName = () => memberName(uid());
const lastSeenMs = () => tsMs(S.house?.memberInfo?.[uid()]?.lastSeen);

function sortEntries(list) {
  return list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || tsMs(b.createdAt) - tsMs(a.createdAt));
}

function entryTitle(e) {
  switch (e.type) {
    case "tank": return "Tankning";
    case "matare": return "Mätarställning";
    case "service": return e.title || (e.workshop ? `Service · ${e.workshop}` : "Service");
    case "eget": return e.title || "Eget jobb";
    case "dack": return TIRE_ACTIONS[e.tireAction] || "Däck";
    case "tvatt": return "Tvätt";
    case "parkering": return e.fine ? "P-bot" : e.recurringId ? "Parkering, hyrd plats" : "Parkering";
    case "kostnad": return e.title || e.category || "Kostnad";
    default: return "Logg";
  }
}

// Ord som räknas som ett byte av en underhållspunkt när de skrivs i "Annat som byttes".
const ITEM_WORDS = {
  olja: ["motorolja", "olja", "oljebyte", "oljefilter", "oljeservice"],
  luftfilter: ["luftfilter", "luftfiltret", "luftfiltren"],
  kupefilter: ["kupefilter", "kupefiltret", "pollenfilter", "pollenfiltret"],
  tandstift: ["tändstift", "tändstiften"],
  bromsvatska: ["bromsvätska", "bromsvätskan", "bromsolja"],
  torkare: ["torkarblad", "torkarbladen", "torkare", "torkarna"],
  kamrem: ["kamrem", "kamremmen", "kamremssats"],
};
const normWord = (t) => String(t || "").toLowerCase().replace(/é/g, "e").trim();

// Räknas posten som ett byte av punkten? Antingen ikryssad, eller skriven i "Annat som byttes"
// (som hela ord, så att till exempel "växellådsolja" inte räknas som motorolja).
// Står punktens namn (eller ett vanligt ord för den) som hela ord i texten?
function nameMatchesItem(text, item) {
  const words = [...(ITEM_WORDS[item.id] || []), normWord(item.name)].map(normWord).filter(Boolean);
  const t = normWord(text);
  return words.some((w) => new RegExp(`(^|[^a-zåäö])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-zåäö])`).test(t));
}

// Vad som gjordes vid en service eller ett eget jobb: [{ key, name, itemId, action, side }].
// Äldre poster utan "work" byggs från items och parts, och allt räknas då som bytt.
const WORK_ACTIONS = { bytt: "Bytt", pafyllt: "Fyllt på", rengjort: "Rengjort", kontrollerat: "Kontrollerat" };
// Positioner som går att kombinera: hjulen för det mesta, fram och bak för torkarblad.
const CORNERS = ["Vänster fram", "Höger fram", "Vänster bak", "Höger bak"];
const ENDS = ["Fram", "Bak"];
const positionsFor = (itemId) => (itemId === "torkare" ? ENDS : CORNERS);
// Valda positioner för en rad. Äldre poster har en enda sida som text ("Fram", "Höger fram").
function sidesOf(w) {
  if (Array.isArray(w?.sides)) return w.sides;
  if (!w?.side) return [];
  if (w.side === "Fram" && w.itemId !== "torkare") return ["Vänster fram", "Höger fram"];
  if (w.side === "Bak" && w.itemId !== "torkare") return ["Vänster bak", "Höger bak"];
  return [w.side];
}
// Så kort text som möjligt: båda fram blir "fram", alla fyra "alla fyra".
function sidesText(sides) {
  const set = new Set(sides);
  if (CORNERS.every((x) => set.has(x))) return "alla fyra";
  const out = [];
  if (set.has("Vänster fram") && set.has("Höger fram")) out.push("fram"); else CORNERS.slice(0, 2).forEach((x) => set.has(x) && out.push(x.toLowerCase()));
  if (set.has("Vänster bak") && set.has("Höger bak")) out.push("bak"); else CORNERS.slice(2).forEach((x) => set.has(x) && out.push(x.toLowerCase()));
  ENDS.forEach((x) => set.has(x) && out.push(x.toLowerCase()));
  return out.join(", ");
}
// Punkter där sida eller position inte har betydelse.
const NO_POSITION = ["olja", "luftfilter", "kupefilter", "bromsvatska", "kamrem", "tandstift"];
function workOf(e, c = car()) {
  if (Array.isArray(e.work)) return e.work;
  const items = c?.items || [];
  const out = (e.items || []).map((id) => {
    const i = items.find((x) => x.id === id);
    return i ? { key: `item:${id}`, itemId: id, name: i.name, action: "bytt", sides: [] } : null;
  }).filter(Boolean);
  for (const p of e.parts || []) if (p.trim()) out.push({ key: normWord(p), itemId: null, name: p.trim(), action: "bytt", sides: [] });
  return out;
}
// "Bromsskivor (höger fram)", "Bromsvätska (fyllt på)".
function workText(w) {
  const extra = [sidesText(sidesOf(w)), w.action && w.action !== "bytt" ? WORK_ACTIONS[w.action].toLowerCase() : ""].filter(Boolean);
  return `${w.name}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}
// Gäller raden punkten? Antingen vald som punkt, eller skriven med punktens namn.
const workIsItem = (w, item) => w.itemId === item.id || (!w.itemId && nameMatchesItem(w.name, item));

// Räknas posten som ett byte av punkten? Bara åtgärden Bytt nollställer intervallet.
function entryCovers(e, item) {
  if (Array.isArray(e.work)) return e.work.some((w) => w.action === "bytt" && workIsItem(w, item));
  if ((e.items || []).includes(item.id)) return true;
  return (e.parts || []).some((p) => nameMatchesItem(p, item));
}
// Har punkten berörts alls (bytt, fyllt på, rengjort eller kontrollerat)? Används för historiken.
function entryTouches(e, item) {
  if (Array.isArray(e.work)) return e.work.some((w) => workIsItem(w, item));
  return entryCovers(e, item);
}

// Delar som bara har skrivits i "Annat som byttes" (inte en underhållspunkt), en rad per del.
// Nyckeln är delens namn i gemener; namnet visas som det skrevs första gången, med stor bokstav.
function extraParts(c) {
  const items = c?.items || [];
  const map = new Map();
  for (const e of S.entries) {
    if (e.carId !== c.id || !["service", "eget"].includes(e.type)) continue;
    for (const w of workOf(e, c)) {
      if (w.itemId) continue;
      const key = normWord(w.name);
      if (!key || items.some((i) => nameMatchesItem(w.name, i))) continue;
      const x = map.get(key) || { key, name: w.name.trim().replace(/^./, (ch) => ch.toUpperCase()), entries: [] };
      if (!x.entries.includes(e)) x.entries.push(e);
      map.set(key, x);
    }
  }
  const list = [...map.values()];
  list.forEach((x) => {
    x.entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    x.lastAction = workOf(x.entries[0], c).find((w) => !w.itemId && normWord(w.name) === x.key)?.action || "bytt";
  });
  return list.sort((a, b) => (b.entries[0].date || "").localeCompare(a.entries[0].date || ""));
}
function entryDetail(e, c = car()) {
  const unit = /kWh/.test(e.fuel || "") ? "kWh" : "l";
  switch (e.type) {
    case "tank": {
      const bits = [];
      if (e.liters != null) bits.push(`${fmt(e.liters, 1)} ${unit} ${e.fuel || ""}`.trim());
      else if (e.fuel) bits.push(e.fuel);
      if (e.full) bits.push("fulltankad");
      if (e.pricePerL != null) bits.push(`${fmt(e.pricePerL, 2)} kr/${unit}`);
      if (e.station) bits.push(e.station);
      return bits.join(" · ");
    }
    case "matare": return "";
    case "service":
    case "eget": return workOf(e, c).map(workText).join(", ") || e.note || "";
    case "dack": {
      const bits = [];
      if (e.depth != null) bits.push(`${fmt(e.depth, 1)} mm`);
      if (e.note) bits.push(e.note);
      return bits.join(" · ");
    }
    case "tvatt": return [e.place, e.note].filter(Boolean).join(" · ");
    case "parkering": {
      const rule = e.recurringId ? (c?.recurring || []).find((x) => x.id === e.recurringId) : null;
      return [e.place, rule ? `återkommande, ${PERIODS[rule.period]?.toLowerCase()}` : "", e.note].filter(Boolean).join(" · ");
    }
    case "kostnad": return e.title && e.category ? e.category : e.note || "";
    default: return "";
  }
}

function activityText(e) {
  if (e._booking) return bookingActivity(e._booking);
  if (e._todo) return e._todo.to === uid() && e.createdBy !== uid() ? `${memberName(e.createdBy)} bad dig: ${e._todo.text}` : `${whoName(e.createdBy)} lade till att göra: ${e._todo.text}`;
  if (e._doc) return `${whoName(e.createdBy)} sparade dokumentet ${e._doc.title}`;
  const n = whoName(e.createdBy);
  const unit = /kWh/.test(e.fuel || "") ? "kWh" : "l";
  const kr = e.amount != null ? ` för ${fmtKr(e.amount)} kr` : "";
  switch (e.type) {
    case "tank": return `${n} tankade${e.liters != null ? ` ${fmt(e.liters, 1)} ${unit} ${e.fuel || ""}`.trimEnd() : e.fuel ? ` ${e.fuel}` : ""}${kr}`;
    case "matare": return `${n} uppdaterade mätarställningen till ${fmt(e.odometer)} mil`;
    case "service": return `${n} loggade service${e.workshop ? ` hos ${e.workshop}` : ""}${kr}`;
    case "eget": return e.title ? `${n} ${e.title.replace(/^./, (x) => x.toLowerCase())}${kr}` : `${n} loggade ett eget jobb${kr}`;
    case "dack": return `${n} ${TIRE_ACTIVITY[e.tireAction] || "loggade något om däcken"}${kr}`;
    case "tvatt": return `${n} tvättade bilen${e.place ? ` hos ${e.place}` : ""}${kr}`;
    case "parkering": return e.fine ? `${n} fick en p-bot${e.place ? ` vid ${e.place}` : ""}${kr}` : `${n} parkerade${e.place ? ` vid ${e.place}` : ""}${kr}`;
    case "kostnad": return `${n} lade till ${(e.title || e.category || "en kostnad").toLowerCase()}${kr}`;
    default: return `${n} loggade något`;
  }
}

function itemStatus(item, c, ents) {
  let last = null;
  for (const e of ents) {
    if (!entryCovers(e, item)) continue;
    if (!last || (e.date || "") > (last.date || "")) last = e;
  }
  let lastDate = last?.date ?? null;
  let lastMil = last?.odometer ?? null;
  // Saknar posten mätarställning används den som var loggad närmast före (eller samma dag), annars närmast efter.
  if (last && lastMil == null) {
    const odos = ents.filter((e) => e.odometer != null && e.date);
    const before = odos.filter((e) => e.date <= last.date).sort((a, b) => b.date.localeCompare(a.date) || b.odometer - a.odometer)[0];
    const after = odos.filter((e) => e.date > last.date).sort((a, b) => a.date.localeCompare(b.date) || a.odometer - b.odometer)[0];
    lastMil = (before || after)?.odometer ?? null;
  }
  if (item.baseDate && (!lastDate || item.baseDate > lastDate)) { lastDate = item.baseDate; lastMil = item.baseMil ?? null; }
  if (!last && item.baseMil != null) lastMil = item.baseMil;
  if (!last && !item.baseDate && item.baseMil == null) return { item, unknown: true, level: "none" };

  // Utan känd mätarställning går det inte att räkna mil kvar, bara tid.
  const odo = odoOf(c);
  let remMil = null, remDays = null, dueDate = null;
  if (item.mil && lastMil != null && odo != null) remMil = lastMil + item.mil - odo;
  if (item.months && lastDate) { dueDate = addMonths(parseDate(lastDate), item.months); remDays = daysUntil(dueDate); }
  const fr = [];
  if (remMil != null) fr.push({ f: remMil / item.mil, kind: "mil" });
  if (remDays != null) fr.push({ f: remDays / (item.months * 30.44), kind: "days" });
  // Utan intervall går det inte att räkna ut nästa byte, men senaste bytet visas ändå.
  if (!item.mil && !item.months && lastDate) return { item, unknown: true, noInterval: true, level: "none", label: "Inget intervall", last, lastDate, lastMil };
  if (!fr.length) return { item, unknown: true, noOdo: odo == null && !!item.mil && lastMil != null, level: "none", last, lastDate, lastMil };
  fr.sort((a, b) => a.f - b.f);
  const frac = fr[0].f;
  const by = fr[0].kind;
  let level = "ok";
  if (frac < 0) level = "urgent";
  else if (frac < 0.12 || (remMil != null && remMil < 300) || (remDays != null && remDays < 45)) level = "soon";
  // Kvar till nästa byte, eller hur mycket det har gått över.
  const label = frac < 0
    ? (by === "mil" ? `${fmt(-remMil)} mil över` : `${daysText(-remDays)} över`)
    : by === "mil" ? `${fmt(remMil)} mil kvar` : `${daysText(remDays)} kvar`;
  return { item, last, lastDate, lastMil, remMil, remDays, dueDate, frac, by, level, label };
}

function allItemStatus(c = car()) {
  const ents = carEntries();
  return (c?.items || []).map((i) => itemStatus(i, c, ents));
}

function primaryService(c) {
  const st = allItemStatus(c);
  return st.find((s) => s.item.id === "olja") || st.find((s) => s.item.mil) || null;
}

// Hur många mil om dagen bilen körs, räknat på mätarställningarna det senaste året. Null om det inte går att räkna.
function milPerDay(c) {
  const since = ymd(addMonths(today0(), -12));
  const pts = S.entries.filter((e) => e.carId === c.id && e.odometer != null && (e.date || "") >= since)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const days = (parseDate(last.date) - parseDate(first.date)) / 864e5;
  const mil = last.odometer - first.odometer;
  return days >= 14 && mil > 0 ? mil / days : null;
}

// Förslag på nästa sista dag för besiktning, räknat från dagen bilen besiktigades.
// Personbil: första gången senast 3 år efter att den togs i trafik, sedan 2 år, därefter var 14:e månad.
// Årsmodellen används som ungefärligt år i trafik. Datumet går alltid att ändra.
// Förslaget visas bara om det ligger framåt i tiden. För en gammal besiktning lämnas rutan tom,
// så att den riktiga sista dagen inte skrivs över av ett datum som redan har passerat.
function suggestNextInspection(dateStr, c) {
  const next = nextInspectionDate(dateStr, c);
  return next && next >= todayStr() ? next : "";
}

function nextInspectionDate(dateStr, c) {
  const d = parseDate(dateStr);
  if (!d) return "";
  const year = Number(c?.year);
  const age = year > 1900 ? d.getFullYear() - year : 99;
  const months = age <= 3 ? 24 : 14;
  const y = d.getFullYear(), m = d.getMonth() + months;
  // Samma dag i månaden, eller sista dagen om månaden är kortare (31 jan + 14 mån = 31 mars, 30 nov → 28 feb).
  const last = new Date(y, m + 1, 0).getDate();
  return ymd(new Date(y, m, Math.min(d.getDate(), last)));
}

// Fordonsskatten betalas i en månad som styrs av sista siffran i registreringsnumret
// (slutar skylten på en bokstav gäller siffran före). Värden: månad 1–12.
const TAX_MONTH_BY_DIGIT = { 0: 3, 1: 4, 2: 5, 3: 6, 4: 8, 5: 10, 6: 11, 7: 12, 8: 1, 9: 2 };
function plateTaxMonth(plate) {
  const digits = String(plate || "").replace(/[^0-9]/g, "");
  return digits ? TAX_MONTH_BY_DIGIT[digits[digits.length - 1]] : null;
}
// Månaden som gäller: vald för hand, annars från registreringsnumret. "av" betyder ingen påminnelse.
function taxMonth(c) {
  if (c?.skattManad === "av") return null;
  return Number(c?.skattManad) || plateTaxMonth(c?.plate) || null;
}

// Senaste tvätten, för raden "Senast tvättad" under Bilen → Uppgifter. Ingen påminnelse.
function levelFromDays(d) {
  if (d == null) return "ok";
  if (d < 0) return "urgent";
  if (d < 30) return "urgent";
  if (d < 90) return "soon";
  return "ok";
}

function tireDeadline(c) {
  const t = today0(), y = t.getFullYear();
  const on = c.tiresOn || "sommar";
  const winter = (c.tires || []).find((s) => s.kind === "vinter");
  const studded = !!winter?.studded;
  if (on === "sommar") {
    const oct1 = new Date(y, 9, 1), dec1 = new Date(y, 11, 1), apr1 = new Date(y, 3, 1);
    if (t >= oct1 && t < dec1) return { key: "dack", date: dec1, calTitle: "Vinterdäck ska vara på", icon: "tire", title: "Vinterdäck på", sub: "Senast 1 december · sommardäck sitter på", days: daysUntil(dec1) };
    if (t >= dec1 || t < apr1) return { icon: "tire", title: "Vinterdäck på", sub: "Krävs vid vinterväglag 1 december–31 mars", days: -1, label: "Nu", level: "urgent" };
    // Sommardäcken sitter på och det är inte dags att byta: ingen rad (vilka däck som sitter på syns under Bilen → Däck).
    return null;
  }
  const mar15 = new Date(y, 2, 15), apr15 = new Date(y, 3, 15), oct1 = new Date(y, 9, 1);
  if (t > apr15 && t < oct1) {
    return studded
      ? { icon: "tire", title: "Dubbdäck av", sub: "Skulle av senast 15 april", days: -1, label: "Nu", level: "urgent" }
      : { icon: "tire", title: "Sommardäck på", sub: "Vinterdäcken sitter fortfarande på", days: 0, label: "Dags", level: "soon" };
  }
  if (t >= mar15 && t <= apr15) {
    return { key: "dack", date: apr15, calTitle: studded ? "Dubbdäcken ska vara av" : "Dags för sommardäck", icon: "tire", title: "Sommardäck på", sub: studded ? "Dubbdäck av senast 15 april" : "Byt när vårvädret är stabilt", days: daysUntil(apr15) };
  }
  // Vinterdäcken sitter på och det är inte dags att byta: ingen rad.
  return null;
}

function deadlines(c) {
  const out = [tireDeadline(c)].filter(Boolean);
  // Sista dagen för besiktning. Är en tid redan bokad (före sista dagen) syns den i bokningen i stället.
  const booked = (c.bookings || []).some((b) => b.kind === "besiktning" && b.date >= todayStr() && (!c.besiktning || b.date <= c.besiktning));
  if (c.besiktning && !booked) {
    const d = parseDate(c.besiktning);
    out.push({ key: "besiktning", date: d, calTitle: "Sista dag för besiktning", icon: "check", title: "Sista dag för besiktning", sub: [`Senast ${fmtDate(d)}`, c.besiktningPlats].filter(Boolean).join(" · "), place: c.besiktningPlats || null, days: daysUntil(d) });
  }
  if (c.forsakringDatum) {
    const d = parseDate(c.forsakringDatum);
    out.push({ key: "forsakring", date: d, calTitle: `Försäkringen förnyas${c.forsakringBolag ? ` (${c.forsakringBolag})` : ""}`, icon: "calendar", title: "Försäkring förnyas", sub: [fmtDate(d), c.forsakringBolag].filter(Boolean).join(" · "), days: daysUntil(d) });
  }
  if (taxMonth(c)) {
    const t = today0();
    // Över 3 600 kr per år betalas skatten tre gånger: var fjärde månad från grundmånaden.
    const three = c.skattBelopp > 3600;
    const base = taxMonth(c) - 1;
    const months = three ? [base, (base + 4) % 12, (base + 8) % 12] : [base];
    const next = months.map((m) => (m >= t.getMonth() ? new Date(t.getFullYear(), m, 1) : new Date(t.getFullYear() + 1, m, 1))).sort((a, b) => a - b)[0];
    const m = next.getMonth();
    const days = t.getMonth() === m ? 0 : daysUntil(next);
    const amount = c.skattBelopp ? (three ? Math.round(c.skattBelopp / 3) : c.skattBelopp) : null;
    const sub = `Betalas i ${MONTHS[m]}${amount ? ` · ${fmt(amount)} kr` : ""}${three ? " · en av tre gånger per år" : ""}`;
    out.push({ key: "skatt", date: next, calTitle: `Fordonsskatt ska betalas${amount ? ` (${fmt(amount)} kr)` : ""}`, icon: "receipt", title: "Fordonsskatt", sub, days, label: days === 0 ? "Denna månad" : undefined });
  }
  for (const x of out) {
    if (!x.level) x.level = levelFromDays(x.days);
    if (!x.label) x.label = x.days == null ? "Klart" : daysText(x.days);
    // Datum som ligger framåt i tiden går att trycka på för att lägga in i kalendern.
    if (x.key && x.date && daysUntil(x.date) >= 0) { x.act = "open-deadline"; x.id = x.key; }
  }
  return out.sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));
}

/* Bokade tider (service, besiktning m.m.) sparas som en lista på bilen. */
// Kort form i listorna: "Fre 13 nov 09:00". Lång form annars: "Fredag 13 november kl 09:00".
function bookingWhen(b, short = false) {
  const d = parseDate(b.date);
  if (!d) return "";
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  if (short) return `${["Sön", "Mån", "Tis", "Ons", "Tors", "Fre", "Lör"][d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()].toLowerCase()}${year}${b.time ? ` ${b.time}` : ""}`;
  return `${WEEKDAYS[d.getDay()].replace(/^./, (x) => x.toUpperCase())} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}${b.time ? ` kl ${b.time}` : ""}`;
}
function sortedBookings(c) {
  return [...(c?.bookings || [])].sort((a, b) => `${a.date}${a.time || ""}`.localeCompare(`${b.date}${b.time || ""}`));
}
function bookingRows(c) {
  return sortedBookings(c).map((b) => {
    const days = daysUntil(parseDate(b.date));
    const kind = BOOK_KINDS[b.kind] || "Bokning";
    const past = days < 0;
    // En bokad besiktning efter sista dagen är för sent: visa det tydligt.
    const late = b.kind === "besiktning" && c.besiktning && b.date > c.besiktning;
    const lastDay = b.kind === "besiktning" && c.besiktning && !past ? (late ? `efter sista dagen ${fmtDateShort(c.besiktning)}!` : b.date === c.besiktning ? "sista dagen" : `sista dag ${fmtDateShort(c.besiktning)}`) : null;
    return {
      icon: "calendar",
      title: past ? `${kind}: blev det gjort?` : `${kind} bokad`,
      short: past ? null : kind,
      when: bookingWhen(b, true),
      // Uppe till höger på smala kolumner: "I morgon 09:00" eller "15 dec 13:00" (veckodagen får inte plats).
      whenShort: days === 0 || days === 1 ? `${days === 0 ? "I dag" : "I morgon"}${b.time ? ` ${b.time}` : ""}` : bookingWhen(b, true).replace(/^\S+ /, ""),
      relDay: days === 0 || days === 1,
      // På gång: rubriken över posten ("I morgon", "Om 33 dagar · 15 dec") och en kort titel ("Service kl 09:00").
      // Datumet står i brickan till vänster, så rubriken visar bara hur långt det är kvar.
      group: (past ? "Passerat" : days === 0 ? "I dag" : days === 1 ? "I morgon" : `Om ${daysText(days)}`) + (lastDay === "sista dagen" ? " · sista dagen" : ""),
      kollSub: [b.place, lastDay === "sista dagen" ? null : lastDay].filter(Boolean).join(" · "),
      tileDate: b.date,
      kollTitle: past ? `${kind}: blev det gjort?` : `${kind}${b.time ? ` kl ${b.time}` : ""}`,
      mapId: !past && (b.lat != null || b.addr || b.place) ? b.id : null,
      phone: !past && b.phone ? String(b.phone).replace(/[^\d+]/g, "") : null,
      sub: [b.place, lastDay].filter(Boolean).join(" · "),
      days,
      level: past || late || days <= 1 ? "urgent" : days <= 7 ? "soon" : "ok",
      label: past ? "Logga" : days === 0 ? "I dag" : days === 1 ? "I morgon" : daysText(days),
      act: "open-booking",
      id: b.id,
      quick: past ? "" : [
        b.lat != null || b.addr || b.place ? `<button class="chip-btn" type="button" data-act="map-directions" data-id="${esc(b.id)}">${icon("pin", 14)} Vägbeskrivning</button>` : "",
        b.phone ? `<a class="chip-btn" href="tel:${esc(String(b.phone).replace(/[^\d+]/g, ""))}">${icon("phone", 14)} Ring</a>` : "",
      ].join(""),
    };
  });
}

function catOf(e) {
  if (e.type === "tank") return "Bränsle";
  if (e.type === "service" || e.type === "eget") return "Service och reparationer";
  if (e.type === "dack") return "Däck";
  // Tvättar som loggats som kostnad förr hamnar också under Tvätt.
  if (e.type === "tvatt" || e.category === "Tvätt") return "Tvätt";
  // P-böter visas för sig, så att de inte döljs bland vanliga parkeringar.
  if (e.type === "parkering") return e.fine ? "P-böter" : "Parkering";
  if (e.category === "Parkering") return "Parkering";
  if (e.category === "Skatt" || e.category === "Besiktning") return "Skatt och besiktning";
  if (e.category === "Försäkring") return "Försäkring";
  return "Övrigt";
}
const CAT_ICON = { "Bränsle": "fuel", "Service och reparationer": "wrench", "Däck": "tire", "Skatt och besiktning": "check", "Försäkring": "doc", "Tvätt": "wash", "Parkering": "parking", "P-böter": "parking", "Övrigt": "receipt" };

function economy(ents, months = 12) {
  const since = addMonths(today0(), -months);
  const inPeriod = ents.filter((e) => parseDate(e.date) >= since);
  const paid = inPeriod.filter((e) => e.amount > 0);
  const cats = {}, catCount = {};
  let total = 0;
  for (const e of paid) { const k = catOf(e); cats[k] = (cats[k] || 0) + e.amount; catCount[k] = (catCount[k] || 0) + 1; total += e.amount; }
  const odos = inPeriod.filter((e) => e.odometer != null).map((e) => e.odometer);
  const driven = odos.length >= 2 ? Math.max(...odos) - Math.min(...odos) : null;
  let monthsSpan = 1;
  if (inPeriod.length) {
    const first = inPeriod.reduce((m, e) => (e.date < m ? e.date : m), inPeriod[0].date);
    const f = parseDate(first), t = new Date();
    monthsSpan = Math.max(1, Math.min(months, (t.getFullYear() - f.getFullYear()) * 12 + t.getMonth() - f.getMonth() + 1));
  }
  const bars = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const sum = ents.filter((e) => (e.date || "").startsWith(key) && e.amount > 0).reduce((s, e) => s + e.amount, 0);
    bars.push({ label: MONTHS_SHORT[d.getMonth()], sum, now: i === 0 });
  }
  const thisMonth = bars[5].sum, lastMonth = bars[4].sum;
  return { total, cats, catCount, driven, perMonth: total / monthsSpan, perMil: driven ? total / driven : null, bars, thisMonth, lastMonth, count: paid.length };
}

function tipsFor(c) {
  const m = new Date().getMonth() + 1;
  const p = profileFor(c);
  const list = [...(p ? p.tips : []), ...GENERIC_TIPS];
  if (!p && isFlex(c)) list.unshift({ sev: "mid", when: (mm) => mm >= 10 || mm <= 2, title: "E85 i kyla", text: "Etanol startar sämre när det är kallt. Använd motorvärmare och tanka bensin när det är riktigt kallt." });
  const rank = { high: 0, mid: 1, low: 2 };
  // Bilens egna tips först, sedan de viktigaste. Batteritipset passar inte elbilar, de har sitt eget.
  const fits = list.filter((t) => (!t.when || t.when(m)) && (!t.flex || isFlex(c)) && (!t.fit || t.fit(c)) && !(t.title === "Batteriet inför vintern" && (isElectric(c) || isHybrid(c))));
  const own = p ? fits.filter((t) => p.tips.includes(t)) : [];
  const rest = fits.filter((t) => !own.includes(t)).sort((a, b) => rank[a.sev] - rank[b.sev]);
  return [...own, ...rest].slice(0, 5);
}

function claudePrompt(c) {
  const st = allItemStatus(c);
  const ents = carEntries();
  const lastService = ents.find((e) => e.type === "service");
  const lines = [];
  lines.push(`Jag har en ${[c.make, c.model, c.engine].filter(Boolean).join(" ")}${c.fuel ? ` (${c.fuel.toLowerCase()})` : ""}${c.year ? ` från ${c.year}` : ""}. Mätarställning: ${fmt(odoOf(c))} mil.`);
  if (lastService) lines.push(`Senaste service: ${fmtDate(lastService.date)}${lastService.odometer != null ? ` vid ${fmt(lastService.odometer)} mil` : ""}: ${entryDetail(lastService, c) || "inga detaljer"}.`);
  const known = st.filter((s) => !s.unknown);
  if (known.length) {
    lines.push("Underhåll enligt min logg:");
    for (const s of known) lines.push(`- ${s.item.name}: senast ${s.lastDate ? fmtDate(s.lastDate) : "okänt datum"}${s.lastMil != null ? `, vid ${fmt(s.lastMil)} mil` : ""}.`);
  }
  const unknown = st.filter((s) => s.unknown).map((s) => s.item.name.toLowerCase());
  if (unknown.length) lines.push(`Jag vet inte när detta gjordes senast: ${unknown.join(", ")}.`);
  const own = ents.filter((e) => e.type === "eget").slice(0, 5);
  if (own.length) lines.push(`Saker vi gjort själva nyligen: ${own.map((e) => `${e.title || "eget jobb"} (${fmtDateShort(e.date)})`).join("; ")}.`);
  lines.push("Vad bör jag hålla extra koll på med just den här bilen, och vad är det snart dags att byta eller kontrollera? Svara kort och konkret på svenska.");
  return lines.join("\n");
}

/* -------------------------------------------------------------- rendering */

const app = $("#app");
const nav = $("#nav");

function setScreen(key, html, { showNav = false, keepForm = false } = {}) {
  // Rita inte om sidan medan någon skriver i ett formulär, men annars ja.
  if (keepForm && S.screen === key) {
    const busy = [...app.querySelectorAll("form[data-keep]")].some((f) => f.dataset.dirty === "1" || f.contains(document.activeElement));
    if (busy) return;
  }
  // Behåll sidledsscrollen i filter- och bilraderna när sidan ritas om.
  const keepScroll = {};
  if (S.screen === key) app.querySelectorAll(".filters, .car-chips").forEach((el) => { keepScroll[el.classList[0]] = el.scrollLeft; });
  // Behåll fokus och markören i ett fält (till exempel sökfältet) om sidan ritas om medan man skriver.
  const active = app.contains(document.activeElement) && document.activeElement.id ? document.activeElement : null;
  const caret = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  S.screen = key;
  // Vilken vy som visas, så att datorlayouten kan ordna korten olika per vy.
  app.dataset.screen = key;
  app.innerHTML = html;
  arrangeColumns();
  addHideButtons();
  if (active) {
    const again = document.getElementById(active.id);
    if (again && again !== active) {
      again.focus({ preventScroll: true });
      try { if (caret) again.setSelectionRange(caret[0], caret[1]); } catch { /* fältet stödjer inte markör */ }
    }
  }
  app.querySelectorAll(".filters, .car-chips").forEach((el) => {
    if (keepScroll[el.classList[0]] != null) el.scrollLeft = keepScroll[el.classList[0]];
    const sel = el.querySelector('[aria-pressed="true"]');
    if (sel) {
      const r = sel.getBoundingClientRect(), box = el.getBoundingClientRect();
      if (r.right > box.right || r.left < box.left) el.scrollLeft += r.left - box.left - (box.width - r.width) / 2;
    }
    markMore(el);
  });
  app.classList.toggle("no-nav", !showNav);
  nav.hidden = !showNav;
  if (showNav) {
    nav.querySelectorAll(".tab").forEach((t) => {
      if (t.dataset.go === S.view) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
  }
}

// På breda skärmar (surfplatta, dator och telefon på tvären) läggs korten i två kolumner.
// Varje kort hamnar i den kolumn som är kortast, så att det inte blir tomma glapp.
const COLUMN_SCREENS = ["view-oversikt", "view-ekonomi", "view-bilen", "view-installningar"];
function arrangeColumns() {
  if (!COLUMN_SCREENS.includes(app.dataset.screen) || !window.matchMedia("(min-width: 760px)").matches) return;
  const kids = [...app.children];
  const full = kids.filter((k) => k.matches(".top, .car-chips, .card.toast, p.hint"));
  const cards = kids.filter((k) => !full.includes(k));
  if (cards.length < 2) return;
  const grid = document.createElement("div");
  grid.className = "mgrid";
  grid.innerHTML = `<div class="mcol"></div><div class="mcol"></div>`;
  const [a, b] = grid.children;
  app.insertBefore(grid, cards[0]);
  for (const card of cards) (a.offsetHeight <= b.offsetHeight ? a : b).appendChild(card);
}
let columnsWide = window.matchMedia("(min-width: 760px)").matches;
// Bakgrundens färgtoning får skärmens verkliga mått, så att den fyller hela ytan även när telefonen vrids.
function sizeBackground() {
  document.documentElement.style.setProperty("--vh", window.innerHeight + "px");
  document.documentElement.style.setProperty("--vw", window.innerWidth + "px");
  // Telefon på tvären: kameraskåran sitter bara på ena sidan, så den andra sidan kan användas.
  const ang = typeof window.orientation === "number" ? window.orientation : (screen.orientation?.angle ?? 0);
  document.documentElement.dataset.notch = ang === 90 ? "left" : ang === -90 || ang === 270 ? "right" : "";
}
sizeBackground();
window.addEventListener("orientationchange", () => setTimeout(sizeBackground, 250));
window.addEventListener("resize", () => {
  sizeBackground();
  const wide = window.matchMedia("(min-width: 760px)").matches;
  if (columnsWide !== null && wide !== columnsWide) render();
  columnsWide = wide;
});

// Rader som går att svepa i sidled tonas ut i högerkanten så länge det finns mer att se.
function markMore(el) { el.classList.toggle("more", el.scrollWidth - el.clientWidth - el.scrollLeft > 4); }
document.addEventListener("scroll", (ev) => { if (ev.target.classList?.contains("filters") || ev.target.classList?.contains("car-chips")) markMore(ev.target); }, true);
window.addEventListener("resize", () => app.querySelectorAll(".filters, .car-chips").forEach(markMore));

// Bränslestapeln: dra upp och ner (eller använd piltangenterna). Sparas när man släpper.
function setFuelDraft(p) {
  p = Math.max(0, Math.min(100, Math.round(p)));
  S.fuelDraft = { carId: S.carId, pct: p };
  const bar = $("#fuel-v");
  if (!bar) return p;
  bar.classList.remove("unset");
  bar.querySelector("i").style.clipPath = `inset(0 ${100 - p}% 0 0 round 10px)`;
  bar.querySelector(".fuel-thumb").style.left = p + "%";
  const t = $("#fuel-pct");
  if (t) { t.textContent = `${p} %`; t.className = `fuel-pct ${pctClass(p)}`; }
  bar.setAttribute("aria-valuenow", p);
  bar.setAttribute("aria-valuetext", pctText(p));
  return p;
}
function saveFuel() {
  if (!S.fuelDraft) return;
  const p = S.fuelDraft.pct;
  const c = car();
  c.fuelLevel = { level: Math.round(p / 12.5), pct: p, by: uid(), at: Date.now(), via: "manual" };
  updateDoc(ref("cars", S.carId), { fuelLevel: { level: Math.round(p / 12.5), pct: p, by: uid(), at: serverTimestamp(), via: "manual" } }).catch(onWriteError);
  S.fuelDraft = null;
  render();
}
let fuelDrag = null;
document.addEventListener("pointerdown", (ev) => {
  const bar = ev.target.closest?.("#fuel-v");
  if (!bar) return;
  ev.preventDefault();
  fuelDrag = bar;
  try { bar.setPointerCapture(ev.pointerId); } catch { /* äldre webbläsare */ }
  const r = bar.getBoundingClientRect();
  setFuelDraft(((ev.clientX - r.left) / r.width) * 100);
});
document.addEventListener("pointermove", (ev) => {
  if (!fuelDrag) return;
  const r = fuelDrag.getBoundingClientRect();
  setFuelDraft(((ev.clientX - r.left) / r.width) * 100);
});
const endFuelDrag = () => { if (!fuelDrag) return; fuelDrag = null; saveFuel(); };
document.addEventListener("pointerup", endFuelDrag);
document.addEventListener("pointercancel", endFuelDrag);
document.addEventListener("keydown", (ev) => {
  if (ev.target.id !== "fuel-v") return;
  const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[ev.key];
  const to = ev.key === "Home" ? 0 : ev.key === "End" ? 100 : null;
  if (step == null && to == null) return;
  ev.preventDefault();
  const cur = S.fuelDraft?.pct ?? fuelPct(car()?.fuelLevel) ?? 50;
  setFuelDraft(to ?? cur + step);
  clearTimeout(window.__fuelKeyTimer);
  window.__fuelKeyTimer = setTimeout(() => { saveFuel(); $("#fuel-v")?.focus(); }, 700);
});

function render() {
  if (!S.user) return renderLogin();
  if (!S.hid) return;
  if (!S.loaded.house || !S.loaded.cars || !S.loaded.entries) {
    return setScreen("loading", `<p class="loading">Hämtar er bil …</p>`);
  }
  if (!S.cars.length) return renderCarSetup();
  const views = { oversikt: viewOverview, logg: viewLog, ekonomi: viewEconomy, bilen: viewCar, aviseringar: viewNotifications, installningar: viewSettings };
  const fn = views[S.view] || viewOverview;
  setScreen("view-" + S.view, fn(), { showNav: true, keepForm: true });
  // Antal nya aviseringar även i sidomenyn på datorn.
  const n = unseenFromOthers().length;
  const bell = nav.querySelector('[data-go="aviseringar"]');
  if (bell) {
    bell.querySelector(".badge")?.remove();
    if (n) bell.insertAdjacentHTML("beforeend", `<span class="badge">${n > 9 ? "9+" : n}</span>`);
    bell.setAttribute("aria-label", `Aviseringar${n ? `, ${n} nya` : ""}`);
  }
  ensureCarImage(car());
  // Under Bilen hämtas PDF-verktyget i förväg, så att serviceboken kan delas direkt med ett tryck.
  if (S.view === "bilen" && !pdfReady()) setTimeout(() => loadPdfLibs().catch(() => {}), 800);
  runLaunchAction();
}

function renderLogin(error = "") {
  // Välkomstsidan: logotyp, bild, rubrik och inloggning.
  setScreen("login", `
    <section class="login">
      <h1 class="login-brand"><img class="login-logo" src="icons/logo.png" alt="Bildagboken" width="900" height="244"></h1>
      <img class="login-art" src="icons/welcome.webp" alt="" width="702" height="697">
      <h2 class="login-title">Håll koll på bilen,<br>tillsammans.</h2>
      <p class="login-sub">Tankning, service, däck, datum och kostnader. Alla ni som delar bilen ser samma sak.</p>
      <button class="btn apple block" type="button" data-act="login" data-provider="apple">${icon("apple", 20)} Logga in med Apple</button>
      <button class="btn google block" type="button" data-act="login" data-provider="google">${icon("google", 20)} Logga in med Google</button>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <p class="hint" style="text-align:center">Har du fått en inbjudan? Logga in först, sedan skriver du in koden.</p>
    </section>`);
}

function renderOnboarding(error = "") {
  const join = new URLSearchParams(location.search).get("join") || "";
  const first = (S.user.displayName || "").split(" ")[0];
  const code = join.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code) loadJoinInfo(code);
  const invited = code && joinInfo?.code === code ? joinInfo.name : null;
  const joinForm = `<form class="card form" data-form="join-house" data-keep>
      <h2>${invited ? `Du är inbjuden till ${esc(invited)}` : "Gå med i en befintlig"}</h2>
      ${invited ? `<p class="muted">Skriv ditt namn så ser de andra vem som loggar. Koden är redan ifylld.</p>` : ""}
      <label class="field"><span>Ditt namn</span><input name="name" id="ob-name2" required maxlength="30" value="${esc(first)}" autocomplete="given-name"></label>
      <label class="field"><span>Inbjudningskod</span><input name="code" id="ob-code" required maxlength="8" value="${esc(join)}" autocapitalize="characters" autocomplete="off" placeholder="Sex tecken" style="text-transform:uppercase;letter-spacing:.12em"></label>
      <button class="btn primary block" type="submit">${invited ? `Gå med i ${esc(invited)}` : "Gå med"}</button>
    </form>`;
  setScreen("onboarding", `
    <header class="top"><div class="hello"><small>Välkommen</small><h1>Kom igång</h1></div></header>
    ${code ? joinForm : ""}
    <form class="card form" data-form="create-house" data-keep>
      <h2>Starta en ny bildagbok</h2>
      <label class="field"><span>Ditt namn</span><input name="name" id="ob-name" required maxlength="30" value="${esc(first)}" autocomplete="given-name"></label>
      <label class="field"><span>Vad heter hushållet?</span><input name="house" id="ob-house" maxlength="40" placeholder="Till exempel Familjen Andersson"></label>
      <button class="btn primary block" type="submit">Skapa</button>
      <p class="hint">Sedan kan du bjuda in andra med en kod, till exempel familj eller den du delar bil med.</p>
    </form>
    ${code ? "" : joinForm}
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <button class="link" type="button" data-act="logout" style="align-self:center">Logga ut (${esc(S.user.email || "")})</button>`);
  if (join && !window.matchMedia("(pointer: coarse)").matches) $("#ob-code")?.focus();
}

// Formuläret för bilen är uppdelat i delar, så att varje "Ändra" bara visar sin egen del.
const CAR_SECTIONS = {
  basic: "Uppgifter om bilen",
  photo: "Bild på bilen",
  dates: "Besiktning, försäkring och skatt",
  tires: "Däck",
  specs: "Anteckningar",
};
function carFormFields(c = {}, { sections = ["basic"], isNew = false } = {}) {
  const sel = (name, opts, val) => `<select name="${name}" id="cf-${name}">${opts.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}"${String(val ?? "") === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  }).join("")}</select>`;
  const inp = (name, label, val, attrs = "") => `<label class="field"><span>${label}</span><input name="${name}" id="cf-${name}" value="${esc(val ?? "")}" ${attrs}></label>`;
  const summer = (c.tires || []).find((t) => t.kind === "sommar") || {};
  const winter = (c.tires || []).find((t) => t.kind === "vinter") || {};
  const head = (k) => (sections.length > 1 ? `<p class="section-t">${CAR_SECTIONS[k]}</p>` : "");
  const parts = {};
  parts.basic = `
    <div class="row2">
      ${inp("make", "Märke", c.make, 'required placeholder="Till exempel Volvo"')}
      ${inp("model", "Modell", c.model, 'required placeholder="Till exempel V50"')}
    </div>
    <div class="row2">
      ${inp("year", "Årsmodell", c.year, 'inputmode="numeric" placeholder="Till exempel 2007"')}
      ${inp("engine", "Motor", c.engine, 'placeholder="Till exempel 1.8F"')}
    </div>
    <label class="field"><span>Drivmedel</span>${sel("fuel", FUELS, c.fuel || "Bensin")}</label>
    <div class="row2">
      ${inp("color", "Färg", c.color, 'placeholder="Till exempel svart"')}
      ${inp("plate", "Registreringsnummer", c.plate, 'placeholder="Till exempel ABC 123" autocapitalize="characters"')}
    </div>
    ${isNew
      ? inp("odometer", "Mätarställning (mil)", "", 'inputmode="numeric" placeholder="Till exempel 21 480"')
      : `<div class="field"><span>Mätarställning</span>
          <div class="odo-row"><b>${odoOf(c) != null ? `${fmt(odoOf(c))} mil` : "Inte angiven"}</b>
          <button class="btn-soft" type="button" data-act="odo-from-car">Uppdatera</button></div>
          <small>Hämtas från loggen. Har någon skrivit fel, ändra eller ta bort den posten i loggen.</small></div>`}`;
  parts.photo = `
    <label class="photo-in">${icon("image", 22)}<span id="photo-label">${c.photoId ? "Eget foto används. Välj ett nytt för att byta." : "Ta eller välj ett eget foto på bilen"}</span><input type="file" name="carPhoto" id="cf-carPhoto" accept="image/*"></label>
    ${c.photoId ? `<label class="check"><input type="checkbox" name="removePhoto" id="cf-removePhoto"> Ta bort eget foto och använd bild från Wikipedia</label>`
      : `<p class="hint">Utan eget foto hämtas en bild på modellen från Wikipedia.</p>`}`;
  parts.dates = `
    <div class="row2">
      ${inp("besiktning", "Sista dag för besiktning", c.besiktning, 'type="date"')}
      ${inp("besiktningPlats", "Besiktningsstation", c.besiktningPlats, 'placeholder="Till exempel Bilprovningen Kungsbacka"')}
    </div>
    <div class="row2">
      ${inp("forsakringBolag", "Försäkringsbolag", c.forsakringBolag, 'placeholder="Till exempel If eller Folksam"')}
      ${inp("forsakringDatum", "Försäkringen förnyas", c.forsakringDatum, 'type="date"')}
    </div>
    <div class="row2">
      <label class="field"><span>Skatt betalas i</span>${sel("skattManad", [
        ["", plateTaxMonth(c.plate) ? `Efter reg.nr: ${MONTHS[plateTaxMonth(c.plate) - 1]}` : "Vet inte"],
        ...MONTHS.map((m, i) => [String(i + 1), m]),
        ["av", "Ingen påminnelse"],
      ], c.skattManad || "")}</label>
      ${inp("skattBelopp", "Skatt per år (kr)", c.skattBelopp, 'inputmode="numeric"')}
    </div>
    <p class="hint">Månaden räknas ut från sista siffran i registreringsnumret. Välj en annan om den inte stämmer. Över 3 600 kr per år betalas skatten tre gånger.</p>`;
  // Varje däcksats får en egen rubrik, och tomma rutor står tomma (inga exempelvärden som ser ifyllda ut).
  const tireHead = (k, label) => `<p class="tire-head" data-tire="${k}">${label}<span class="tire-on"${(c.tiresOn || "sommar") === k ? "" : " hidden"}> · sitter på</span></p>`;
  parts.tires = `
    <label class="field"><span>Det här sitter på nu</span>${sel("tiresOn", [["sommar", "Sommardäck"], ["vinter", "Vinterdäck"]], c.tiresOn || "sommar")}</label>
    ${tireHead("sommar", "Sommardäck")}
    <div class="row2">
      ${inp("s_brand", "Märke", summer.brand)}
      ${inp("s_size", "Dimension", summer.size, 'autocomplete="off"')}
    </div>
    <div class="row2">
      ${inp("s_year", "Tillverkningsår", summer.year, 'inputmode="numeric" autocomplete="off"')}
      ${inp("s_depth", "Mönsterdjup (mm)", summer.depth, 'inputmode="decimal" autocomplete="off"')}
    </div>
    <div class="row2">
      ${inp("s_pf", "Lufttryck fram (bar)", summer.pressureFront != null ? fmt(summer.pressureFront, 1) : "", 'inputmode="decimal" autocomplete="off"')}
      ${inp("s_pr", "Lufttryck bak (bar)", summer.pressureRear != null ? fmt(summer.pressureRear, 1) : "", 'inputmode="decimal" autocomplete="off"')}
    </div>
    ${tireHead("vinter", "Vinterdäck")}
    <div class="row2">
      ${inp("w_brand", "Märke", winter.brand)}
      ${inp("w_size", "Dimension", winter.size, 'autocomplete="off"')}
    </div>
    <div class="row2">
      ${inp("w_year", "Tillverkningsår", winter.year, 'inputmode="numeric" autocomplete="off"')}
      ${inp("w_depth", "Mönsterdjup (mm)", winter.depth, 'inputmode="decimal" autocomplete="off"')}
    </div>
    <div class="row2">
      ${inp("w_pf", "Lufttryck fram (bar)", winter.pressureFront != null ? fmt(winter.pressureFront, 1) : "", 'inputmode="decimal" autocomplete="off"')}
      ${inp("w_pr", "Lufttryck bak (bar)", winter.pressureRear != null ? fmt(winter.pressureRear, 1) : "", 'inputmode="decimal" autocomplete="off"')}
    </div>
    <label class="check"><input type="checkbox" name="w_studded" id="cf-w_studded"${winter.studded ? " checked" : ""}> Vinterdäcken är dubbade</label>
    <p class="hint">Dimensionen står på däckets sida, till exempel 205/55 R16. Rätt lufttryck står oftast på en dekal i förardörren eller i tanklocket. Sommar- och vinterdäcken sparas var för sig.</p>`;
  parts.specs = `
    <label class="field"><span>Anteckningar om bilen</span><textarea name="specsText" id="cf-specsText" rows="9">${esc(c.specsText ?? SPEC_TEMPLATE)}</textarea></label>
    <p class="hint">Skriv fritt. Rader som "Motorolja: 5W-30" visas som rutor, så har ni oljetyp, däckdimension och liknande till hands i butiken.</p>`;
  return sections.map((k) => head(k) + parts[k]).join("");
}

function renderCarSetup() {
  setScreen("car-setup", `
    <header class="top"><div class="hello"><small>Ett sista steg</small><h1>Lägg till er bil</h1></div></header>
    <form class="card form" data-form="car-new" data-keep>
      ${carFormFields({}, { sections: ["basic"], isNew: true })}
      <button class="btn primary block" type="submit">Spara bilen</button>
      <p class="hint">Datum för besiktning, försäkring och däck lägger du till under Bilen efteråt.</p>
    </form>
    ${inviteCard()}`, { keepForm: true });
}

function carSvg(c) {
  const colors = { svart: "#1d1c1b", vit: "#ecebe7", silver: "#a7abae", "grå": "#77797b", gra: "#77797b", "röd": "#8e2020", rod: "#8e2020", "blå": "#24406b", bla: "#24406b", "grön": "#2f4b3c", gron: "#2f4b3c", beige: "#c9b79c", brun: "#5a4030", gul: "#d9a929", orange: "#d96a1f" };
  const key = Object.keys(colors).find((k) => (c.color || "").toLowerCase().includes(k));
  const body = key ? colors[key] : "#4a4744";
  return `<svg class="car" viewBox="0 0 320 112" role="img" aria-label="${esc([c.color, c.make, c.model].filter(Boolean).join(" "))} från sidan">
    <ellipse cx="160" cy="104" rx="140" ry="5" fill="var(--ink)" opacity=".12"/>
    <path fill="${body}" d="M12 80c0-9 5-15 18-17l50-6c13-12 28-21 48-25 10-2 22-3 36-3h70c12 0 20 2 26 8l22 21c10 2 16 7 16 15v8c0 4-3 6-7 6h-10a27 27 0 0 0-54 0H106a27 27 0 0 0-54 0H22c-6 0-10-3-10-8Z"/>
    <path fill="var(--car-glass)" d="M88 57c12-11 25-18 40-21 6-1 14-2 22-2l4 23Z"/>
    <path fill="var(--car-glass)" d="M160 34h46l2 23h-44Z"/>
    <path fill="var(--car-glass)" d="M213 34h22c8 0 13 2 17 6l16 17h-53Z"/>
    <path d="M70 69h228" stroke="#fff" stroke-opacity=".14" stroke-width="1.5"/>
    <rect x="294" y="62" width="9" height="12" rx="2" fill="#E77026" opacity=".9"/>
    <rect x="14" y="66" width="10" height="6" rx="2" fill="#f3efe6" opacity=".9"/>
    <circle cx="79" cy="88" r="21" fill="#141414"/><circle cx="79" cy="88" r="12" fill="#6f6f6f"/><circle cx="79" cy="88" r="4" fill="#2a2a2a"/>
    <circle cx="257" cy="88" r="21" fill="#141414"/><circle cx="257" cy="88" r="12" fill="#6f6f6f"/><circle cx="257" cy="88" r="4" fill="#2a2a2a"/>
  </svg>`;
}

/* Bild på bilen: eget foto om det finns, annars bild från Wikipedia, annars ritad siluett. */
const photoCache = {};
const photoPending = {};
// Bilens foto sparas också i telefonen, så att det syns direkt när appen startar.
const carPhotoKey = (id) => "carphoto." + id;
function rememberCarPhoto(id, data) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith("bildagboken.carphoto.") && k !== "bildagboken." + carPhotoKey(id)) localStorage.removeItem(k); }
    if (data) pref.set(carPhotoKey(id), data);
  } catch { /* fullt eller avstängt: då hämtas fotot som vanligt */ }
}
function loadPhoto(id) {
  if (photoCache[id] || photoPending[id] || !S.hid) return;
  const saved = pref.get(carPhotoKey(id));
  if (saved) { photoCache[id] = saved; return; }
  photoPending[id] = true;
  getDoc(ref("photos", id)).then((s) => {
    photoCache[id] = s.exists() ? s.data().data : "";
    if (photoCache[id] && S.cars.some((c) => c.photoId === id)) rememberCarPhoto(id, photoCache[id]);
    render();
  }).catch(() => {}).finally(() => { delete photoPending[id]; });
}

const imageLookups = {};
async function ensureCarImage(c) {
  if (!c || c.photoId || !c.make || !c.model || !navigator.onLine) return;
  const key = `v2|${c.make}|${c.model}`.toLowerCase();
  if (c.imageChecked === key || imageLookups[c.id] === key) return;
  imageLookups[c.id] = key;
  const title = `${c.make.trim()} ${c.model.trim()}`.replace(/\s+/g, "_");
  let imageUrl = null, imageFallback = null, imageCredit = null;
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`);
    if (r.ok) {
      const j = await r.json();
      const src = j.thumbnail?.source || j.originalimage?.source;
      if (j.type !== "disambiguation" && src) {
        // Wikimedia levererar bara vissa standardbredder; 960 px är en av dem.
        const clean = src.split("?")[0].replace("//thumb.wikimedia.org/", "//upload.wikimedia.org/");
        imageFallback = clean;
        imageUrl = /\/\d+px-/.test(clean) ? clean.replace(/\/\d+px-/, "/960px-") : clean;
        imageCredit = j.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
      }
    }
  } catch { /* ingen bild, siluetten används */ }
  updateDoc(ref("cars", c.id), { imageUrl, imageFallback, imageCredit, imageChecked: key }).catch(() => {});
}

function carVisual(c) {
  if (c.photoId) {
    if (photoCache[c.photoId] == null) loadPhoto(c.photoId);
    const d = photoCache[c.photoId];
    if (d) return `<figure class="car-fig"><img class="car-photo" src="${esc(d)}" alt="Foto på er ${esc(`${c.make} ${c.model}`)}"></figure>`;
    // Medan fotot hämtas visas en tom yta i samma storlek, inte den ritade bilen.
    if (d !== "") return `<figure class="car-fig"><div class="car-photo car-wait" aria-hidden="true"></div></figure>`;
  }
  if (c.imageUrl) {
    return `<figure class="car-fig"><img class="car-photo" src="${esc(c.imageUrl)}" alt="${esc(`${c.make} ${c.model}`)}, bild från Wikipedia" referrerpolicy="no-referrer"${c.imageFallback && c.imageFallback !== c.imageUrl ? ` data-fallback="${esc(c.imageFallback)}"` : ""} onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.removeAttribute('data-fallback')}else{this.closest('figure').hidden=true}">
      <figcaption><a href="${esc(c.imageCredit || "https://wikipedia.org")}" target="_blank" rel="noopener">Bild: Wikipedia</a></figcaption></figure>`;
  }
  return carSvg(c);
}

/* Bränslemätare: hur mycket som finns kvar i tanken, i procent. Äldre värden sparades i åttondelar (level 0–8). */
const fuelPct = (f) => (f ? (typeof f.pct === "number" ? f.pct : typeof f.level === "number" ? f.level * 12.5 : null) : null);
const pctText = (p) => (p <= 0 ? "Tom tank" : p >= 100 ? "Full tank" : `${Math.round(p)} %`);
const pctClass = (p) => (p <= 25 ? "low" : p <= 50 ? "mid" : "ok");
// Bränsleruta: stor siffra och en liggande stapel att dra i, från Tom till Full.
function fuelGauge(c) {
  const f = c.fuelLevel;
  const draft = S.fuelDraft && S.fuelDraft.carId === c.id ? S.fuelDraft.pct : null;
  const p = draft ?? fuelPct(f);
  const v = p ?? 0;
  return `<div class="hero-tile">
    <div class="tile-top"><span class="label">Bränsle</span><span class="fuel-pct ${p == null ? "" : pctClass(v)}" id="fuel-pct">${p == null ? "–" : `${Math.round(v)} %`}</span></div>
    <div class="fuel-h${p == null ? " unset" : ""}" id="fuel-v" role="slider" tabindex="0" aria-label="Bränsle kvar i tanken" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v)}" aria-valuetext="${esc(p == null ? "Inte angivet" : pctText(v))}">
      <i style="clip-path:inset(0 ${100 - v}% 0 0 round 10px)"></i><span class="fuel-thumb" style="left:${v}%"></span>
    </div>
    <div class="fuel-ends"><span>Tom</span><span>Full</span></div>
  </div>`;
}
// Bokningar visas i flödet som poster av typen "bokning", så att de kan sorteras ihop med loggarna.
// Det som inte är poster men ändå ska synas för den andra: bokningar, att göra och dokument.
function bookingFeed() {
  return S.cars.flatMap((c) => [
    ...(c.bookings || []).filter((b) => b.createdAt).map((b) => ({ id: b.id, carId: c.id, createdBy: b.createdBy, createdAt: b.createdAt, date: b.date, _booking: b })),
    ...(c.todos || []).filter((t) => t.at && !t.done).map((t) => ({ id: t.id, carId: c.id, createdBy: t.by, createdAt: t.at, _todo: t })),
    ...(c.docs || []).filter((d) => d.at).map((d) => ({ id: d.id, carId: c.id, createdBy: d.by, createdAt: d.at, date: d.date, _doc: d })),
  ]);
}
// Vad som öppnas när man trycker på en rad i flödet.
function feedAct(e) {
  if (e._booking) return ["open-booking", e.id];
  if (e._todo) return ["go-view", "oversikt"];
  if (e._doc) return ["open-doc", e.id];
  return ["open-entry", e.id];
}

// Poster med ett datum längre bak än 30 dagar räknas inte som nyheter, även om de nyss lades in
// (till exempel gamla servicar som förs in i efterhand). De finns kvar i loggen och i aviseringslistan.
const isRecentDate = (e) => !e.date || e.date >= ymd(new Date(Date.now() - 30 * 864e5));

function unseenFromOthers() {
  const seen = lastSeenMs();
  return [...S.entries.filter(isRecentDate), ...bookingFeed()].filter((e) => e.createdBy !== uid() && tsMs(e.createdAt) > seen);
}

function headerMain() {
  const d = new Date();
  const dateTxt = `${["Söndag", "Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag"][d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const n = unseenFromOthers().length;
  return `<header class="top">
    <div class="hello"><small>${dateTxt}</small><h1><span class="hi-mobile">Hej ${esc(myName())}</span><span class="hi-desk">Översikt</span></h1></div>
    ${topActions()}
  </header>`;
}
// Aviseringar och Inställningar uppe till höger, på alla flikar.
function topActions() {
  const n = unseenFromOthers().length;
  return `<div class="top-actions">
      <button class="icon-btn" type="button" data-go="aviseringar" aria-label="Aviseringar${n ? `, ${n} nya` : ""}">${icon("bell")}${n ? `<span class="badge">${n > 9 ? "9+" : n}</span>` : ""}</button>
      <button class="icon-btn" type="button" data-go="installningar" aria-label="Inställningar">${icon("gear")}</button>
    </div>`;
}

// Rubrik för en vy. Med back visas samma tillbaka-pil som i formulären, till vänster, och den går till vyn man kom ifrån.
// deskTitle: rubriken på datorn, där den står på samma rad som logotypen (till exempel "Bilen" i stället för bilens namn).
function subHeader(small, title, back = false, deskTitle = null) {
  const to = S.prevView || "oversikt";
  const toName = { oversikt: "översikten", logg: "loggen", ekonomi: "ekonomin", bilen: "bilen" }[to] || "översikten";
  return `<header class="top${back ? " has-back" : ""}">
    ${back ? `<button class="icon-btn back-btn" type="button" data-go="${to}" aria-label="Tillbaka till ${toName}">${icon("back", 18)}</button>` : ""}
    <div class="hello"><small>${esc(small)}</small><h1>${deskTitle ? `<span class="hi-mobile">${esc(title)}</span><span class="hi-desk">${esc(deskTitle)}</span>` : esc(title)}</h1></div>
    ${back ? "" : topActions()}
  </header>`;
}

// Kom man till Aviseringar eller Inställningar från en annan vy går tillbaka-pilen dit.
const SIDE_VIEWS = ["aviseringar", "installningar"];
function rememberPrev(next) {
  if (SIDE_VIEWS.includes(next) && !SIDE_VIEWS.includes(S.view)) S.prevView = S.view;
}

function rowHtml(x) {
  const inner = `<span class="dl-ic">${icon(x.icon, 22)}</span>
    <span><span class="dl-t"><span class="dl-tt">${x.short ? `<span class="t-long">${esc(x.title)}</span><span class="t-short">${esc(x.short)}</span>` : esc(x.title)}</span>${x.label || x.when ? `<span class="dl-when">${x.relDay ? `<span class="pill pill-in ${x.level}">${esc(x.whenShort)}</span>` : `${x.label ? `<span class="pill pill-in ${x.level}">${esc(x.label)}</span>` : ""}${x.whenShort ? `<span class="when-t">${esc(x.whenShort)}</span>` : ""}`}</span>` : ""}</span><span class="dl-s">${x.when ? `<span class="sub-when">${esc(x.when)}${x.sub ? " · " : ""}</span>` : ""}${esc(x.sub || "")}</span></span>
    <span class="pill pill-out ${x.level}">${esc(x.label)}</span>`;
  return x.act
    ? `<button class="dl as-btn" type="button" data-act="${x.act}" data-id="${esc(x.id || "")}"${x.type ? ` data-type="${esc(x.type)}"` : ""}>${inner}</button>`
    : `<div class="dl">${inner}</div>`;
}
// En rad med eventuella snabbknappar under (vägbeskrivning och ring för en bokning).
function rowWithQuick(x) {
  return rowHtml(x) + (x.quick ? `<div class="row-quick">${x.quick}</div>` : "");
}

function installCard() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone || pref.get("installDismissed")) return "";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const desktop = !ios && window.matchMedia("(pointer: fine)").matches;
  return `<article class="card">
    <h2>${desktop ? "Installera appen" : "Lägg appen på hemskärmen"} <button class="link" type="button" data-act="dismiss-install">Dölj</button></h2>
    <p class="muted">${ios
      ? "Tryck på Dela-knappen i Safari och välj <b>Lägg till på hemskärmen</b>. Då öppnas Bildagboken som en vanlig app."
      : desktop ? "I Chrome och Edge finns en installera-knapp längst till höger i adressfältet. Då öppnas Bildagboken i ett eget fönster."
      : "Öppna webbläsarens meny och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>."}</p>
  </article>`;
}

// Kom igång: tre steg som gör appen användbar direkt. Försvinner när allt är gjort eller när man döljer det.
function startCard(c) {
  if (!c || pref.get("startHidden." + S.hid)) return "";
  const alone = (S.house?.members || []).length < 2;
  const steps = [
    { done: odoOf(c) != null, title: "Fyll i mätarställningen", sub: "Då räknar appen ut när service och däck behövs.", act: "new-entry", type: "matare" },
    { done: !!(c.besiktning || c.forsakringDatum), title: "Lägg in besiktning och försäkring", sub: "Ni får en påminnelse i god tid.", act: "edit-car", section: "dates" },
    { done: !alone, title: "Bjud in någon", sub: "Den du delar bilen med ser och loggar samma sak.", act: "copy-invite" },
  ];
  const left = steps.filter((x) => !x.done).length;
  if (!left) return "";
  return `<article class="card start-card">
    <h2><span>Kom igång <span class="muted" style="font-weight:500;font-size:13px;margin-left:4px">${3 - left} av 3</span></span> <button class="link" type="button" data-act="hide-start">Dölj</button></h2>
    <div class="rows">${steps.map((x, i) => x.done
      ? `<div class="dl start-step done"><span class="step-n" aria-hidden="true">✓</span><span><span class="dl-t">${esc(x.title)}</span><span class="dl-s">Klart</span></span></div>`
      : `<button class="dl as-btn start-step" type="button" data-act="${x.act}"${x.type ? ` data-type="${x.type}"` : ""}${x.section ? ` data-section="${x.section}"` : ""}>
          <span class="step-n" aria-hidden="true">${i + 1}</span><span><span class="dl-t">${esc(x.title)}</span><span class="dl-s">${esc(x.sub)}</span></span><span class="dl-v">›</span></button>`).join("")}</div>
  </article>`;
}

function inviteCard() {
  if (!S.house || (S.house.members || []).length > 1) return "";
  return `<article class="card">
    <h2>Dela bilen med någon</h2>
    <p class="muted">Bjud in någon till ${esc(S.house.name || "hushållet")}. Alla ni som delar ser och loggar samma sak. Den du bjuder in loggar in med Apple eller Google och skriver in koden:</p>
    <p class="code" style="margin:10px 0">${esc(S.house.inviteCode)}</p>
    <button class="btn-soft" type="button" data-act="copy-invite">Kopiera inbjudningslänk</button>
  </article>`;
}

/* ----------------------------------------------------------- att göra */

// Gemensam att göra-lista för bilen. Klara saker ligger kvar överstrukna tills någon rensar dem.
function todoItemsHtml(items) {
  return `<div class="todos">${items.map((t) => `<label class="todo${t.done ? " done" : ""}">
      <input type="checkbox" class="vh" data-act="todo-toggle" data-id="${esc(t.id)}"${t.done ? " checked" : ""}><span class="box" aria-hidden="true"></span>
      <span class="todo-t">${esc(t.text)}</span><small>${esc(whoName(t.by))}</small></label>`).join("")}</div>`;
}
function todoFormHtml() {
  return `<form class="todo-add" data-form="todo" data-keep novalidate>
      <div class="todo-row">
        <input name="text" id="todo-text" placeholder="Något att göra, köpa eller laga" autocomplete="off" enterkeyhint="done" aria-label="Ny sak">
        <button class="todo-btn" type="submit" aria-label="Lägg till">${icon("plus", 20)}</button>
      </div>
    </form>`;
}
function todoCard(c) {
  const list = c.todos || [];
  const open = list.filter((t) => !t.done), done = list.filter((t) => t.done);
  return `<article class="card">
    <h2>Att göra ${done.length ? `<button class="link" type="button" data-act="todo-clear">Rensa klara</button>` : ""}</h2>
    ${list.length ? todoItemsHtml([...open, ...done]) : `<p class="muted">Saker att göra, köpa eller laga på bilen. Alla ni som delar bilen ser samma lista.</p>`}
    ${todoFormHtml()}
  </article>`;
}
function saveTodo(form) {
  const text = String(new FormData(form).get("text") || "").trim();
  if (!text) return;
  const c = car();
  const list = [...(c.todos || []), { id: "t" + randomId(8), text, done: false, by: uid(), at: Date.now() }];
  c.todos = list;
  updateDoc(ref("cars", c.id), { todos: list }).catch(onWriteError);
  form.reset();
  // Sidan ritas inte om medan någon skriver i ett formulär, så släpp fokus först och sätt tillbaka det efteråt.
  delete form.dataset.dirty;
  document.activeElement?.blur?.();
  render();
  $("#todo-text")?.focus({ preventScroll: true });
}

/* ----------------------------------------------------------- dokument */

// Foton av försäkringsbrev, registreringsbevis, garantier och liknande. Sparas som bilderna i loggen.
// Alla bilder från loggen i datumordning. Hämtas först när man vill se dem, eftersom varje bild är stor.
const gridPhotos = new Map();
function photosCard(c) {
  const ents = S.entries.filter((e) => e.carId === c.id && e.photoId).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (!ents.length) return "";
  const shown = ents.slice(0, 24);
  return `<div class="photos-part">
    <p class="label" style="margin:0 0 8px">Bilder från loggen</p>
    ${S.showPhotos ? `<div class="photo-grid">${shown.map((e) => `<button type="button" class="pg" data-act="open-entry" data-id="${esc(e.id)}" aria-label="${esc(entryTitle(e))}, ${esc(fmtDateShort(e.date))}">
        ${gridPhotos.get(e.photoId) ? `<img src="${esc(gridPhotos.get(e.photoId))}" alt="">` : `<span class="pg-wait"></span>`}<span class="pg-d"><b>${esc(photoLabel(e))}</b>${esc(fmtDateShort(e.date))}</span></button>`).join("")}</div>
      ${ents.length > shown.length ? `<p class="hint" style="margin-top:8px">De ${shown.length} senaste av ${ents.length} bilder.</p>` : ""}
      <button class="link" type="button" data-act="hide-photos" style="margin-top:10px">Dölj bilderna</button>`
      : `<p class="muted">Kvitton och foton från loggen, i datumordning. ${ents.length === 1 ? "1 bild" : `${ents.length} bilder`}.</p>
      <div class="ask" style="margin-top:8px"><button class="btn-soft" type="button" data-act="show-photos">${icon("image", 16)} Visa bilderna</button></div>`}
  </div>`;
}
// Vad en bild i loggen hör till: typen av post, eller kategorin för en kostnad (till exempel Besiktning).
function photoLabel(e) {
  if (e.type === "kostnad") return e.category || "Kostnad";
  return TYPE[e.type]?.label || "Post";
}
async function loadPhotoGrid() {
  const c = car();
  const ids = S.entries.filter((e) => e.carId === c.id && e.photoId).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 24).map((e) => e.photoId).filter((id) => !gridPhotos.has(id));
  await Promise.all(ids.map((id) => getDoc(ref("photos", id)).then((snap) => { if (snap.exists()) gridPhotos.set(id, snap.data().data); }).catch(() => {})));
  render();
}

// Bilder och dokument i samma kort: sparade dokument överst, bilderna från loggen under.
function docsCard(c) {
  const docs = [...(c.docs || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const photos = photosCard(c);
  return `<div class="card">
    <h2>Bilder och dokument</h2>
    ${docs.length ? `<div class="rows">${docs.map((d) => `<button class="dl as-btn" type="button" data-act="open-doc" data-id="${esc(d.id)}"><span class="dl-ic">${icon("doc", 20)}</span>
      <span><span class="dl-t">${esc(d.title)}</span><span class="dl-s">${esc(d.validTo ? `Gäller till ${fmtDateShort(d.validTo)}` : `Sparat ${fmtDateShort(d.date)} av ${whoName(d.by).replace(/^Du$/, "dig")}`)}</span></span>${docPill(d)}</button>`).join("")}</div>`
      : `<p class="muted">Fota försäkringsbrev, registreringsbevis, garantier och kvitton ni vill spara. Ni ser samma dokument.</p>`}
    <div class="ask"><button class="btn-soft" type="button" data-act="new-doc">${icon("plus", 16)} Lägg till dokument</button></div>
    ${photos}
  </div>`;
}
// Hur länge ett dokument (försäkring, garanti) gäller: som en pill i listan och en påminnelse när det närmar sig.
function docPill(d) {
  if (!d.validTo) return "<span></span>";
  const days = daysUntil(parseDate(d.validTo));
  return `<span class="pill ${days < 0 ? "urgent" : levelFromDays(days)}">${esc(days < 0 ? "Har gått ut" : daysText(days) + " kvar")}</span>`;
}
function docReminders(c) {
  return (c.docs || []).filter((d) => d.validTo).map((d) => ({ d, days: daysUntil(parseDate(d.validTo)) }))
    .filter((x) => x.days <= 60 && x.days >= -30)
    .map(({ d, days }) => ({ tileDate: d.validTo, icon: "doc", title: days < 0 ? `${d.title} har gått ut` : `${d.title} går ut`, sub: `Gäller till ${fmtDate(d.validTo)}`, level: days < 0 ? "urgent" : levelFromDays(days), label: days < 0 ? "Gått ut" : daysText(days), act: "open-doc", id: d.id, days, always: true }));
}
function docForm(d = null) {
  openSheet(d ? "Ändra dokument" : "Dokument", `
    <form class="form" data-form="doc"${d ? ` data-id="${esc(d.id)}"` : ""} novalidate>
      ${field("Vad är det?", `<input name="title" id="doc-title" required placeholder="Till exempel försäkringsbrev 2027" autocomplete="off" value="${esc(d?.title || "")}">`)}
      ${field("Gäller till (valfritt)", `<input type="date" name="validTo" id="doc-valid" value="${esc(d?.validTo || "")}">`, "Till exempel när försäkringen, garantin eller parkeringstillståndet går ut. Ni får en påminnelse två månader innan.")}
      ${d ? "" : `<label class="photo-in">${icon("camera", 22)}<span id="photo-label">Fota eller välj en bild</span><input type="file" name="photo" id="ef-photo" accept="image/*"></label>
      <p class="hint">PDF-filer går inte att spara. Ta en skärmbild av PDF:en och välj den i stället.</p>`}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button>
    </form>`);
}
async function saveDoc(form) {
  const fd = new FormData(form);
  const title = String(fd.get("title") || "").trim();
  const file = fd.get("photo");
  if (!title) return formError("Skriv vad det är för dokument.");
  if (form.dataset.id) {
    const c = car();
    const list = (c.docs || []).map((x) => (x.id === form.dataset.id ? { ...x, title, validTo: String(fd.get("validTo") || "") || null } : x));
    c.docs = list;
    updateDoc(ref("cars", c.id), { docs: list }).catch(onWriteError);
    closeSheet(); render();
    return showToast("Dokumentet är ändrat");
  }
  if (!file || !file.size) return formError("Välj en bild av dokumentet.");
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = "Sparar …";
  const data = await compressImage(file).catch(() => null);
  if (!data) { btn.disabled = false; btn.textContent = "Spara"; return formError("Bilden gick inte att läsa in. Prova en annan bild."); }
  const c = car();
  const pRef = doc(col("photos"));
  setDoc(pRef, { data, carId: c.id, createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
  const list = [...(c.docs || []), { id: "d" + randomId(8), title, photoId: pRef.id, date: todayStr(), by: uid(), at: Date.now(), validTo: String(fd.get("validTo") || "") || null }];
  c.docs = list;
  updateDoc(ref("cars", c.id), { docs: list }).catch(onWriteError);
  closeSheet(); render();
  showToast("Dokumentet är sparat");
}
function docSheet(id) {
  const d = (car()?.docs || []).find((x) => x.id === id);
  if (!d) return;
  openSheet(d.title, `
    <div id="photo-box"><p class="hint">Hämtar bilden …</p></div>
    <p class="hint" style="margin-top:8px">Sparat ${esc(fmtDate(d.date))} av ${esc(whoName(d.by).replace(/^Du$/, "dig"))}${d.validTo ? `. Gäller till ${esc(fmtDate(d.validTo))}` : ""}. Tryck på bilden för att se den större.</p>
    <div class="form" style="margin-top:14px">
      <button class="btn primary block" type="button" data-act="edit-doc" data-id="${esc(d.id)}">Ändra</button>
      <button class="btn danger block" type="button" data-act="delete-doc" data-id="${esc(d.id)}">Ta bort dokumentet</button>
    </div>`);
  getDoc(ref("photos", d.photoId)).then((snap) => {
    const box = $("#photo-box");
    if (box) box.innerHTML = snap.exists() ? `<button class="photo-zoom" type="button" data-act="photo-zoom" aria-label="Visa bilden större"><img class="photo" src="${esc(snap.data().data)}" alt="${esc(d.title)}"></button>` : `<p class="hint">Bilden finns inte längre.</p>`;
  }).catch(() => { const box = $("#photo-box"); if (box) box.innerHTML = `<p class="hint">Bilden gick inte att hämta just nu.</p>`; });
}

/* ------------------------------------------------------------ servicebok */

// Servicebok att skriva ut eller spara som PDF: bilen, underhållet och alla jobb med datum, mil och kostnad.
// Serviceboken som vanlig text i tabeller. Samma innehåll används för utskrift och för länken till en köpare.
function serviceBookData(c) {
  const ents = carEntries().filter((e) => ["service", "eget", "dack"].includes(e.type) || (e.type === "kostnad" && e.category === "Besiktning"))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const what = (e) => {
    if (e.type === "kostnad") return ["Besiktning", e.title].filter(Boolean).join(" · ");
    if (e.type === "dack") return [TIRE_ACTIONS[e.tireAction] || "Däck", e.depth != null ? `${fmt(e.depth, 1)} mm` : ""].filter(Boolean).join(" · ");
    const w = workOf(e, c).map(workText).join(", ");
    return [e.type === "eget" ? e.title || "Eget jobb" : "Service", w].filter(Boolean).join(": ");
  };
  const st = allItemStatus(c).filter((x) => !x.unknown || x.lastDate);
  return {
    car: carName(c), plate: c.plate ? String(c.plate).toUpperCase() : "", made: todayStr(),
    facts: [["Registreringsnummer", c.plate ? String(c.plate).toUpperCase() : ""], ["Årsmodell", c.year ? String(c.year) : ""], ["Motor", c.engine], ["Drivmedel", c.fuel], ["Färg", c.color], ["Mätarställning", odoOf(c) != null ? `${fmt(odoOf(c))} mil` : ""], ["Sista dag för besiktning", c.besiktning ? fmtDate(c.besiktning) : ""]].filter(([, v]) => v),
    items: st.map((x) => [x.item.name, intervalText(x.item).replace(/^var /, ""), x.lastDate ? `${fmtDate(x.lastDate)}${x.lastMil != null ? `, ${fmt(x.lastMil)} mil` : ""}` : "–", x.unknown ? "–" : dueText(x) || "–"]),
    rows: ents.map((e) => [fmtDate(e.date), e.odometer != null ? `${fmt(e.odometer)} mil` : "–", what(e), e.note || "", e.workshop || e.place || "", e.amount != null ? `${fmtKr(e.amount)} kr` : ""]),
    total: `${fmtKr(ents.reduce((a, e) => a + (e.amount || 0), 0))} kr`,
  };
}
// Databasen kan inte spara listor i listor, så tabellerna sparas som listor med objekt.
function serviceBookToStore(d) {
  return {
    car: d.car, plate: d.plate, made: d.made, total: d.total,
    facts: d.facts.map(([k, v]) => ({ k, v: String(v ?? "") })),
    items: d.items.map(([name, interval, last, next]) => ({ name, interval, last, next })),
    rows: d.rows.map(([date, odo, what, note, place, cost]) => ({ date, odo, what, note, place, cost })),
  };
}
function serviceBookFromStore(d) {
  const arr = (x, keys) => (Array.isArray(x) ? x : x && typeof x === "object" ? keys.map((k) => x[k] ?? "") : []);
  return {
    ...d,
    facts: (d.facts || []).map((x) => arr(x, ["k", "v"])),
    items: (d.items || []).map((x) => arr(x, ["name", "interval", "last", "next"])),
    rows: (d.rows || []).map((x) => arr(x, ["date", "odo", "what", "note", "place", "cost"])),
  };
}
function serviceBookHtml(d) {
  d = serviceBookFromStore(d);
  const S2 = (x) => esc(String(x ?? ""));
  const rows = Array.isArray(d.rows) ? d.rows : [];
  return `<div class="pb">
    <header class="pb-head"><div><h1>Servicebok</h1><p>${S2(d.car)}${d.plate ? ` · ${S2(d.plate)}` : ""}</p></div><p class="pb-date">Utskriven ${S2(fmtDate(d.made || todayStr()))}<br>Bildagboken</p></header>
    <table class="pb-facts">${(d.facts || []).map(([k, v]) => `<tr><th>${S2(k)}</th><td>${S2(v)}</td></tr>`).join("")}</table>
    ${(d.items || []).length ? `<h2>Underhåll</h2><table class="pb-table"><thead><tr><th>Punkt</th><th>Intervall</th><th>Senast</th><th>Nästa</th></tr></thead><tbody>
      ${d.items.map((r) => `<tr>${r.slice(0, 4).map((v) => `<td>${S2(v)}</td>`).join("")}</tr>`).join("")}
    </tbody></table>` : ""}
    <h2>Utfört arbete</h2>
    ${rows.length ? `<table class="pb-table"><thead><tr><th>Datum</th><th>Mätarställning</th><th>Vad</th><th>Var</th><th class="r">Kostnad</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${S2(r[0])}</td><td>${S2(r[1])}</td><td>${S2(r[2])}${r[3] ? `<br><small>${S2(r[3])}</small>` : ""}</td><td>${S2(r[4])}</td><td class="r">${S2(r[5])}</td></tr>`).join("")}
    </tbody><tfoot><tr><td colspan="4">Totalt ${rows.length} ${rows.length === 1 ? "post" : "poster"}</td><td class="r">${S2(d.total)}</td></tr></tfoot></table>`
      : `<p>Inga service, egna jobb, däckbyten eller besiktningar är loggade än.</p>`}
  </div>`;
}

// Länk till en köpare: en kopia av serviceboken som vem som helst med länken kan läsa, men inte ändra.
// Kopian uppdateras bara när ni trycker Uppdatera, och den tas bort när ni slutar dela.
async function shareServiceBook() {
  const c = car();
  const token = c.shareToken || randomId(10) + randomId(10);
  await setDoc(doc(db, "shares", token), { householdId: S.hid, carId: c.id, createdBy: uid(), updatedAt: Date.now(), data: serviceBookToStore(serviceBookData(c)) });
  if (!c.shareToken) { c.shareToken = token; await updateDoc(ref("cars", c.id), { shareToken: token }); }
  render();
  return token;
}
const shareUrl = (token) => `${location.origin}${location.pathname}?visa=${token}`;
function shareCardHtml(c) {
  if (!c.shareToken) return `<button class="btn-soft" type="button" data-act="share-book">${icon("next", 16)} Dela med en köpare</button>`;
  return `</div><div class="share-box">
      <p class="label">Delad med en länk</p>
      <p class="share-url">${esc(shareUrl(c.shareToken).replace(/^https?:\/\//, ""))}</p>
      <div class="ask" style="margin-top:8px">
        <button class="btn-soft" type="button" data-act="share-copy">Kopiera länken</button>
        <button class="btn-soft" type="button" data-act="share-book">Uppdatera</button>
        <button class="link danger" type="button" data-act="share-stop">Sluta dela</button>
      </div>
      <p class="hint">Den som har länken kan läsa serviceboken, men inte se resten av appen eller ändra något. Tryck Uppdatera efter nya poster.</p>`;
}
// Sidan köparen ser: bara serviceboken, utan inloggning.
const viewToken = new URLSearchParams(location.search).get("visa");
let sharedBookData = null;
async function renderShared(token) {
  setScreen("shared", `<p class="loading">Hämtar serviceboken …</p>`);
  try {
    const snap = await getDoc(doc(db, "shares", token));
    if (!snap.exists()) return setScreen("shared", `<div class="card empty"><b>Länken gäller inte längre</b>Ägaren har slutat dela serviceboken.</div>`);
    const d = snap.data().data || {};
    sharedBookData = d;
    loadPdfLibs().catch(() => {});
    document.title = `Servicebok ${d.car || ""}`.trim();
    setScreen("shared", `<div class="card shared-book">${serviceBookHtml(d)}</div>
      <div class="ask" style="justify-content:center"><button class="btn primary" type="button" data-act="print-shared">${icon("print", 18)} Dela eller spara som PDF</button></div>
      <p class="hint" style="text-align:center">Delad från Bildagboken. Uppdaterad ${esc(fmtDate(ymd(new Date(snap.data().updatedAt || Date.now()))))}.</p>`);
  } catch (e) {
    setScreen("shared", `<div class="card empty"><b>Serviceboken gick inte att hämta</b>${esc(e.code === "permission-denied" ? "Länken gäller inte." : "Kontrollera nätet och försök igen.")}</div>`);
  }
}
// Serviceboken som PDF, byggd i telefonen med jsPDF. Delas via telefonens delningsmeny
// (Spara i Filer, Skriv ut, AirDrop, Mail) eller laddas ner på datorn.
const PDF_LIBS = ["https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js", "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"];
let pdfLibsPromise = null;
function loadPdfLibs() {
  if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve(window.jspdf.jsPDF);
  if (pdfLibsPromise) return pdfLibsPromise;
  const add = (src) => new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = src; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  pdfLibsPromise = add(PDF_LIBS[0]).then(() => add(PDF_LIBS[1])).then(() => window.jspdf.jsPDF).catch((e) => { pdfLibsPromise = null; throw e; });
  return pdfLibsPromise;
}
const pdfReady = () => !!window.jspdf?.jsPDF?.API?.autoTable;
function serviceBookPdf(d0) {
  const d = serviceBookFromStore(d0);
  const t = (x) => tr(String(x ?? "")).replace(/[–—]/g, "-").replace(/›/g, ">");
  const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(22); pdf.text(t("Servicebok"), 14, 20);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(12); pdf.text(t(`${d.car || ""}${d.plate ? ` · ${d.plate}` : ""}`), 14, 27);
  pdf.setFontSize(9); pdf.setTextColor(110); pdf.text(t(`Utskriven ${fmtDate(d.made || todayStr())} · Bildagboken`), W - 14, 20, { align: "right" }); pdf.setTextColor(0);
  pdf.setDrawColor(30); pdf.setLineWidth(0.6); pdf.line(14, 31, W - 14, 31);
  const base = { margin: { left: 14, right: 14 }, styles: { font: "helvetica", fontSize: 9, cellPadding: 1.8, textColor: 20 }, headStyles: { fillColor: [35, 34, 33], textColor: 255, fontStyle: "bold" }, alternateRowStyles: { fillColor: [246, 243, 240] } };
  pdf.autoTable({ ...base, startY: 35, theme: "plain", body: d.facts.map(([k, v]) => [t(k), t(v)]), columnStyles: { 0: { textColor: 110, cellWidth: 50 } } });
  let y = pdf.lastAutoTable.finalY + 8;
  if (d.items.length) {
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.text(t("Underhåll"), 14, y);
    pdf.autoTable({ ...base, startY: y + 3, head: [["Punkt", "Intervall", "Senast", "Nästa"].map(t)], body: d.items.map((r) => r.map(t)) });
    y = pdf.lastAutoTable.finalY + 8;
  }
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.text(t("Utfört arbete"), 14, y);
  if (d.rows.length) {
    pdf.autoTable({ ...base, startY: y + 3, head: [["Datum", "Mätarställning", "Vad", "Var", "Kostnad"].map(t)],
      body: d.rows.map((r) => [t(r[0]), t(r[1]), t(r[2]) + (r[3] ? `\n${t(r[3])}` : ""), t(r[4]), t(r[5])]),
      foot: [[{ content: t(`Totalt ${d.rows.length} ${d.rows.length === 1 ? "post" : "poster"}`), colSpan: 4 }, t(d.total)]],
      footStyles: { fillColor: [255, 255, 255], textColor: 20, fontStyle: "bold" }, columnStyles: { 4: { halign: "right" } } });
  } else {
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.text(t("Inga service, egna jobb, däckbyten eller besiktningar är loggade än."), 14, y + 7);
  }
  return pdf.output("blob");
}
// Dela PDF:en (iPhone och Android) eller ladda ner den (dator). Måste anropas direkt från ett tryck.
async function sharePdf(blob, name) {
  const file = new File([blob], name, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name.replace(/\.pdf$/, "") }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
let pendingPdf = null;
async function exportServiceBook(data, name) {
  if (pdfReady()) return sharePdf(serviceBookPdf(data), name);
  // Första gången hämtas PDF-verktyget (cirka 400 kB). Efter det behövs ett tryck till för att dela.
  showToast("Gör i ordning PDF:en …");
  try { await loadPdfLibs(); } catch { return printFallback(data); }
  pendingPdf = { blob: serviceBookPdf(data), name };
  openSheet("Serviceboken är klar", `<p class="muted">PDF:en är klar att dela. Välj Spara i Filer, Skriv ut eller skicka den direkt.</p>
    <button class="btn primary block" type="button" data-act="pdf-share" style="margin-top:14px">${icon("print", 18)} Dela eller spara PDF</button>`);
}
// Om PDF-verktyget inte går att hämta: vanlig utskrift.
function printFallback(data) {
  document.getElementById("print-root")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div id="print-root">${serviceBookHtml(data)}</div>`);
  window.addEventListener("afterprint", () => document.getElementById("print-root")?.remove(), { once: true });
  setTimeout(() => window.print(), 50);
}
const pdfName = (d) => `Servicebok ${d.car || ""}${d.plate ? " " + d.plate : ""}`.trim().replace(/[^\wåäöÅÄÖ -]/g, "") + ".pdf";
function printServiceBook() {
  const c = car();
  if (!c) return;
  const d = serviceBookData(c);
  return exportServiceBook(d, pdfName(d));
}

/* --------------------------------------------------------- läsa kvitton */

// Textigenkänning i telefonen (Tesseract, svenska). Hämtas första gången den används, cirka 3 MB.
const TESS = "https://cdn.jsdelivr.net/npm/";
let tessPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tessPromise) return tessPromise;
  tessPromise = new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = TESS + "tesseract.js@5.1.1/dist/tesseract.min.js";
    sc.onload = () => resolve(window.Tesseract);
    sc.onerror = () => { tessPromise = null; reject(new Error("kunde inte ladda")); };
    document.head.appendChild(sc);
  });
  return tessPromise;
}
async function readReceiptText(file, onProgress) {
  const T = await loadTesseract();
  const worker = await T.createWorker("swe", 1, {
    workerPath: TESS + "tesseract.js@5.1.1/dist/worker.min.js",
    corePath: TESS + "tesseract.js-core@5.1.1",
    langPath: TESS + "@tesseract.js-data/swe@1.0.0/4.0.0_best_int",
    logger: (m) => { if (m.status === "recognizing text" && onProgress) onProgress(m.progress); },
  });
  try { return (await worker.recognize(file)).data.text || ""; }
  finally { worker.terminate(); }
}
// Plocka ut belopp, datum och ställe ur texten på ett kvitto.
const BRANDS = ["Circle K", "OKQ8", "Preem", "St1", "Ingo", "Shell", "Tanka", "Qstar", "Q8", "Gulf", "Din-X", "Bilia", "Mekonomen", "Vianor", "Euromaster", "Däckia", "Speedy", "Biltema", "Jula", "Clas Ohlson", "Easypark", "EasyPark", "Aimo", "Apcoa", "Parkster", "Q-Park", "Europark", "Statoil", "Hedin", "Volvo", "Ahlberg"];
function parseReceipt(text) {
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const money = (s) => {
    const out = [];
    for (const m of s.matchAll(/(\d{1,3}(?:[ . ]\d{3})*|\d+)[,.](\d{2})(?!\d)/g)) out.push(Number(m[1].replace(/[ . ]/g, "") + "." + m[2]));
    return out;
  };
  let amount = null;
  const key = /(att\s*betala|totalt|total|summa|belopp|betalt|kortbetalning|debiterat|sek\b|kr\b)/i;
  for (const l of lines) {
    if (!key.test(l) || /moms|vat|netto|exkl|rabatt|växel|pris\/l|kr\/l|per\s*liter/i.test(l)) continue;
    const vals = money(l);
    if (vals.length) { const v = Math.max(...vals); if (amount == null || (/att\s*betala|totalt|total|summa/i.test(l) && v >= amount)) amount = v; }
  }
  if (amount == null) {
    const all = lines.filter((l) => !/moms|vat|kr\/l|pris\/l/i.test(l)).flatMap(money).filter((v) => v > 0 && v < 100000);
    if (all.length) amount = Math.max(...all);
  }
  let date = null;
  const t = lines.join(" ");
  let m = t.match(/\b(20\d{2})[-./](0[1-9]|1[0-2])[-./](0[1-9]|[12]\d|3[01])\b/);
  if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = t.match(/\b(0[1-9]|[12]\d|3[01])[-./](0[1-9]|1[0-2])[-./](20\d{2}|\d{2})\b/))) date = `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2]}-${m[1]}`;
  else if ((m = t.match(/\b(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/)) && Number(m[1]) >= 20) date = `20${m[1]}-${m[2]}-${m[3]}`;
  let place = null;
  for (const b of BRANDS) {
    const re = new RegExp(b.replace(/[-]/g, "[- ]?").replace(/ /g, "\\s*"), "i");
    const hit = lines.find((l) => re.test(l));
    if (hit) { place = b; const city = (hit.replace(re, "").match(/[A-ZÅÄÖ][a-zåäö]{3,}/) || [])[0]; if (city) place += " " + city; break; }
  }
  return { amount, date, place };
}

// Kvittoknappen i formulären: fota kvittot, läs av det och fyll i belopp, datum och ställe. Fotot sparas som bild på posten.
const RECEIPT_TYPES = ["tank", "service", "eget", "dack", "tvatt", "parkering", "kostnad"];
function receiptButton() {
  return `<label class="btn ghost block receipt-btn" id="receipt-btn">${icon("camera", 18)} <span id="receipt-label">Läs av ett kvitto</span>
    <input type="file" id="ef-scan" accept="image/*" class="vh"></label>`;
}
async function scanReceipt(file) {
  const label = $("#receipt-label"), btn = $("#receipt-btn");
  if (!file || !label) return;
  // Kvittot blir också postens bild.
  const photo = $("#ef-photo");
  if (photo) {
    try { const dt = new DataTransfer(); dt.items.add(file); photo.files = dt.files; photo.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* går inte att flytta bilden i den här webbläsaren */ }
  }
  btn?.classList.add("busy");
  label.textContent = "Läser kvittot …";
  try {
    const text = await readReceiptText(file, (p) => { if ($("#receipt-label")) $("#receipt-label").textContent = `Läser kvittot … ${Math.round(p * 100)} %`; });
    const r = parseReceipt(text);
    const filled = [];
    const set = (id, v) => { const x = document.getElementById(id); if (x && v != null && v !== "") { x.value = v; x.classList.add("from-receipt"); x.dispatchEvent(new Event("input", { bubbles: true })); return true; } return false; };
    if (r.amount != null && set("ef-amount", fmtKr(r.amount).replace(/\s/g, " "))) filled.push(`${fmtKr(r.amount)} kr`);
    if (r.date && r.date <= todayStr() && set("ef-date", r.date)) { filled.push(fmtDateShort(r.date)); const d = $("#ef-date"); if (d) markDateQuick(d); }
    if (r.place) {
      const id = ["ef-station", "ef-workshop", "ef-place"].find((x) => document.getElementById(x) && !document.getElementById(x).value.trim());
      if (id && set(id, r.place)) { filled.push(r.place); if (id === "ef-station") document.querySelector("#sheet details.more")?.setAttribute("open", ""); }
    }
    if ($("#receipt-label")) $("#receipt-label").textContent = filled.length ? `Ifyllt från kvittot: ${filled.join(", ")}` : "Hittade inget belopp. Fyll i själv.";
    if (filled.length) showToast("Kontrollera det som fylldes i från kvittot.");
  } catch (e) {
    console.warn("Kvittot gick inte att läsa", e);
    if ($("#receipt-label")) $("#receipt-label").textContent = navigator.onLine ? "Kvittot gick inte att läsa. Fyll i själv." : "Läsningen behöver nät första gången.";
  } finally {
    btn?.classList.remove("busy");
  }
}

/* ------------------------------------------------------------- genvägar */

// Länkar som öppnar ett formulär direkt, för hemskärmen och appen Genvägar: ?ny=tank och liknande.
const SHORTCUTS = [["tank", "Logga tankning"], ["matare", "Uppdatera mätarställningen"], ["tvatt", "Logga tvätt"], ["parkering", "Logga parkering"], ["bokning", "Lägg in bokad tid"], ["meny", "Vad vill du logga?"]];
let launchAction = new URLSearchParams(location.search).get("ny");
function runLaunchAction() {
  if (!launchAction) return;
  const a = launchAction;
  launchAction = null;
  const u = new URL(location.href); u.searchParams.delete("ny");
  history.replaceState(history.state, "", u.pathname + u.search + (u.hash || "#oversikt"));
  setTimeout(() => {
    if (a === "bokning") bookingForm();
    else if (TYPE[a]) entryForm(a);
    else typePicker();
  }, 0);
}
const shortcutUrl = (k) => `${location.origin}${location.pathname}?ny=${k}`;
function shortcutsCard() {
  return `<div class="card">
    <h2>Genvägar</h2>
    <p class="muted">Länkar som öppnar ett formulär direkt. Lägg dem i appen Genvägar på iPhone och sedan på hemskärmen, så loggar du med ett tryck.</p>
    <div class="rows" style="margin-top:8px">${SHORTCUTS.map(([k, l]) => `<div class="dl"><span class="dl-ic">${icon(k === "bokning" ? "calendar" : k === "meny" ? "plus" : TYPE[k].icon, 20)}</span>
      <span><span class="dl-t">${esc(l)}</span><span class="dl-s">${esc(shortcutUrl(k).replace(/^https?:\/\//, ""))}</span></span>
      <button class="link" type="button" data-act="copy-shortcut" data-id="${k}">Kopiera</button></div>`).join("")}</div>
    <details class="more" style="margin-top:12px"><summary>Så gör du på iPhone</summary>
      <ol class="steps"><li>Kopiera länken du vill ha.</li><li>Öppna appen <b>Genvägar</b> och tryck på plus.</li><li>Lägg till åtgärden <b>Öppna URL:er</b> och klistra in länken.</li><li>Tryck på dela-knappen och välj <b>Lägg till på hemskärmen</b>.</li></ol>
      <p class="hint">Länken öppnas i Safari. Första gången behöver du logga in där också, sedan kommer Safari ihåg dig.</p>
    </details>
  </div>`;
}

function viewOverview() {
  const c = car();
  const parts = [headerMain()];

  const unseen = unseenFromOthers();
  if (unseen.length) {
    const e = unseen.sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt))[0];
    parts.push(`<button class="card toast" type="button" data-go="aviseringar">
      <span class="avatar">${esc(memberName(e.createdBy).slice(0, 1).toUpperCase())}</span>
      <p><b>${esc(activityText(e))}</b><time>${esc(timeAgo(tsMs(e.createdAt)))}</time></p>
      <span class="new-pill">${unseen.length > 1 ? `${unseen.length} nya` : "Ny"}</span>
    </button>`);
  }

  // Bilkortet: namn och regnummer, bilden, och under den två rutor: mätarställning och bränsle.
  parts.push(`<article class="card hero">
    <div class="hero-car">
      <div class="hero-name">${c.plate ? `<span class="plate">${esc(c.plate)}</span>` : ""}<b>${esc(carName(c))}</b></div>
      <div class="sub">${esc([c.year, c.fuel].filter(Boolean).join(" · "))}</div>
    </div>
    <label class="car-pick" title="Byt bild på bilen">
      ${carVisual(c)}
      <span class="cam" aria-hidden="true">${icon("camera", 19)}</span>
      <input type="file" accept="image/*" id="hero-photo" class="vh" aria-label="Byt bild på bilen">
    </label>
    <div class="hero-tiles">
      <button class="hero-tile odo-tile" type="button" data-act="new-entry" data-type="matare" aria-label="Mätarställning ${odoOf(c) != null ? fmt(odoOf(c)) : "saknas"} mil. Tryck för att uppdatera.">
        <span class="label">Mätarställning</span>
        <span class="odo-num">${odoOf(c) != null ? fmt(odoOf(c)) : "–"}<span>mil</span></span>
        ${odoAgeHtml(c).replace("</span>", " ›</span>")}
      </button>
      ${fuelGauge(c)}
    </div>
  </article>`);


  parts.push(startCard(c));

  const dls = deadlines(c);
  parts.push("<!--card:koll-->", `<article class="card">
    <h2>På gång</h2>
    ${kollRowsHtml([...bookingRows(c).map((b) => ({ ...b, always: true })), ...odoReminder(c), ...docReminders(c), ...dls])}
    ${!c.besiktning && !c.forsakringDatum ? `<div class="ask"><button class="btn-soft" type="button" data-act="edit-car" data-section="dates">Lägg till besiktning, försäkring och skatt</button></div>` : ""}
    <div class="ask"><button class="btn-soft" type="button" data-act="new-booking">${icon("calendar", 16)} Lägg in bokad tid</button></div>
  </article>`);

  parts.push("<!--card:todo-->", todoCard(c));
  parts.push("<!--card:recent-->", recentCard(c));
  parts.push("<!--card:maint-->");

  // Underhåll: de punkter som är närmast att bytas, med samma staplar som under Bilen.
  const st = allItemStatus(c);
  const known = st.filter((x) => !x.unknown).sort((a, b) => daysToDue(a, c) - daysToDue(b, c));
  const unknownCount = st.length - known.length;
  const ps = primaryService(c);
  if (!known.length && st.length) {
    parts.push(ps?.noOdo
      ? `<article class="card"><h2>Underhåll</h2>
        <p class="muted">Fyll i bilens mätarställning, så räknar appen ut hur många mil det är kvar till nästa byte.</p>
        <div class="ask"><button class="btn-soft" type="button" data-act="new-entry" data-type="matare">Fyll i mätarställning</button></div></article>`
      : `<article class="card"><h2>Underhåll</h2>
        <p class="muted">Ange när olja, filter och liknande byttes senast, så räknar appen ut när det är dags igen.</p>
        <div class="ask"><button class="btn-soft" type="button" data-act="edit-items">Ange senaste byte</button></div></article>`);
  } else if (known.length) {
    const top = S.maintAll ? known : known.slice(0, 3);
    parts.push(`<article class="card">
      <h2>Underhåll</h2>
      <div class="rows">${top.map((x) => `<button class="dl as-btn" type="button" data-act="edit-item" data-id="${esc(x.item.id)}">
        <span class="dl-ic">${icon("wrench", 20)}</span>
        <span><span class="dl-t">${esc(x.item.name)}</span><span class="dl-s">${esc(itemSubText(x))}</span>${wearBar(x)}</span>
        <span class="pill ${x.level}">${esc(x.label)}</span></button>`).join("")}</div>
      ${known.length > 3 ? `<button class="link" type="button" data-act="toggle-maint" style="margin-top:10px">${S.maintAll ? "Visa färre" : `Visa ${known.length - 3} till`}</button>` : ""}
      ${unknownCount && pref.get("maintHintHidden." + c.id) !== String(unknownCount) ? `<div class="ask"><button class="btn-soft" type="button" data-act="edit-items">Fyll i underhåll (${unknownCount} kvar)</button><button class="link" type="button" data-act="hide-maint-hint" data-n="${unknownCount}">Dölj</button></div>` : ""}
    </article>`);
  }



  const eco = economy(carEntries());
  const maxBar = Math.max(1, ...eco.bars.map((b) => b.sum));
  const hasCosts = carEntries().some((e) => e.amount > 0);
  parts.push("<!--card:eco-->", `<article class="card">
    <h2>Ekonomi <button class="link" type="button" data-go="ekonomi">Visa alla</button></h2>
    ${hasCosts ? `<div class="eco">
      <div class="stat"><div class="label">${MONTHS[new Date().getMonth()].replace(/^./, (x) => x.toUpperCase())}</div><div class="n">${fmtKr(eco.thisMonth)} <small>kr</small></div></div>
      <div class="stat"><div class="label">Snitt per månad</div><div class="n">${(() => { const y = yearAverage(carEntries().filter((e) => e.amount > 0 && e.date), new Date().getFullYear()); return y.total ? fmtKr(y.avg) : "–"; })()} <small>kr</small></div></div>
      <div class="bars" aria-label="Kostnad per månad de senaste sex månaderna">
        ${eco.bars.map((b) => `<div class="bar${b.now ? " now" : ""}">${b.sum ? `<b>${fmt(b.sum / 1000, 1)}k</b>` : ""}<i style="height:${Math.round((b.sum / maxBar) * 70)}%"></i><span>${b.label}</span></div>`).join("")}
      </div>
    </div>
`
    : `<p class="muted">Här ser ni vad bilen kostar per månad när ni har loggat er första tankning eller kostnad.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="new-entry" data-type="tank">${icon("fuel", 16)} Logga en tankning</button></div>`}
  </article>`);

  const tips = tipsFor(c);
  parts.push("<!--card:tips-->", `<article class="card">
    <h2>Tips för ${esc(carName(c))}</h2>
    <div class="recs">${tips.map((t) => `<div class="rec"><span class="sev ${t.sev === "high" ? "high" : t.sev === "mid" ? "mid" : ""}"></span><div><b>${esc(t.title)}</b><p>${esc(t.text)}</p></div></div>`).join("")}</div>
    <div class="ask">
      <a class="btn" href="https://claude.ai/new" target="_blank" rel="noopener" data-act="ask-claude">${icon("spark", 18)} Fråga Claude</a>
      <small>Kopierar en fråga med er bil och historik som du klistrar in i Claude.</small>
    </div>
  </article>`);
  parts.push("<!--card:end-->", inviteCard(), installCard());
  return arrangeCards(parts);
}

// Korten på Översikt i den ordning man valt under Inställningar, utan de man har dolt.
const CARD_NAMES = { koll: "På gång", todo: "Att göra", recent: "Senaste aktivitet", maint: "Underhåll", eco: "Ekonomi", tips: "Tips" };
// Korten som går att flytta, per vy. Översikt sparas under "cards" (som förut) och Bilen under "cards.bilen".
const CARD_VIEWS = {
  oversikt: { names: CARD_NAMES, pref: "cards", title: "Översikten" },
  bilen: { names: { upp: "Uppgifter", maint: "Underhåll", dack: "Däck", media: "Bilder och dokument", book: "Servicebok" }, pref: "cards.bilen", title: "Bilen" },
};
function cardPrefs(view = "oversikt") {
  const v = CARD_VIEWS[view];
  let p = {};
  try { p = JSON.parse(pref.get(v.pref) || "{}"); } catch { p = {}; }
  const order = (p.order || []).filter((k) => v.names[k]);
  for (const k of Object.keys(v.names)) if (!order.includes(k)) order.push(k);
  return { order, hidden: (p.hidden || []).filter((k) => v.names[k]) };
}
function saveCardPrefs(view, p) { pref.set(CARD_VIEWS[view].pref, JSON.stringify(p)); }
// Lägger korten i den sparade ordningen. Varje kort får data-card, så att det kan flyttas direkt på sidan.
function arrangeCards(parts, view = "oversikt") {
  if (typeof parts === "string") parts = parts.split(/(<!--card:\w+-->)/);
  const head = [], tail = [], byKey = {};
  let key = null;
  for (const x of parts) {
    const m = typeof x === "string" && x.match(/^<!--card:(\w+)-->$/);
    if (m) { key = m[1]; continue; }
    if (key === null) head.push(x);
    else if (key === "end") tail.push(x);
    else (byKey[key] = byKey[key] || []).push(x);
  }
  const { order, hidden } = cardPrefs(view);
  const tag = (k, html) => String(html).replace(/^(\s*<(?:article|div)\b)/, `$1 data-card="${k}" data-view="${view}"`);
  return [...head, ...order.filter((k) => !hidden.includes(k)).map((k) => tag(k, (byKey[k] || []).join(""))), ...tail].join("");
}
// Dra korten i ordning: håll i handtaget och dra raden upp eller ner. De andra raderna flyttar undan.
let cardDrag = null;
document.addEventListener("pointerdown", (ev) => {
  const h = ev.target.closest?.(".drag-handle");
  if (!h) return;
  ev.preventDefault();
  const row = h.closest(".card-row"), list = row.parentElement;
  const rows = [...list.children];
  const rects = rows.map((r) => r.getBoundingClientRect());
  cardDrag = { row, list, rows, rects, from: rows.indexOf(row), to: rows.indexOf(row), startY: ev.clientY, step: rects.length > 1 ? rects[1].top - rects[0].top : rects[0].height };
  row.classList.add("dragging");
  try { h.setPointerCapture(ev.pointerId); } catch { /* äldre webbläsare */ }
});
document.addEventListener("pointermove", (ev) => {
  if (!cardDrag) return;
  const d = cardDrag, dy = ev.clientY - d.startY;
  d.row.style.transform = `translateY(${dy}px)`;
  const to = Math.max(0, Math.min(d.rows.length - 1, d.from + Math.round(dy / d.step)));
  if (to === d.to) return;
  d.to = to;
  d.rows.forEach((r, i) => {
    if (r === d.row) return;
    const shift = d.from < to && i > d.from && i <= to ? -d.step : d.from > to && i < d.from && i >= to ? d.step : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : "";
  });
});
const endCardDrag = () => {
  if (!cardDrag) return;
  const d = cardDrag;
  cardDrag = null;
  d.rows.forEach((r) => { r.style.transform = ""; });
  d.row.classList.remove("dragging");
  if (d.to === d.from) return;
  const view = d.list.dataset.view || "oversikt";
  const p = cardPrefs(view);
  const [k] = p.order.splice(d.from, 1);
  p.order.splice(d.to, 0, k);
  saveCardPrefs(view, p);
  render();
};
document.addEventListener("pointerup", endCardDrag);
document.addEventListener("pointercancel", endCardDrag);
// Tangentbord: piltangenterna på handtaget flyttar raden.
document.addEventListener("keydown", (ev) => {
  const h = ev.target.closest?.(".drag-handle");
  if (!h || !["ArrowUp", "ArrowDown"].includes(ev.key)) return;
  ev.preventDefault();
  const view = h.closest(".card-order")?.dataset.view || "oversikt";
  const p = cardPrefs(view);
  const i = p.order.indexOf(h.dataset.id), j = i + (ev.key === "ArrowUp" ? -1 : 1);
  if (i < 0 || j < 0 || j >= p.order.length) return;
  [p.order[i], p.order[j]] = [p.order[j], p.order[i]];
  saveCardPrefs(view, p);
  render();
  document.querySelector(`.card-order[data-view="${view}"] .drag-handle[data-id="${h.dataset.id}"]`)?.focus();
});
/* ------------------------------------------- flytta kort direkt på sidan */

// Som på iPhones hemskärm: håll fingret på ett kort tills korten vibrerar, dra sedan korten dit du vill.
// Klar (eller ett tryck bredvid korten) sparar ordningen.
let arranging = null;      // vilken vy som är i flyttläge
// Trycket som avslutar en lång tryckning eller en dragning ska inte räknas som ett klick. Gäller bara en kort stund.
let suppressTimer = null;
function suppressNextClick() { suppressClick = true; clearTimeout(suppressTimer); suppressTimer = setTimeout(() => { suppressClick = false; }, 450); }
let pressTimer = null, pressStart = null, dragCard = null, suppressClick = false;
const ARRANGE_VIEWS = { oversikt: "view-oversikt", bilen: "view-bilen" };
function enterArrange(view) {
  arranging = view;
  document.body.classList.add("arranging");
  navigator.vibrate?.(12);
  document.getElementById("arrange-bar")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div class="arrange-bar" id="arrange-bar" role="status">
    <span>Dra för att flytta, tryck på krysset för att dölja</span><button class="btn primary" type="button" id="arrange-done">Klar</button></div>`);
  addHideButtons();
}
// Ett kryss uppe till vänster på varje kort i flyttläget, som döljer kortet.
function addHideButtons() {
  if (!arranging) return;
  const names = CARD_VIEWS[arranging].names;
  app.querySelectorAll(`[data-card][data-view="${arranging}"]`).forEach((el) => {
    if (el.querySelector(":scope > .card-hide")) return;
    el.insertAdjacentHTML("afterbegin", `<button class="card-hide" type="button" data-key="${el.dataset.card}" aria-label="Dölj ${esc(names[el.dataset.card] || "kortet")}">${icon("close", 14)}</button>`);
  });
}
function hideCardNow(btn) {
  const view = arranging, key = btn.dataset.key;
  const el = btn.closest("[data-card]");
  const p = cardPrefs(view);
  if (!p.hidden.includes(key)) p.hidden.push(key);
  saveCardPrefs(view, p);
  navigator.vibrate?.(8);
  el.classList.add("card-gone");
  setTimeout(() => { el.remove(); }, 180);
  const name = CARD_VIEWS[view].names[key] || "Kortet";
  showToast(`${name} är dolt. Du kan visa det igen under Inställningar.`, 6000, () => {
    const q = cardPrefs(view);
    saveCardPrefs(view, { ...q, hidden: q.hidden.filter((k) => k !== key) });
    if (arranging) exitArrange(true); else render();
    showToast(`${name} visas igen`);
  });
}
function exitArrange(save = true) {
  if (!arranging) return;
  const view = arranging;
  arranging = null;
  document.body.classList.remove("arranging");
  document.getElementById("arrange-bar")?.remove();
  if (save) {
    // Ordningen som den syns: uppifrån och ner, vänster före höger.
    const els = [...app.querySelectorAll(`[data-card][data-view="${view}"]`)];
    const pos = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
    const shown = els.sort((a, b) => (Math.abs(pos.get(a).top - pos.get(b).top) < 24 ? pos.get(a).left - pos.get(b).left : pos.get(a).top - pos.get(b).top)).map((el) => el.dataset.card);
    // De synliga korten får sina nya platser, dolda kort ligger kvar där de var.
    const p = cardPrefs(view);
    const queue = [...shown];
    const order = p.order.map((k) => (shown.includes(k) ? queue.shift() : k));
    saveCardPrefs(view, { ...p, order });
  }
  render();
}
function cardAt(target) {
  const el = target.closest?.("[data-card]");
  return el && app.contains(el) && ARRANGE_VIEWS[el.dataset.view] === app.dataset.screen ? el : null;
}
function startCardDrag(el, x, y) {
  const r = el.getBoundingClientRect();
  dragCard = { el, dx: x - r.left, dy: y - r.top };
  el.classList.add("lifted");
  navigator.vibrate?.(8);
}
function moveCardDrag(x, y) {
  const d = dragCard;
  if (!d) return;
  d.el.style.transform = "";
  const base = d.el.getBoundingClientRect();
  // Byt plats med kortet som fingret är över.
  const others = [...app.querySelectorAll(`[data-card][data-view="${arranging}"]`)].filter((e) => e !== d.el);
  for (const o of others) {
    const r = o.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const before = y < r.top + r.height / 2;
    if (before && o.previousElementSibling !== d.el) o.parentElement.insertBefore(d.el, o);
    else if (!before && o.nextElementSibling !== d.el) o.parentElement.insertBefore(d.el, o.nextElementSibling);
    break;
  }
  const now = d.el.getBoundingClientRect();
  d.el.style.transform = `translate(${x - d.dx - now.left}px, ${y - d.dy - now.top}px)`;
  // Rulla sidan när kortet dras nära kanten.
  if (y < 90) window.scrollBy(0, -12); else if (y > innerHeight - 130) window.scrollBy(0, 12);
  void base;
}
function endCardDrag2() {
  if (!dragCard) return;
  dragCard.el.classList.remove("lifted");
  dragCard.el.style.transform = "";
  dragCard = null;
}
// Fingret: håll still en stund för att börja. Rör man fingret direkt är det en vanlig rullning.
document.addEventListener("touchstart", (ev) => {
  if (ev.touches.length !== 1) return;
  const el = cardAt(ev.target);
  if (!el) return;
  const t = ev.touches[0];
  pressStart = { x: t.clientX, y: t.clientY, el };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!pressStart) return;
    if (!arranging) { enterArrange(el.dataset.view); suppressNextClick(); }
    startCardDrag(el, pressStart.x, pressStart.y);
  }, arranging ? 180 : 480);
}, { passive: true });
document.addEventListener("touchmove", (ev) => {
  const t = ev.touches[0];
  if (dragCard) { ev.preventDefault(); moveCardDrag(t.clientX, t.clientY); return; }
  if (pressStart && Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > 10) { clearTimeout(pressTimer); pressStart = null; }
}, { passive: false });
const touchEnd = () => { clearTimeout(pressTimer); pressStart = null; if (dragCard) { endCardDrag2(); suppressNextClick(); } };
document.addEventListener("touchend", touchEnd);
document.addEventListener("touchcancel", touchEnd);
// Musen (dator): håll inne knappen på ett kort.
document.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0 || ("ontouchstart" in window && ev.sourceCapabilities?.firesTouchEvents)) return;
  const el = cardAt(ev.target);
  if (!el) return;
  pressStart = { x: ev.clientX, y: ev.clientY, el };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!pressStart) return;
    if (!arranging) { enterArrange(el.dataset.view); suppressNextClick(); }
    startCardDrag(el, pressStart.x, pressStart.y);
  }, arranging ? 120 : 480);
});
document.addEventListener("mousemove", (ev) => {
  if (dragCard) { ev.preventDefault(); moveCardDrag(ev.clientX, ev.clientY); return; }
  if (pressStart && Math.hypot(ev.clientX - pressStart.x, ev.clientY - pressStart.y) > 6) { clearTimeout(pressTimer); pressStart = null; }
});
document.addEventListener("mouseup", () => { clearTimeout(pressTimer); pressStart = null; if (dragCard) { endCardDrag2(); suppressNextClick(); } });
// I flyttläget gör knapparna på korten ingenting. Klar eller ett tryck (på ett kort eller bredvid) avslutar.
document.addEventListener("click", (ev) => {
  if (ev.target.closest?.("#arrange-done")) { ev.preventDefault(); exitArrange(true); return; }
  const hideBtn = arranging && ev.target.closest?.(".card-hide");
  if (hideBtn) { ev.preventDefault(); ev.stopPropagation(); suppressClick = false; hideCardNow(hideBtn); return; }
  if (arranging && ev.target.closest?.("#toast")) return;
  if (suppressClick) { suppressClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
  if (!arranging) return;
  if (ev.target.closest?.("#arrange-bar")) return;
  // Ett tryck var som helst, på ett kort eller bredvid, avslutar flyttläget (en dragning räknas inte som tryck).
  ev.preventDefault(); ev.stopPropagation();
  exitArrange(true);
}, true);
document.addEventListener("contextmenu", (ev) => { if (cardAt(ev.target)) ev.preventDefault(); });

function cardsSettingsCard(view = "oversikt") {
  const v = CARD_VIEWS[view];
  const { order, hidden } = cardPrefs(view);
  return `<div class="card">
    <h2>${esc(v.title)}</h2>
    <p class="muted">Välj vilka kort som syns. Håll i handtaget och dra för att ändra ordningen.${view === "oversikt" ? " Du kan också hålla fingret på ett kort direkt på sidan." : ""} Gäller den här telefonen.</p>
    <div class="card-order" data-view="${view}">${order.map((k) => `<div class="card-row" data-key="${k}">
      <label class="check"><input type="checkbox" data-act="card-toggle" data-view="${view}" data-id="${k}"${hidden.includes(k) ? "" : " checked"}> ${esc(v.names[k])}</label>
      <button class="drag-handle" type="button" data-id="${k}" aria-label="Flytta ${esc(v.names[k])}. Dra, eller använd piltangenterna.">${icon("grip", 20)}</button>
    </div>`).join("")}</div>
  </div>`;
}

// "Uppdaterad för 3 veckor sedan" under mätarställningen. Orange efter en månad.
// Påminnelse när mätarställningen inte har uppdaterats på en månad, så att underhållet räknas rätt.
function odoReminder(c) {
  const last = latestOdoEntry(c.id);
  if (!last?.date) return [];
  const ago = -daysUntil(parseDate(last.date));
  if (ago < 30) return [];
  return [{ icon: "gauge", title: "Dags att uppdatera mätarställningen", sub: `Senast ${fmtDateShort(last.date)}, ${fmt(last.odometer)} mil`, level: "soon", label: "Uppdatera", act: "new-entry", type: "matare", always: true, days: 0 }];
}

function odoAgeHtml(c) {
  const last = latestOdoEntry(c.id);
  if (!last?.date) return "";
  const ago = Math.max(0, -daysUntil(parseDate(last.date)));
  const when = ago === 0 ? "i dag" : ago === 1 ? "i går" : ago < 14 ? `för ${ago} dagar sedan` : ago < 60 ? `för ${Math.round(ago / 7)} veckor sedan` : `för ${daysText(ago)} sedan`;
  return `<span class="odo-age${ago >= 30 ? " old" : ""}">Uppdaterad ${esc(when)}${ago >= 30 ? " · dags att uppdatera" : ""}</span>`;
}

// På gång: bokningar, tvätt, brådskande och det som händer inom tre månader. Resten bakom "Visa fler".
function kollRowsHtml(rows) {
  const near = (x) => x.always || x.level === "urgent" || x.level === "soon" || (x.days != null && x.days <= 92);
  // Det som är nära eller bråttom visas, men alltid minst tre saker om det finns så många.
  let shown = rows.filter(near), later = rows.filter((x) => !near(x));
  if (shown.length < 3) { shown = [...shown, ...later.slice(0, 3 - shown.length)]; later = later.slice(Math.max(0, 3 - rows.filter(near).length)); }
  const all = S.kollAll;
  // Sorterat efter när, med en liten rubrik för varje tidpunkt: "I morgon", "Om 33 dagar · 15 dec", "Om 6 mån".
  const list = [...shown, ...(all ? later : [])].map((x, i) => ({ x, i })).sort((a, b) => (a.x.days ?? 0) - (b.x.days ?? 0) || a.i - b.i).map(({ x }) => x);
  let prev = null;
  const html = list.map((x) => {
    const group = x.group || (/^\d/.test(x.label || "") ? `Om ${x.label}` : x.label || "");
    const head = group && group !== prev ? `<div class="koll-head ${x.level === "urgent" ? "urgent" : ""}">${esc(group)}</div>` : "";
    prev = group;
    const sub = x.kollSub ?? x.sub;
    const inner = `<span class="koll-t">${esc(x.kollTitle || x.title)}</span>${sub ? `<span class="koll-s">${esc(sub)}</span>` : ""}`;
    // Brickan till vänster: dag och månad, månad och år för skatten, annars en ikon.
    const dt = x.tileDate ? (typeof x.tileDate === "string" ? parseDate(x.tileDate) : x.tileDate) : x.date || null;
    const tile = dt && x.key === "skatt"
      ? `<span class="koll-tile kt-month"><b>${esc(MONTHS_SHORT[dt.getMonth()])}</b><small>${dt.getFullYear()}</small></span>`
      : dt ? `<span class="koll-tile"><b>${dt.getDate()}</b><small>${esc(MONTHS_SHORT[dt.getMonth()])}</small></span>`
      : `<span class="koll-tile ic">${icon(x.icon || "calendar", 20)}</span>`;
    const main = x.act
      ? `<button class="koll-main" type="button" data-act="${x.act}" data-id="${esc(x.id || "")}"${x.type ? ` data-type="${esc(x.type)}"` : ""}>${inner}</button>`
      : `<div class="koll-main">${inner}</div>`;
    const btns = (x.mapId ? `<button class="koll-btn" type="button" data-act="map-directions" data-id="${esc(x.mapId)}" aria-label="Vägbeskrivning">${icon("pin", 18)}</button>` : "")
      + (x.phone ? `<a class="koll-btn" href="tel:${esc(x.phone)}" aria-label="Ring">${icon("phone", 18)}</a>` : "");
    return `${head}<div class="koll-row ${x.level || ""}">${tile}${main}${btns}</div>`;
  }).join("");
  return `<div class="koll">${html}</div>
    ${later.length ? `<button class="link" type="button" data-act="toggle-koll" style="margin-top:10px">${all ? "Visa färre" : `Visa ${later.length} till`}</button>` : ""}`;
}

// De tre senaste loggarna, för båda, så att man ser vad den andra har gjort.
function bookingActivity(b) {
  const n = whoName(b.createdBy);
  const kind = (BOOK_KINDS[b.kind] || "en tid").toLowerCase();
  return `${n} bokade ${kind} till ${fmtDateShort(b.date)}${b.time ? ` kl ${b.time}` : ""}${b.place ? ` hos ${b.place}` : ""}`;
}

function recentCard(c) {
  const items = [
    ...S.entries.filter((e) => e.carId === c.id && isRecentDate(e)).map((e) => ({ ts: tsMs(e.createdAt), who: e.createdBy, text: activityText(e), act: "open-entry", id: e.id, date: e.date })),
    ...(c.bookings || []).filter((b) => b.createdAt).map((b) => ({ ts: tsMs(b.createdAt), who: b.createdBy, text: bookingActivity(b), act: "open-booking", id: b.id, date: b.date })),
    ...bookingFeed().filter((e) => e.carId === c.id && (e._todo || e._doc)).map((e) => { const [act, id] = feedAct(e); return { ts: tsMs(e.createdAt), who: e.createdBy, text: activityText(e), act, id, date: e.date }; }),
  ].sort((a, b) => b.ts - a.ts).slice(0, 3);
  if (!items.length) return "";
  return `<article class="card">
    <h2>Senaste aktivitet <button class="link" type="button" data-go="logg">Visa alla</button></h2>
    <div class="rows">${items.map((x) => {
      const mine = x.who === uid();
      return `<button class="dl as-btn" type="button" data-act="${x.act}" data-id="${esc(x.id)}">
        <span class="avatar${mine ? " me" : ""}">${esc((mine ? myName() : memberName(x.who)).slice(0, 1).toUpperCase())}</span>
        <span><span class="dl-t">${esc(x.text)}</span><span class="dl-s">${esc(timeAgo(x.ts) || fmtDateShort(x.date))}</span></span>
        <span></span></button>`;
    }).join("")}</div>
  </article>`;
}

// Bokade tider överst i loggen. De följer filtret: service och reparation under Service,
// däckbyte under Däck och besiktning under Kostnader.
const BOOK_FILTER = { service: "service", reparation: "service", dack: "dack", besiktning: "besiktning", annat: null };
function upcomingHtml(q) {
  const c = car();
  const list = sortedBookings(c).filter((b) => {
    if (S.filter !== "alla" && BOOK_FILTER[b.kind] !== S.filter) return false;
    if (!q) return true;
    const hay = [BOOK_KINDS[b.kind], b.place, b.addr, b.note, bookingWhen(b), b.date].filter(Boolean).join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  });
  if (!list.length) return { html: "", n: 0 };
  return { n: list.length, html: `<div class="month">Kommande</div><div class="card">${list.map((b) => {
    const past = daysUntil(parseDate(b.date)) < 0;
    const kind = BOOK_KINDS[b.kind] || "Bokning";
    return `<button class="entry" type="button" data-act="open-booking" data-id="${esc(b.id)}">
      <span class="dl-ic">${icon("calendar", 20)}</span>
      <span><span class="t">${esc(past ? `${kind}: blev det gjort?` : `${kind} bokad`)}</span>${b.place || b.addr ? `<span class="d">${esc([b.place, b.addr].filter(Boolean).join(" · "))}</span>` : ""}
        <span class="m">${esc(bookingWhen(b))}</span></span>
      <span class="amt"></span>
    </button>`;
  }).join("")}</div>` };
}

// Ikonen för en post: samma som i plusmenyn och i Ekonomi.
function entryIcon(e) {
  if (e.type === "kostnad") return CAT_ICON[catOf(e)] || "receipt";
  return TYPE[e.type]?.icon || "list";
}
function entryRow(e, fromCat = null) {
  const mine = e.createdBy === uid();
  const d = entryDetail(e);
  return `<button class="entry" type="button" data-act="open-entry" data-id="${esc(e.id)}"${fromCat ? ` data-cat="${esc(fromCat)}"` : ""}>
    <span class="dl-ic">${icon(entryIcon(e), 20)}</span>
    <span><span class="t">${esc(entryTitle(e))}</span>${d ? `<span class="d">${esc(d)}</span>` : ""}
      <span class="m"><span class="who${mine ? " me" : ""}">${esc(whoName(e.createdBy))}</span>${esc(fmtDateShort(e.date))}${e.odometer != null && e.type !== "matare" ? ` · ${fmt(e.odometer)} mil` : ""}${e.photoId ? " · bild" : ""}</span></span>
    <span class="amt">${e.amount != null ? `${fmtKr(e.amount)} kr` : e.type === "matare" && e.odometer != null ? `${fmt(e.odometer)} mil` : ""}</span>
  </button>`;
}

// Sök: varje ord man skriver måste finnas någonstans i posten (titel, detaljer, verkstad, anteckning, vem, belopp, datum).
function entryMatches(e, q) {
  if (!q) return true;
  const c = S.cars.find((x) => x.id === e.carId) || car();
  const hay = [
    TYPE[e.type]?.label, entryTitle(e), entryDetail(e, c), e.note, e.workshop, e.station, e.place, e.category, e.fuel,
    ["service", "eget"].includes(e.type) ? workOf(e, c).map(workText).join(" ") : "", whoName(e.createdBy), memberName(e.createdBy),
    e.amount != null ? `${Math.round(e.amount)} ${fmt(e.amount)} kr` : "", e.odometer != null ? `${e.odometer} ${fmt(e.odometer)} mil` : "",
    fmtDate(e.date), e.date,
  ].filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w.replace(/\s/g, "")) || hay.replace(/\s/g, "").includes(w));
}

function logListHtml() {
  const q = (S.query || "").trim();
  // Filtret Mätarställning visar alla poster med mätarställning (även service, tankning och däck), inte bara manuella avläsningar.
  const isInspection = (e) => e.type === "kostnad" && e.category === "Besiktning";
  const inFilter = (e) => S.filter === "alla" || (S.filter === "matare" ? e.odometer != null : S.filter === "besiktning" ? isInspection(e) : S.filter === "kostnad" ? e.type === "kostnad" && !isInspection(e) : e.type === S.filter);
  const ents = carEntries().filter((e) => inFilter(e) && entryMatches(e, q));
  const groups = [];
  for (const e of ents) {
    const key = (e.date || "").slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, items: [] }; groups.push(g); }
    g.items.push(e);
  }
  const monthLabel = (key) => {
    const [y, m] = key.split("-").map(Number);
    const name = MONTHS[m - 1].replace(/^./, (x) => x.toUpperCase());
    return y === new Date().getFullYear() ? name : `${name} ${y}`;
  };
  const { html: upcoming0, n: nUpcoming0 } = upcomingHtml(q);
  // Vid sökning: även att göra och dokument.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hitText = (t) => words.length && words.every((w) => String(t || "").toLowerCase().includes(w));
  const c0 = car();
  const extra = q ? [
    ...(c0?.todos || []).filter((t) => hitText(t.text)).map((t) => ({ icon: "todo", title: t.text, sub: t.done ? "Att göra · klart" : "Att göra", level: "none", label: "", act: "go-view", id: "oversikt" })),
    ...(c0?.docs || []).filter((d) => hitText(d.title)).map((d) => ({ icon: "doc", title: d.title, sub: "Dokument", level: "none", label: "", act: "open-doc", id: d.id })),
  ] : [];
  const upcoming = (extra.length ? `<div class="card"><div class="rows">${extra.map(rowHtml).join("")}</div></div>` : "") + upcoming0;
  const nUpcoming = nUpcoming0 + extra.length;
  const hits = ents.length + nUpcoming;
  // Summa för det som visas, när man har filtrerat eller sökt: i år och totalt.
  const paid = (S.filter !== "alla" || q) ? ents.filter((e) => e.amount > 0) : [];
  const year = String(new Date().getFullYear());
  const yearSum = paid.filter((e) => (e.date || "").startsWith(year)).reduce((a, e) => a + e.amount, 0);
  const allSum = paid.reduce((a, e) => a + e.amount, 0);
  const sumText = paid.length ? `${fmtKr(yearSum)} kr i år${allSum !== yearSum ? ` · ${fmtKr(allSum)} kr totalt` : ""}` : "";
  const countText = q ? `${hits === 1 ? "1 träff" : `${hits} träffar`} för ”${esc(q)}”` : S.filter !== "alla" ? `${ents.length === 1 ? "1 post" : `${ents.length} poster`}` : "";
  const count = countText ? `<p class="hint log-sum" style="margin:0 4px">${countText}${sumText ? ` · <b>${esc(sumText)}</b>` : ""}</p>` : "";
  if (!groups.length && upcoming) return count + upcoming;
  if (!groups.length) {
    return q
      ? `${count}<div class="card empty"><b>Inga träffar</b>Prova ett annat ord, till exempel verkstad, del eller belopp.</div>`
      : `<div class="card empty"><b>${S.filter === "alla" ? "Inget loggat än" : "Inget här än"}</b>Tryck på plusknappen för att logga en tankning, service eller något du gjort själv.</div>`;
  }
  return count + upcoming + groups.map((g) => `<div class="month">${esc(monthLabel(g.key))}</div><div class="card">${g.items.map((e) => entryRow(e)).join("")}</div>`).join("");
}

function viewLog() {
  const filters = [["alla", "Alla"], ...LOG_ORDER.map((k) => [k, typeLabel(k)])];
  return `${subHeader("Allt som hänt med bilen", "Logg")}
    <label class="search">${icon("search", 18)}
      <input type="search" id="log-search" placeholder="Sök, till exempel bromsar" value="${esc(S.query || "")}" autocomplete="off" enterkeyhint="search" aria-label="Sök i loggen">
      ${S.query ? `<button class="search-clear" type="button" data-act="clear-search" aria-label="Rensa sökningen">${icon("close", 14)}</button>` : ""}
    </label>
    <div class="filters" role="group" aria-label="Filtrera loggen">
      ${filters.map(([k, l]) => `<button type="button" data-act="filter" data-f="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join("")}
    </div>
    <div id="log-list" class="log-list">${logListHtml()}</div>`;
}

// Ekonomi: vald månad överst (bläddra bakåt och framåt), årets tolv månader som staplar, och årets nyckeltal.
const ymKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
function ecoSelected() {
  const now = ymKey(new Date());
  if (!S.ecoMonth || S.ecoMonth > now) S.ecoMonth = now;
  return S.ecoMonth;
}
function monthLabelLong(key) {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[m - 1].replace(/^./, (x) => x.toUpperCase())} ${y}`;
}
function catRows(list, total, monthKey) {
  const cats = {}, count = {};
  for (const e of list) { const k = catOf(e); cats[k] = (cats[k] || 0) + e.amount; count[k] = (count[k] || 0) + 1; }
  const c = car();
  return Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    return `<button class="dl as-btn" type="button" data-act="open-cat" data-id="${esc(k)}" data-month="${monthKey}">
    <span class="dl-ic">${icon(CAT_ICON[k] || "receipt", 20)}</span>
    <span><span class="dl-t">${esc(k)}</span><span class="dl-s">${total ? fmt((v / total) * 100) : 0} % · ${count[k]} st</span></span>
    <span class="dl-v">${fmtKr(v)} kr ›</span></button>`;
  }).join("");
}

// Snitt per månad för ett år: på de månader som har passerat, från första loggade månaden om bilen började loggas samma år.
function yearAverage(paid, year) {
  const nowKey = ymKey(new Date());
  const firstKey = paid.reduce((m, e) => (e.date.slice(0, 7) < m ? e.date.slice(0, 7) : m), nowKey);
  const total = paid.filter((e) => e.date.startsWith(`${year}-`)).reduce((a, e) => a + e.amount, 0);
  const startM = year === Number(firstKey.slice(0, 4)) ? Number(firstKey.slice(5, 7)) : 1;
  const endM = year === new Date().getFullYear() ? new Date().getMonth() + 1 : 12;
  return { total, avg: total / Math.max(1, endM - startM + 1) };
}

function viewEconomy() {
  const paid = carEntries().filter((e) => e.amount > 0 && e.date);
  const sel = ecoSelected();
  const nowKey = ymKey(new Date());
  const year = Number(sel.slice(0, 4));
  const firstKey = paid.reduce((m, e) => (e.date.slice(0, 7) < m ? e.date.slice(0, 7) : m), nowKey);
  const firstYear = Number(firstKey.slice(0, 4));

  // Vald månad
  const monthList = paid.filter((e) => e.date.startsWith(sel));
  const monthTotal = monthList.reduce((s, e) => s + e.amount, 0);

  // Årets tolv månader
  const sums = Array.from({ length: 12 }, (_, i) => paid.filter((e) => e.date.startsWith(`${year}-${pad(i + 1)}`)).reduce((s, e) => s + e.amount, 0));
  const max = Math.max(1, ...sums);
  const yearTotal = sums.reduce((a, b) => a + b, 0);
  const yearAvg = yearAverage(paid, year).avg;

  // Årets nyckeltal
  const drivenIn = (y, until = `${y}-12-31`) => {
    const odos = carEntries().filter((e) => e.odometer != null && (e.date || "").startsWith(`${y}-`) && e.date <= until).map((e) => e.odometer);
    return odos.length >= 2 ? Math.max(...odos) - Math.min(...odos) : null;
  };
  const driven = drivenIn(year);
  // Jämförelse med året innan, när det finns något att jämföra med.
  // Pågående år jämförs med samma period året innan (till och med samma dag), annars hela året.
  const cutoff = year === new Date().getFullYear() ? `${year - 1}-${todayStr().slice(5)}` : `${year - 1}-12-31`;
  const prevPaid = paid.filter((e) => e.date.startsWith(`${year - 1}-`) && e.date <= cutoff);
  const prevTotal = prevPaid.reduce((a, e) => a + e.amount, 0);
  const prevDriven = drivenIn(year - 1, cutoff);
  const delta = (now, before, unit = "") => {
    if (!before || now == null) return "";
    const p = Math.round(((now - before) / before) * 100);
    return `<div class="delta ${p > 0 ? "up" : p < 0 ? "down" : ""}">${p > 0 ? "+" : ""}${p} % mot ${year === new Date().getFullYear() ? `samma tid ${year - 1}` : year - 1}${unit}</div>`;
  };
  const c = car();
  // Bilåret i siffror: vad pengarna gick till och vad som gjordes.
  const yearList = paid.filter((e) => e.date.startsWith(`${year}-`));
  const byCat = {};
  for (const e of yearList) byCat[catOf(e)] = (byCat[catOf(e)] || 0) + e.amount;
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  const topMonth = sums.reduce((m, v, i) => (v > m.v ? { v, i } : m), { v: 0, i: -1 });
  const countType = (t) => carEntries().filter((e) => e.type === t && (e.date || "").startsWith(`${year}-`)).length;
  const yearFacts = [
    ["Tankningar", countType("tank")], ["Service och egna jobb", countType("service") + countType("eget")], ["Tvättar", countType("tvatt")], ["Parkeringar", countType("parkering")],
  ].filter(([, n]) => n);

  const navBtn = (act, d, label, disabled) => `<button class="icon-btn" type="button" data-act="${act}" data-d="${d}" aria-label="${label}"${disabled ? " disabled" : ""}>${icon(d < 0 ? "back" : "next", 18)}</button>`;
  return `${subHeader("Vad bilen kostar", "Ekonomi")}
    <div class="card eco-month">
      <div class="eco-nav">
        ${navBtn("eco-step", -1, "Föregående månad", sel <= firstKey)}
        <div class="eco-nav-t"><div class="label">Kostnad</div><h2>${esc(monthLabelLong(sel))}</h2></div>
        ${navBtn("eco-step", 1, "Nästa månad", sel >= nowKey)}
      </div>
      <div class="eco-big">${fmtKr(monthTotal)} <small>kr</small></div>
      ${monthList.length
        ? `<p class="muted" style="text-align:center;margin:0 0 10px">${monthList.length === 1 ? "1 post" : `${monthList.length} poster`}</p><div class="rows">${catRows(monthList, monthTotal, sel)}</div>`
        : `<p class="muted" style="text-align:center">Inga kostnader loggade i ${esc(MONTHS[Number(sel.slice(5, 7)) - 1])}.</p>`}
    </div>
    <div class="card">
      <div class="eco-nav">
        ${navBtn("eco-year", -1, "Föregående år", year <= firstYear)}
        <div class="eco-nav-t"><div class="label">Hela året</div><h2>${year}</h2></div>
        ${navBtn("eco-year", 1, "Nästa år", year >= new Date().getFullYear())}
      </div>
      <div class="year-bars" role="group" aria-label="Kostnad per månad ${year}">
        ${sums.map((v, i) => {
          const key = `${year}-${pad(i + 1)}`;
          const future = key > nowKey;
          return `<button type="button" class="ybar${key === sel ? " sel" : ""}" data-act="eco-month" data-m="${key}"${future ? " disabled" : ""} aria-label="${esc(monthLabelLong(key))}: ${fmtKr(v)} kr" aria-pressed="${key === sel}">
            <i${v ? "" : ' class="zero"'} style="height:${v ? Math.max(4, Math.round((v / max) * 100)) : 0}%"></i><span>${MONTHS_SHORT[i]}</span></button>`;
        }).join("")}
      </div>
      <div class="eco" style="margin-top:12px">
        <div class="stat"><div class="label">Totalt ${year}</div><div class="n">${fmtKr(yearTotal)} <small>kr</small></div>${delta(yearTotal, prevTotal)}</div>
        <div class="stat"><div class="label">Snitt per månad</div><div class="n">${yearTotal ? fmtKr(yearAvg) : "–"} <small>kr</small></div></div>
        <div class="stat"><div class="label">Kostnad per mil</div><div class="n">${driven && yearTotal ? fmt(yearTotal / driven, 2) : "–"} <small>kr</small></div>${driven && prevDriven && prevTotal ? delta(yearTotal / driven, prevTotal / prevDriven) : ""}</div>
        <div class="stat"><div class="label">Körsträcka</div><div class="n">${driven != null ? fmt(driven) : "–"} <small>mil</small></div>${delta(driven, prevDriven)}</div>
      </div>
      <p class="hint" style="margin-top:10px">Tryck på en stapel för att se den månaden. Kostnad per mil räknas på körsträckan mellan årets loggade mätarställningar.</p>
    </div>
    ${(c.recurring || []).length ? `<div class="card"><h2>Återkommande kostnader</h2><div class="rows">${c.recurring.map((r) => {
      const ended = r.end && r.end <= todayStr();
      return `<button class="dl as-btn" type="button" data-act="open-rec" data-id="${esc(r.id)}"><span class="dl-ic">${icon("parking", 20)}</span>
        <span><span class="dl-t">${esc(r.place || "Parkering")}</span><span class="dl-s">${esc(`${fmtKr(r.amount)} kr ${PERIODS[r.period]?.toLowerCase()} · ${ended ? `slutade ${fmtDateShort(r.end)}` : `sedan ${fmtDateShort(r.start)}`}`)}</span></span>
        <span class="pill ${ended ? "none" : "ok"}">${ended ? "Avslutad" : "Pågår"}</span></button>`;
    }).join("")}</div></div>` : ""}
    ${(() => {
      const tanks = carEntries().filter((e) => e.type === "tank" && (e.date || "").startsWith(`${year}-`)).sort((a, b) => a.date.localeCompare(b.date));
      if (tanks.length < 2) return "";
      const paidT = tanks.filter((e) => e.amount > 0);
      const sum = paidT.reduce((a, e) => a + e.amount, 0);
      const gaps = tanks.slice(1).map((e, i) => (parseDate(e.date) - parseDate(tanks[i].date)) / 864e5);
      const gap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const st = {};
      for (const e of tanks) if (e.station) st[e.station] = (st[e.station] || 0) + 1;
      const fav = Object.entries(st).sort((a, b) => b[1] - a[1])[0];
      const max = paidT.reduce((m, e) => (e.amount > (m?.amount || 0) ? e : m), null);
      return `<div class="card"><h2>Tankningar ${year}</h2><dl class="detail-list">
        <div><dt>Antal</dt><dd>${tanks.length} st</dd></div>
        ${paidT.length ? `<div><dt>Snitt per tankning</dt><dd>${esc(fmtKr(sum / paidT.length))} kr</dd></div>` : ""}
        <div><dt>Tankar ungefär</dt><dd>${gap < 1.5 ? "varje dag" : `var ${Math.round(gap)}:e dag`}</dd></div>
        ${max ? `<div><dt>Dyraste</dt><dd>${esc(fmtKr(max.amount))} kr, ${esc(fmtDateShort(max.date))}</dd></div>` : ""}
        ${fav ? `<div><dt>Oftast hos</dt><dd>${esc(fav[0])} (${fav[1]} gånger)</dd></div>` : ""}
      </dl></div>`;
    })()}
    ${yearTotal || yearFacts.length ? `<div class="card">
      <h2>Bilåret ${year} i siffror</h2>
      <dl class="detail-list">
        ${topCat ? `<div><dt>Mest pengar på</dt><dd>${esc(topCat[0])}, ${esc(fmtKr(topCat[1]))} kr (${Math.round((topCat[1] / yearTotal) * 100)} %)</dd></div>` : ""}
        ${topMonth.i >= 0 ? `<div><dt>Dyraste månaden</dt><dd>${esc(MONTHS[topMonth.i].replace(/^./, (x) => x.toUpperCase()))}, ${esc(fmtKr(topMonth.v))} kr</dd></div>` : ""}
        ${yearFacts.map(([k, n]) => `<div><dt>${esc(k)}</dt><dd>${n} st</dd></div>`).join("")}
        ${prevTotal ? `<div><dt>Jämfört med ${year === new Date().getFullYear() ? `samma tid ${year - 1}` : year - 1}</dt><dd>${yearTotal >= prevTotal ? `${esc(fmtKr(yearTotal - prevTotal))} kr mer` : `${esc(fmtKr(prevTotal - yearTotal))} kr mindre`}</dd></div>` : ""}
      </dl>
    </div>` : ""}`;
}

// Stapel som fylls på från förra bytet till nästa: tom när det är nybytt, full när det är dags.
// Ungefär hur många dagar det är kvar till ett byte, så att punkterna kan sorteras efter vad som kommer först.
// Mil räknas om till dagar med hur mycket bilen brukar köras (annars 1 500 mil per år). Försenade kommer först.
function daysToDue(s, c) {
  if (s.frac < 0) return -1e6 + s.frac * 1000;
  const rate = milPerDay(c) || 1500 / 365;
  const ds = [s.remDays, s.remMil != null ? s.remMil / rate : null].filter((x) => x != null);
  return ds.length ? Math.min(...ds) : 1e6;
}

// Intervallet i text: "var 2 000 mil eller 1 år". Hela år skrivs i år, annars i månader.
function monthsText(m) { return m % 12 === 0 ? `${m / 12} år` : `${m} mån`; }
function intervalText(item) {
  const t = [item.mil ? `${fmt(item.mil)} mil` : "", item.months ? monthsText(item.months) : ""].filter(Boolean).join(" eller ");
  return t ? `var ${t}` : "inget intervall";
}
// Raden under en underhållspunkt, samma på Översikt och Bilen: nästa gräns om den är känd, annars intervallet.
function itemSubText(s) {
  if (s.noOdo) return `${intervalText(s.item)} · mätarställning saknas`;
  if (s.noInterval) return s.lastDate ? `Senast ${fmtDateShort(s.lastDate)}` : "";
  if (s.unknown) return `${intervalText(s.item)} · senaste byte okänt`;
  return dueText(s) || intervalText(s.item);
}

// Nästa gräns i text: "Vid 23 700 mil eller senast juli 2027".
function dueText(s) {
  return [s.item.mil && s.lastMil != null ? `Vid ${fmt(s.lastMil + s.item.mil)} mil` : "", s.dueDate ? `senast ${MONTHS[s.dueDate.getMonth()]} ${s.dueDate.getFullYear()}` : ""]
    .filter(Boolean).join(" eller ").replace(/^s/, "S");
}

function wearBar(s) {
  if (s.unknown || s.frac == null) return "";
  const used = Math.max(0, Math.min(1, 1 - s.frac));
  return `<span class="wear ${s.level}" role="img" aria-label="${Math.round(used * 100)} % av intervallet har gått"><i style="width:${(used * 100).toFixed(1)}%"></i></span>`;
}

function viewCar() {
  const c = car();
  // Anteckningar: rader med "namn: värde" visas som rutor, övriga rader som vanlig text. Tomma mallrader ("Motorolja:") visas inte.
  const lines = (c.specsText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const specs = lines.map((l) => { const i = l.indexOf(":"); return i > 0 && i < 40 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter((x) => x && x[1]);
  const freeLines = lines.filter((l) => { const i = l.indexOf(":"); return !(i > 0 && i < 40); });
  const st = allItemStatus(c);
  // De däck som sitter på står överst.
  const tires = ["sommar", "vinter"].sort((a, b) => ((c.tiresOn || "sommar") === b) - ((c.tiresOn || "sommar") === a)).map((k) => {
    const t = (c.tires || []).find((x) => x.kind === k) || {};
    const on = (c.tiresOn || "sommar") === k;
    const pressure = t.pressureFront != null || t.pressureRear != null
      ? `${t.pressureFront != null ? fmt(t.pressureFront, 1) : "–"} / ${t.pressureRear != null ? fmt(t.pressureRear, 1) : "–"} bar`
      : "";
    const sub = [t.brand, t.size, t.year, t.depth != null && t.depth !== "" ? `${fmt(num(t.depth), 1)} mm` : "", pressure, k === "vinter" && t.studded ? "dubbade" : ""].filter(Boolean).join(" · ");
    const depth = num(t.depth);
    const low = depth != null && depth < (k === "vinter" ? 4 : 3);
    return `<div class="dl"><div class="dl-ic">${icon("tire", 20)}</div><div><div class="dl-t">${k === "sommar" ? "Sommardäck" : "Vinterdäck"}${on ? " · sitter på" : ""}</div><div class="dl-s">${esc(sub || "Inga uppgifter")}</div></div><span class="pill ${low ? "soon" : on ? "ok" : "none"}">${low ? "Slitna" : on ? "På" : "Förråd"}</span></div>`;
  }).join("");
  return arrangeCards(`${subHeader([c.year, c.fuel].filter(Boolean).join(" · "), carName(c), false, "Bilen")}
    <div class="car-chips" role="group" aria-label="Välj bil">
      ${S.cars.map((x) => `<button type="button" data-act="pick-car" data-id="${esc(x.id)}" aria-pressed="${x.id === c.id}">${icon("car", 16)}${esc(carName(x))}</button>`).join("")}
      <button type="button" class="add" data-act="add-car">${icon("plus", 16)}Lägg till bil</button>
    </div>
    <!--card:upp--><div class="card"><h2>Uppgifter <button class="link" type="button" data-act="edit-car" data-section="basic,photo,dates">Ändra</button></h2>
      <dl class="detail-list">
        ${[["Registreringsnummer", c.plate], ["Motor", c.engine], ["Färg", c.color], ["Mätarställning", odoOf(c) != null ? `${fmt(odoOf(c))} mil` : ""], ["Sista dag för besiktning", [c.besiktning ? fmtDate(c.besiktning) : "", c.besiktningPlats].filter(Boolean).join(", ")], ["Försäkringsbolag", [c.forsakringBolag, c.forsakringDatum ? `förnyas ${fmtDate(c.forsakringDatum)}` : ""].filter(Boolean).join(", ")], ["Skatt", [c.skattBelopp ? `${fmt(c.skattBelopp)} kr/år` : "", taxMonth(c) ? MONTHS[taxMonth(c) - 1] : ""].filter(Boolean).join(", ")]]
          .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v || "–")}</dd></div>`).join("")}
      </dl>
    </div>
    <!--card:maint--><div class="card" id="underhall" style="scroll-margin-top:16px">
      <h2>Underhåll <button class="link" type="button" data-act="edit-items">Ändra</button></h2>
      <div class="rows">${st.filter((s) => s.item.mil || s.item.months || s.lastDate).map((s) => `<button class="dl as-btn" type="button" data-act="edit-item" data-id="${esc(s.item.id)}"><div class="dl-ic">${icon("wrench", 20)}</div><div><div class="dl-t">${esc(s.item.name)}</div><div class="dl-s">${esc(itemSubText(s))}</div>${wearBar(s)}</div><span class="pill ${s.unknown ? "none" : s.level}">${esc(s.noInterval ? "Inget intervall" : s.unknown ? "Okänt" : s.label)}</span></button>`).join("") || `<p class="muted">Inga punkter. Lägg till under Ändra.</p>`}</div>
      ${(() => {
        const extras = extraParts(c);
        if (!extras.length) return "";
        const rows = extras.map((x) => `<button class="dl as-btn" type="button" data-act="open-part" data-id="${esc(x.key)}"><div class="dl-ic">${icon("wrench", 20)}</div><div><div class="dl-t">${esc(x.name)}</div><div class="dl-s">${esc(`senast ${(WORK_ACTIONS[x.lastAction] || "Bytt").toLowerCase()} ${fmtDateShort(x.entries[0].date)}${x.entries.length > 1 ? ` · ${x.entries.length} gånger` : ""}`)}</div></div><span></span></button>`).join("");
        return `${S.partsAll ? `<p class="label" style="margin:14px 0 2px">Annat som har gjorts</p><div class="rows">${rows}</div>` : ""}
          <button class="link" type="button" data-act="toggle-parts" style="margin-top:10px">${S.partsAll ? "Visa färre" : `Visa ${extras.length} till`}</button>`;
      })()}
      <p class="hint" style="margin-top:10px">Intervallen är vanliga riktvärden. Kontrollera mot bilens servicebok.</p>
    </div>
    <!--card:dack--><div class="card"><h2>Däck <button class="link" type="button" data-act="edit-car" data-section="tires">Ändra</button></h2><div class="rows">${tires}</div></div>
    <!--card:media-->${docsCard(c)}
    <!--card:book--><div class="card">
      <h2>Servicebok</h2>
      <p class="muted">All service, egna jobb, däckbyten och besiktningar med datum, mätarställning och kostnad. Bra att visa en köpare eller verkstad.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="print-book">${icon("print", 16)} Dela eller spara som PDF</button>
      ${shareCardHtml(c)}</div>
    </div>`, "bilen");
}

function viewNotifications() {
  const seen = lastSeenMs();
  const c = car();
  const fl = fuelPct(c.fuelLevel);
  const reminders = [
    ...(fl != null && fl <= 25 ? [{ icon: "fuel", title: "Tanka snart", sub: `Bränslet är på ${pctText(fl).toLowerCase()}`, label: `${Math.round(fl)} %` }] : []),
    ...bookingRows(c).filter((b) => b.days <= 1),
    ...deadlines(c).filter((d) => d.level === "urgent"),
    ...allItemStatus(c).filter((s) => !s.unknown && s.level === "urgent").map((s) => ({ title: `Dags för ${s.item.name.toLowerCase()}`, sub: s.label })),
  ];
  const feed = [...S.entries, ...bookingFeed()].sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)).slice(0, 40);
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  return `${subHeader("Det ni gjort med bilen", "Aviseringar", true)}
    ${perm === "default" ? `<div class="card"><h2>Få notiser i telefonen</h2><p class="muted">Då ser du när någon av de andra loggar något. Notiserna kommer när appen är öppen eller nyss har använts.</p><div class="ask"><button class="btn-soft" type="button" data-act="enable-notif">Slå på notiser</button></div></div>` : ""}
    ${reminders.length ? `<div class="card"><h2>Påminnelser</h2><div class="rows">${reminders.map((r) => rowHtml({ icon: r.icon || "bell", title: r.title, sub: r.sub, level: "urgent", label: r.label || "Nu", act: r.act, id: r.id })).join("")}</div></div>` : ""}
    <div class="card">
      ${feed.length ? feed.map((e) => {
        const mine = e.createdBy === uid();
        const isNew = !mine && tsMs(e.createdAt) > seen;
        const otherCar = S.cars.length > 1 ? carName(S.cars.find((x) => x.id === e.carId)) : "";
        const [act, id] = feedAct(e);
        return `<button class="entry" type="button" data-act="${act}" data-id="${esc(id)}" data-car="${esc(e.carId)}">
          <span class="avatar${mine ? " me" : ""}">${esc((mine ? myName() : memberName(e.createdBy)).slice(0, 1).toUpperCase())}</span>
          <span><span class="t">${esc(activityText(e))}</span><span class="m">${esc(timeAgo(tsMs(e.createdAt)))}${otherCar ? ` · ${esc(otherCar)}` : ""}</span></span>
          <span>${isNew ? `<span class="new-pill">Ny</span>` : ""}</span>
        </button>`;
      }).join("") : `<div class="empty"><b>Inget här än</b>När någon av er loggar något syns det här.</div>`}
    </div>`;
}

function viewSettings() {
  const members = S.house?.members || [];
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const permText = { granted: "Påslagna", denied: "Avstängda i telefonens inställningar", default: "Inte påslagna", unsupported: "Stöds inte här. På iPhone: lägg först till appen på hemskärmen." }[perm];
  return `${subHeader(S.house?.name || "Hushållet", "Inställningar", true)}
    <div class="card">
      <h2>Ni som delar</h2>
      <div class="rows">${members.map((m) => `<div class="dl"><div class="avatar${m === uid() ? " me" : ""}">${esc(memberName(m).slice(0, 1).toUpperCase())}</div><div><div class="dl-t">${esc(memberName(m))}${m === uid() ? " (du)" : ""}</div><div class="dl-s">${esc(S.house.memberInfo?.[m]?.email || "")}</div></div>
        <span class="row-actions">${members.length > 1 ? (m === uid()
          ? `<button class="link danger" type="button" data-act="leave-house">Lämna</button>`
          : `<button class="link danger" type="button" data-act="remove-member" data-id="${esc(m)}" aria-label="Ta bort ${esc(memberName(m))}">Ta bort</button>`) : ""}</span></div>`).join("")}</div>
      <p class="label" style="margin-top:14px">Inbjudningskod</p>
      <p class="code" style="margin:4px 0 10px">${esc(S.house?.inviteCode || "")}</p>
      <div class="ask">
        <button class="btn-soft" type="button" data-act="copy-invite">Kopiera inbjudningslänk</button>
        <button class="link" type="button" data-act="new-invite-code">Byt kod</button>
      </div>
      <p class="hint" style="margin-top:10px">Den som har koden kan gå med. Byt kod om den har kommit på villovägar, då slutar den gamla att fungera.</p>
    </div>
    <form class="card form" data-form="rename" data-keep>
      <h2>Namn</h2>
      <label class="field"><span>Hushållets namn</span><input name="house" id="st-house" required maxlength="40" value="${esc(S.house?.name || "")}"></label>
      <label class="field"><span>Ditt namn, så ser de andra vem som har loggat</span><input name="name" id="st-name" required maxlength="30" value="${esc(myName())}"></label>
      <button class="btn primary block" type="submit">Spara</button>
    </form>
    <div class="card">
      <h2>Utseende</h2>
      <div class="theme-grid" role="group" aria-label="Tema">
        ${Object.entries(THEMES).map(([k, t]) => `<button class="theme-btn" type="button" data-act="theme" data-v="${k}" aria-pressed="${(pref.get("theme") || "auto") === k}">
          <span class="theme-sw" style="background:${t.sw}" aria-hidden="true"><i style="background:${t.dot}"></i></span>${t.name}</button>`).join("")}
      </div>
      <p class="hint" style="margin-top:10px">Automatiskt följer telefonen: Ljust eller Mörkt beroende på om telefonen har mörkt läge påslaget.</p>
    </div>
    <div class="card">
      <h2>Språk</h2>
      <div class="seg" role="group" aria-label="Språk">
        ${[["sv", "Svenska"], ["en", "English"]].map(([k, l]) => `<button type="button" data-act="lang" data-v="${k}" aria-pressed="${LANG === k}" data-notr>${l}</button>`).join("")}
      </div>
    </div>
    <div class="card">
      <h2>Notiser</h2>
      <p class="muted">${esc(permText)}</p>
      ${perm === "default" ? `<div class="ask"><button class="btn-soft" type="button" data-act="enable-notif">Slå på notiser</button></div>` : ""}
      <p class="hint" style="margin-top:10px">Notiser kommer när appen är öppen eller nyss har använts. Aviseringslistan visar alltid allt nytt.</p>
    </div>
    <div class="card">
      <h2>Bilar</h2>
      <div class="rows">${S.cars.map((x) => `<div class="dl"><div class="dl-ic">${icon("car", 20)}</div><div><div class="dl-t">${esc(carName(x))}</div><div class="dl-s">${esc([x.year, x.plate].filter(Boolean).join(" · "))}</div></div>
        <span class="row-actions">${x.id === S.carId ? `<span class="pill ok">Vald</span>` : `<button class="link" type="button" data-act="pick-car" data-id="${esc(x.id)}">Välj</button>`}
        <button class="link danger" type="button" data-act="delete-car" data-id="${esc(x.id)}" aria-label="Ta bort ${esc(carName(x))}">Ta bort</button></span></div>`).join("")}</div>
      <p class="hint" style="margin-top:10px">Ta bort raderar bilen och hela dess logg för alla ni som delar bilen. Du får frågan en gång till innan något tas bort.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="add-car">${icon("plus", 16)} Lägg till bil</button></div>
    </div>
    ${cardsSettingsCard("oversikt")}
    ${cardsSettingsCard("bilen")}
    ${shortcutsCard()}
    <div class="card">
      <h2>Säkerhetskopia</h2>
      <p class="muted"><b>Loggen</b> som kalkylark, med bokade tider, för Excel eller Numbers. Bra att ha med vid försäljning av bilen.</p>
      <p class="muted"><b>Allt</b> i en fil: uppgifter, datum, däck, underhåll, anteckningar, bokningar och hela loggen. Bilder kommer inte med.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="export-log">Ladda ner loggen</button><button class="btn-soft" type="button" data-act="export-all">Ladda ner allt</button></div>
    </div>
    <div class="card">
      <h2>Konto</h2>
      <p class="muted">Inloggad som ${esc(S.user.email || "")}</p>
      <div class="rows" style="margin-top:8px">${Object.keys(PROVIDER_IDS).map((k) => {
        const on = linkedProviders().includes(k);
        return `<div class="dl"><div class="dl-ic">${icon(k, 20)}</div><div><div class="dl-t">${PROVIDER_NAMES[k]}</div><div class="dl-s">${on ? "Kopplat, du kan logga in med det" : "Inte kopplat"}</div></div>
          ${on ? `<span class="pill ok">Kopplat</span>` : `<button class="link" type="button" data-act="link-provider" data-provider="${k}">Koppla</button>`}</div>`;
      }).join("")}</div>
      <p class="hint" style="margin-top:10px">Koppla både Google och Apple så kan du logga in med vilket du vill och ändå se samma bilar och logg.</p>
      <div class="ask"><button class="btn ghost block" type="button" data-act="logout">Logga ut</button></div>
      <div class="ask" style="justify-content:space-between">
        <a class="link" href="integritet.html" target="_blank" rel="noopener">Så hanteras dina uppgifter</a>
        <button class="link danger" type="button" data-act="delete-account">Radera mitt konto</button>
      </div>
    </div>
    <p class="hint" style="text-align:center">Bildagboken ${VERSION}</p>`;
}

/* ------------------------------------------------------------------ sheets */

const sheet = $("#sheet");
const scrim = $("#scrim");

let sheetReturnFocus = null;
// En öppen ruta läggs i webbläsarens historik, så att bakåt (Android, svep i Safari) stänger rutan i stället för appen.
let sheetHistory = null, ignorePops = 0;
function openSheet(title, body, { back = null, backId = null } = {}) {
  if (sheet.hidden) sheetReturnFocus = document.activeElement;
  if (!sheetHistory) {
    try { history.pushState({ bdSheet: 1 }, "", location.href); sheetHistory = location.href; } catch { /* historiken går inte att ändra */ }
  }
  sheet.innerHTML = `<div class="grab"></div>
    <div class="sheet-head">
      ${back ? `<button class="icon-btn" type="button" data-act="${back}"${backId ? ` data-id="${esc(backId)}"` : ""} aria-label="Tillbaka">${icon("back", 18)}</button>` : ""}
      <h3 id="sheet-title" title="${esc(title)}">${esc(title)}</h3>
      <button class="icon-btn" type="button" data-act="close-sheet" aria-label="Stäng">${icon("close", 18)}</button>
    </div>${body}`;
  sheet.setAttribute("aria-labelledby", "sheet-title");
  sheet.hidden = false;
  scrim.hidden = false;
  sheet.scrollTop = 0;
  document.body.style.overflow = "hidden";
  // Flytta fokus in i rutan, så att tangentbord och skärmläsare hamnar rätt. Fält som fokuseras senare går före.
  setTimeout(() => {
    if (sheet.hidden || sheet.contains(document.activeElement)) return;
    const h = $("#sheet-title");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }, 0);
}
// Dra rutan nedåt i handtaget eller rubriken för att stänga den, som i andra appar på telefonen.
(() => {
  let startY = null, dy = 0;
  sheet.addEventListener("touchstart", (ev) => {
    if (window.matchMedia("(min-width: 900px)").matches) return;
    if (!ev.target.closest(".grab, .sheet-head") || ev.target.closest("button")) return;
    startY = ev.touches[0].clientY; dy = 0; sheet.style.transition = "none";
  }, { passive: true });
  sheet.addEventListener("touchmove", (ev) => {
    if (startY == null) return;
    dy = Math.max(0, ev.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  const end = () => {
    if (startY == null) return;
    startY = null;
    sheet.style.transition = "transform .18s ease-out";
    if (dy > 90) { sheet.style.transform = "translateY(100%)"; setTimeout(() => { closeSheet(); sheet.style.transform = ""; sheet.style.transition = ""; }, 170); }
    else { sheet.style.transform = ""; setTimeout(() => { sheet.style.transition = ""; }, 200); }
  };
  sheet.addEventListener("touchend", end);
  sheet.addEventListener("touchcancel", end);
})();

// iPhone tappar ibland bort var skärmens nederkant är när rutor öppnas och stängs, eller när
// tangentbordet försvinner, och lägger då menyn längst ner mitt på sidan. Det här lägger tillbaka den.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
function nudgeFixed() {
  requestAnimationFrame(() => {
    window.scrollTo(window.scrollX, window.scrollY);
    nav.style.transform = "translateZ(0)";
    requestAnimationFrame(() => { nav.style.transform = ""; });
  });
}
document.addEventListener("focusout", (ev) => { if (ev.target.matches?.("input, textarea, select")) setTimeout(nudgeFixed, 60); });
window.visualViewport?.addEventListener("resize", () => setTimeout(nudgeFixed, 60));
window.addEventListener("pageshow", nudgeFixed);

function closeSheet(fromBack = false) {
  if (sheetHistory) {
    if (!fromBack && history.state?.bdSheet) { ignorePops++; history.back(); }
    sheetHistory = null;
  }
  sheet.hidden = true;
  scrim.hidden = true;
  sheet.innerHTML = "";
  document.body.style.overflow = "";
  setTimeout(nudgeFixed, 30);
  const back = sheetReturnFocus;
  sheetReturnFocus = null;
  if (back && document.contains(back) && back !== document.body) back.focus({ preventScroll: true });
}

/* Bekräftelseruta: frågar "Vill du verkligen …?" med Avbryt och Ta bort. Ger true om man trycker Ta bort. */
let confirmResolve = null;
function confirmDialog({ title, lines = [], okLabel = "Ta bort", warn = "Det går inte att ångra." }) {
  const box = $("#confirm"), dim = $("#confirm-scrim");
  $("#confirm-title").textContent = title;
  $("#confirm-body").innerHTML = lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("") + (warn ? `<p class="warn">${esc(warn)}</p>` : "");
  const yes = $("#confirm-yes");
  yes.textContent = okLabel;
  yes.className = "btn solid-danger";
  box.hidden = false;
  dim.hidden = false;
  $("#confirm-no").focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(answer) {
  $("#confirm").hidden = true;
  $("#confirm-scrim").hidden = true;
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(answer);
}
$("#confirm-yes").addEventListener("click", () => closeConfirm(true));
$("#confirm-no").addEventListener("click", () => closeConfirm(false));
$("#confirm-scrim").addEventListener("click", () => closeConfirm(false));

// Samma ordning överallt (plusmenyn och filtren i loggen), i tre grupper:
// det man gör när man kör, underhåll av bilen och övriga kostnader. Det vanligaste först i varje grupp.
const LOG_GROUPS = [
  ["Köra", ["tank", "matare", "parkering"]],
  ["Underhåll", ["service", "dack", "eget"]],
  ["Övrigt", ["besiktning", "tvatt", "kostnad"]],
];
const LOG_ORDER = LOG_GROUPS.flatMap(([, keys]) => keys);
const typeIcon = (k) => (k === "besiktning" ? "check" : TYPE[k].icon);
const typeLabel = (k) => (k === "besiktning" ? "Besiktning" : TYPE[k].label);
function typePicker() {
  openSheet("Vad vill du logga?", LOG_GROUPS.map(([name, keys]) => `<p class="types-head">${name}</p><div class="types">
    ${keys.map((k) => `<button type="button" data-act="new-entry" data-type="${k === "besiktning" ? "kostnad" : k}"${k === "besiktning" ? ' data-cat="Besiktning"' : ""}>${icon(typeIcon(k), 26)}${typeLabel(k)}</button>`).join("")}
  </div>`).join("") + `
  <p class="types-head">Boka</p><button class="btn primary block" type="button" data-act="new-booking">${icon("calendar", 18)} Lägg in bokad tid</button>
  <p class="hint" style="margin-top:14px">Det du sparar syns direkt för alla ni som delar bilen.</p>`);
}

// Snabbval under ett datumfält: I dag och I går.
function dateQuick(target) {
  return `<div class="date-quick" data-for="${target}">
    <button type="button" class="chip-btn" data-act="date-quick" data-target="${target}" data-d="0">I dag</button>
    <button type="button" class="chip-btn" data-act="date-quick" data-target="${target}" data-d="-1">I går</button>
  </div>`;
}
function markDateQuick(input) {
  const box = document.querySelector(`.date-quick[data-for="${input.id}"]`);
  if (!box) return;
  box.querySelectorAll("button").forEach((b) => {
    const d = new Date(); d.setDate(d.getDate() + Number(b.dataset.d));
    b.setAttribute("aria-pressed", String(input.value === ymd(d)));
  });
}

// Förslag i textfälten från det ni har skrivit förut: verkstäder, mackar och platser, de vanligaste först.
const SUGGEST_FIELDS = { "ef-workshop": ["workshop"], "ef-station": ["station"], "ef-place": ["place"] };
function attachSuggestions(form, type) {
  for (const [id, keys] of Object.entries(SUGGEST_FIELDS)) {
    const input = form.querySelector("#" + id);
    if (!input) continue;
    const count = new Map();
    for (const e of S.entries) {
      if (e.carId !== S.carId || (id === "ef-place" && e.type !== type)) continue;
      for (const k of keys) { const v = String(e[k] || "").trim(); if (v) count.set(v, (count.get(v) || 0) + 1); }
    }
    if (id === "ef-workshop") for (const b of car()?.bookings || []) if (b.place) count.set(b.place, (count.get(b.place) || 0) + 1);
    const values = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v]) => v);
    if (!values.length) continue;
    const listId = id + "-list";
    input.setAttribute("list", listId);
    input.insertAdjacentHTML("afterend", `<datalist id="${listId}">${values.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`);
  }
}

// Bilden i en post i full storlek. Dubbeltryck zoomar, och man kan nypa för att zooma på telefonen.
function openLightbox(src, alt = "") {
  if (!src) return;
  $("#lightbox")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Bild">
    <button class="icon-btn lb-close" type="button" data-act="lightbox-close" aria-label="Stäng bilden">${icon("close", 18)}</button>
    <div class="lb-scroll"><img src="${esc(src)}" alt="${esc(alt)}"></div>
  </div>`);
  const lb = $("#lightbox");
  lb.querySelector("img").addEventListener("dblclick", (ev) => { ev.currentTarget.classList.toggle("zoomed"); });
  lb.addEventListener("click", (ev) => { if (ev.target === lb || ev.target.classList.contains("lb-scroll")) lb.remove(); });
  lb.querySelector(".lb-close").focus();
}

function field(label, input, hint = "") {
  return `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ""}</label>`;
}

function bookingForm(b = {}) {
  const isEdit = !!b.id;
  const station = car()?.besiktningPlats || "";
  const kinds = Object.entries(BOOK_KINDS);
  openSheet(isEdit ? `${BOOK_KINDS[b.kind] || "Bokning"} ${fmtDateShort(b.date)}` : "Bokad tid", `
    <form class="form" data-form="booking"${isEdit ? ` data-id="${esc(b.id)}"` : ""} novalidate>
      ${isEdit ? `<button class="btn ghost block" type="button" data-act="booking-done" data-id="${esc(b.id)}">${b.kind === "annat" ? "Klart, ta bort bokningen" : "Klart, logga det"}</button>` : ""}
      ${field("Vad är bokat?", `<select name="kind" id="bk-kind">${kinds.map(([k, l]) => `<option value="${k}"${(b.kind || "service") === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
      ${(() => {
        // Datum i ett stort fält och tiden i ett snurrhjul som i Apples egna appar. Heldag betyder ingen tid.
        const t = b.time || "";
        return field("Datum", `<input type="date" name="date" id="bk-date" required value="${esc(b.date || "")}" class="big-date">`)
          + `<div class="field"><span>Tid</span>
            <label class="ios-switch-row"><span>Heldag</span><input type="checkbox" id="bk-allday" class="ios-switch"${b.id && !t ? " checked" : ""}></label>
            <div class="wheel" id="bk-wheel"${b.id && !t ? " hidden" : ""} aria-label="Välj tid">
              <div class="wheel-band" aria-hidden="true"></div>
              ${wheelCol("h", Array.from({ length: 24 }, (_, i) => pad(i)), "Timme")}
              <span class="wheel-sep" aria-hidden="true">:</span>
              ${wheelCol("m", wheelMinutes(t), "Minut")}
            </div>
            <input type="hidden" name="time" id="bk-time" value="${esc(t || (b.id ? "" : "09:00"))}"></div>`;
      })()}
      ${field("Var", `<input name="place" id="bk-place" value="${esc(b.place || "")}" placeholder="Till exempel Mölndals däckservice" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="bk-suggest" aria-expanded="false">
        <span class="suggest" id="bk-suggest" role="listbox" hidden></span>`)}
      ${field("Adress", `<input name="placeAddr" id="bk-addr" value="${esc(b.addr || "")}" placeholder="Till exempel Kråketorpsgatan 20, Mölndal" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="bk-addr-suggest" aria-expanded="false">
        <input type="hidden" name="placeLat" id="bk-lat" value="${b.lat ?? ""}">
        <input type="hidden" name="placeLon" id="bk-lon" value="${b.lon ?? ""}">
        <input type="hidden" name="placeId" id="bk-pid" value="${esc(b.placeId || "")}">
        <input type="hidden" name="placeSrc" id="bk-src" value="${esc(b.geoSrc || "")}">
        <span class="suggest" id="bk-addr-suggest" role="listbox" hidden></span>`, "Med gatuadress hittar kartan rätt när bokningen ligger i kalendern.")}
      ${field("Telefon", `<input type="tel" name="phone" id="bk-phone" value="${esc(b.phone || "")}" placeholder="Fylls i från kartan om det finns" autocomplete="off">`)}
      <div class="bk-map" id="bk-map" hidden>
        <div class="bk-map-inner" id="bk-map-inner"></div>
        <button class="bk-map-open" type="button" data-act="map-open" aria-label="Öppna platsen i en kartapp"><span>${icon("pin", 14)} Öppna i kartan</span></button>
      </div>
      ${field("Anteckning", `<textarea name="note" id="bk-note" rows="2" placeholder="Till exempel lämna nyckeln i brevlådan">${esc(b.note || "")}</textarea>`)}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button>
      ${isEdit
        ? `<button class="btn ghost block" type="button" data-act="booking-calendar" data-id="${esc(b.id)}">${icon("calendar", 18)} Lägg till i kalendern</button>
           <button class="btn danger block" type="button" data-act="delete-booking" data-id="${esc(b.id)}">Ta bort bokningen</button>`
        : `<button class="btn ghost block" type="submit" name="cal" value="1">${icon("calendar", 18)} Spara och lägg till i kalendern</button>`}
      <p class="hint">Bokningen syns för alla ni som delar bilen under På gång och bland påminnelserna dagen innan. Lägger du den i kalendern påminner telefonen dig också.</p>
    </form>`, { back: isEdit ? null : "new-entry" });
  // Finns platsen redan med position visas kartan direkt.
  showBookingMap();
  refreshBookingPlace();
  // Hjulet ställs in när rutan har ritats, så att det kan rulla till rätt tid.
  requestAnimationFrame(() => setWheel(b.time || "09:00"));
  // Väljer man Besiktning och inte skrivit någon plats fylls bilens besiktningsstation i.
  const kindSel = $("#bk-kind"), placeIn = $("#bk-place");
  if (station && kindSel && placeIn) {
    const fill = () => { if (kindSel.value === "besiktning" && !placeIn.value.trim()) placeIn.value = station; };
    kindSel.addEventListener("change", fill);
    fill();
  }
}

// Snurrhjul för tid: två kolumner som snäpper fast på ett värde, med markeringen i mitten.
const WHEEL_ROW = 40;
function wheelMinutes(t) {
  const list = Array.from({ length: 12 }, (_, i) => pad(i * 5));
  const m = (t || "").slice(3, 5);
  if (m && !list.includes(m)) { list.push(m); list.sort(); }
  return list;
}
function wheelCol(name, values, label) {
  return `<div class="wheel-col" data-col="${name}" role="listbox" aria-label="${label}" tabindex="0">
    <div class="wheel-pad"></div>${values.map((v) => `<div class="wheel-item" role="option" data-v="${v}">${v}</div>`).join("")}<div class="wheel-pad"></div>
  </div>`;
}
function wheelValue() {
  const pick = (col) => { const items = [...col.querySelectorAll(".wheel-item")]; return items[Math.max(0, Math.min(items.length - 1, Math.round(col.scrollTop / WHEEL_ROW)))]; };
  const h = pick($('#bk-wheel [data-col="h"]')), m = pick($('#bk-wheel [data-col="m"]'));
  document.querySelectorAll("#bk-wheel .wheel-item").forEach((x) => x.classList.remove("sel"));
  h?.classList.add("sel"); m?.classList.add("sel");
  return h && m ? `${h.dataset.v}:${m.dataset.v}` : "";
}
function setWheel(t) {
  const [hh, mm] = (t || "09:00").split(":");
  for (const [name, v] of [["h", hh], ["m", mm]]) {
    const col = $(`#bk-wheel [data-col="${name}"]`);
    if (!col) continue;
    const items = [...col.querySelectorAll(".wheel-item")];
    const i = Math.max(0, items.findIndex((x) => x.dataset.v === v));
    col.scrollTop = i * WHEEL_ROW;
  }
  wheelValue();
}
let wheelTimer = null;
document.addEventListener("scroll", (ev) => {
  if (!ev.target.classList?.contains("wheel-col")) return;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { const v = wheelValue(); const hid = $("#bk-time"); if (hid && !$("#bk-allday")?.checked) hid.value = v; }, 90);
}, true);
// Tryck på ett värde i hjulet: rulla dit.
document.addEventListener("click", (ev) => {
  const it = ev.target.closest?.(".wheel-item");
  if (!it) return;
  const col = it.parentElement;
  col.scrollTo({ top: [...col.querySelectorAll(".wheel-item")].indexOf(it) * WHEEL_ROW, behavior: "smooth" });
});
// Piltangenter i hjulet (dator).
document.addEventListener("keydown", (ev) => {
  const col = ev.target.closest?.(".wheel-col");
  if (!col || !["ArrowUp", "ArrowDown"].includes(ev.key)) return;
  ev.preventDefault();
  col.scrollTop += ev.key === "ArrowDown" ? WHEEL_ROW : -WHEEL_ROW;
});

// Vanliga tider för bokningar, som knappar i formuläret.
const BOOK_TIMES = ["07:00", "07:30", "08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
function setBookingTime(v) {
  const hid = $("#bk-time");
  if (!hid) return;
  hid.value = v || "";
  document.querySelectorAll("[data-act=bk-time]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === hid.value)));
  const other = document.querySelector(".time-other");
  const isOther = !!v && !BOOK_TIMES.includes(v);
  other?.classList.toggle("on", isOther);
  const lab = $("#bk-time-label");
  if (lab) lab.textContent = isOther ? v : "Annan tid";
  if (!isOther && $("#bk-time-other")) $("#bk-time-other").value = "";
}
function saveBooking(form, wantCalendar = false) {
  const c = car();
  const fd = new FormData(form);
  const str = (k) => String(fd.get(k) ?? "").trim();
  const date = str("date");
  const time = str("time");
  if (!date) return formError("Välj vilket datum som är bokat.");
  const id = form.dataset.id || "b" + randomId(8);
  const lat = num(fd.get("placeLat")), lon = num(fd.get("placeLon"));
  const prev = (c.bookings || []).find((x) => x.id === id);
  const b = clean({
    id, kind: str("kind") || "service", date, time: time || null, place: str("place") || null,
    addr: str("placeAddr") || null, lat: lat ?? null, lon: lon ?? null,
    placeId: lat != null ? str("placeId") || null : null, geoSrc: lat != null ? str("placeSrc") || null : null,
    note: str("note") || null, phone: str("phone") || null,
    // Vem som bokade och när behålls när bokningen ändras (visas under Senaste).
    createdBy: prev?.createdBy || uid(), createdAt: prev?.createdAt || Date.now(),
  });
  const list = (c.bookings || []).filter((x) => x.id !== id);
  list.push(b);
  updateDoc(ref("cars", c.id), { bookings: list }).catch(onWriteError);
  closeSheet();
  showToast(form.dataset.id ? "Bokningen är ändrad" : `${BOOK_KINDS[b.kind]} ${bookingWhen(b).toLowerCase()} är inlagd`);
  if (wantCalendar) addToCalendar(bookingCalendarEvent(b, c));
}

/* ---------------------------------------------------------- säkerhetskopia */

// Hela loggen som en CSV-fil som Excel, Numbers och Google Kalkylark öppnar direkt (semikolon och decimalkomma).
function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Loggen och de bokade tiderna som kalkylark (semikolon och decimalkomma, som Excel och Numbers öppnar direkt).
function exportLog() {
  const bookings = S.cars.flatMap((c) => (c.bookings || []).map((b) => ({ c, b })));
  if (!S.entries.length && !bookings.length) return showToast("Det finns inget loggat att ladda ner än.");
  const cell = (v) => {
    if (v == null || v === "") return "";
    const t = typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ["Bil", "Reg.nr", "Datum", "Typ", "Vad", "Detaljer", "Belopp (kr)", "Mätarställning (mil)", "Mängd", "Drivmedel", "Verkstad", "Station eller plats", "Anteckning", "Loggad av"];
  const rows = [...S.entries, ...S.cars.flatMap((x) => recurringEntries(x))].sort((a, b) => (a.date || "").localeCompare(b.date || "")).map((e) => {
    const c = S.cars.find((x) => x.id === e.carId);
    return [
      c ? carName(c) : "Borttagen bil", c?.plate, e.date, TYPE[e.type]?.label || e.type, entryTitle(e), entryDetail(e, c),
      e.amount, e.odometer, e.liters, e.fuel, e.workshop, e.station || e.place, e.note, memberName(e.createdBy),
    ].map(cell).join(";");
  });
  const bookRows = bookings.sort((x, y) => (x.b.date || "").localeCompare(y.b.date || "")).map(({ c, b }) => [
    carName(c), c.plate, b.date, "Bokad tid", BOOK_KINDS[b.kind] || "Bokning", [b.time ? `kl ${b.time}` : "", b.addr].filter(Boolean).join(" · "),
    "", "", "", "", "", b.place, b.note, memberName(b.createdBy),
  ].map(cell).join(";"));
  downloadFile(`Bildagboken ${todayStr()}.csv`, "﻿" + [head.join(";"), ...rows, ...bookRows].join("\r\n"), "text/csv;charset=utf-8");
  showToast(`Loggen är nedladdad (${S.entries.length} poster${bookings.length ? ` och ${bookings.length} bokade tider` : ""}).`);
}

// Allt om bilarna i en fil: uppgifter, datum, däck, underhåll, anteckningar, bokningar och hela loggen.
// Bilder tas inte med, de skulle göra filen för stor.
function exportAll() {
  const plain = (v) => {
    if (v && typeof v.toMillis === "function") return new Date(v.toMillis()).toISOString();
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
    return v;
  };
  const data = {
    app: "Bildagboken", version: VERSION, exported: new Date().toISOString(),
    household: S.house?.name || null,
    members: Object.fromEntries((S.house?.members || []).map((m) => [m, memberName(m)])),
    cars: S.cars.map((c) => plain({ ...c, imageUrl: undefined, imageFallback: undefined, imageCredit: undefined, imageChecked: undefined })),
    entries: S.entries.map((e) => plain(e)),
  };
  downloadFile(`Bildagboken säkerhetskopia ${todayStr()}.json`, JSON.stringify(data, null, 2), "application/json");
  showToast(`Säkerhetskopian är nedladdad (${S.cars.length} ${S.cars.length === 1 ? "bil" : "bilar"}, ${S.entries.length} poster).`);
}

/* ------------------------------------------------------------- kalender */

// Bygger en kalenderfil (.ics) som iPhone, Android och datorer kan lägga in i kalendern.
function buildIcs({ uid: eventId, title, date, time = null, durationMin = 60, location = null, geo = null, description = null, alarm }) {
  const esc2 = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  const ymdC = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hm = (d) => `${ymdC(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const d = typeof date === "string" ? parseDate(date) : new Date(date);
  let start, end;
  if (time) {
    const [h, m] = time.split(":").map(Number);
    const s = new Date(d); s.setHours(h || 0, m || 0, 0, 0);
    const e = new Date(s.getTime() + durationMin * 60000);
    start = `DTSTART:${hm(s)}`; end = `DTEND:${hm(e)}`;
  } else {
    const e = new Date(d); e.setDate(e.getDate() + 1);
    start = `DTSTART;VALUE=DATE:${ymdC(d)}`; end = `DTEND;VALUE=DATE:${ymdC(e)}`;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bildagboken//SV", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${eventId}@bildagboken`, `DTSTAMP:${stamp}`, start, end,
    `SUMMARY:${esc2(title)}`,
    location ? `LOCATION:${esc2(location)}` : null,
    // Position: GEO för alla kalendrar, och Apples egen rad så att iPhone visar kartan och vägbeskrivning.
    geo ? `GEO:${geo.lat};${geo.lon}` : null,
    geo ? `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-ADDRESS="${String(geo.address || "").replace(/"/g, "")}";X-TITLE="${String(geo.title || "").replace(/"/g, "")}":geo:${geo.lat},${geo.lon}` : null,
    description ? `DESCRIPTION:${esc2(description)}` : null,
    // Påminnelse: dagen innan för bokade tider, en vecka innan för sista datum.
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc2(title)}`, `TRIGGER:${alarm || (time ? "-P1D" : "-PT15H")}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).map(foldIcs).join("\r\n");
}

// Kalenderfiler ska ha högst 75 byte per rad; längre rader delas med radbrytning och mellanslag.
function foldIcs(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ""; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

// Flera händelser i en och samma kalenderfil.
function deadlineEvent(x, c) {
  return {
    uid: `${c.id}-${x.key}-${ymd(x.date)}`,
    title: `${x.calTitle}: ${carName(c)}`,
    date: x.date,
    location: x.place,
    description: [x.place ? x.sub.replace(` · ${x.place}`, "") : x.sub, c.plate ? `Reg.nr ${c.plate}` : null, "Inlagd från Bildagboken"].filter(Boolean).join("\n"),
    alarm: "-P6DT15H",
    fileName: `${x.title} ${ymd(x.date)}`,
  };
}
// Alla kommande bokningar och sista datum för alla bilar, i en fil.
function addToCalendar(ev) {
  const ics = ev._ics || buildIcs(ev);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const a = document.createElement("a");
  a.href = url;
  // På iPhone öppnas kalenderfilen direkt och man trycker "Lägg till". På dator laddas filen ner.
  if (!ios) a.download = `${(ev.fileName || ev.title || "bildagboken").replace(/[^\wåäöÅÄÖ -]/g, "").trim() || "bildagboken"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  showToast(ios ? "Tryck på Lägg till för att spara i kalendern." : "Kalenderfilen laddas ner. Öppna den så läggs händelsen in i kalendern.", 6000);
}

function bookingCalendarEvent(b, c = car()) {
  const kind = BOOK_KINDS[b.kind] || "Bokning";
  return {
    uid: `${c.id}-${b.id}`,
    title: `${kind}: ${carName(c)}`,
    date: b.date,
    time: b.time,
    durationMin: b.kind === "besiktning" ? 30 : 60,
    location: [b.place, b.addr].filter(Boolean).join(", "),
    geo: b.lat != null && b.lon != null ? { lat: b.lat, lon: b.lon, title: b.place, address: b.addr } : null,
    description: [b.note, c.plate ? `Reg.nr ${c.plate}` : null, "Inlagd från Bildagboken"].filter(Boolean).join("\n"),
    fileName: `${kind} ${b.date}`,
  };
}

function deadlineSheet(key) {
  const c = car();
  const x = deadlines(c).find((d) => d.key === key);
  if (!x) return;
  const section = key === "dack" ? "tires" : "dates";
  const about = {
    besiktning: "Det här är sista dagen bilen måste vara besiktigad. Datumet står i besiktningsprotokollet och hos Transportstyrelsen. När du har bokat en tid hos stationen, lägg in den som bokad tid, så visas den i stället.",
    forsakring: "Dagen då försäkringen förnyas. Bra tillfälle att jämföra priser några veckor innan.",
    skatt: "Månaden då fordonsskatten ska betalas, senast sista dagen i månaden. Den styrs av sista siffran i registreringsnumret, men går att ändra under Ändra datum.",
    dack: "Räknas ut från årstiden och vilka däck som sitter på.",
  }[key];
  const removable = key === "besiktning" || key === "forsakring" || key === "skatt";
  openSheet(x.title, `
    ${about ? `<p class="muted" style="margin:0 0 14px">${esc(about)}</p>` : ""}
    <dl class="detail-list">
      <div><dt>Datum</dt><dd>${esc(fmtDate(x.date))}</dd></div>
      <div><dt>Kvar</dt><dd>${esc(x.label)}</dd></div>
      ${(() => {
        // Bara det som inte redan står i Datum: station, försäkringsbolag eller belopp.
        const extra = { besiktning: c.besiktningPlats, forsakring: c.forsakringBolag }[key] ?? (key === "skatt" || key === "dack" ? x.sub : "");
        const label = { besiktning: "Station", forsakring: "Bolag", skatt: "Att betala", dack: "Däck" }[key] || "Detaljer";
        return extra ? `<div><dt>${label}</dt><dd>${esc(extra)}</dd></div>` : "";
      })()}
    </dl>
    <div class="form" style="margin-top:18px">
      ${key === "besiktning" ? `<button class="btn primary block" type="button" data-act="book-inspection">${icon("calendar", 18)} Lägg in bokad tid</button>` : ""}
      <button class="btn ${key === "besiktning" ? "ghost" : "primary"} block" type="button" data-act="deadline-calendar" data-id="${esc(key)}">${icon("calendar", 18)} Lägg till i kalendern</button>
      <button class="btn ghost block" type="button" data-act="edit-car" data-section="${section}">Ändra datum</button>
      ${removable ? `<button class="btn danger block" type="button" data-act="deadline-remove" data-id="${esc(key)}">Ta bort datumet</button>` : ""}
      <p class="hint">Kalendern påminner dig en vecka innan.</p>
    </div>`);
}

function removeBooking(carId, bookingId) {
  const c = S.cars.find((x) => x.id === carId);
  if (!c) return;
  updateDoc(ref("cars", c.id), { bookings: (c.bookings || []).filter((x) => x.id !== bookingId) }).catch(onWriteError);
}

function entryForm(type, e = {}, opts = {}) {
  const c = car();
  const v = (k) => esc(e[k] ?? "");
  const date = field("Datum", `<input type="date" name="date" id="ef-date" required value="${esc(e.date || todayStr())}">`) + (e.id ? "" : dateQuick("ef-date"));
  const odo = (required = false) => field("Mätarställning (mil)", `<input name="odometer" id="ef-odometer" inputmode="numeric" ${required ? "required" : ""} placeholder="${odoOf(c) != null ? `Senast ${fmt(odoOf(c))}` : "Till exempel 21 480"}" value="${e.odometer ?? ""}">`);
  const amount = (example, label = "Kostnad (kr)", extra = "", hint = "") => field(label, `<input name="amount" id="ef-amount" inputmode="decimal"${extra} value="${e.amount ?? ""}" placeholder="Till exempel ${example}">`, hint);
  const note = field("Anteckning", `<textarea name="note" id="ef-note" rows="2">${v("note")}</textarea>`);
  const photo = `<label class="photo-in">${icon("image", 22)}<span id="photo-label">${e.photoId ? "Bild bifogad. Välj en ny för att byta." : "Lägg till kvitto eller bild"}</span><input type="file" name="photo" id="ef-photo" accept="image/*"></label>`;
  // "Det här gjordes": underhållspunkterna (som förut) och egna delar. Ikryssad rad visar åtgärd och, där det passar, position.
  const workSection = ["service", "eget"].includes(type) ? workFormHtml(c, workOf(e, c)) : "";
  const items = workSection, parts = "";
  // Anteckning och bild ligger under "Fler detaljer" i alla formulär, öppet om något redan är ifyllt.
  const more = (extra = "", open = false) => `<details class="more"${open || e.note || e.photoId ? " open" : ""}>
          <summary>Fler detaljer (valfritt)</summary>
          <div class="form">${extra}${note}${photo}</div>
        </details>`;
  let body = "";
  switch (type) {
    case "tank": {
      const fuels = fuelOptions(c);
      body = `${amount("579", "Kostnad (kr)", " required", "Läs av pumpen med kameran: tryck i fältet, välj <b>Skanna text</b> och peka på totalsumman.")}
        ${!e.id ? (() => {
          const seen = new Set();
          const last = S.entries.filter((x) => x.carId === c.id && x.type === "tank" && x.amount > 0).map((x) => x.amount).filter((a) => !seen.has(a) && seen.add(a)).slice(0, 3);
          return last.length ? `<div class="date-quick">${last.map((a) => `<button type="button" class="chip-btn" data-act="amount-quick" data-v="${esc(fmtKr(a))}">${esc(fmtKr(a))} kr</button>`).join("")}</div>` : "";
        })() : ""}
        <label class="check"><input type="checkbox" name="full" id="ef-full"${e.full === false ? "" : " checked"}> Tankade fullt</label>
        ${odo(false)}
        ${date}
        ${more(`<div class="row2">
              ${field("Drivmedel", `<select name="fuel" id="ef-fuel">${fuels.map((f) => `<option${(e.fuel || pref.get("fuel." + c.id) || fuels[0]) === f ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>`)}
              ${field("Station", geoInput("station", "ef-station", e.station, "fuel", ""))}
            </div>`, !!e.station)}`;
      break;
    }
    case "matare":
      body = `${odo(true)}${date}`;
      break;
    // Samma ordning i alla formulär: vad → belopp → mätarställning → datum → detaljer.
    case "service":
      body = `${items}${parts}
        ${field("Verkstad", `<input name="workshop" id="ef-workshop" value="${v("workshop")}" placeholder="Till exempel Mekonomen">`)}
        ${amount("2 500")}${odo(false)}${date}${more()}`;
      break;
    case "eget":
      body = `${field("Vad gjorde du?", `<input name="title" id="ef-title" required value="${v("title")}" placeholder="Till exempel bytte glödlampa bak">`)}
        ${items}${parts}${amount("450", "Kostnad för delar (kr)")}${odo(false)}${date}${more()}`;
      break;
    case "dack": {
      const actDefault = e.tireAction || ((c.tiresOn || "sommar") === "sommar" ? "till_vinter" : "till_sommar");
      body = `${field("Vad gjordes?", `<select name="tireAction" id="ef-tireAction">${Object.entries(TIRE_ACTIONS).map(([k, l]) => `<option value="${k}"${actDefault === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
        <div class="row2" id="ef-tire-row">
          <div id="ef-tirekind-box"${isSwap(actDefault) ? " hidden" : ""}>${field("Vilka däck?", `<select name="tireKind" id="ef-tireKind"><option value="">Välj</option><option value="sommar"${e.tireKind === "sommar" ? " selected" : ""}>Sommardäck</option><option value="vinter"${e.tireKind === "vinter" ? " selected" : ""}>Vinterdäck</option></select>`)}</div>
          ${field("Mönsterdjup (mm)", `<input name="depth" id="ef-depth" inputmode="decimal" value="${e.depth ?? ""}" placeholder="Valfritt">`)}
        </div>
        ${field("Var", `<input name="place" id="ef-place" value="${v("place")}" placeholder="Valfritt, till exempel Mölndals däckservice" autocomplete="off">`)}
        ${amount("800")}${odo(false)}${date}${more()}`;
      break;
    }
    case "tvatt":
      body = `${field("Var", geoInput("place", "ef-place", e.place ?? (e.id ? "" : pref.get("wash." + c.id) || ""), "car_wash", "Till exempel Circle K Mölndal"))}
        ${amount("149")}
        ${date}${more()}`;
      break;
    case "parkering":
      body = `${field("Var", geoInput("place", "ef-place", e.place, "parking", "Till exempel Kungsgatan, Göteborg"))}
        ${amount("45")}
        <label class="check"><input type="checkbox" name="fine" id="ef-fine"${e.fine ? " checked" : ""}> P-bot eller felparkeringsavgift</label>
        ${!e.id ? `<label class="check"><input type="checkbox" name="recurring" id="ef-recurring"${opts.recurringId ? " checked" : ""}> Återkommande (hyrd plats)</label>
        <div id="ef-rec-box"${opts.recurringId ? "" : " hidden"}>
          <div class="row2">
            ${field("Hur ofta", `<select name="period" id="ef-period">${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}"${String(e.period || 1) === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
            ${field("Slutar", `<input type="date" name="endDate" id="ef-endDate" value="${esc(e.end || "")}">`, "Lämna tom om den fortsätter.")}
          </div>
          <p class="hint">Kostnaden ovan gäller per gång, och första betalningen anges nedanför. Den räknas in i Ekonomi och loggen varje gång, utan att du behöver logga den igen.</p>
        </div>` : ""}
        ${date}${more()}`;
      break;
    case "kostnad":
      // Besiktning har en egen knapp i plusmenyn: då finns ingen Typ-lista, och Besiktning finns inte bland andra kostnader.
      body = `${e.category === "Besiktning"
        ? `<input type="hidden" name="category" id="ef-category" value="Besiktning">`
        : field("Typ", `<select name="category" id="ef-category">${COST_CATS.filter((k) => !["Tvätt", "Parkering", "Besiktning"].includes(k) || e.category === k).map((k) => `<option${e.category === k ? " selected" : ""}>${k}</option>`).join("")}</select>`)}
        ${field("Beskrivning", `<input name="title" id="ef-title" value="${v("title")}" placeholder="Valfritt, till exempel Halvförsäkring 2027">`)}
        ${amount(e.category === "Besiktning" ? "520" : "3 200")}${date}
        ${!e.id ? `<div id="ef-next-besikt"${e.category === "Besiktning" ? "" : " hidden"}>${field("Nästa besiktning senast (valfritt)", `<input type="date" name="nextBesiktning" id="ef-nextBesiktning" value="${e.category === "Besiktning" ? esc(suggestNextInspection(e.date || todayStr(), c)) : ""}">`, "Uträknat från besiktningens datum. Kontrollera mot protokollet.")}</div>
        <p class="hint" id="ef-old-besikt" hidden>Det här är en äldre besiktning, så nästa datum behövs inte. Den sparas bara i loggen.</p>` : ""}
        ${more()}`;
      break;
  }
  const isEdit = !!e.id;
  const formTitle = type === "kostnad" && e.category === "Besiktning" ? "Besiktning" : TYPE[type].label;
  openSheet(isEdit ? `Ändra ${formTitle.toLowerCase()}` : formTitle, `
    <form class="form" data-form="entry" data-type="${type}"${isEdit ? ` data-id="${esc(e.id)}"` : ""}${opts.recurringId ? ` data-rec="${esc(opts.recurringId)}"` : ""}${opts.bookingId ? ` data-booking="${esc(opts.bookingId)}"` : ""} novalidate>
      ${!isEdit && RECEIPT_TYPES.includes(type) ? receiptButton() : ""}
      ${body}
      ${e.loc ? `<input type="hidden" name="loc" value="${esc(JSON.stringify(e.loc))}">` : ""}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button>
    </form>`, opts.back ? { back: opts.back, backId: opts.backId } : isEdit ? { back: "open-entry", backId: e.id } : { back: opts.bookingId ? null : "new-entry" });
  if (opts.recurringId) { const lab = $("#ef-date")?.closest("label")?.querySelector("span"); if (lab) lab.textContent = "Första betalningen"; }
  const ef = $('form[data-form="entry"]');
  if (ef) { attachSuggestions(ef, type); if ($("#ef-date")) markDateQuick($("#ef-date")); }
  // Sätt markören i första fältet bara på dator. På telefon öppnar det tangentbordet direkt och döljer formuläret.
  if (!window.matchMedia("(pointer: coarse)").matches) {
    if (type === "tank" && !isEdit) $("#ef-amount")?.focus({ preventScroll: true });
    if (type === "matare") $("#ef-odometer")?.focus({ preventScroll: true });
  }
}

/* ------------------------------------------------- sök företag och adress */

// Förslag medan man skriver, från Photon (byggd på OpenStreetMap), bara inom Sverige.
// "Var" föreslår företag och platser, "Adress" föreslår gator. Kartan saknar ofta husnummer,
// så det nummer man själv skriver behålls när man väljer en gata.
const PLACE_FIELDS = {
  poi: { input: "bk-place", box: "bk-suggest" },
  addr: { input: "bk-addr", box: "bk-addr-suggest" },
};
let placeTimer = null, placeAbort = null;
function placeSearchSoon(kind) {
  clearTimeout(placeTimer);
  const f = PLACE_FIELDS[kind];
  const input = document.getElementById(f.input), box = document.getElementById(f.box);
  const q = input?.value.trim() || "";
  Object.values(PLACE_FIELDS).forEach((x) => { const b = document.getElementById(x.box); if (b && b !== box) b.hidden = true; });
  if (q.length < 3) { if (box) box.hidden = true; input?.setAttribute("aria-expanded", "false"); return; }
  placeTimer = setTimeout(() => placeSearch(kind, q), 400);
}

const cityOf = (pr) => pr.city || pr.town || pr.village || pr.district || pr.locality || "";
const isStreet = (pr) => pr.osm_key === "highway" || pr.type === "street";
const isArea = (pr) => ["place", "boundary", "landuse"].includes(pr.osm_key) || ["city", "district", "county", "state", "country"].includes(pr.type);

// Adressrad för ett förslag. Saknas husnummer används det man har skrivit.
function addrOf(pr, typedNo = "") {
  const street = isStreet(pr) ? pr.name : pr.street;
  const no = pr.housenumber || (isStreet(pr) ? typedNo : "");
  return [[street, no].filter(Boolean).join(" "), [pr.postcode, cityOf(pr)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// Apple Maps via MapKit JS. Laddas först när den behövs. Utan token, eller om Apple inte svarar, används OpenStreetMap.
let mapkitPromise = null;
function loadMapKit() {
  if (!MAPKIT_TOKEN) return Promise.reject(new Error("ingen token"));
  if (window.mapkit?.Search && mapkitPromise) return mapkitPromise;
  if (mapkitPromise) return mapkitPromise;
  mapkitPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { mapkitPromise = null; reject(new Error("timeout")); }, 10000);
    window.__bdMapkitReady = () => {
      try {
        window.mapkit.init({ authorizationCallback: (done) => done(MAPKIT_TOKEN), language: "sv" });
        clearTimeout(timer);
        resolve(window.mapkit);
      } catch (e) { clearTimeout(timer); mapkitPromise = null; reject(e); }
    };
    const sc = document.createElement("script");
    sc.src = "https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.core.js";
    sc.crossOrigin = "anonymous";
    sc.async = true;
    sc.dataset.callback = "__bdMapkitReady";
    sc.dataset.libraries = "services,full-map";
    sc.onerror = () => { clearTimeout(timer); mapkitPromise = null; reject(new Error("kunde inte ladda")); };
    document.head.appendChild(sc);
  });
  return mapkitPromise;
}

const stripCountry = (a) => String(a || "").replace(/,?\s*(Sverige|Sweden)$/i, "").trim();

// Sök företag eller adresser i Apple Maps, i Sverige.
// Var sökningen ska utgå från, så att närmaste träffar kommer först.
// Telefonens position om man tillåter det (sparas en stund), annars platser ni har sparat i appen, annars hela Sverige.
let searchCenterCache = null;
async function searchCenter() {
  const fresh = (p) => p && Date.now() - p.at < 30 * 60000;
  if (fresh(searchCenterCache)) return searchCenterCache;
  try { const saved = JSON.parse(pref.get("searchPos") || "null"); if (fresh(saved)) return (searchCenterCache = saved); } catch { /* inget sparat */ }
  if (pref.get("searchPosDenied") !== "1" && "geolocation" in navigator) {
    try {
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 6000, maximumAge: 10 * 60000 }));
      searchCenterCache = { lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now(), gps: true };
      pref.set("searchPos", JSON.stringify(searchCenterCache));
      return searchCenterCache;
    } catch (e) { if (e?.code === 1) pref.set("searchPosDenied", "1"); }
  }
  // Mitten av de platser ni har sparat (bokningar och poster med position).
  const pts = [...S.cars.flatMap((c) => (c.bookings || []).filter((b) => b.lat != null).map((b) => [b.lat, b.lon])), ...S.entries.filter((e) => e.loc?.lat != null).map((e) => [e.loc.lat, e.loc.lon])];
  if (pts.length) {
    const mid = (i) => pts.map((p) => p[i]).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
    return (searchCenterCache = { lat: mid(0), lon: mid(1), at: Date.now() });
  }
  return null;
}
async function appleSearch(kind, q) {
  const mk = await loadMapKit();
  const center = await searchCenter();
  const region = center
    ? new mk.CoordinateRegion(new mk.Coordinate(center.lat, center.lon), new mk.CoordinateSpan(0.6, 1))
    : new mk.CoordinateRegion(new mk.Coordinate(62.5, 16.5), new mk.CoordinateSpan(15, 20));
  const search = new mk.Search({ language: "sv-SE", region });
  const opts = { limitToCountries: "SE", language: "sv-SE" };
  const run = (query) => new Promise((resolve) => {
    try { search.search(query, (err, d) => resolve(err ? [] : d?.places || []), opts); } catch { resolve([]); }
  });
  // Apple har två sökningar: vanlig sökning och förslag medan man skriver (som i Kartor-appen).
  // Förslagen hittar oftare mindre företag, så båda används och träffarna slås ihop.
  const suggest = () => new Promise((resolve) => {
    if (typeof search.autocomplete !== "function") return resolve([]);
    try { search.autocomplete(q, (err, d) => resolve(err ? [] : d?.results || []), opts); } catch { resolve([]); }
  });
  const [direct, suggestions] = await Promise.all([run(q), suggest()]);
  const extra = [];
  for (const r of suggestions.slice(0, 4)) {
    // Ett förslag utan position söks upp, så att det får adress och plats på kartan.
    const places = await run(r);
    if (places[0]) extra.push(places[0]);
  }
  const seenPlace = new Set();
  const places = [...direct, ...extra].filter((pl) => {
    const key = `${pl.name}|${pl.coordinate?.latitude?.toFixed?.(4)}|${pl.coordinate?.longitude?.toFixed?.(4)}`;
    return !seenPlace.has(key) && seenPlace.add(key);
  });
  return places.filter((pl) => !pl.countryCode || pl.countryCode === "SE").map((pl) => {
    const street = [pl.thoroughfare, pl.subThoroughfare].filter(Boolean).join(" ");
    const addr = stripCountry(pl.formattedAddress) || [street, [pl.postCode, pl.locality].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const isPoi = !!pl.pointOfInterestCategory || (pl.name && pl.name !== street && pl.name !== pl.locality);
    const lat = pl.coordinate?.latitude, lon = pl.coordinate?.longitude;
    const pid = pl.id || "";
    const tel = pl.telephone || pl.phoneNumber || "";
    return kind === "poi"
      ? (isPoi ? { title: pl.name, sub: addr, name: pl.name, addr, lat, lon, pid, tel, src: "apple" } : null)
      : { title: addr.split(", ")[0], sub: addr.split(", ").slice(1).join(", "), name: "", addr, lat, lon, pid: "", src: "apple" };
  }).filter(Boolean)
    // Närmast först när vi vet var man är.
    .map((x, i) => ({ x, i, d: center && x.lat != null ? distM(center, { lat: x.lat, lon: x.lon }) : i }))
    .sort((a, b) => (center ? a.d - b.d : a.i - b.i)).map((o) => o.x);
}

// Sök i OpenStreetMap (Photon). Används när Apple Maps inte går att nå.
async function photonSearch(kind, q, signal) {
  const typedNo = (q.match(/\b(\d{1,4}[a-zA-Z]?)\b/) || [])[1] || "";
  // Kartan hittar inget om husnumret är med, så adresser söks utan nummer och numret läggs till efteråt.
  const searchQ = kind === "addr" && typedNo ? q.replace(new RegExp(`\\b${typedNo}\\b`), " ").replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim() : q;
  const center = await searchCenter().catch(() => null);
  const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(searchQ)}&limit=8&bbox=10.5,55.0,24.3,69.1${center ? `&lat=${center.lat}&lon=${center.lon}&location_bias_scale=0.5` : ""}`, { signal });
  if (!res.ok) throw new Error("photon " + res.status);
  const j = await res.json();
  return (j.features || [])
    .filter((x) => (x.properties?.countrycode || "SE") === "SE")
    .filter((x) => (kind === "poi" ? !isStreet(x.properties) && !isArea(x.properties) && x.properties.name : !isArea(x.properties)))
    .map((x) => {
      const pr = x.properties;
      const [lon, lat] = x.geometry?.coordinates || [];
      const addr = addrOf(pr, typedNo);
      return kind === "poi" ? { title: pr.name, sub: addr, name: pr.name, addr, lat, lon } : { title: addr.split(", ")[0], sub: addr.split(", ").slice(1).join(", "), name: "", addr, lat, lon };
    });
}

async function placeSearch(kind, q) {
  const f = PLACE_FIELDS[kind];
  const input = document.getElementById(f.input), box = document.getElementById(f.box);
  if (!box || !input) return;
  placeAbort?.abort();
  placeAbort = new AbortController();
  const signal = placeAbort.signal;
  try {
    let found;
    try { found = await appleSearch(kind, q); } catch { found = null; }
    if (signal.aborted) return;
    // Hittar Apple inget, eller svarar inte, provas OpenStreetMap.
    if (!found || !found.length) found = await photonSearch(kind, q, signal).catch(() => found || []);
    if (input.value.trim() !== q) return;
    const seen = new Set();
    const list = found.filter((x) => x.title && !seen.has(x.title + x.sub) && seen.add(x.title + x.sub)).slice(0, 6);
    box.innerHTML = list.length
      ? list.map((x) => `<button type="button" role="option" data-act="place-pick" data-kind="${kind}" data-name="${esc(x.name)}" data-addr="${esc(x.addr)}" data-lat="${x.lat ?? ""}" data-lon="${x.lon ?? ""}" data-pid="${esc(x.pid || "")}" data-tel="${esc(x.tel || "")}" data-src="${x.src || ""}"><b>${esc(x.title)}</b>${x.sub ? `<span>${esc(x.sub)}</span>` : ""}</button>`).join("")
      : `<p class="hint">${kind === "poi" ? "Hittade inget företag med det namnet. Skriv namnet själv och fyll i adressen nedanför." : "Hittade ingen adress. Skriv den själv, den kommer ändå med i kalendern."}</p>`;
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
  } catch (e) {
    if (e.name !== "AbortError") { box.innerHTML = `<p class="hint">Sökningen fungerar inte just nu. Du kan skriva själv.</p>`; box.hidden = false; }
  }
}

// Liten karta under adressen i bokningen. Apple Maps om det går, annars en karta från OpenStreetMap.
let bookingMap = null;
async function showBookingMap() {
  const box = $("#bk-map"), inner = $("#bk-map-inner");
  if (!box || !inner) return;
  const lat = num($("#bk-lat")?.value), lon = num($("#bk-lon")?.value);
  if (lat == null || lon == null) { box.hidden = true; return; }
  box.hidden = false;
  return miniMap(inner, lat, lon, $("#bk-place")?.value || "");
}
// Liten karta med en nål. Apple Maps om det går, annars OpenStreetMap.
async function miniMap(inner, lat, lon, title = "") {
  try { bookingMap?.destroy?.(); } catch { /* redan borta */ }
  bookingMap = null;
  inner.innerHTML = "";
  try {
    const mk = await loadMapKit();
    if (!document.contains(inner)) return;
    const coord = new mk.Coordinate(lat, lon);
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    bookingMap = new mk.Map(inner, {
      center: coord, isScrollEnabled: false, isZoomEnabled: false, isRotationEnabled: false,
      showsMapTypeControl: false, showsZoomControl: false, showsUserLocationControl: false,
      showsCompass: mk.FeatureVisibility?.Hidden, showsScale: mk.FeatureVisibility?.Hidden,
      colorScheme: dark ? mk.Map?.ColorSchemes?.Dark : mk.Map?.ColorSchemes?.Light,
    });
    bookingMap.cameraDistance = 900;
    bookingMap.addAnnotation(new mk.MarkerAnnotation(coord, { title, color: "#E77026" }));
  } catch (err) {
    console.warn("Apple-kartan kunde inte visas", err);
    const d = 0.004;
    inner.innerHTML = `<iframe title="Karta" loading="lazy" referrerpolicy="no-referrer" src="https://www.openstreetmap.org/export/embed.html?bbox=${lon - d},${lat - d / 2},${lon + d},${lat + d / 2}&layer=mapnik&marker=${lat},${lon}"></iframe>`;
  }
}

// Saknar adressen position (skriven för hand) letas den upp, så att kartan kan visas.
async function geocodeBookingAddress() {
  const addr = $("#bk-addr")?.value.trim();
  if (!addr || num($("#bk-lat")?.value) != null) return;
  let hit = null;
  try { hit = (await appleSearch("addr", addr))[0]; } catch { /* försök med OpenStreetMap */ }
  if (!hit) { try { hit = (await photonSearch("addr", addr))[0]; } catch { /* ingen träff */ } }
  if (!hit || $("#bk-addr")?.value.trim() !== addr) return;
  const set = (id, v) => { const x = document.getElementById(id); if (x) x.value = v ?? ""; };
  set("bk-lat", hit.lat); set("bk-lon", hit.lon); set("bk-pid", hit.pid || ""); set("bk-src", hit.src || "");
  showBookingMap();
}

// Äldre bokningar fick sin position från OpenStreetMap, som ofta bara hittar gatan och inte huset.
// Går Apple Maps att nå letas platsen upp där i stället, och rättas i bokningen.
async function refreshBookingPlace() {
  const form = $('form[data-form="booking"]');
  const name = $("#bk-place")?.value.trim() || "", addr = $("#bk-addr")?.value.trim() || "";
  if (!form?.dataset.id || $("#bk-src")?.value === "apple" || (!name && !addr)) return;
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9åäö]/g, "");
  const street = norm(addr.split(",")[0]);
  let hit = null;
  try {
    if (name) {
      const list = await appleSearch("poi", addr ? `${name}, ${addr}` : name);
      const near = (x) => !street || norm(x.addr).includes(street) || norm(x.addr.split(",")[0]) === street;
      hit = list.find((x) => near(x) && (norm(x.name).includes(norm(name).slice(0, 6)) || norm(name).includes(norm(x.name).slice(0, 6)))) || list.find(near) || null;
    }
    if (!hit && addr) hit = (await appleSearch("addr", addr))[0] || null;
  } catch { return; }
  if (!hit || hit.lat == null || !document.contains(form)) return;
  if (($("#bk-place")?.value.trim() || "") !== name || ($("#bk-addr")?.value.trim() || "") !== addr) return;
  const set = (id, v) => { const x = document.getElementById(id); if (x) x.value = v ?? ""; };
  set("bk-lat", hit.lat); set("bk-lon", hit.lon); set("bk-pid", hit.pid || ""); set("bk-src", "apple");
  showBookingMap();
  // Spara den rättade positionen direkt, så att kalendern och kartlänkarna också blir rätt.
  const c = car(), id = form.dataset.id;
  const list = (c?.bookings || []).map((x) => (x.id === id ? clean({ ...x, lat: hit.lat, lon: hit.lon, placeId: hit.pid || null, geoSrc: "apple" }) : x));
  if (c && list.some((x) => x.id === id)) updateDoc(ref("cars", c.id), { bookings: list }).catch(onWriteError);
}

// Välj kartapp: Apple Kartor eller Google Maps, med platsen ifylld.
// Med Apples plats-id öppnas företagets egen sida i Apple Kartor (öppettider, telefon och vägbeskrivning).
// Utan id söks företagets namn nära platsen, så att Kartor hittar företaget och inte bara sätter en nål.
function openMapChooser({ name, addr, lat, lon, pid, directions = false }) {
  const q = [name, addr].filter(Boolean).join(", ");
  if (directions) return mapChoiceDialog("Vägbeskrivning", q,
    // Apples nya kartlänkar: /directions med destination och färdsätt. Med plats-id hittar Kartor rätt företag.
    `https://maps.apple.com/directions?${new URLSearchParams({ destination: addr || q || `${lat},${lon}`, ...(pid ? { "destination-place-id": pid } : {}), mode: "driving" }).toString().replace(/\+/g, "%20")}`,
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q || `${lat},${lon}`)}&travelmode=driving`);
  const near = lat != null ? { sll: `${lat},${lon}` } : addr ? { near: addr } : {};
  const apple = pid
    ? `https://maps.apple.com/place?${new URLSearchParams({ "place-id": pid, ...(name ? { name } : {}) })}`
    : name
      ? `https://maps.apple.com/?${new URLSearchParams({ q: name, ...near })}`
      : `https://maps.apple.com/?${new URLSearchParams({ address: addr || `${lat},${lon}`, ...(lat != null ? { ll: `${lat},${lon}` } : {}) })}`;
  const google = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || `${lat},${lon}`)}`;
  mapChoiceDialog("Öppna i kartan", q, apple, google);
}
function mapChoiceDialog(title, q, apple, google) {
  document.getElementById("map-choice")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div class="confirm-scrim" id="map-choice-scrim" data-act="map-choice-close"></div>
    <div class="confirm" id="map-choice" role="dialog" aria-modal="true" aria-labelledby="map-choice-t">
      <h3 id="map-choice-t">${esc(title)}</h3>
      ${q ? `<p style="margin:0 0 12px;color:var(--ink-2)">${esc(q)}</p>` : ""}
      <div class="form">
        <a class="btn primary block" href="${esc(apple)}" target="_blank" rel="noopener" data-act="map-choice-close">Apple Kartor</a>
        <a class="btn ghost block" href="${esc(google)}" target="_blank" rel="noopener" data-act="map-choice-close">Google Maps</a>
        <button class="btn ghost block" type="button" data-act="map-choice-close">Avbryt</button>
      </div>
    </div>`);
  $("#map-choice a")?.focus();
}

/* ----------------------------------------------------------- plats (GPS) */

// Textfält med en knapp som fyller i närmaste tvätt eller mack utifrån telefonens position.
function geoInput(name, id, value, kind, placeholder) {
  return `<span class="geo-row"><input name="${name}" id="${id}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}" autocomplete="off">
    <button class="geo-btn" type="button" data-act="geo-fill" data-kind="${kind}" data-target="${id}" aria-label="Använd min plats" title="Använd min plats">${icon("pin", 20)}</button></span>
    <span class="geo-picks" id="${id}-picks" hidden></span>`;
}

const distM = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Biltvättar eller mackar nära positionen, närmast först, från OpenStreetMap (Overpass).
async function nearbyPlaces(kind, lat, lon, radius) {
  const q = `[out:json][timeout:10];(node(around:${radius},${lat},${lon})[amenity=${kind}];way(around:${radius},${lat},${lon})[amenity=${kind}];);out center tags 20;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  if (!res.ok) throw new Error("overpass " + res.status);
  const j = await res.json();
  const seen = new Set();
  return (j.elements || []).map((el) => {
    const t = el.tags || {};
    const p = el.center || el;
    const base = t.name || t.brand || t.operator;
    if (!base || p.lat == null) return null;
    const city = t["addr:city"];
    return { name: city && !base.includes(city) ? `${base} ${city}` : base, d: distM({ lat, lon }, { lat: p.lat, lon: p.lon }) };
  }).filter(Boolean).sort((a, b) => a.d - b.d).map((x) => x.name).filter((n) => !seen.has(n) && seen.add(n));
}

// Gata och ort för positionen, om ingen tvätt eller mack hittas (Nominatim).
async function reverseAddress(lat, lon) {
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=sv&lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error("nominatim " + res.status);
  const j = await res.json();
  const a = j.address || {};
  const road = a.road || a.pedestrian || a.neighbourhood || "";
  const area = a.town || a.city || a.village || a.suburb || a.municipality || "";
  const named = j.name && j.name !== road ? j.name : "";
  return [named || road, area].filter(Boolean).join(", ");
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject({ code: "unsupported" });
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}

function workRowHtml(r, w, n) {
  const showPos = !(r.itemId && NO_POSITION.includes(r.itemId));
  const action = w?.action || "bytt";
  return `<div class="work-row" data-key="${esc(r.key)}" data-item="${esc(r.itemId || "")}" data-name="${esc(r.name)}">
    <label class="check"><input type="checkbox" class="w-on"${w ? " checked" : ""}> ${esc(r.name)}</label>
    <div class="w-opts">
      <div class="w-act" role="radiogroup" aria-label="Vad gjordes med ${esc(r.name.toLowerCase())}">${Object.entries(WORK_ACTIONS).map(([k, l]) => `<label><input type="radio" name="wa${n}" value="${k}"${action === k ? " checked" : ""}><span>${l}</span></label>`).join("")}</div>
      ${showPos ? `<div class="w-sides${positionsFor(r.itemId) === CORNERS ? " corners" : ""}" role="group" aria-label="Var på bilen">${positionsFor(r.itemId).map((pos) => `<label><input type="checkbox" value="${pos}"${sidesOf(w).includes(pos) ? " checked" : ""}><span>${pos}</span></label>`).join("")}</div>` : ""}
    </div>
  </div>`;
}

let workRowSeq = 0;
function workFormHtml(c, work) {
  const byKey = new Map(work.map((w) => [w.itemId ? `item:${w.itemId}` : normWord(w.name), w]));
  const rows = (c.items || []).map((i) => ({ key: `item:${i.id}`, itemId: i.id, name: i.name }));
  // Egna delar som redan finns i posten (till exempel när man ändrar en service).
  for (const w of work) if (!w.itemId) rows.push({ key: normWord(w.name), itemId: null, name: w.name });
  return `<fieldset><legend>Det här gjordes</legend>
    <div class="checks" id="work-rows">${rows.map((r) => workRowHtml(r, byKey.get(r.key), ++workRowSeq)).join("")}</div>
    <div class="w-add">
      <input id="w-search" placeholder="Sök eller lägg till en del, till exempel bromsskivor" autocomplete="off" aria-label="Sök eller lägg till en del">
      <span class="suggest" id="w-suggest" role="listbox" hidden></span>
    </div>
    <p class="hint" style="margin-top:6px">Kryssa i det som gjordes. Bara <b>Bytt</b> räknas som nytt byte för underhållet. Fyllt på, rengjort och kontrollerat syns i historiken.</p>
  </fieldset>`;
}

// Förslag i sökrutan: egna delar som använts förut och inte redan finns i listan, plus "Lägg till …".
function workSuggest(q) {
  const box = $("#w-suggest");
  if (!box) return;
  const t = normWord(q);
  if (!t) { box.hidden = true; return; }
  const present = new Set([...document.querySelectorAll("#work-rows .work-row")].map((r) => r.dataset.key));
  const c = car();
  const itemHit = (c.items || []).find((i) => normWord(i.name) === t || nameMatchesItem(q, i));
  const known = extraParts(c).filter((x) => !present.has(x.key) && x.key.includes(t)).slice(0, 5);
  const exact = known.some((x) => x.key === t) || itemHit;
  box.innerHTML = [
    ...known.map((x) => `<button type="button" data-act="w-add" data-name="${esc(x.name)}"><b>${esc(x.name)}</b><span>Använd förut</span></button>`),
    itemHit ? `<button type="button" data-act="w-add" data-item="${esc(itemHit.id)}" data-name="${esc(itemHit.name)}"><b>${esc(itemHit.name)}</b><span>Finns i listan ovan, kryssa i den</span></button>` : "",
    !exact ? `<button type="button" data-act="w-add" data-name="${esc(q.trim().replace(/^./, (x) => x.toUpperCase()))}"><b>Lägg till ”${esc(q.trim())}”</b><span>Ny del</span></button>` : "",
  ].join("");
  box.hidden = !box.innerHTML;
}

function formError(msg) {
  const el = $("#form-err");
  if (el) { el.textContent = msg; el.hidden = false; }
}

async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let max = 1400, q = 0.72, out = "";
    for (let tries = 0; tries < 6; tries++) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.naturalWidth * scale);
      cv.height = Math.round(img.naturalHeight * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      out = cv.toDataURL("image/jpeg", q);
      if (out.length < 850000) return out;
      max *= 0.8; q -= 0.08;
    }
    return out.length < 1000000 ? out : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function saveEntry(form) {
  const type = form.dataset.type;
  const id = form.dataset.id || null;
  const existing = id ? S.entries.find((x) => x.id === id) : null;
  const c = car();
  const fd = new FormData(form);
  const str = (k) => String(fd.get(k) ?? "").trim();
  const data = { type, carId: existing?.carId || c.id, date: str("date") || todayStr(), note: str("note") || null };
  try { const l = JSON.parse(str("loc") || "null"); if (l && typeof l === "object") data.loc = l; } catch { /* ingen plats */ }
  const typedPlace = str("workshop") || str("place");
  if (data.loc?.name && typedPlace && typedPlace !== data.loc.name) data.loc = null;
  data.odometer = num(fd.get("odometer"));
  if (fd.has("amount")) data.amount = num(fd.get("amount"));

  if (data.odometer != null && (data.odometer < 0 || data.odometer > 200000)) return formError("Mätarställningen ser fel ut. Ange den i mil, till exempel 21 480.");
  // Varna om mätarställningen är lägre än den senaste (vanligt när man tappar en siffra).
  // Varnar också om en äldre post får högre mätarställning än en senare.
  if (data.odometer != null && form.dataset.odoOk !== "1") {
    const odoEnts = S.entries.filter((e) => e.carId === data.carId && e.odometer != null && e.id !== id);
    // Samma dag jämförs bara för nya poster, så att man kan ändra en äldre post från samma dag utan varning.
    const before = odoEnts.filter((e) => ((e.date || "") < data.date || ((e.date || "") === data.date && !id)) && e.odometer > data.odometer).sort((a, b) => b.odometer - a.odometer)[0];
    const after = odoEnts.filter((e) => (e.date || "") > data.date && e.odometer < data.odometer).sort((a, b) => a.odometer - b.odometer)[0];
    if (before) {
      form.dataset.odoOk = "1";
      return formError(`${fmt(data.odometer)} mil är lägre än tidigare (${fmt(before.odometer)} mil, ${fmtDateShort(before.date)}). Stämmer det? Tryck Spara igen för att spara ändå.`);
    }
    if (after) {
      form.dataset.odoOk = "1";
      return formError(`${fmt(data.odometer)} mil är högre än en senare post (${fmt(after.odometer)} mil, ${fmtDateShort(after.date)}). Stämmer datumet? Tryck Spara igen för att spara ändå.`);
    }
  }

  switch (type) {
    case "tank": {
      // Liter fylls inte i längre. Äldre tankningar som har liter behåller dem, och literpriset följer beloppet.
      data.fuel = str("fuel");
      data.station = str("station") || null;
      data.full = fd.get("full") === "on";
      if (data.amount == null || data.amount <= 0) return formError("Fyll i vad tankningen kostade.");
      if (existing?.liters > 0) data.pricePerL = Math.round((data.amount / existing.liters) * 100) / 100;
      pref.set("fuel." + c.id, data.fuel);
      break;
    }
    case "matare":
      if (data.odometer == null) return formError("Fyll i mätarställningen.");
      break;
    case "service":
    case "eget":
      {
        // Läs raderna i "Det här gjordes". items och parts sparas också (bara byten), så att äldre funktioner fungerar som förut.
        const seen = new Set();
        data.work = [...form.querySelectorAll(".work-row")].filter((row) => row.querySelector(".w-on")?.checked).map((row) => ({
          key: row.dataset.key,
          itemId: row.dataset.item || null,
          name: row.dataset.name,
          action: row.querySelector(".w-act input:checked")?.value || "bytt",
          sides: [...row.querySelectorAll(".w-sides input:checked")].map((x) => x.value),
        })).filter((w) => !seen.has(w.key) && seen.add(w.key));
        data.items = data.work.filter((w) => w.action === "bytt" && w.itemId).map((w) => w.itemId);
        data.parts = data.work.filter((w) => w.action === "bytt" && !w.itemId).map((w) => w.name);
      }
      data.workshop = type === "service" ? str("workshop") || null : null;
      data.title = type === "eget" ? str("title") : null;
      if (type === "eget" && !data.title) return formError("Skriv vad du gjorde.");
      break;
    case "dack":
      data.tireAction = str("tireAction");
      data.depth = num(fd.get("depth"));
      data.tireKind = data.tireAction === "till_vinter" ? "vinter" : data.tireAction === "till_sommar" ? "sommar" : str("tireKind") || null;
      data.place = str("place") || null;
      break;
    case "tvatt":
      data.place = str("place") || null;
      if (data.amount != null && data.amount < 0) return formError("Kostnaden kan inte vara mindre än noll.");
      if (data.place) pref.set("wash." + c.id, data.place);
      break;
    case "parkering":
      data.place = str("place") || null;
      data.fine = fd.get("fine") === "on";
      if (data.amount != null && data.amount < 0) return formError("Kostnaden kan inte vara mindre än noll.");
      // Återkommande: spara som regel på bilen i stället för en enskild post.
      if (fd.get("recurring") === "on" && !existing) {
        if (!data.amount) return formError("Fyll i vad platsen kostar per gång.");
        const end = str("endDate") || null;
        if (end && end < data.date) return formError("Slutdatumet ska ligga efter första betalningen.");
        const rid = form.dataset.rec || "r" + randomId(8);
        const prev = (c.recurring || []).find((x) => x.id === rid);
        const rule = clean({ id: rid, type: "parkering", place: data.place, amount: data.amount, period: Number(str("period")) || 1, start: data.date, end, note: data.note, createdBy: prev?.createdBy || uid(), createdAt: prev?.createdAt || Date.now() });
        const list = [...(c.recurring || []).filter((x) => x.id !== rid), rule];
        updateDoc(ref("cars", c.id), { recurring: list }).catch(onWriteError);
        c.recurring = list;
        closeSheet();
        showToast(prev ? "Den återkommande parkeringen är ändrad" : `Återkommande parkering inlagd: ${fmtKr(rule.amount)} kr ${PERIODS[rule.period].toLowerCase()}`, 5000);
        render();
        return;
      }
      break;
    case "kostnad":
      data.category = str("category");
      data.title = str("title") || null;
      if (data.amount == null && data.category !== "Besiktning") return formError("Fyll i kostnaden.");
      if (data.category === "Besiktning" && str("nextBesiktning") && str("nextBesiktning") <= data.date) return formError("Nästa besiktning ska ligga efter den här.");
      break;
  }

  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = "Sparar …"; }

  const file = fd.get("photo");
  if (file && file.size) {
    try {
      const dataUrl = await compressImage(file);
      if (!dataUrl) throw new Error("för stor");
      const pRef = doc(col("photos"));
      setDoc(pRef, { data: dataUrl, carId: data.carId, createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
      if (existing?.photoId) deleteDoc(ref("photos", existing.photoId)).catch(() => {});
      data.photoId = pRef.id;
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = "Spara"; }
      return formError("Bilden gick inte att läsa in. Prova en annan bild eller ta ett nytt foto.");
    }
  }

  const payload = clean(data);
  if (existing) {
    updateDoc(ref("entries", existing.id), { ...payload, updatedAt: serverTimestamp() }).catch(onWriteError);
  } else {
    setDoc(doc(col("entries")), { ...payload, createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
  }

  // Håll bilens uppgifter i takt med loggen.
  const carTarget = S.cars.find((x) => x.id === data.carId) || c;
  const carUpdate = {};
  if (type === "dack" && !existing) {
    if (data.tireAction === "till_vinter") carUpdate.tiresOn = "vinter";
    if (data.tireAction === "till_sommar") carUpdate.tiresOn = "sommar";
  }
  if (type === "dack" && data.depth != null && data.tireKind) {
    const tires = [...(carTarget.tires || [])];
    const i = tires.findIndex((t) => t.kind === data.tireKind);
    if (i >= 0) tires[i] = { ...tires[i], depth: data.depth };
    else tires.push({ kind: data.tireKind, depth: data.depth });
    carUpdate.tires = tires;
  }
  // Fulltankning sätter bränslemätaren till Full.
  if (type === "tank" && data.full && !existing) {
    carUpdate.fuelLevel = { level: 8, pct: 100, by: uid(), at: serverTimestamp(), via: "tank" };
  }
  // Gjord besiktning: flytta "Besiktning senast" till nästa datum.
  // Bara om det nya datumet är senare än det som redan finns, så att en gammal besiktning inte flyttar sista dagen bakåt.
  if (type === "kostnad" && data.category === "Besiktning" && str("nextBesiktning") && str("nextBesiktning") > (carTarget.besiktning || "")) carUpdate.besiktning = str("nextBesiktning");
  if (form.dataset.booking) {
    carUpdate.bookings = (carTarget.bookings || []).filter((x) => x.id !== form.dataset.booking);
  }
  if (Object.keys(carUpdate).length) updateDoc(ref("cars", carTarget.id), carUpdate).catch(onWriteError);

  closeSheet();
  showToast(existing ? "Ändringen är sparad" : `${TYPE[type].label} sparad${type === "tank" ? ". De andra ser den direkt." : ""}`);
  if (!existing && S.view !== "oversikt" && S.view !== "logg") setView("logg");
}

// Var något gjordes: verkstaden, platsen eller namnet från bokningen.
const PLACE_TYPES = ["service", "dack", "kostnad"];
function entryPlaceName(e) {
  if (!PLACE_TYPES.includes(e.type) && !e.loc) return "";
  return e.loc?.name || e.workshop || e.place || (e.type === "kostnad" && e.category === "Besiktning" ? (e.title || "").replace(/^Besiktning hos /, "") : "") || "";
}
// Kartan i en post. Saknar posten position letas platsen upp i Apple Maps en gång och sparas.
// En adress med gata och nummer, inte bara en ort ("Kråketorpsgatan 20, 431 53 Mölndal").
const hasStreet = (a) => /\d/.test(String(a || "").split(",")[0]);
async function showEntryMap(e) {
  const box = $("#en-map"), inner = $("#en-map-inner");
  if (!box || !inner) return;
  let loc = e.loc;
  // Saknas position, eller är adressen bara en ort (då hittades staden i stället för företaget), letas platsen upp.
  // Bara en träff med gatuadress godtas. Görs en gång per post.
  if ((loc?.lat == null || !hasStreet(loc.addr)) && !loc?.checked) {
    const name = entryPlaceName(e);
    if (!name || name === "Besiktning") { if (loc?.lat == null) return; }
    else {
      try {
        const city = loc?.addr && !hasStreet(loc.addr) ? loc.addr : "";
        let hit = null;
        for (const q of [name, city && `${name} ${city}`].filter(Boolean)) {
          const list = [...(await appleSearch("poi", q)), ...(await appleSearch("addr", q))];
          hit = list.find((x) => x.lat != null && hasStreet(x.addr));
          if (hit) break;
        }
        if (!document.contains(box)) return;
        loc = hit
          ? clean({ name: e.loc?.name || name, addr: hit.addr, lat: hit.lat, lon: hit.lon, pid: hit.pid || null })
          : loc?.lat != null ? { ...loc, checked: true } : null;
        if (loc) { updateDoc(ref("entries", e.id), { loc }).catch(onWriteError); e.loc = loc; }
        // Visa adressen i listan ovanför kartan när den har hittats.
        const dd = [...document.querySelectorAll("#sheet .detail-list dt")].find((d) => d.textContent === "Adress");
        if (hit && dd) dd.nextElementSibling.textContent = hit.addr;
        else if (hit) document.querySelector("#sheet .detail-list")?.insertAdjacentHTML("beforeend", `<div><dt>Adress</dt><dd>${esc(hit.addr)}</dd></div>`);
        if (!hit) dd?.parentElement.remove();
      } catch { if (loc?.lat == null) return; }
    }
    if (!loc || loc.lat == null) return;
  }
  box.hidden = false;
  miniMap(inner, loc.lat, loc.lon, loc.name || "");
}

function openEntry(id, { fromCat = null } = {}) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  const c = S.cars.find((x) => x.id === e.carId) || car();
  const rows = [
    ["Datum", fmtDate(e.date)],
    ["Loggad av", whoName(e.createdBy)],
    e.odometer != null ? ["Mätarställning", `${fmt(e.odometer)} mil`] : null,
    e.amount != null ? ["Kostnad", `${fmtKr(e.amount)} kr`] : null,
    e.liters != null ? ["Mängd", `${fmt(e.liters, 2)} ${/kWh/.test(e.fuel || "") ? "kWh" : "l"} ${e.fuel || ""}`] : null,
    e.pricePerL != null ? ["Pris", `${fmt(e.pricePerL, 2)} kr per enhet`] : null,
    e.type === "tank" ? ["Fulltankad", e.full ? "Ja" : "Nej"] : null,
    e.station ? ["Station", e.station] : null,
    e.place ? ["Plats", e.place] : null,
    e.type === "parkering" && e.fine ? ["Typ", "P-bot eller felparkeringsavgift"] : null,
    e.workshop ? ["Verkstad", e.workshop] : null,
    hasStreet(e.loc?.addr) ? ["Adress", e.loc.addr] : null,
    e.category && e.type === "kostnad" ? ["Typ", e.category] : null,
    e.depth != null ? ["Mönsterdjup", `${fmt(e.depth, 1)} mm`] : null,
    ["service", "eget"].includes(e.type) && workOf(e, c).length ? ["Gjordes", workOf(e, c).map(workText).join(", ")] : null,
    e.note ? ["Anteckning", e.note] : null,
  ].filter(Boolean);
  openSheet(entryTitle(e), `
    <dl class="detail-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${entryPlaceName(e) ? `<div class="bk-map" id="en-map"${e.loc?.lat != null ? "" : " hidden"} style="margin-top:14px">
      <div class="bk-map-inner" id="en-map-inner"></div>
      <button class="bk-map-open" type="button" data-act="entry-map" data-id="${esc(e.id)}" aria-label="Öppna platsen i en kartapp"><span>${icon("pin", 14)} Öppna i kartan</span></button>
    </div>` : ""}
    ${e.photoId ? `<div id="photo-box" style="margin-top:14px"><p class="hint">Hämtar bilden …</p></div>` : ""}
    <div class="btn-row" style="margin-top:18px">
      <button class="btn primary" type="button" data-act="edit-entry" data-id="${esc(e.id)}">Ändra</button>
      <button class="btn danger" type="button" data-act="delete-entry" data-id="${esc(e.id)}">Ta bort</button>
    </div>
    ${e.recurringId || e._virtual ? "" : `<button class="btn ghost block" type="button" data-act="log-again" data-id="${esc(e.id)}" style="margin-top:10px">${icon("plus", 18)} Logga igen</button>`}`, fromCat?.startsWith("item:") ? { back: "edit-item", backId: fromCat.slice(5) } : fromCat?.startsWith("part:") ? { back: "open-part", backId: fromCat.slice(5) } : fromCat ? { back: "open-cat", backId: fromCat } : {});
  if (entryPlaceName(e)) showEntryMap(e);
  if (e.photoId) {
    getDoc(ref("photos", e.photoId)).then((s) => {
      const box = $("#photo-box");
      if (!box) return;
      box.innerHTML = s.exists() ? `<button class="photo-zoom" type="button" data-act="photo-zoom" aria-label="Visa bilden större"><img class="photo" src="${esc(s.data().data)}" alt="Bifogad bild för ${esc(entryTitle(e))}"></button>` : `<p class="hint">Bilden finns inte längre.</p>`;
    }).catch(() => { const box = $("#photo-box"); if (box) box.innerHTML = `<p class="hint">Bilden gick inte att hämta just nu.</p>`; });
  }
}

// En underhållspunkt: status, alla loggade byten (ikryssade eller skrivna i Annat som byttes) och knappar för att logga eller ändra.
function itemSheet(id) {
  const c = car();
  const item = (c.items || []).find((i) => i.id === id);
  if (!item) return;
  const st = itemStatus(item, c, carEntries());
  const history = carEntries().filter((e) => entryTouches(e, item)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const interval = intervalText(item) === "inget intervall" ? "" : intervalText(item);
  const manual = item.baseDate && !history.some((e) => e.date >= item.baseDate);
  openSheet(item.name, `
    <dl class="detail-list">
      <div><dt>Intervall</dt><dd>${esc(interval || "–")}</dd></div>
      <div><dt>Senast bytt</dt><dd>${esc(st.lastDate ? [fmtDate(st.lastDate), st.lastMil != null ? `vid ${fmt(st.lastMil)} mil` : ""].filter(Boolean).join(", ") : "Okänt")}</dd></div>
      ${!st.unknown ? `<div><dt>Nästa</dt><dd>${esc(dueText(st) || "–")}</dd></div><div><dt>Kvar</dt><dd>${esc(st.label)}</dd></div>` : ""}
    </dl>
    ${wearBar(st) ? `<div style="margin-top:12px">${wearBar(st)}</div>` : ""}
    <h3 class="section-t" style="margin-top:20px">I loggen</h3>
    ${history.length
      ? `<div class="rows" style="margin-top:6px">${history.map((e) => entryRow(e, `item:${id}`)).join("")}</div>`
      : `<p class="muted" style="margin-top:6px">Inga loggade byten än. Kryssa i ${esc(item.name.toLowerCase())} när du loggar en service eller ett eget jobb, så hamnar det här.</p>`}
    ${manual ? `<p class="hint" style="margin-top:8px">Senaste byte är ifyllt för hand under Underhåll: ${esc(fmtDate(item.baseDate))}${item.baseMil != null ? ` vid ${fmt(item.baseMil)} mil` : ""}.</p>` : ""}
    <div class="form" style="margin-top:18px">
      <button class="btn primary block" type="button" data-act="log-item" data-id="${esc(id)}">Logga byte</button>
      <button class="btn ghost block" type="button" data-act="edit-item-form" data-id="${esc(id)}">Ändra intervall eller senaste byte</button>
    </div>`);
}

function recurringSheet(rid) {
  const c = car();
  const r = (c.recurring || []).find((x) => x.id === rid);
  if (!r) return;
  const paid = recurringEntries({ ...c, recurring: [r] });
  const sum = paid.reduce((a, e) => a + (e.amount || 0), 0);
  const ended = r.end && r.end <= todayStr();
  openSheet(r.place ? `Parkering · ${r.place}` : "Återkommande parkering", `
    <dl class="detail-list">
      <div><dt>Kostnad</dt><dd>${esc(`${fmtKr(r.amount)} kr, ${PERIODS[r.period]?.toLowerCase()}`)}</dd></div>
      <div><dt>Började</dt><dd>${esc(fmtDate(r.start))}</dd></div>
      <div><dt>Slutar</dt><dd>${esc(r.end ? fmtDate(r.end) : "Pågår")}</dd></div>
      <div><dt>Betalt hittills</dt><dd>${esc(`${fmtKr(sum)} kr · ${paid.length} ${paid.length === 1 ? "gång" : "gånger"}`)}</dd></div>
      ${r.note ? `<div><dt>Anteckning</dt><dd>${esc(r.note)}</dd></div>` : ""}
    </dl>
    <div class="form" style="margin-top:18px">
      <button class="btn primary block" type="button" data-act="edit-rec" data-id="${esc(r.id)}">Ändra</button>
      ${!ended ? `<button class="btn ghost block" type="button" data-act="end-rec" data-id="${esc(r.id)}">Avsluta från i dag</button>` : ""}
      <button class="btn danger block" type="button" data-act="delete-rec" data-id="${esc(r.id)}">Ta bort</button>
      <p class="hint">Betalningarna räknas fram automatiskt. Säger du upp platsen, välj Avsluta så finns det som har betalats kvar. Höjs priset: avsluta den här och lägg in en ny från det datumet, så stämmer de tidigare betalningarna. Ändrar du beloppet här gäller det alla betalningar.</p>
    </div>`);
}

function partSheet(key) {
  const c = car();
  const x = extraParts(c).find((p) => p.key === key);
  if (!x) return;
  openSheet(x.name, `
    <dl class="detail-list">
      <div><dt>Senast</dt><dd>${esc(`${WORK_ACTIONS[x.lastAction] || "Bytt"} ${fmtDate(x.entries[0].date)}`)}</dd></div>
      <div><dt>Antal gånger</dt><dd>${x.entries.length}</dd></div>
    </dl>
    <h3 class="section-t" style="margin-top:20px">I loggen</h3>
    <div class="rows" style="margin-top:6px">${x.entries.map((e) => entryRow(e, `part:${key}`)).join("")}</div>
    <div class="form" style="margin-top:18px">
      <button class="btn primary block" type="button" data-act="log-part" data-id="${esc(x.name)}">Logga byte</button>
      <button class="btn ghost block" type="button" data-act="part-to-item" data-id="${esc(x.name)}">Gör till underhållspunkt</button>
      <p class="hint">Som underhållspunkt kan delen få ett intervall och en stapel som visar när det är dags igen.</p>
    </div>`);
}

function itemsSheet(focusId = null) {
  const c = car();
  openSheet("Underhåll", `
    <form class="form" data-form="items" novalidate>
      <p class="hint">Fyll i när det gjordes senast om det inte finns i loggen. När ni loggar en service där punkten är ikryssad som Bytt räknas den om automatiskt.</p>
      <div class="form" id="item-rows">${(c.items || []).map(itemRowHtml).join("")}</div>
      <button class="btn ghost block" type="button" data-act="add-item-row">Lägg till punkt</button>
      <button class="btn primary block" type="submit">Spara</button>
      <button class="link" type="button" data-act="reset-items" style="align-self:center">Återställ standardpunkter för ${esc(`${c.make} ${c.model}`)}</button>
    </form>`);
  // Öppnad från en viss punkt: visa den och markera den.
  if (focusId) {
    const row = sheet.querySelector(`.item-row[data-item="${CSS.escape(focusId)}"]`);
    if (row) {
      row.classList.add("focus");
      setTimeout(() => {
        row.scrollIntoView({ block: "center" });
        if (!window.matchMedia("(pointer: coarse)").matches) row.querySelector('[name="baseDate"]')?.focus({ preventScroll: true });
      }, 30);
    }
  }
}

function itemRowHtml(i) {
  return `<div class="item-row" data-item="${esc(i.id)}">
    <label class="field"><span>Namn</span><input name="name" value="${esc(i.name)}" required></label>
    <div class="row2">
      <label class="field"><span>Intervall (mil)</span><input name="mil" inputmode="numeric" value="${i.mil ?? ""}" placeholder="–"></label>
      ${(() => {
        const years = i.months && i.months % 12 === 0;
        return `<label class="field"><span>Intervall (tid)</span><span class="unit-row"><input name="months" inputmode="numeric" value="${i.months ? (years ? i.months / 12 : i.months) : ""}" placeholder="–" aria-label="Intervall i tid">
          <select name="monthsUnit" aria-label="Enhet"><option value="ar"${years || !i.months ? " selected" : ""}>år</option><option value="man"${i.months && !years ? " selected" : ""}>mån</option></select></span></label>`;
      })()}
    </div>
    <div class="row2">
      <label class="field"><span>Senast bytt</span><input name="baseDate" type="date" value="${esc(i.baseDate || "")}"></label>
      <label class="field"><span>Mätarställning då (mil)</span><input name="baseMil" inputmode="numeric" value="${i.baseMil ?? ""}"></label>
    </div>
    <button class="link" type="button" data-act="remove-item-row" style="justify-self:start">Ta bort</button>
  </div>`;
}

function carSheet(edit, sections = ["basic"]) {
  const c = edit ? car() : {};
  const title = !edit ? "Lägg till bil" : sections.length === 1 || sections[0] !== "basic" ? CAR_SECTIONS[sections[0]] : `Ändra ${c.make || ""} ${c.model || ""}`.trim();
  openSheet(title, `
    <form class="form" data-form="${edit ? "car-edit" : "car-new"}" novalidate>
      ${carFormFields(c, { sections, isNew: !edit })}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button>
      ${edit && sections.includes("basic") ? `<p class="hint">Vill du ta bort bilen? Det gör du under Inställningar → Bilar.</p>` : ""}
    </form>`);
}

async function deleteCar(carId) {
  const ents = S.entries.filter((e) => e.carId === carId);
  const carPhoto = S.cars.find((x) => x.id === carId)?.photoId;
  const ops = [ref("cars", carId), ...ents.map((e) => ref("entries", e.id)), ...ents.filter((e) => e.photoId).map((e) => ref("photos", e.photoId))];
  if (carPhoto) ops.push(ref("photos", carPhoto));
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
}

// Teman: bakgrundsfärgen (bar) används också för telefonens statusrad.
const THEMES = {
  auto: { name: "Automatiskt", sw: "linear-gradient(135deg, #E9E4DF 50%, #171514 50%)", dot: "#E77026" },
  light: { name: "Ljust", sw: "#E9E4DF", dot: "#E77026", bar: "#E9E4DF" },
  dark: { name: "Mörkt", sw: "#171514", dot: "#F08443", bar: "#171514" },
  gron: { name: "Grönt", sw: "#E1E8DE", dot: "#2E7D4F", bar: "#E1E8DE" },
  hav: { name: "Hav", sw: "#E0E7EF", dot: "#2563EB", bar: "#E0E7EF" },
  natt: { name: "Natt", sw: "#12131C", dot: "#8B7CF6", bar: "#12131C" },
};
function applyTheme(mode) {
  const root = document.documentElement;
  const t = THEMES[mode];
  if (t && mode !== "auto") root.dataset.theme = mode;
  else delete root.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = t?.bar || (/dark/.test(m.media) ? "#171514" : "#E9E4DF");
  });
}

// Läser bara de fält som finns i formuläret, så att en del aldrig skriver över en annan.
function readCarForm(form) {
  const fd = new FormData(form);
  const has = (k) => !!form.elements.namedItem(k);
  const str = (k) => String(fd.get(k) ?? "").trim();
  const data = {};
  if (has("make")) {
    Object.assign(data, {
      make: str("make"), model: str("model"), year: str("year") || null, engine: str("engine") || null,
      fuel: str("fuel"), color: str("color") || null, plate: str("plate").toUpperCase() || null,
    });
  }
  // Bara för en ny bil: blir bilens första loggpost.
  if (has("odometer")) data.odometer = num(fd.get("odometer"));
  if (has("besiktning")) {
    Object.assign(data, {
      besiktning: str("besiktning") || null,
      besiktningPlats: str("besiktningPlats") || null,
      forsakringBolag: str("forsakringBolag") || null,
      forsakringDatum: str("forsakringDatum") || null,
      skattManad: str("skattManad") === "av" ? "av" : str("skattManad") ? Number(str("skattManad")) : null,
      skattBelopp: num(fd.get("skattBelopp")),
    });
  }
  if (has("tiresOn")) {
    Object.assign(data, {
      tiresOn: str("tiresOn") || "sommar",
      tires: [
        clean({ kind: "sommar", brand: str("s_brand") || null, size: str("s_size") || null, year: str("s_year") || null, depth: num(fd.get("s_depth")), pressureFront: num(fd.get("s_pf")), pressureRear: num(fd.get("s_pr")) }),
        clean({ kind: "vinter", brand: str("w_brand") || null, size: str("w_size") || null, year: str("w_year") || null, depth: num(fd.get("w_depth")), pressureFront: num(fd.get("w_pf")), pressureRear: num(fd.get("w_pr")), studded: fd.get("w_studded") === "on" }),
      ],
    });
  }
  if (has("specsText")) data.specsText = String(fd.get("specsText") ?? "");
  return data;
}

/* ----------------------------------------------------------------- actions */

function setView(v) {
  if (arranging) exitArrange(true);
  rememberPrev(v);
  S.view = v;
  if (location.hash !== "#" + v) history.replaceState(history.state, "", "#" + v);
  render();
  window.scrollTo(0, 0);
  if (v === "aviseringar" && S.hid) {
    updateDoc(doc(db, "households", S.hid), { [`memberInfo.${uid()}.lastSeen`]: serverTimestamp() }).catch(() => {});
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const ACTIONS = {
  async login(el) {
    const provider = authProvider(el?.dataset.provider || "google");
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)) {
        try { await signInWithRedirect(auth, provider); } catch (e2) { renderLogin(authError(e2)); }
      } else if (e.code !== "auth/popup-closed-by-user") {
        renderLogin(authError(e));
      }
    }
  },
  async "link-provider"(el) {
    // Koppla ett inloggningssätt till kontot man redan har, så att samma bilar och logg följer med.
    const name = el.dataset.provider;
    const provider = authProvider(name);
    try {
      await linkWithPopup(auth.currentUser, provider);
      await auth.currentUser.reload?.();
      S.user = auth.currentUser;
      showToast(`${PROVIDER_NAMES[name]} är kopplat. Nu kan du logga in med det också.`, 5000);
      render();
    } catch (e) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)) {
        try { await linkWithRedirect(auth.currentUser, provider); } catch (e2) { showToast(authError(e2), 8000); }
      } else if (e.code !== "auth/popup-closed-by-user") {
        showToast(authError(e, name), 9000);
      }
    }
  },
  async "delete-account"() {
    const others = (S.house?.members || []).filter((m) => m !== uid());
    const house = S.house?.name || "hushållet";
    const ok = await confirmDialog({
      title: "Radera ditt konto?",
      lines: others.length
        ? [`Ditt konto och din inloggning tas bort, och du lämnar ${house}.`, "Det du har loggat finns kvar för de andra."]
        : [`Ditt konto och ${house} tas bort, med allt som är loggat: bilar, logg, bilder, dokument och delade serviceböcker.`, "Ladda gärna ner en säkerhetskopia först, under Säkerhetskopia."],
      okLabel: "Radera",
    });
    if (!ok) return;
    // Firebase kräver en färsk inloggning för att radera ett konto. Logga in en gång till först, innan något tas bort.
    const signedInAgo = Date.now() - Date.parse(auth.currentUser?.metadata?.lastSignInTime || 0);
    if (!(signedInAgo < 4 * 60e3)) {
      try {
        await reauthenticateWithPopup(auth.currentUser, authProvider(linkedProviders()[0] || "google"));
      } catch (e) {
        if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return showToast("Kontot är inte raderat.");
        return showToast("Logga ut och logga in igen, och radera sedan kontot direkt efteråt.", 7000);
      }
    }
    showToast("Raderar …", 20000);
    try {
      await deleteAccountData(others.length > 0);
      await deleteUser(auth.currentUser);
    } catch (e) {
      console.error(e);
      return showToast(e?.code === "auth/requires-recent-login" ? "Logga ut och logga in igen, och radera sedan kontot direkt efteråt." : `Det gick inte att radera allt (${e.code || e.message}). Försök igen med nät.`, 8000);
    }
    cleanup();
    try { localStorage.clear(); } catch { /* inget sparat */ }
    S.hid = null; S.house = null;
    renderLogin();
    showToast("Ditt konto är raderat.", 5000);
  },
  async logout() {
    cleanup();
    await signOut(auth);
  },
  "close-sheet"() { closeSheet(); },
  "new-entry"(el) {
    const t = el.dataset.type;
    // Besiktning är en kostnad av typen Besiktning, men har en egen knapp så att den är lätt att hitta.
    if (t && TYPE[t]) entryForm(t, el.dataset.cat ? { category: el.dataset.cat } : {});
    else typePicker();
  },
  "open-entry"(el) {
    // Uträknade betalningar för en återkommande kostnad öppnar regeln.
    if (el.dataset.id.startsWith("rec:")) return recurringSheet(el.dataset.id.split(":")[1]);
    openEntry(el.dataset.id, { fromCat: el.dataset.cat || null });
  },
  "open-rec"(el) { recurringSheet(el.dataset.id); },
  "edit-rec"(el) {
    const r = (car().recurring || []).find((x) => x.id === el.dataset.id);
    if (r) entryForm("parkering", { place: r.place, amount: r.amount, date: r.start, period: r.period, end: r.end, note: r.note }, { recurringId: r.id });
  },
  async "end-rec"(el) {
    const c = car();
    const r = (c.recurring || []).find((x) => x.id === el.dataset.id);
    if (!r) return;
    const ok = await confirmDialog({ title: "Avsluta den återkommande parkeringen?", lines: ["Inga fler betalningar räknas efter i dag. Det som redan har betalats finns kvar i loggen och Ekonomi."], okLabel: "Avsluta", warn: "" });
    if (!ok) return;
    const list = (c.recurring || []).map((x) => (x.id === r.id ? { ...x, end: todayStr() } : x));
    updateDoc(ref("cars", c.id), { recurring: list }).catch(onWriteError);
    c.recurring = list;
    closeSheet(); render(); showToast("Avslutad från och med i dag");
  },
  "delete-rec"(el) {
    const c = car();
    const r = (c.recurring || []).find((x) => x.id === el.dataset.id);
    if (!r) return;
    const list = (c.recurring || []).filter((x) => x.id !== r.id);
    updateDoc(ref("cars", c.id), { recurring: list }).catch(onWriteError);
    c.recurring = list;
    closeSheet(); render();
    showToast("Den återkommande parkeringen är borttagen", 6000, () => {
      const again = [...(c.recurring || []).filter((x) => x.id !== r.id), r];
      c.recurring = again;
      updateDoc(ref("cars", c.id), { recurring: again }).catch(onWriteError);
      render();
    });
  },
  "new-booking"() { bookingForm(); },
  "booking-calendar"(el) {
    const c = car();
    const b = (c.bookings || []).find((x) => x.id === el.dataset.id);
    if (b) addToCalendar(bookingCalendarEvent(b, c));
  },
  "open-deadline"(el) { deadlineSheet(el.dataset.id); },
  "deadline-calendar"(el) {
    const c = car();
    const x = deadlines(c).find((d) => d.key === el.dataset.id);
    if (!x) return;
    addToCalendar(deadlineEvent(x, c));
  },
  async "geo-fill"(el) {
    const input = document.getElementById(el.dataset.target);
    const picks = document.getElementById(el.dataset.target + "-picks");
    if (!input || el.disabled) return;
    const what = { fuel: "mack", parking: "parkering" }[el.dataset.kind] || "biltvätt";
    el.disabled = true;
    el.classList.add("busy");
    try {
      let pos;
      try {
        pos = await currentPosition();
      } catch (err) {
        const msg = err.code === 1 ? "Appen fick inte använda din plats. Tillåt plats för den här sidan i telefonens inställningar och försök igen."
          : err.code === "unsupported" ? "Den här webbläsaren kan inte ange plats."
          : "Kunde inte hitta din position. Försök igen, gärna utomhus.";
        return showToast(msg, 7000);
      }
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      // Sök lite längre bort om positionen är osäker, men aldrig mer än en kilometer.
      const base = { fuel: 250, parking: 150 }[el.dataset.kind] || 300;
      const radius = Math.round(Math.min(1000, Math.max(base, (accuracy || 0) + 100)));
      const names = await nearbyPlaces(el.dataset.kind, lat, lon, radius).catch(() => []);
      if (names.length) {
        input.value = names[0];
        if (picks) {
          picks.innerHTML = names.length > 1 ? names.slice(0, 5).map((n) => `<button type="button" class="chip-btn" data-act="geo-pick" data-target="${esc(el.dataset.target)}" data-v="${esc(n)}">${esc(n)}</button>`).join("") : "";
          picks.hidden = names.length < 2;
        }
        showToast(names.length > 1 ? `Hittade ${names.length} ställen i närheten. Tryck på rätt om det inte är det första.` : `Närmaste ${what}: ${names[0]}`, 5000);
      } else {
        const addr = await reverseAddress(lat, lon).catch(() => "");
        if (!addr) return showToast("Hittade ingen plats just nu. Skriv in den själv.", 5000);
        input.value = addr;
        if (picks) picks.hidden = true;
        showToast(`Ingen ${what} med namn hittades precis här, så adressen är ifylld. Ändra om det behövs.`, 6000);
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
      el.disabled = false;
      el.classList.remove("busy");
    }
  },
  "place-pick"(el) {
    const set = (id, v) => { const x = document.getElementById(id); if (x) x.value = v; };
    if (el.dataset.kind === "poi") set("bk-place", el.dataset.name);
    // Ett företag utan adress i kartan lämnar en adress man redan har skrivit orörd.
    if (el.dataset.addr || el.dataset.kind === "addr") set("bk-addr", el.dataset.addr);
    set("bk-lat", el.dataset.lat);
    set("bk-lon", el.dataset.lon);
    set("bk-pid", el.dataset.pid || "");
    set("bk-src", el.dataset.src || "");
    if (el.dataset.tel && !$("#bk-phone")?.value.trim()) set("bk-phone", el.dataset.tel);
    showBookingMap();
    Object.values(PLACE_FIELDS).forEach((x) => {
      const b = document.getElementById(x.box); if (b) b.hidden = true;
      document.getElementById(x.input)?.setAttribute("aria-expanded", "false");
    });
  },
  "map-open"() {
    openMapChooser({ name: $("#bk-place")?.value.trim(), addr: $("#bk-addr")?.value.trim(), lat: num($("#bk-lat")?.value), lon: num($("#bk-lon")?.value), pid: $("#bk-pid")?.value || "" });
  },
  "map-choice-close"() {
    document.getElementById("map-choice")?.remove();
    document.getElementById("map-choice-scrim")?.remove();
  },
  "geo-pick"(el) {
    const input = document.getElementById(el.dataset.target);
    if (input) { input.value = el.dataset.v; input.dispatchEvent(new Event("input", { bubbles: true })); }
    const picks = document.getElementById(el.dataset.target + "-picks");
    if (picks) picks.hidden = true;
  },
  "toggle-koll"() { S.kollAll = !S.kollAll; render(); nudgeFixed(); },
  "toggle-maint"() { S.maintAll = !S.maintAll; render(); },
  "hide-maint-hint"(el) { pref.set("maintHintHidden." + S.carId, el.dataset.n); render(); },
  "book-inspection"() { bookingForm({ kind: "besiktning" }); },
  "deadline-remove"(el) {
    const key = el.dataset.id;
    const fields = { besiktning: { besiktning: null }, forsakring: { forsakringDatum: null }, skatt: { skattManad: "av" } }[key];
    if (!fields) return;
    const c = car(), carId = S.carId;
    const before = Object.fromEntries(Object.keys(fields).map((k) => [k, c[k] ?? null]));
    updateDoc(ref("cars", carId), fields).catch(onWriteError);
    closeSheet();
    showToast("Datumet är borttaget", 6000, () => updateDoc(ref("cars", carId), before).catch(onWriteError));
  },
  "open-cat"(el) {
    // Id:t kan bära med sig månaden ("Bränsle@@2026-11"), så att tillbaka från en post visar samma månad.
    const [cat, idMonth] = el.dataset.id.split("@@");
    const month = el.dataset.month || idMonth || null;
    const since = addMonths(today0(), -12);
    const list = carEntries().filter((e) => e.amount > 0 && catOf(e) === cat && (month ? (e.date || "").startsWith(month) : parseDate(e.date) >= since));
    const sum = list.reduce((s, e) => s + e.amount, 0);
    openSheet(cat, `
      <p class="muted" style="margin-bottom:10px">${month ? esc(monthLabelLong(month)) : "Senaste 12 månaderna"} · ${list.length} st · <b>${fmtKr(sum)} kr</b></p>
      <div class="rows">${list.map((e) => entryRow(e, month ? `${cat}@@${month}` : cat)).join("") || `<p class="muted">Inget här.</p>`}</div>`);
  },
  "eco-step"(el) {
    const [y, m] = ecoSelected().split("-").map(Number);
    S.ecoMonth = ymKey(new Date(y, m - 1 + Number(el.dataset.d), 1));
    render();
  },
  "eco-year"(el) {
    const [y, m] = ecoSelected().split("-").map(Number);
    const ny = y + Number(el.dataset.d);
    // Samma månad nästa eller förra året, men aldrig framåt i tiden.
    S.ecoMonth = ymKey(new Date(ny, m - 1, 1));
    render();
  },
  "eco-month"(el) { S.ecoMonth = el.dataset.m; render(); },
  "open-booking"(el) {
    // Från aviseringarna kan bokningen gälla en annan bil än den som är vald.
    if (el.dataset.car && el.dataset.car !== S.carId && S.cars.some((x) => x.id === el.dataset.car)) { S.carId = el.dataset.car; pref.set("car", S.carId); }
    const b = (car()?.bookings || []).find((x) => x.id === el.dataset.id);
    if (b) bookingForm(b);
  },
  "booking-done"(el) {
    const c = car();
    const b = (c.bookings || []).find((x) => x.id === el.dataset.id);
    if (!b) return closeSheet();
    const note = b.note || null;
    const date = b.date <= todayStr() ? b.date : todayStr();
    // Platsen från bokningen (namn, adress och position) följer med till posten, så att kartan syns i loggen.
    const loc = b.place || b.addr ? clean({ name: b.place || null, addr: b.addr || null, lat: b.lat ?? null, lon: b.lon ?? null, pid: b.placeId || null }) : null;
    switch (b.kind) {
      case "service":
      case "reparation":
        return entryForm("service", { date, workshop: b.place, note, loc, title: b.kind === "reparation" ? "Reparation" : null }, { bookingId: b.id });
      case "dack":
        return entryForm("dack", { date, place: b.place || null, note, loc }, { bookingId: b.id });
      case "besiktning":
        return entryForm("kostnad", { date, category: "Besiktning", title: b.place ? `Besiktning hos ${b.place}` : "Besiktning", note, loc }, { bookingId: b.id });
      default:
        removeBooking(c.id, b.id);
        closeSheet();
        showToast("Bokningen är borttagen");
    }
  },
  "delete-booking"(el) {
    const b = (car()?.bookings || []).find((x) => x.id === el.dataset.id);
    if (!b) return closeSheet();
    const carId = S.carId;
    removeBooking(carId, b.id);
    closeSheet();
    showToast("Bokningen är borttagen", 6000, () => {
      const c = S.cars.find((x) => x.id === carId);
      if (!c) return;
      const list = [...(c.bookings || []).filter((x) => x.id !== b.id), b];
      c.bookings = list;
      updateDoc(ref("cars", carId), { bookings: list }).catch(onWriteError);
      render();
    });
  },
  // Ny post med samma uppgifter som en tidigare, till exempel samma tvätt eller parkering. Datum, mätarställning och bild är nya.
  "log-again"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (!e) return;
    const { id, date, odometer, photoId, createdAt, createdBy, tireAction, recurringId, ...rest } = e;
    entryForm(e.type, rest, { back: "open-entry", backId: e.id });
  },
  "photo-zoom"(el) { openLightbox(el.querySelector("img")?.src, el.querySelector("img")?.alt); },
  "lightbox-close"() { $("#lightbox")?.remove(); },
  "date-quick"(el) {
    const input = document.getElementById(el.dataset.target);
    if (!input) return;
    const d = new Date(); d.setDate(d.getDate() + Number(el.dataset.d || 0));
    input.value = ymd(d);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    markDateQuick(input);
  },
  "entry-map"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (!e) return;
    const l = e.loc || {};
    openMapChooser({ name: l.name || entryPlaceName(e), addr: l.addr, lat: l.lat, lon: l.lon, pid: l.pid });
  },
  "map-directions"(el) {
    const b = (car()?.bookings || []).find((x) => x.id === el.dataset.id);
    if (b) openMapChooser({ name: b.place, addr: b.addr, lat: b.lat, lon: b.lon, pid: b.placeId, directions: true });
  },
  "go-view"(el) { setView(el.dataset.id); },
  async "share-book"(el) {
    el.disabled = true;
    try { const t = await shareServiceBook(); const ok = await copyText(shareUrl(t)); showToast(ok ? "Serviceboken är delad. Länken är kopierad." : "Serviceboken är delad"); }
    catch (e) { console.error(e); showToast(e.code === "permission-denied" ? "Det gick inte att dela. Säkerhetsreglerna i Firebase behöver uppdateras." : "Det gick inte att dela just nu", 6000); }
    finally { el.disabled = false; }
  },
  async "share-copy"() { const c = car(); if (!c?.shareToken) return; const ok = await copyText(shareUrl(c.shareToken)); showToast(ok ? "Länken är kopierad" : shareUrl(c.shareToken), ok ? 3500 : 9000); },
  "share-stop"() {
    const c = car();
    if (!c?.shareToken) return;
    deleteDoc(doc(db, "shares", c.shareToken)).catch(onWriteError);
    c.shareToken = null;
    updateDoc(ref("cars", c.id), { shareToken: null }).catch(onWriteError);
    render();
    showToast("Länken fungerar inte längre");
  },
  "print-shared"() { if (sharedBookData) exportServiceBook(sharedBookData, pdfName(sharedBookData)); },
  "pdf-share"() { if (pendingPdf) { sharePdf(pendingPdf.blob, pendingPdf.name); closeSheet(); } },
  "bk-time"(el) { setBookingTime(el.dataset.v); },
  "todo-toggle"(el) {
    const c = car();
    const t = (c.todos || []).find((x) => x.id === el.dataset.id);
    if (!t) return;
    const list = (c.todos || []).map((x) => (x.id === t.id ? { ...x, done: !x.done, doneBy: !x.done ? uid() : null } : x));
    c.todos = list;
    updateDoc(ref("cars", c.id), { todos: list }).catch(onWriteError);
    render();
    if (!t.done) showToast(`Klart: ${t.text}`, 6000, null, { label: "Logga det", fn: () => entryForm("eget", { title: t.text.replace(/^./, (x) => x.toUpperCase()) }) });
  },
  "card-toggle"(el) {
    const view = el.dataset.view || "oversikt";
    const p = cardPrefs(view);
    const hidden = p.hidden.includes(el.dataset.id) ? p.hidden.filter((k) => k !== el.dataset.id) : [...p.hidden, el.dataset.id];
    saveCardPrefs(view, { order: p.order, hidden });
    render();
  },
  "card-move"(el) {
    const p = cardPrefs();
    const i = p.order.indexOf(el.dataset.id), j = i + Number(el.dataset.d);
    if (i < 0 || j < 0 || j >= p.order.length) return;
    [p.order[i], p.order[j]] = [p.order[j], p.order[i]];
    pref.set("cards", JSON.stringify(p));
    render();
    document.querySelector(`[data-act="card-move"][data-id="${el.dataset.id}"][data-d="${el.dataset.d}"]`)?.focus({ preventScroll: true });
  },
  "amount-quick"(el) { const a = $("#ef-amount"); if (a) { a.value = el.dataset.v; a.dispatchEvent(new Event("input", { bubbles: true })); } },
  "edit-doc"(el) { const d = (car()?.docs || []).find((x) => x.id === el.dataset.id); if (d) docForm(d); },
  "hide-photos"() { S.showPhotos = false; render(); },
  async "show-photos"() { S.showPhotos = true; render(); await loadPhotoGrid(); },
  "todo-clear"() {
    const c = car();
    const before = c.todos || [];
    const list = before.filter((t) => !t.done);
    c.todos = list;
    updateDoc(ref("cars", c.id), { todos: list }).catch(onWriteError);
    render();
    showToast("Klara saker är borttagna", 6000, () => { c.todos = before; updateDoc(ref("cars", c.id), { todos: before }).catch(onWriteError); render(); });
  },
  "new-doc"() { docForm(); },
  "open-doc"(el) { docSheet(el.dataset.id); },
  "delete-doc"(el) {
    const c = car();
    const d = (c.docs || []).find((x) => x.id === el.dataset.id);
    if (!d) return closeSheet();
    const list = (c.docs || []).filter((x) => x.id !== d.id);
    c.docs = list;
    updateDoc(ref("cars", c.id), { docs: list }).catch(onWriteError);
    const timer = setTimeout(() => deleteDoc(ref("photos", d.photoId)).catch(() => {}), 8000);
    closeSheet(); render();
    showToast("Dokumentet är borttaget", 6000, () => {
      clearTimeout(timer);
      c.docs = [...(c.docs || []).filter((x) => x.id !== d.id), d];
      updateDoc(ref("cars", c.id), { docs: c.docs }).catch(onWriteError);
      render();
    });
  },
  "print-book"() { printServiceBook(); },
  async "copy-shortcut"(el) {
    const ok = await copyText(shortcutUrl(el.dataset.id));
    showToast(ok ? "Länken är kopierad" : shortcutUrl(el.dataset.id), ok ? 3500 : 9000);
  },
  "edit-entry"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (e) entryForm(e.type, e);
  },
  "delete-entry"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (!e) return closeSheet();
    const { id, ...data } = e;
    deleteDoc(ref("entries", id)).catch(onWriteError);
    // Bilden tas bort först när det inte längre går att ångra.
    const photoTimer = e.photoId ? setTimeout(() => deleteDoc(ref("photos", e.photoId)).catch(() => {}), 8000) : null;
    closeSheet();
    showToast(`${TYPE[e.type]?.label || "Posten"} är borttagen`, 6000, () => {
      clearTimeout(photoTimer);
      setDoc(ref("entries", id), clean(data)).catch(onWriteError);
    });
  },
  filter(el) { S.filter = el.dataset.f; render(); },
  "clear-search"() {
    S.query = "";
    render();
    $("#log-search")?.focus();
  },
  "edit-car"(el) {
    const sections = (el.dataset.section || "basic,photo,dates").split(",").filter((k) => CAR_SECTIONS[k]);
    carSheet(true, sections.length ? sections : ["basic"]);
  },
  "add-car"() { carSheet(false); },
  async "odo-from-car"(el) {
    // Spara det man har ändrat om bilen innan mätarställningen öppnas, så att inget försvinner.
    const form = el.closest("form");
    if (form) {
      const ok = await saveCarEdit(form, { keepOpen: true });
      if (ok !== true) return;
    }
    entryForm("matare");
    showToast("Ändringarna om bilen är sparade.");
  },
  "edit-items"() { itemsSheet(); },
  "edit-item"(el) { itemSheet(el.dataset.id); },
  "edit-item-form"(el) { itemsSheet(el.dataset.id); },
  "log-item"(el) { entryForm("service", { items: [el.dataset.id] }, { back: "edit-item", backId: el.dataset.id }); },
  "w-add"(el) {
    const list = $("#work-rows");
    if (!list) return;
    const itemId = el.dataset.item || null;
    const key = itemId ? `item:${itemId}` : normWord(el.dataset.name);
    let row = list.querySelector(`.work-row[data-key="${CSS.escape(key)}"]`);
    if (!row) {
      list.insertAdjacentHTML("beforeend", workRowHtml({ key, itemId, name: el.dataset.name }, { action: "bytt" }, ++workRowSeq));
      row = list.lastElementChild;
    }
    row.querySelector(".w-on").checked = true;
    row.scrollIntoView({ block: "nearest" });
    const s = $("#w-search"); if (s) s.value = "";
    const box = $("#w-suggest"); if (box) box.hidden = true;
  },
  "toggle-parts"() { S.partsAll = !S.partsAll; render(); },
  "open-part"(el) { partSheet(el.dataset.id); },
  "log-part"(el) { entryForm("service", { parts: [el.dataset.id] }, { back: "open-part", backId: normWord(el.dataset.id) }); },
  "part-to-item"(el) {
    // Lägg till delen som underhållspunkt utan intervall, och öppna formuläret så att man kan fylla i intervallet.
    const c = car();
    const id = "i" + randomId(6);
    const items = [...(c.items || []), { id, name: el.dataset.id, mil: null, months: null }];
    updateDoc(ref("cars", c.id), { items }).catch(onWriteError);
    c.items = items;
    itemsSheet(id);
    showToast(`${el.dataset.id} är en underhållspunkt. Fyll i intervallet och spara.`, 5000);
  },
  "add-item-row"() {
    $("#item-rows").insertAdjacentHTML("beforeend", itemRowHtml({ id: "i" + randomId(6), name: "", mil: null, months: null }));
    $("#item-rows .item-row:last-child input")?.focus();
  },
  "remove-item-row"(el) { el.closest(".item-row")?.remove(); },
  "reset-items"() {
    const c = car();
    const old = Object.fromEntries((c.items || []).map((i) => [i.id, i]));
    const fresh = defaultItems(c).map((i) => ({ ...i, baseDate: old[i.id]?.baseDate, baseMil: old[i.id]?.baseMil }));
    $("#item-rows").innerHTML = fresh.map(itemRowHtml).join("");
    showToast("Standardpunkterna är inlagda. Tryck Spara för att behålla dem.");
  },
  "pick-car"(el) { S.carId = el.dataset.id; pref.set("car", S.carId); render(); },
  async "delete-car"(el) {
    const c = S.cars.find((x) => x.id === el.dataset.id) || car();
    if (!c) return;
    const n = S.entries.filter((e) => e.carId === c.id).length;
    const ok = await confirmDialog({
      title: `Ta bort ${carName(c)}?`,
      lines: [
        `Bilen${n ? ` och hela dess logg (${n} ${n === 1 ? "post" : "poster"})` : ""} tas bort för alla ni som delar bilen.`,
        c.plate ? `Reg.nr ${c.plate}` : null,
      ],
      okLabel: "Ta bort bilen",
    });
    if (!ok) return;
    el.disabled = true;
    el.textContent = "Tar bort …";
    try {
      await deleteCar(c.id);
      if (!sheet.hidden) closeSheet();
      showToast(`${carName(c)} är borttagen`);
    } catch (e) {
      onWriteError(e);
      el.disabled = false;
    }
  },
  lang(el) {
    const v = el.dataset.v;
    if (v === LANG) return;
    pref.set("lang", v);
    location.reload();
  },
  theme(el) {
    const v = el.dataset.v;
    pref.set("theme", v);
    applyTheme(v);
    el.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
  },
  async "copy-invite"() {
    const link = `${location.origin}${location.pathname}?join=${S.house.inviteCode}`;
    syncInviteName();
    const name = S.house.name ? `${S.house.name} i Bildagboken` : "vår bildagbok";
    const ok = await copyText(`Gå med i ${name}: ${link}\nKod: ${S.house.inviteCode}`);
    showToast(ok ? "Inbjudan kopierad. Skicka den till den du vill dela bilen med." : `Koden är ${S.house.inviteCode}. Länk: ${link}`, ok ? 3500 : 9000);
  },
  "ask-claude"() {
    const text = tr(claudePrompt(car()));
    copyText(text).then((ok) => showToast(ok ? "Frågan är kopierad. Klistra in den i Claude." : "Kunde inte kopiera. Öppna Claude och beskriv bilen själv.", 5000));
  },
  async "enable-notif"() {
    if (!("Notification" in window)) return showToast("Notiser stöds inte här. På iPhone: lägg först till appen på hemskärmen.", 6000);
    const p = await Notification.requestPermission();
    showToast(p === "granted" ? "Notiser är påslagna" : "Notiser slogs inte på");
    render();
  },
  async "new-invite-code"() {
    const ok = await confirmDialog({ title: "Byta inbjudningskod?", lines: [`Koden ${S.house?.inviteCode || ""} slutar fungera. Ni som redan är med påverkas inte.`], okLabel: "Byt kod", warn: "" });
    if (!ok) return;
    try { await rotateInviteCode(); showToast(`Ny kod: ${S.house.inviteCode}`); } catch (e) { onWriteError(e); }
  },
  async "remove-member"(el) {
    const m = el.dataset.id;
    const ok = await confirmDialog({
      title: `Ta bort ${memberName(m)}?`,
      lines: [`${memberName(m)} kommer inte längre åt bilarna och loggen. Det som redan är loggat finns kvar.`, "Inbjudningskoden byts också, så att den gamla inte går att använda igen."],
      okLabel: "Ta bort",
      warn: "",
    });
    if (!ok) return;
    try {
      await updateDoc(doc(db, "households", S.hid), { members: (S.house.members || []).filter((x) => x !== m) });
      await rotateInviteCode();
      showToast(`${memberName(m)} är borttagen`);
    } catch (e) { onWriteError(e); }
  },
  async "leave-house"() {
    const ok = await confirmDialog({
      title: "Lämna hushållet?",
      lines: [`Du kommer inte längre åt ${S.house?.name || "hushållets"} bilar och logg. Det du har loggat finns kvar för de andra.`, "Vill du komma tillbaka behöver du en ny inbjudningskod."],
      okLabel: "Lämna",
    });
    if (!ok) return;
    try {
      await updateDoc(doc(db, "households", S.hid), { members: (S.house.members || []).filter((x) => x !== uid()) });
      cleanup();
      renderOnboarding();
      showToast("Du har lämnat hushållet");
    } catch (e) { onWriteError(e); }
  },
  "export-log"() { exportLog(); },
  "export-all"() { exportAll(); },
  "hide-start"() { pref.set("startHidden." + S.hid, "1"); render(); showToast("Dolt. Du hittar allt under Bilen och Inställningar."); },
  "dismiss-install"() { pref.set("installDismissed", "1"); render(); },
};

const PROVIDER_NAMES = { google: "Google", apple: "Apple" };
const PROVIDER_IDS = { google: "google.com", apple: "apple.com" };

function authProvider(name) {
  if (name === "apple") {
    const p = new OAuthProvider("apple.com");
    p.addScope("email");
    p.addScope("name");
    p.setCustomParameters({ locale: "sv_SE" });
    return p;
  }
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  return p;
}

// Vilka inloggningssätt kontot har, till exempel ["google", "apple"].
function linkedProviders() {
  const ids = (S.user?.providerData || []).map((x) => x.providerId);
  return Object.keys(PROVIDER_IDS).filter((k) => ids.includes(PROVIDER_IDS[k]));
}

function authError(e, name = null) {
  const map = {
    "auth/network-request-failed": "Ingen kontakt med nätet. Försök igen.",
    "auth/unauthorized-domain": "Den här adressen är inte godkänd för inloggning i Firebase.",
    "auth/popup-closed-by-user": "Inloggningen avbröts.",
    "auth/operation-not-allowed": "Det här inloggningssättet är inte påslaget i Firebase än.",
    "auth/account-exists-with-different-credential": "Det finns redan ett konto med samma e-postadress. Logga in på det sätt du använde först, och koppla sedan det andra under Inställningar → Konto.",
    "auth/credential-already-in-use": `Det ${PROVIDER_NAMES[name] || ""}-kontot används redan av ett annat konto i Bildagboken. Logga ut, logga in med det och lämna det hushållet först, eller använd ett annat konto.`,
    "auth/provider-already-linked": `${PROVIDER_NAMES[name] || "Det"} är redan kopplat till ditt konto.`,
    "auth/requires-recent-login": "Logga ut och logga in igen, och försök sedan koppla på nytt.",
  };
  return map[e?.code] || `Inloggningen misslyckades (${e?.code || e?.message || "okänt fel"}).`;
}

function onWriteError(e) {
  console.error(e);
  showToast(e?.code === "permission-denied" ? "Du har inte behörighet att spara det här." : "Kunde inte spara. Det sparas när telefonen har nät igen.", 6000);
}

/* ----------------------------------------------------------- form submits */

async function onSubmit(ev) {
  const form = ev.target.closest("form[data-form]");
  if (!form) return;
  ev.preventDefault();
  const kind = form.dataset.form;
  try {
    if (kind === "entry") return await saveEntry(form);
    if (kind === "create-house") return await createHouse(form);
    if (kind === "join-house") return await joinHouse(form);
    if (kind === "car-new") return await saveNewCar(form);
    if (kind === "car-edit") return saveCarEdit(form);
    if (kind === "items") return saveItems(form);
    if (kind === "booking") return saveBooking(form, ev.submitter?.value === "1");
    if (kind === "todo") return saveTodo(form);
    if (kind === "doc") return await saveDoc(form);
    if (kind === "rename") {
      const fd = new FormData(form);
      const name = String(fd.get("name") || "").trim();
      const house = String(fd.get("house") || "").trim();
      if (!name || !house) return showToast("Fyll i både hushållets namn och ditt namn.");
      updateDoc(doc(db, "households", S.hid), { name: house, [`memberInfo.${uid()}.name`]: name }).catch(onWriteError);
      syncInviteName(house);
      delete form.dataset.dirty;
      document.activeElement?.blur?.();
      showToast("Namnen är sparade");
    }
  } catch (e) {
    console.error(e);
    showToast(`Något gick fel: ${e.code || e.message}`, 6000);
  }
}

async function createHouse(form) {
  const fd = new FormData(form);
  const name = String(fd.get("name") || "").trim();
  const house = String(fd.get("house") || "").trim() || `${name}s bil`;
  if (!name) return;
  form.querySelector("button[type=submit]").disabled = true;
  const code = randomId(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  const hRef = doc(collection(db, "households"));
  await setDoc(hRef, {
    name: house,
    members: [uid()],
    memberInfo: { [uid()]: { name, email: S.user.email || null, lastSeen: serverTimestamp() } },
    inviteCode: code,
    createdAt: serverTimestamp(),
  });
  await setDoc(doc(db, "invites", code), { householdId: hRef.id, houseName: house, createdBy: uid(), createdAt: serverTimestamp() });
  subscribe(hRef.id);
}

// Skapar en ny inbjudningskod och tar bort den gamla, så att den inte går att använda längre.
async function rotateInviteCode() {
  const old = S.house?.inviteCode;
  const code = randomId(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  await setDoc(doc(db, "invites", code), { householdId: S.hid, houseName: S.house?.name || "", createdBy: uid(), createdAt: serverTimestamp() });
  await updateDoc(doc(db, "households", S.hid), { inviteCode: code });
  S.house = { ...S.house, inviteCode: code };
  if (old) deleteDoc(doc(db, "invites", old)).catch(() => {});
  render();
}

// Namnet på hushållet sparas också i inbjudan, så att den som blir inbjuden ser vem som bjuder in innan hen har gått med.
function syncInviteName(name = S.house?.name) {
  const code = S.house?.inviteCode;
  if (!code || !name) return;
  updateDoc(doc(db, "invites", code), { houseName: name }).catch(() => {});
}

// Inbjudan som hör till koden i länken (?join=KOD), hämtas en gång för välkomsttexten.
let joinInfo = null;
async function loadJoinInfo(code) {
  if (!code || joinInfo?.code === code) return;
  joinInfo = { code, name: null };
  try {
    const inv = await getDoc(doc(db, "invites", code));
    if (inv.exists()) joinInfo.name = inv.data().houseName || null;
  } catch (e) { /* utan nät visas den vanliga texten */ }
  if (joinInfo.name && S.screen === "onboarding") renderOnboarding();
}

// Raderar det som hör till kontot. Är man inte ensam lämnar man bara hushållet, annars tas hela hushållet bort.
async function deleteAccountData(hasOthers) {
  const hid = S.hid;
  if (!hid) return;
  await deleteDoc(doc(db, "households", hid, "tokens", uid())).catch(() => {});
  if (hasOthers) {
    await updateDoc(doc(db, "households", hid), {
      members: (S.house.members || []).filter((x) => x !== uid()),
      [`memberInfo.${uid()}`]: deleteField(),
    });
    return;
  }
  for (const c of S.cars) if (c.shareToken) await deleteDoc(doc(db, "shares", c.shareToken)).catch(() => {});
  if (S.house?.inviteCode) await deleteDoc(doc(db, "invites", S.house.inviteCode)).catch(() => {});
  cleanup();
  for (const sub of ["entries", "photos", "cars", "tokens"]) {
    const qs = await getDocs(collection(db, "households", hid, sub));
    for (let i = 0; i < qs.docs.length; i += 400) {
      const b = writeBatch(db);
      qs.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
      await b.commit();
    }
  }
  await deleteDoc(doc(db, "households", hid));
}

async function joinHouse(form) {
  const fd = new FormData(form);
  const name = String(fd.get("name") || "").trim();
  const code = String(fd.get("code") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!name || !code) return;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  let inv;
  try {
    inv = await getDoc(doc(db, "invites", code));
  } catch (e) {
    btn.disabled = false;
    return renderOnboarding("Kunde inte kontrollera koden. Kolla att du har nät och försök igen.");
  }
  if (!inv.exists()) { btn.disabled = false; return renderOnboarding("Hittade ingen inbjudan med den koden. Kontrollera stavningen."); }
  const hid = inv.data().householdId;
  const houseName = inv.data().houseName;
  await updateDoc(doc(db, "households", hid), {
    members: arrayUnion(uid()),
    [`memberInfo.${uid()}`]: { name, email: S.user.email || null, lastSeen: serverTimestamp() },
    joinedWith: code,
  });
  history.replaceState(null, "", location.pathname + "#oversikt");
  S.justJoined = houseName || true;
  subscribe(hid);
}

async function saveNewCar(form) {
  const data = readCarForm(form);
  if (!data.make || !data.model) return formError("Fyll i märke och modell.") ?? showToast("Fyll i märke och modell.");
  const startOdo = data.odometer;
  delete data.odometer;
  if (startOdo != null && (startOdo < 0 || startOdo > 200000)) return formError("Mätarställningen ser fel ut. Ange den i mil, till exempel 21 480.") ?? showToast("Mätarställningen ser fel ut. Ange den i mil.");
  const cRef = doc(col("cars"));
  if (startOdo != null) {
    // Mätarställningen vid start blir bilens första loggpost.
    setDoc(doc(col("entries")), { type: "matare", carId: cRef.id, date: todayStr(), odometer: startOdo, note: null, createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
  }
  const full = {
    ...clean(data),
    items: defaultItems(data),
    specsText: SPEC_TEMPLATE,
    tiresOn: new Date().getMonth() >= 11 || new Date().getMonth() <= 2 ? "vinter" : "sommar",
    tires: [],
    createdAt: serverTimestamp(),
    createdBy: uid(),
  };
  setDoc(cRef, full).catch(onWriteError);
  // Lägg in bilen lokalt direkt, så att vyn inte ritas innan databasen hunnit skicka tillbaka den.
  if (!S.cars.some((x) => x.id === cRef.id)) S.cars = [...S.cars, { ...full, id: cRef.id, createdAt: Date.now() }];
  S.carId = cRef.id;
  pref.set("car", cRef.id);
  closeSheet();
  setView("oversikt");
  showToast(`${data.make} ${data.model} är tillagd`);
}

// Komprimerar och sparar ett foto på bilen. Returnerar foto-id, eller null om bilden inte gick att läsa.
async function uploadCarPhoto(c, file) {
  const dataUrl = await compressImage(file).catch(() => null);
  if (!dataUrl) return null;
  const pRef = doc(col("photos"));
  setDoc(pRef, { data: dataUrl, carId: c.id, kind: "car", createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
  photoCache[pRef.id] = dataUrl;
  rememberCarPhoto(pRef.id, dataUrl);
  if (c.photoId) deleteDoc(ref("photos", c.photoId)).catch(() => {});
  return pRef.id;
}

async function changeHeroPhoto(file) {
  const c = car();
  if (!c || !file) return;
  showToast("Sparar bilden …", 10000);
  const id = await uploadCarPhoto(c, file);
  if (!id) return showToast("Bilden gick inte att läsa in. Prova en annan bild.", 5000);
  updateDoc(ref("cars", c.id), { photoId: id }).catch(onWriteError);
  showToast("Bilden är bytt. Ta bort den under Bilen → Uppgifter → Ändra.");
}

async function saveCarEdit(form, { keepOpen = false } = {}) {
  const data = readCarForm(form);
  if ("make" in data && (!data.make || !data.model)) return formError("Fyll i märke och modell.");
  const c = car();
  const fd = new FormData(form);
  const payload = clean(data);
  if ("make" in data && `${c.make}|${c.model}`.toLowerCase() !== `${data.make}|${data.model}`.toLowerCase()) {
    Object.assign(payload, { imageUrl: null, imageCredit: null, imageChecked: null });
  }
  const file = fd.get("carPhoto");
  if (file && file.size) {
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Sparar bilden …"; }
    const id = await uploadCarPhoto(c, file);
    if (!id) {
      if (btn) { btn.disabled = false; btn.textContent = "Spara"; }
      return formError("Bilden gick inte att läsa in. Prova en annan bild.");
    }
    payload.photoId = id;
  } else if (fd.get("removePhoto") === "on" && c.photoId) {
    deleteDoc(ref("photos", c.photoId)).catch(() => {});
    payload.photoId = null;
    Object.assign(payload, { imageChecked: null });
  }
  updateDoc(ref("cars", c.id), payload).catch(onWriteError);
  if (keepOpen) return true;
  closeSheet();
  showToast("Bilen är uppdaterad");
  return true;
}

function saveItems(form) {
  const rows = [...form.querySelectorAll(".item-row")];
  const items = rows.map((r) => {
    const g = (n) => r.querySelector(`[name="${n}"]`)?.value.trim() ?? "";
    return clean({
      id: r.dataset.item,
      name: g("name"),
      mil: num(g("mil")),
      months: num(g("months")) != null ? Math.round(num(g("months")) * (g("monthsUnit") === "man" ? 1 : 12)) || null : null,
      baseDate: g("baseDate") || null,
      baseMil: num(g("baseMil")),
    });
  }).filter((i) => i.name);
  updateDoc(ref("cars", S.carId), { items }).catch(onWriteError);
  closeSheet();
  showToast("Underhållet är sparat");
}

/* ---------------------------------------------------------- input helpers */

// Rutan "Nästa besiktning senast" för en besiktning: förslag från datumet, och dold när besiktningen är äldre än två månader.
function updateNextInspection() {
  const next = $("#ef-nextBesiktning");
  if (!next) return;
  const isInsp = $("#ef-category")?.value === "Besiktning";
  const dateVal = $("#ef-date")?.value || todayStr();
  const old = isInsp && dateVal < ymd(addMonths(today0(), -2));
  const box = $("#ef-next-besikt"), note = $("#ef-old-besikt");
  if (box) box.hidden = !isInsp || old;
  if (note) note.hidden = !old;
  if (old) { next.value = ""; delete next.dataset.manual; return; }
  if (next.dataset.manual !== "1" && isInsp) next.value = suggestNextInspection(dateVal, car());
}

function onInput(ev) {
  if (ev.isTrusted && ev.target.classList?.contains("from-receipt")) ev.target.classList.remove("from-receipt");
  if (ev.target.id === "ef-recurring") {
    const b = $("#ef-rec-box"); if (b) b.hidden = !ev.target.checked;
    const lab = $("#ef-date")?.closest("label")?.querySelector("span");
    if (lab) lab.textContent = ev.target.checked ? "Första betalningen" : "Datum";
  }
  if (ev.target.id === "w-search") workSuggest(ev.target.value);
  if (ev.target.id === "bk-place") placeSearchSoon("poi");
  if (ev.target.id === "bk-addr") {
    // Egen adress: positionen från ett tidigare förslag gäller inte längre.
    ["bk-lat", "bk-lon", "bk-pid", "bk-src"].forEach((id) => { const x = document.getElementById(id); if (x) x.value = ""; });
    const mb = $("#bk-map"); if (mb) mb.hidden = true;
    placeSearchSoon("addr");
  }
  if (ev.target.id === "ef-category") {
    const box = $("#ef-next-besikt");
    if (box) box.hidden = ev.target.value !== "Besiktning";
  }
  // Föreslå nästa besiktning så länge man inte själv har ändrat datumet.
  if (ev.target.id === "ef-nextBesiktning") ev.target.dataset.manual = "1";
  if ((ev.target.id === "ef-category" || ev.target.id === "ef-date") && $("#ef-nextBesiktning")) updateNextInspection();
  if (ev.target.id === "cf-tiresOn") {
    // Flytta "sitter på" till den däcksats som väljs.
    document.querySelectorAll(".tire-head").forEach((h) => { h.querySelector(".tire-on").hidden = h.dataset.tire !== ev.target.value; });
    return;
  }
  if (ev.target.id === "log-search") {
    const had = !!S.query;
    S.query = ev.target.value;
    // Uppdatera bara listan, så att sökfältet och tangentbordet stannar kvar.
    const list = $("#log-list");
    if (list) list.innerHTML = logListHtml();
    if (had !== !!S.query) {
      const box = ev.target.closest(".search");
      const btn = box?.querySelector(".search-clear");
      if (S.query && !btn) box.insertAdjacentHTML("beforeend", `<button class="search-clear" type="button" data-act="clear-search" aria-label="Rensa sökningen">${icon("close", 14)}</button>`);
      if (!S.query && btn) btn.remove();
    }
    return;
  }
  const keep = ev.target.closest("form[data-keep]");
  if (keep) keep.dataset.dirty = "1";
  if (ev.target.name === "odometer" || ev.target.name === "date") {
    const f = ev.target.closest("form");
    if (f) delete f.dataset.odoOk;
  }
}

function onChange(ev) {
  if (ev.target.id === "bk-time-other") setBookingTime(ev.target.value);
  if (ev.target.id === "bk-allday") {
    const wheel = $("#bk-wheel"), hid = $("#bk-time");
    if (wheel) wheel.hidden = ev.target.checked;
    if (hid) hid.value = ev.target.checked ? "" : "09:00";
    if (!ev.target.checked) requestAnimationFrame(() => setWheel("09:00"));
  }
  if (ev.target.id === "ef-tireAction") { const box = $("#ef-tirekind-box"); if (box) box.hidden = isSwap(ev.target.value); }
  if (ev.target.id === "ef-scan") { scanReceipt(ev.target.files?.[0]); ev.target.value = ""; }
  if (ev.target.id === "ef-date") markDateQuick(ev.target);
  if (ev.target.id === "bk-addr") geocodeBookingAddress();
  if ((ev.target.id === "ef-date" || ev.target.id === "ef-category") && $("#ef-nextBesiktning")) updateNextInspection();
  if (ev.target.id === "hero-photo") {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (f) changeHeroPhoto(f);
    return;
  }
  if (ev.target.id === "ef-photo" || ev.target.id === "cf-carPhoto") {
    const f = ev.target.files?.[0];
    const lab = $("#photo-label");
    if (lab) lab.textContent = f ? `Vald bild: ${f.name}` : "Lägg till kvitto eller bild";
  }
}

/* --------------------------------------------------------- toast & notify */

let toastTimer;
// Meddelande längst ner. Med undo visas en Ångra-knapp så länge meddelandet syns.
let toastUndo = null, toastAction = null;
function showToast(text, ms = 3500, undo = null, action = null) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(text)}</span>${undo ? `<button class="toast-undo" type="button" id="toast-undo">Ångra</button>` : ""}${action ? `<button class="toast-undo" type="button" id="toast-act">${esc(action.label)}</button>` : ""}`;
  t.hidden = false;
  toastUndo = undo;
  toastAction = action;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; toastUndo = null; toastAction = null; }, undo || action ? Math.max(ms, 6000) : ms);
}
document.addEventListener("click", (ev) => {
  if (ev.target.closest?.("#toast-act") && toastAction) {
    const fn = toastAction.fn;
    toastAction = null;
    $("#toast").hidden = true;
    fn();
    return;
  }
  if (ev.target.closest?.("#toast-undo") && toastUndo) {
    const fn = toastUndo;
    toastUndo = null;
    $("#toast").hidden = true;
    fn();
    showToast("Ångrat");
  }
});

function notify(text, tag) {
  if (document.visibilityState === "visible") {
    showToast(text, 5000);
  } else if ("Notification" in window && Notification.permission === "granted" && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification("Bildagboken", { body: tr(text), icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag })).catch(() => {});
  }
}
function announce(e) { notify(activityText(e), e.id); }

// När någon annan sätter bränslet lågt får de andra en avisering.
const fuelSeen = {};
function checkFuelChanges(cars, first) {
  for (const c of cars) {
    const f = c.fuelLevel;
    if (fuelPct(f) == null) continue;
    const at = tsMs(f.at);
    const prev = fuelSeen[c.id];
    fuelSeen[c.id] = at;
    if (first || !prev || at <= prev || f.by === uid()) continue;
    if (fuelPct(f) <= 25) notify(`${memberName(f.by)}: bränslet i ${carName(c)} är på ${pctText(fuelPct(f)).toLowerCase()}. Tanka snart.`, `fuel-${c.id}`);
  }
}

// När någon annan bokar en tid får de andra en avisering, precis som för nya loggar.
const bookingsSeen = new Set();
function checkNewBookings(cars, first) {
  for (const c of cars) {
    for (const b of c.bookings || []) {
      const key = `${c.id}/${b.id}`;
      if (bookingsSeen.has(key)) continue;
      bookingsSeen.add(key);
      if (first || b.createdBy === uid()) continue;
      notify(`${bookingActivity(b)}${S.cars.length > 1 ? ` (${carName(c)})` : ""}`, `booking-${b.id}`);
    }
    for (const [kind, list] of [["t", c.todos || []], ["d", c.docs || []]]) {
      for (const x of list) {
        const key = `${c.id}/${kind}/${x.id}`;
        if (bookingsSeen.has(key)) continue;
        bookingsSeen.add(key);
        if (first || x.by === uid() || !x.at) continue;
        notify(activityText(kind === "t" ? { createdBy: x.by, _todo: x } : { createdBy: x.by, _doc: x }), `${kind}-${x.id}`);
      }
    }
  }
}

/* ------------------------------------------------------------ data wiring */

function cleanup() {
  S.unsubs.forEach((u) => { try { u(); } catch { /* redan stängd */ } });
  S.unsubs = [];
  S.hid = null; S.house = null; S.cars = []; S.entries = []; S.carId = null;
  S.loaded = { house: false, cars: false, entries: false };
  closeSheet();
}

function onListenError(e) {
  console.error(e);
  if (e.code === "permission-denied") {
    cleanup();
    if (S.user) renderOnboarding("Du har inte längre tillgång till hushållet.");
  } else {
    showToast("Tappade kontakten med databasen. Försöker igen när det finns nät.", 6000);
  }
}

function subscribe(hid) {
  S.unsubs.forEach((u) => u());
  S.unsubs = [];
  S.hid = hid;
  S.loaded = { house: false, cars: false, entries: false };
  render();

  S.unsubs.push(onSnapshot(doc(db, "households", hid), (s) => {
    S.house = s.data({ serverTimestamps: "estimate" });
    S.loaded.house = true;
    if (S.justJoined) {
      showToast(typeof S.justJoined === "string" ? `Välkommen till ${S.justJoined}!` : "Välkommen! Nu delar ni bilen.", 4500);
      S.justJoined = null;
    }
    // Äldre inbjudningar saknar hushållets namn. Det läggs till en gång, så att nästa inbjudna ser det.
    const stamp = `${S.house?.inviteCode}|${S.house?.name}`;
    if (S.house?.inviteCode && pref.get("inviteName") !== stamp) { syncInviteName(); pref.set("inviteName", stamp); }
    render();
  }, onListenError));

  S.unsubs.push(onSnapshot(collection(db, "households", hid, "cars"), { includeMetadataChanges: true }, (s) => {
    S.pending.cars = s.docs.filter((d) => d.metadata?.hasPendingWrites).length;
    updateNetBanner();
    S.cars = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
      .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
    if (!S.cars.find((c) => c.id === S.carId)) {
      const saved = pref.get("car");
      S.carId = S.cars.find((c) => c.id === saved)?.id || S.cars[0]?.id || null;
    }
    checkFuelChanges(S.cars, !S.loaded.cars);
    checkNewBookings(S.cars, !S.loaded.cars);
    S.loaded.cars = true;
    render();
  }, onListenError));

  let first = true;
  S.unsubs.push(onSnapshot(query(collection(db, "households", hid, "entries"), orderBy("date", "desc")), { includeMetadataChanges: true }, (s) => {
    S.pending.entries = s.docs.filter((d) => d.metadata?.hasPendingWrites).length;
    updateNetBanner();
    S.entries = sortEntries(s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })));
    if (!first) {
      for (const ch of s.docChanges()) {
        if (ch.type !== "added" || ch.doc.metadata.hasPendingWrites) continue;
        const e = { id: ch.doc.id, ...ch.doc.data({ serverTimestamps: "estimate" }) };
        if (e.createdBy !== uid() && isRecentDate(e)) announce(e);
      }
    }
    first = false;
    S.loaded.entries = true;
    render();
  }, onListenError));
}

async function loadHousehold() {
  setScreen("loading", `<p class="loading">Hämtar er bildagbok …</p>`);
  try {
    const qs = await getDocs(query(collection(db, "households"), where("members", "array-contains", uid())));
    if (qs.empty) return renderOnboarding();
    subscribe(qs.docs[0].id);
  } catch (e) {
    console.error(e);
    setScreen("error", `<div class="card empty"><b>Kunde inte hämta er data</b>${esc(e.code === "unavailable" ? "Telefonen verkar sakna nät. Försök igen om en stund." : e.code || e.message)}<div class="ask" style="justify-content:center"><button class="btn" type="button" data-act="retry">Försök igen</button></div></div>`);
  }
}
ACTIONS.retry = loadHousehold;

/* ------------------------------------------------------------------- boot */

function hideSuggestions(except = null) {
  Object.values(PLACE_FIELDS).forEach((x) => {
    const b = document.getElementById(x.box);
    if (b && b !== except) { b.hidden = true; document.getElementById(x.input)?.setAttribute("aria-expanded", "false"); }
  });
}

document.addEventListener("click", (ev) => {
  // Tryck utanför en förslagslista stänger den.
  const inSuggest = ev.target.closest(".suggest");
  const field = Object.values(PLACE_FIELDS).find((x) => ev.target.id === x.input);
  if (!inSuggest) hideSuggestions(field ? document.getElementById(field.box) : null);
  if (!inSuggest && ev.target.id !== "w-search") { const wb = $("#w-suggest"); if (wb) wb.hidden = true; }
  const go = ev.target.closest("[data-go]");
  if (go) { ev.preventDefault(); closeSheet(); setView(go.dataset.go); return; }
  const a = ev.target.closest("[data-act]");
  if (!a || a.tagName === "SELECT") return;
  const fn = ACTIONS[a.dataset.act];
  if (!fn) return;
  if (a.tagName !== "A") ev.preventDefault();
  fn(a, ev);
});
document.addEventListener("submit", onSubmit);
document.addEventListener("input", onInput);
document.addEventListener("change", onChange);
document.addEventListener("keydown", (ev) => {
  // Enter i sökrutan för delar lägger till första förslaget i stället för att spara formuläret.
  if (ev.key === "Enter" && ev.target.id === "w-search") {
    ev.preventDefault();
    $("#w-suggest button")?.click();
    return;
  }
  // Piltangenter, Enter och Escape i förslagslistorna för Var och Adress.
  const field = Object.values(PLACE_FIELDS).find((x) => ev.target.id === x.input || ev.target.closest?.(`#${x.box}`));
  const box = field && document.getElementById(field.box);
  if (box && !box.hidden) {
    const opts = [...box.querySelectorAll("button")];
    const i = opts.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" && opts.length) { ev.preventDefault(); opts[Math.min(opts.length - 1, i + 1)].focus(); return; }
    if (ev.key === "ArrowUp" && opts.length) { ev.preventDefault(); if (i <= 0) document.getElementById(field.input).focus(); else opts[i - 1].focus(); return; }
    if (ev.key === "Enter" && ev.target.id === field.input && opts.length) { ev.preventDefault(); opts[0].click(); return; }
    if (ev.key === "Escape") { ev.preventDefault(); hideSuggestions(); document.getElementById(field.input).focus(); return; }
  }
  if (ev.key !== "Escape") return;
  if (document.getElementById("lightbox")) return $("#lightbox").remove();
  if (document.getElementById("map-choice")) return ACTIONS["map-choice-close"]();
  if (!$("#confirm").hidden) return closeConfirm(false);
  if (!sheet.hidden) closeSheet();
});
// En liten rad överst när nätet saknas, med hur många ändringar som väntar på att laddas upp.
function updateNetBanner() {
  const el = $("#net");
  if (!el) return;
  const n = S.pending.cars + S.pending.entries;
  const offline = !navigator.onLine;
  el.hidden = !offline && !(n && S.netWasOff);
  if (el.hidden) return;
  el.classList.toggle("syncing", !offline);
  el.textContent = offline
    ? (n ? `Ingen nätkontakt · ${n === 1 ? "1 ändring väntar" : `${n} ändringar väntar`}` : "Ingen nätkontakt · det du sparar laddas upp sen")
    : `Laddar upp ${n === 1 ? "1 ändring" : `${n} ändringar`} …`;
  if (!n && !offline) S.netWasOff = false;
}
window.addEventListener("offline", () => { S.netWasOff = true; updateNetBanner(); });
window.addEventListener("online", () => {
  updateNetBanner();
  if (!S.pending.cars && !S.pending.entries) { S.netWasOff = false; updateNetBanner(); }
  showToast("Nätet är tillbaka. Allt är uppladdat när raden överst försvinner.", 3000);
});
updateNetBanner();
window.addEventListener("popstate", () => {
  if (ignorePops) {
    // Rutan stängdes med en knapp och historiken backades ett steg. Byttes vyn under tiden ligger den kvar.
    ignorePops--;
    if (S.view && location.hash.slice(1) !== S.view) history.replaceState(null, "", "#" + S.view);
    return;
  }
  $("#lightbox")?.remove();
  if (document.getElementById("map-choice")) ACTIONS["map-choice-close"]();
  if (!$("#confirm").hidden) closeConfirm(false);
  if (!sheet.hidden) closeSheet(true);
});
window.addEventListener("hashchange", () => {
  const v = location.hash.slice(1);
  if (v && v !== S.view) { rememberPrev(v); S.view = v; render(); }
});

applyTheme(pref.get("theme") || "auto");
const initial = location.hash.slice(1);
if (initial) S.view = initial;

getRedirectResult(auth).catch((e) => renderLogin(authError(e)));
if (viewToken) renderShared(viewToken);
onAuthStateChanged(auth, (user) => {
  if (viewToken) return;
  const changed = (user?.uid || null) !== (S.user?.uid || null);
  S.user = user;
  if (!user) { cleanup(); renderLogin(); return; }
  if (changed || !S.hid) loadHousehold();
});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
    // Leta efter en ny version varje gång appen öppnas igen.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // En ny version har tagit över: ladda om en gång, men inte mitt i ett formulär.
    if (!hadController || reloaded || !sheet.hidden) return;
    reloaded = true;
    location.reload();
  });
}
