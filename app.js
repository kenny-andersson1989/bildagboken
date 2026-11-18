// Bildagboken — delad bilapp för ett hushåll. Data synkas via Firebase (Firestore + inloggning med Google eller Apple).
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  linkWithPopup, linkWithRedirect, onAuthStateChanged, signOut, reauthenticateWithPopup, deleteUser,
  signInWithCredential, linkWithCredential, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp, arrayUnion, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { MAPKIT_TOKEN } from "./maps-config.js";
import { CAR_MODELS } from "./car-models.js";
import { PARTS } from "./parts.js";
import { PART_INFO } from "./parts-info.js";

const VERSION = "2.8";

/* ---------------------------------------------------------------- språk */

// Svenska är grundspråket. Med engelska översätts allt som visas på skärmen när det ritas (se trTree längre ner).
// iPhone-appen (ett skal runt webbappen): inloggning och notiser går via iOS, eftersom Google
// inte tillåter inloggning i en inbäddad webbläsare och webbnotiser inte finns där.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
// Android-appen: Apple-inloggning går inte smidigt där, så bara Google visas.
const ANDROID = NATIVE && window.Capacitor?.getPlatform?.() === "android";
const nativePlugin = (name) => window.Capacitor?.Plugins?.[name] || window.Capacitor?.registerPlugin?.(name);
// Länkar som öppnar appen (bildagboken.com/?join=…, ?visa=…, ?ny=…): visa samma sida i appen.
// Kräver tillägget App i iPhone-appen (från version 1.1). I äldre versioner händer inget.
if (NATIVE && window.Capacitor?.isPluginAvailable?.("App")) {
  const AppLinks = nativePlugin("App");
  const openLink = (url) => {
    try {
      const u = new URL(url);
      if (u.hostname !== location.hostname) return;
      const to = u.pathname + u.search + u.hash;
      if (to !== location.pathname + location.search + location.hash) location.href = to;
    } catch { /* ingen giltig länk */ }
  };
  Promise.resolve(AppLinks.addListener("appUrlOpen", (e) => openLink(e.url))).catch(() => {});
  // Startades appen av en länk: öppna den en gång (annars laddas sidan om i en slinga).
  AppLinks.getLaunchUrl().then((r) => {
    if (!r?.url) return;
    let seen = null;
    try { seen = sessionStorage.getItem("bildagboken.launchUrl"); sessionStorage.setItem("bildagboken.launchUrl", r.url); } catch { /* utan lagring */ }
    if (seen !== r.url) openLink(r.url);
  }).catch(() => {});
}
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
  trips: [],
  places: [],
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
// I Glenns teman används symbolerna i pixelstil (px-), annars de vanliga (i-).
const normWord = (t) => String(t || "").toLowerCase().replace(/é/g, "e").trim();
// Saknas en pixelvariant (till exempel delarnas ikoner) används pixelskiftnyckeln.
const icon = (name, size = 22) => {
  const px = document.documentElement.dataset.garage && (document.getElementById(`px-${name}`) ? name : "wrench");
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${px ? `px-${px}` : `i-${name}`}"/></svg>`;
};

// Ikon för en underhållspunkt eller en del. Först punktens id, sedan delkatalogen i parts.js:
// den del vars ord (namn eller alias) är längst och finns i namnet vinner. Inget träffar: skiftnyckeln.
const PART_ICON_IDS = { olja: "p-olja", luftfilter: "p-luftfilter", kupefilter: "p-kupefilter", tandstift: "p-tandstift", bromsvatska: "p-bromsvatska", torkare: "p-torkare", ac: "p-ac", batteri: "p-batteri", kamrem: "p-kamrem" };
// Underhållspunkternas namn räknas också, så att till exempel "Tändstiftsats" får tändstiftets ikon.
const PART_WORDS = [
  ["motorolja", "p-olja"], ["luftfilter", "p-luftfilter"], ["kupefilter", "p-kupefilter"], ["tändstift", "p-tandstift"],
  ["torkarblad", "p-torkare"], ["batteri", "p-batteri"], ["klimatanläggning", "p-klimat"],
  ...PARTS.flatMap((x) => [x.name, ...(x.alias || [])].map((w) => [w, x.icon])),
].map(([w, ic]) => [normWord(w), ic]).sort((a, b) => b[0].length - a[0].length);
// "Bra att veta" för en del i delkatalogen: delens eget namn, annars den del vars ord finns i namnet
// (längst ord först, så "Bromsskivor fram vänster" hittar Bromsskivor fram).
const PART_INFO_WORDS = PARTS.flatMap((p) => [p.name, ...(p.alias || [])].map((w) => [normWord(w), p.name])).sort((a, b) => b[0].length - a[0].length);
function partInfo(name) {
  if (!name) return null;
  const exact = PART_INFO[name] || PART_INFO[Object.keys(PART_INFO).find((k) => normWord(k) === normWord(name))];
  const hit = exact || PART_INFO[PART_INFO_WORDS.find(([w]) => w && normWord(name).includes(w))?.[1]];
  return hit ? [hit[EN ? 1 : 0]] : null;
}
function partIcon(name, id) {
  if (id && PART_ICON_IDS[id]) return PART_ICON_IDS[id];
  const t = normWord(name);
  return PART_WORDS.find(([w]) => t.includes(w))?.[1] || "wrench";
}
// Delar i katalogen som passar det man skrivit: namn som börjar med texten först, sedan namn som innehåller den,
// sedan delar där ett annat ord för delen passar (skriver man "belägg" föreslås Bromsklotsar).
const PART_SIDES = { fram: ["Vänster fram", "Höger fram"], bak: ["Vänster bak", "Höger bak"] };
function catalogMatches(q) {
  const t = normWord(q);
  if (t.length < 2) return [];
  const score = (x) => {
    const n = normWord(x.name);
    if (n.startsWith(t)) return 0;
    if (n.includes(t)) return 1;
    return (x.alias || []).some((a) => normWord(a).startsWith(t) || (t.length >= 4 && t.includes(normWord(a)))) ? 2 : 9;
  };
  return PARTS.map((x) => [score(x), x]).filter(([sc]) => sc < 9).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
}// Symbolerna som står direkt i index.html (menyn) byts när temat byts.
function swapIcons(root = document) {
  const px = !!document.documentElement.dataset.garage;
  root.querySelectorAll("use").forEach((u) => {
    const h = u.getAttribute("href") || "";
    if (/^#(i|px)-/.test(h)) u.setAttribute("href", h.replace(/^#(i|px)-/, px ? "#px-" : "#i-"));
  });
}
swapIcons();
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
// Resultatet av en besiktning, som det står på protokollet.
const INSP_RESULTS = { godkand: "Godkänd", anmarkning: "Godkänd med anmärkning", efterkontroll: "Underkänd, efterkontroll", korforbud: "Körförbud" };
const INSP_SHORT = { godkand: "Godkänd", anmarkning: "Anmärkning", efterkontroll: "Efterkontroll", korforbud: "Körförbud" };
const inspFailed = (r) => r === "efterkontroll" || r === "korforbud";
const isInspection = (e) => e?.type === "kostnad" && e.category === "Besiktning";

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

// Uppgraderar bilarnas underhållspunkter en gång, och ändrar inget som man själv har ställt in:
// version 2: AC-service och bilbatteri läggs till om de saknas.
// version 3: punkter som fortfarande har de gamla standardintervallen får de nya.
function addNewItems(cars) {
  for (const c of cars) {
    if (!Array.isArray(c.items) || (c.itemsV || 0) >= 3 || c.metadata?.hasPendingWrites || !S.hid) continue;
    let items = c.items;
    if ((c.itemsV || 0) < 2) items = [...items, ...[{ id: "ac", name: "AC-service", mil: null, months: 24 }, { id: "batteri", name: "Bilbatteri", mil: null, months: 60 }].filter((x) => !items.some((i) => i.id === x.id))];
    const same = (i, mil, months) => (i.mil ?? null) === mil && (i.months ?? null) === months;
    items = items.map((i) => {
      if (i.id === "luftfilter" && same(i, 4000, 48)) return { ...i, mil: 6000, months: null };
      if (i.id === "kupefilter" && same(i, 2000, 24)) return { ...i, mil: 3000 };
      if (i.id === "tandstift" && (same(i, 3000, 72) || same(i, 6000, 72))) return { ...i, mil: 10000, months: null };
      return i;
    });
    c.items = items; c.itemsV = 3;
    updateDoc(doc(db, "households", S.hid, "cars", c.id), { items, itemsV: 3 }).catch(() => {});
  }
}

function defaultItems(c) {
  const el = isElectric(c), diesel = isDiesel(c), flex = isFlex(c);
  const p = profileFor(c);
  const items = [];
  if (!el) items.push({ id: "olja", name: "Motorolja och oljefilter", mil: 2000, months: 12 });
  if (!el) items.push({ id: "luftfilter", name: "Luftfilter", mil: 6000, months: null });
  items.push({ id: "kupefilter", name: "Kupéfilter", mil: 3000, months: 24 });
  if (!el && !diesel) items.push({ id: "tandstift", name: "Tändstift", mil: 10000, months: null });
  items.push({ id: "bromsvatska", name: "Bromsvätska", mil: null, months: 24 });
  items.push({ id: "torkare", name: "Torkarblad", mil: null, months: 12 });
  items.push({ id: "ac", name: "AC-service", mil: null, months: 24 });
  items.push({ id: "batteri", name: "Bilbatteri", mil: null, months: 60 });
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
  // Resor i körjournalen räknas också: mätaren vid start direkt, och mätaren vid slut när resan avslutas.
  for (const t of S.trips) {
    if (t.carId !== carId || t.id === excludeId) continue;
    const reads = [t.odoStart != null && { date: t.date, odometer: t.odoStart, createdAt: t.startedAt || t.createdAt },
      t.odoEnd != null && { date: t.date, odometer: t.odoEnd, createdAt: t.endedAt || t.createdAt }].filter(Boolean);
    for (const e of reads) if (!best || (e.date || "") > (best.date || "") || ((e.date || "") === (best.date || "") && tsMs(e.createdAt) > tsMs(best.createdAt))) best = e;
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
// Nästa betalning efter i dag för en återkommande kostnad, eller null om den har slutat.
function nextRecDate(r) {
  const s = parseDate(r.start), t = todayStr();
  if (!s || !r.period) return null;
  for (let i = 0; i < 1200; i++) {
    const ds = ymd(addMonthsKeepDay(s, i * r.period));
    if (ds > t) return r.end && ds > r.end ? null : ds;
  }
  return null;
}
function dayBeforeStr(ds) {
  const d = parseDate(ds);
  d.setDate(d.getDate() - 1);
  return ymd(d);
}
// Nytt pris från ett datum: den gamla regeln slutar dagen före och en ny tar vid, så tidigare betalningar behåller sitt pris.
// Efter ett prisbyte är parkeringen flera regler efter varandra (`prev` pekar bakåt). Hela kedjan, äldst först.
function recChain(c, rid) {
  const all = c.recurring || [];
  let r = all.find((x) => x.id === rid);
  if (!r) return [];
  const seen = new Set([r.id]);
  while (r.prev && !seen.has(r.prev)) { const p = all.find((x) => x.id === r.prev); if (!p) break; seen.add(p.id); r = p; }
  const out = [r];
  for (;;) { const n = all.find((x) => x.prev === out.at(-1).id && !out.includes(x)); if (!n) break; out.push(n); }
  return out;
}
const recPeriod = (r) => `${fmtKr(r.amount)} kr, ${PERIODS[r.period]?.toLowerCase()}`;
function splitRecurring(c, r, from, changes) {
  const rest = (c.recurring || []).filter((x) => x.id !== r.id);
  if (from <= r.start) return [...rest, clean({ ...r, ...changes })];
  const old = { ...r, end: dayBeforeStr(from) };
  const neu = clean({ ...r, ...changes, id: "r" + randomId(8), prev: r.id, start: from, createdBy: uid(), createdAt: Date.now() });
  return [...rest, old, neu];
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
// Gratisversionens gränser. Avstängda tills Plus går att köpa: sätt då `from` till startdagen, till exempel "2027-03-01".
// Hushåll som skapades före den dagen och inte har Plus har inga gränser. Plus har egna gränser (PLUS).
// Hushåll som skapas från och med 16 november 2026 har gratisgränserna. De som fanns innan har inga gränser.
const FREE = { from: "2026-11-16", cars: 1, members: 2, photos: 30 };
// Går Plus att köpa? Tills dess har nya hushåll gratisversionen, och Plus visas som "kommer snart".
const PLUS_ON_SALE = false;
// Plus är för en familj, som familjeabonnemang brukar vara: upp till sex personer och sex bilar.
const PLUS = { cars: 6, members: 6, photos: 2000 };
// Testläge för administratören: visa appen som gratisversionen (med gränserna) eller som Plus.
// Gäller bara på den här enheten och bara för det egna hushållet. Inget sparas i databasen.
const testMode = () => (S.user && isAdmin() ? pref.get("testMode") || "" : "");
const hasPlus = (h = S.house) => (h === S.house && testMode() ? testMode() === "plus" : tsMs(h?.plus?.until) > Date.now());
function limited(h = S.house) {
  if (h === S.house && testMode()) return testMode() === "free";
  if (!FREE.from || !h || hasPlus(h)) return false;
  const made = tsMs(h.createdAt);
  return !made || made >= Date.parse(FREE.from);
}
// Plus visas för alla först när det går att köpa. Administratören ser det i testläget.
const plusOnSale = () => PLUS_ON_SALE || !!testMode();
// Funktioner som bara finns i Plus. Administratören har dem (utom i testläget).
const plusFeat = () => hasPlus() || (isAdmin() && !testMode());
// Låst, men går att köpa: då visas funktionen med en hänvisning till Plus. Innan Plus säljs är den dold.
const plusLock = () => !plusFeat() && plusOnSale();
// Rutan som visas när man trycker på något som ingår i Plus.
const PLUS_FEATURES = {
  garage: ["wrench", "Glenns Garage", "Tre teman i pixelstil, med Glenns skylt på Översikt och saker från verkstaden på korten."],
  glenn: ["spark", "Fråga Glenn", "Glenn är appens AI. Skriv eller prata med honom om allt ni har loggat: kostnader, service, däck och förbrukning."],
  ai: ["camera", "Läsning med AI", "Fota kvittot, servicefakturan eller besiktningsprotokollet, så fylls allt i åt dig."],
  trips: ["route", "Körjournal", "Logga tjänsteresor och privata resor. Milersättningen räknas ut, och iPhone-appen kan logga resorna själv."],
  cars: ["car", "Upp till 6 bilar", "Hela familjens bilar i samma app, och alla fungerar samtidigt."],
  members: ["home", "Upp till 6 personer", "Alla i familjen som kör bilarna kan vara med."],
  photos: ["image", "2 000 bilder", "Plats för kvitton, dokument och bilder på bilen."],
  docs: ["doc", "Papper och avtal", "Försäkring, garanti, vägassistans och andra papper på ett ställe, med påminnelse innan något går ut."],
  forecast: ["calendar", "Smarta påminnelser", "Appen räknar ut när service och byten blir aktuella utifrån hur mycket ni kör."],
  econ: ["coin", "Mer om kostnaderna", "Jämför år mot år och se vad bilen beräknas kosta i år."],
  salepack: ["print", "Säljpaket", "Serviceboken som PDF med kvittona och en sammanställning av kostnaderna, inför en försäljning."],
  letter: ["bell", "Glenns månadsbrev", "En hälsning från Glenn varje månad: vad bilen kostade, hur mycket ni körde och vad som närmar sig."],
};
function plusUpsell(key) {
  const f = PLUS_FEATURES[key];
  if (!f || !plusOnSale()) return plusSheet();
  const others = PLUS_PERKS.filter(([, t]) => t !== f[1]).slice(0, 4).map(([, t]) => (/^Fråga/.test(t) ? t : t[0].toLowerCase() + t.slice(1)));
  openSheet("Ingår i Plus", `
    <div class="upsell-hero"><span class="dl-ic">${icon(f[0], 26)}</span><div><b>${esc(f[1])}</b><span>${esc(f[2])}</span></div></div>
    <p class="muted">${esc(`Med Plus får ni också ${others.join(", ")} och mer. Ett köp gäller alla i hushållet.`)}</p>
    <div class="form" style="margin-top:14px">
      ${canBuyHere() ? `<button class="btn primary block" type="button" data-act="plus-buy">Prova gratis i 14 dagar</button>` : ""}
      <button class="btn ${canBuyHere() ? "ghost" : "primary"} block" type="button" data-act="plus">Läs mer om Plus</button>
    </div>
    ${canBuyHere() ? "" : `<p class="hint">Plus köps i iPhone-appen och gäller sedan för alla i hushållet, också här.</p>`}`);
}
// "Ni har Plus till 3 mars 2027", eller utan datum (testläget).
const plusUntilText = () => { const u = tsMs(S.house?.plus?.until); return u > Date.now() ? `Ni har Plus till ${fmtDate(ymd(new Date(u)))}` : "Ni har Plus"; };
// Fördelarna med Plus, i den ordning de visas överallt.
const PLUS_PERKS = [
  ["route", "Körjournal", "Logga tjänsteresor och privata resor. Milersättningen räknas ut, och iPhone-appen kan logga resorna själv."],
  ["spark", "Fråga Glenn", "Glenn är appens AI. Skriv eller prata med honom om allt ni har loggat: kostnader, service, däck och förbrukning."],
  ["camera", "Läsning med AI", "Fota kvittot, servicefakturan eller besiktningsprotokollet, så fylls allt i åt dig."],
  ["car", "Upp till 6 bilar", "Hela familjens bilar i samma app."],
  ["home", "Upp till 6 personer", "Alla i familjen som kör bilarna."],
  ["image", "2 000 bilder", "Plats för kvitton, dokument och bilder på bilen."],
];
// Gränserna som gäller för hushållet: gratis, Plus, eller inga alls (innan Plus säljs, och för hushåll
// som skapades före FREE.from och inte har Plus).
function caps(h = S.house) {
  if (h === S.house && testMode()) return testMode() === "plus" ? PLUS : FREE;
  if (!FREE.from || !h) return null;
  if (hasPlus(h)) return PLUS;
  return limited(h) ? FREE : null;
}
const photoCount = () => S.entries.reduce((a, e) => a + photosOf(e).length, 0);
function limitSheet(kind) {
  if (caps() === PLUS) {
    const what = { cars: `${PLUS.cars} bilar`, members: `${PLUS.members} personer`, photos: `${fmt(PLUS.photos)} bilder` }[kind];
    return openSheet("Fullt", `<p>${esc(`Bildagboken Plus har plats för ${what} i ett hushåll.${kind === "photos" ? " Ta bort några bilder för att lägga till nya." : ""}`)}</p>
      ${kind === "photos" ? "" : `<p class="muted">Behöver ni fler, till exempel för ett företag? Skriv till <a class="link" href="mailto:kontakt@bildagboken.com" data-notr>kontakt@bildagboken.com</a>.</p>`}`);
  }
  const text = {
    cars: `Gratisversionen har plats för ${FREE.cars} bil. Med Bildagboken Plus kan ni ha upp till ${PLUS.cars} bilar.`,
    members: `Gratisversionen har plats för ${FREE.members} personer i hushållet. Med Bildagboken Plus kan ni vara upp till ${PLUS.members}.`,
    photos: `Gratisversionen har plats för ${FREE.photos} bilder. Alla bilder finns kvar, men för att lägga till nya behöver ni ta bort några eller skaffa Bildagboken Plus.`,
  }[kind];
  openSheet("Bildagboken Plus", `<p>${esc(text)}</p>
    ${plusOnSale() ? "" : `<p class="muted">Bildagboken Plus går inte att köpa än, men kommer snart.</p>`}
    <div class="form" style="margin-top:16px"><button class="btn primary block" type="button" data-act="plus">Läs om Bildagboken Plus</button></div>`);
}
// Utan Plus fungerar bara en bil. Ägaren väljer vilken (activeCar), annars den som lades till först.
// De andra är låsta: allt finns kvar, men det går inte att logga på dem förrän ni har Plus igen.
const ACTIVE_CAR_DAYS = 30; // så ofta ägaren får byta vilken bil som fungerar
function activeCarId() {
  const c = caps();
  if (!c || S.cars.length <= c.cars) return null;
  return S.cars.find((x) => x.id === S.house?.activeCar)?.id || S.cars[0]?.id || null;
}
const carLocked = (c) => { const a = activeCarId(); return !!(a && c && c.id !== a); };
// När ägaren får byta bil nästa gång (0 = nu).
const activeCarNext = () => { const t = tsMs(S.house?.activeCarAt); return t && Date.now() - t < ACTIVE_CAR_DAYS * 864e5 ? t + ACTIVE_CAR_DAYS * 864e5 : 0; };
// Förr kunde "Senast bytt" fyllas i för hand under Underhåll, utanför loggen. De datumen flyttas in i loggen
// som egna jobb (ett per datum), så att allt underhåll finns i loggen. Id:t bestäms av bilen och datumet,
// så det blir bara en post även om flera telefoner gör det samtidigt.
const baseMigrated = new Set();
function migrateBaseDates(c) {
  const withBase = (c.items || []).filter((i) => i.baseDate);
  if (!withBase.length || baseMigrated.has(c.id) || !S.hid) return;
  baseMigrated.add(c.id);
  const byDate = {};
  for (const i of withBase) (byDate[i.baseDate] = byDate[i.baseDate] || []).push(i);
  const writes = Object.entries(byDate).map(([date, list]) => {
    const names = list.map((i) => i.name);
    const title = `${names.length > 1 ? `${names.slice(0, -1).join(", ")} och ${names.at(-1).toLowerCase()}` : names[0]} bytt`;
    const mil = list.find((i) => i.baseMil != null)?.baseMil ?? null;
    return setDoc(doc(col("entries"), `base-${c.id}-${date}`), clean({
      type: "eget", carId: c.id, date, title, items: list.map((i) => i.id), odometer: mil, note: "Fanns ifyllt i Underhåll",
      fromBase: true, createdBy: uid(), createdAt: serverTimestamp(),
    }), { merge: true });
  });
  Promise.all(writes)
    .then(() => updateDoc(ref("cars", c.id), { items: c.items.map((i) => { const { baseDate, baseMil, ...rest } = i; return rest; }) }))
    .catch((e) => { baseMigrated.delete(c.id); console.warn("Flytta datum till loggen", e); });
}
// Papperskorgen: en borttagen bil (deletedAt) ligger kvar i TRASH_DAYS dagar och kan återställas av ägaren.
// Funktionen rensaPapperskorg raderar den sedan för gott. Loggen och resorna för bilen döljs under tiden.
const TRASH_DAYS = 30;
function syncTrash() {
  const gone = new Set((S.trash || []).map((c) => c.id));
  if (S.allEntries) {
    S.trashEntries = S.allEntries.filter((e) => e.deletedAt && !gone.has(e.carId)).sort((a, b) => tsMs(b.deletedAt) - tsMs(a.deletedAt));
    S.entries = S.allEntries.filter((e) => !e.deletedAt && !gone.has(e.carId));
  }
  if (S.allTrips) S.trips = gone.size ? S.allTrips.filter((t) => !gone.has(t.carId)) : S.allTrips;
  if (S.carId && !S.cars.some((c) => c.id === S.carId)) {
    const saved = pref.get("car");
    S.carId = S.cars.find((c) => c.id === saved)?.id || S.cars[0]?.id || null;
  }
}
const trashUntil = (c) => new Date(tsMs(c.deletedAt) + TRASH_DAYS * 864e5);
async function restoreCar(id) {
  const c = (S.trash || []).find((x) => x.id === id);
  if (!c) return;
  if (!isOwner()) return showToast("Bara hushållets ägare kan återställa bilen.");
  if (caps() && S.cars.length >= caps().cars) return limitSheet("cars");
  try {
    await updateDoc(ref("cars", id), { deletedAt: deleteField(), deletedBy: deleteField() });
    pref.set("car", id);
    if (S.cars.some((x) => x.id === id)) S.carId = id;
    showToast(`${carName(c)} är återställd`);
    render();
  } catch (e) { onWriteError(e); }
}
function restoreEntry(id) {
  updateDoc(ref("entries", id), { deletedAt: deleteField(), deletedBy: deleteField() }).then(() => showToast("Posten är återställd")).catch(onWriteError);
}
// En rad för en borttagen post: vad, när, vilken bil och vem som tog bort den.
function trashEntryRow(e) {
  const c = S.cars.find((x) => x.id === e.carId);
  const what = [TYPE[e.type]?.label || "Post", e.date ? fmtDateShort(e.date) : "", e.amount != null ? `${fmtKr(e.amount)} kr` : "", S.cars.length > 1 && c ? carName(c) : ""].filter(Boolean).join(" · ");
  return `<div class="dl"><span class="dl-ic">${icon(TYPE[e.type]?.icon || "list", 20)}</span>
    <span><span class="dl-t">${esc(what)}</span><span class="dl-s">${esc(`Borttagen av ${e.deletedBy === uid() ? "dig" : memberName(e.deletedBy)} · raderas för gott ${fmtDate(ymd(trashUntil(e)))}`)}</span></span>
    <button class="btn-soft" type="button" data-act="trash-entry" data-id="${esc(e.id)}">Återställ</button></div>`;
}
function trashCard() {
  const t = S.trash || [], te = S.trashEntries || [];
  if (!t.length && !te.length) return "";
  return `<div class="card"><h2>Papperskorg</h2>
    ${te.length ? `<details class="more"${t.length ? "" : " open"}><summary>${esc(`Borttagna poster (${te.length})`)}</summary><div class="rows">${te.slice(0, 50).map(trashEntryRow).join("")}</div></details>` : ""}
    <div class="rows">${t.map((c) => `<div class="dl"><span class="dl-ic">${icon("car", 20)}</span>
      <span><span class="dl-t">${esc(carName(c))}</span><span class="dl-s">${esc(`Raderas för gott ${fmtDate(ymd(trashUntil(c)))}`)}</span></span>
      ${isOwner() ? `<span class="trash-acts"><button class="btn-soft" type="button" data-act="trash-restore" data-id="${esc(c.id)}">Återställ</button><button class="link danger" type="button" data-act="trash-delete" data-id="${esc(c.id)}">Radera nu</button></span>` : "<span></span>"}</div>`).join("")}</div>
    <p class="hint" style="margin-top:8px">${esc(`Det som tas bort ligger här i ${TRASH_DAYS} dagar, så att det går att få tillbaka. Sedan raderas det för gott.${t.length && !isOwner() ? ` Bilar kan bara hushållets ägare, ${memberName(ownerUid())}, återställa.` : ""}`)}</p>
  </div>`;
}
// Raden med bilarna (tryck för att byta) och Lägg till bil. Samma på Översikt och Bilen.
function carChips(c, add = true) {
  return `<div class="car-chips" role="group" aria-label="Välj bil">
    ${S.cars.map((x) => `<button type="button" data-act="pick-car" data-id="${esc(x.id)}" aria-pressed="${x.id === c.id}">${icon(carLocked(x) ? "lock" : "car", 16)}${esc(carName(x))}</button>`).join("")}
    ${add ? `<button type="button" class="add" data-act="add-car">${icon("plus", 16)}Lägg till bil</button>` : ""}
  </div>`;
}
function viewLocked() {
  const c = car(), a = S.cars.find((x) => x.id === activeCarId());
  const next = activeCarNext();
  return `${headerMain()}
  <div class="car-chips" role="group" aria-label="Välj bil">
    ${S.cars.map((x) => `<button type="button" data-act="pick-car" data-id="${esc(x.id)}" aria-pressed="${x.id === c.id}">${icon(carLocked(x) ? "lock" : "car", 16)}${esc(carName(x))}</button>`).join("")}
  </div>
  <article class="card locked-car">
    <span class="lc-ic">${icon("lock", 28)}</span>
    <h2>${esc(`${carName(c)} är låst`)}</h2>
    <p class="muted">${esc(`Utan Plus fungerar en bil i taget, och just nu är det ${carName(a)}. Allt som är loggat på ${carName(c)} finns kvar och syns igen när ni har Plus.`)}</p>
    <div class="form" style="margin-top:14px">
      <button class="btn primary block" type="button" data-act="plus" data-f="cars">${icon("spark", 18)} Skaffa Plus, så fungerar alla bilar</button>
      <button class="btn block" type="button" data-act="pick-car" data-id="${esc(a.id)}">${esc(`Gå till ${carName(a)}`)}</button>
      ${isOwner()
        ? next ? `<p class="hint">${esc(`Du kan byta vilken bil som fungerar igen ${fmtDate(ymd(new Date(next)))}.`)}</p>`
          : `<button class="hh-ghost" type="button" data-act="set-active-car" data-id="${esc(c.id)}">${esc(`Använd ${carName(c)} i stället`)}</button>`
        : `<p class="hint">${esc(`Det är hushållets ägare, ${memberName(ownerUid())}, som väljer vilken bil som fungerar.`)}</p>`}
    </div>
  </article>`;
}
const membersFull = () => { const c = caps(); return !!c && (S.house?.members || []).length >= c.members; };
// Ett tips om Plus på Översikt, en gång, när appen har hunnit göra nytta (20 loggade saker eller en månad).
function plusTipCard() {
  if (!limited() || !plusOnSale() || pref.get("plusTip." + S.hid)) return "";
  const month = Date.now() - tsMs(S.house?.createdAt) > 30 * 864e5;
  if (S.entries.length < 20 && !month) return "";
  return `<article class="card plus-tip">
    <h2>Gillar ni Bildagboken?</h2>
    <div class="tip-perks">
      <div>${icon("spark", 18)}<span><b>Fråga Glenn</b> om allt ni har loggat, med text eller röst</span></div>
      <div>${icon("route", 18)}<span><b>Körjournal</b> som räknar ut milersättningen</span></div>
      <div>${icon("camera", 18)}<span><b>Fota kvittot</b>, så fyller AI i resten</span></div>
      <div>${icon("car", 18)}<span><b>Hela familjen</b>: upp till 6 bilar och 6 personer</span></div>
    </div>
    <p class="muted">${esc(canBuyHere() ? "Prova gratis i 14 dagar. Ett köp gäller alla i hushållet." : "Ett köp gäller alla i hushållet.")}</p>
    <div class="ask"><button class="btn-soft" type="button" data-act="plus-tip" data-id="read">${icon("spark", 16)} Läs om Plus</button><button class="hh-ghost" type="button" data-act="plus-tip">Inte nu</button></div>
  </article>`;
}
// Plus-sidan. Visas först när gränserna är påslagna (FREE.from). Köpet byggs in med RevenueCat.
function plusSheet() {
  const rows = [
    ["Bilar", `${FREE.cars}`, `${PLUS.cars}`],
    ["Personer i hushållet", `${FREE.members}`, `${PLUS.members}`],
    ["Bilder", `${FREE.photos}`, fmt(PLUS.photos)],
    ["Körjournal", "–", "Ingår"],
    ["Läsning med AI", "–", "Ingår"],
    ["Fråga Glenn (AI)", "–", "Ingår"],
  ];
  openSheet("Bildagboken Plus", `
    <p>${hasPlus() ? esc(`${plusUntilText()}. Det gäller alla i hushållet.`) : "Ett köp gäller alla i hushållet. Allt ni har loggat finns kvar, vad ni än väljer."}</p>
    <div class="plus-perks">${PLUS_PERKS.map(([ic, t, d]) => `<div class="plus-perk"><span class="dl-ic">${icon(ic, 20)}</span><div><b>${esc(t)}</b><span>${esc(d)}</span></div></div>`).join("")}</div>
    <table class="plus-t"><thead><tr><th></th><th>Gratis</th><th>Plus</th></tr></thead>
      <tbody>${rows.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td><b>${esc(c)}</b></td></tr>`).join("")}</tbody></table>
    ${hasPlus() && !tripsVisible() ? `<div class="form" style="margin-top:16px"><button class="btn primary block" type="button" data-act="trips-on">${icon("route", 18)} Slå på körjournalen</button></div>` : ""}
    ${hasPlus() ? (S.house?.plus?.by === uid() && !S.house?.plus?.gift ? `<p class="hint" style="margin-top:16px">${canBuyHere() ? `Du betalar för Plus via App Store. <a href="https://apps.apple.com/account/subscriptions" target="_blank" rel="noopener">Hantera eller avsluta prenumerationen</a>` : "Du betalar för Plus via App Store. Prenumerationen hanterar du i iPhone-appen eller under Inställningar → ditt namn → Prenumerationer på din iPhone."}</p>` : "")
      : !plusOnSale() ? `<p class="hint" style="margin-top:16px">Plus går inte att köpa än, men kommer snart. Allt ni loggar nu finns kvar när ni uppgraderar.</p>`
      : canBuyHere() ? `<div class="form" style="margin-top:16px"><button class="btn primary block" type="button" data-act="plus-buy">Skaffa Plus</button>
      <p class="hint">Prova gratis i 14 dagar. Avsluta när du vill.</p></div>`
      : `<p class="hint" style="margin-top:16px">Plus köps i iPhone-appen. När någon i hushållet har köpt det gäller det för alla, också här.</p>`}`);
}

// Köp av Plus i iPhone-appen, med RevenueCat. Den publika nyckeln får synas i appen. Användarens id i
// RevenueCat är Firebase-id:t, så servern (revenuecatWebhook) vet vilket hushåll köpet gäller.
const RC_KEY = "appl_FjMWAabuQLsCPRttCaLPjSvJxqP";
const canBuyHere = () => NATIVE && !ANDROID;
let rcUser = null;
async function rcPlugin() {
  if (!canBuyHere() || !S.user || !window.Capacitor?.isPluginAvailable?.("Purchases")) return null;
  const P = nativePlugin("Purchases");
  if (rcUser === null) await P.configure({ apiKey: RC_KEY, appUserID: S.user.uid }).catch((e) => { if (!/already/i.test(e?.message || "")) throw e; });
  else if (rcUser !== S.user.uid) await P.logIn({ appUserID: S.user.uid });
  rcUser = S.user.uid;
  return P;
}
const rcCancelled = (e) => !!(e?.userCancelled || e?.data?.userCancelled) || String(e?.code ?? e?.data?.code ?? "") === "1";
const rcHasPlus = (info) => { const a = (info?.customerInfo || info)?.entitlements?.active || {}; return !!(a.bildagboken_plus || a.plus); };
const PERIOD_UNIT = { DAY: ["dag", "dagar"], WEEK: ["vecka", "veckor"], MONTH: ["månad", "månader"], YEAR: ["år", "år"] };
function introText(p) {
  const i = p?.introPrice;
  if (!i) return "";
  const n = i.periodNumberOfUnits || 1, u = PERIOD_UNIT[i.periodUnit] || ["", ""];
  const len = `${n} ${n === 1 ? u[0] : u[1]}`;
  return i.price === 0 ? `${len} gratis` : `${i.priceString} de första ${len}`;
}
let rcPkgs = [];
async function plusBuySheet() {
  openSheet("Skaffa Plus", `<p class="muted">Hämtar priserna …</p>`);
  let P = null, err = "";
  const hasPlugin = canBuyHere() && !!window.Capacitor?.isPluginAvailable?.("Purchases");
  try {
    P = await rcPlugin();
    if (P) {
      const o = await P.getOfferings();
      const order = { MONTHLY: 1, ANNUAL: 2 };
      rcPkgs = (o?.current?.availablePackages || []).slice().sort((a, b) => (order[a.packageType] || 9) - (order[b.packageType] || 9));
      if (!rcPkgs.length) err = o?.current ? "Erbjudandet har inga paket" : `Inget aktuellt erbjudande (${Object.keys(o?.all || {}).join(", ") || "inga alls"})`;
    }
  } catch (e) {
    reportError(e, "plus-offerings"); rcPkgs = [];
    err = [e?.code != null ? `kod ${e.code}` : "", e?.readableErrorCode || e?.data?.readableErrorCode || "", e?.message || String(e), e?.underlyingErrorMessage || e?.data?.underlyingErrorMessage || ""].filter(Boolean).join(" · ");
  }
  // Administratören ser felet, så att det går att se vad som är fel i App Store Connect eller RevenueCat.
  const errHtml = err && isAdmin() ? `<p class="hint" style="word-break:break-word">Fel: ${esc(err)}</p>` : "";
  if (!P && hasPlugin) {
    openSheet("Skaffa Plus", `<p>Köpet gick inte att starta just nu. Försök igen om en stund.</p>${errHtml}
      <div class="form"><button class="btn block" type="button" data-act="plus-buy">Försök igen</button></div>`);
    return;
  }
  if (!P) {
    openSheet("Skaffa Plus", `<p>Den här versionen av appen kan inte köpa Plus än. Uppdatera Bildagboken i App Store (eller TestFlight) och försök igen.</p>`);
    return;
  }
  if (!rcPkgs.length) {
    openSheet("Skaffa Plus", `<p>Priserna gick inte att hämta just nu. Kontrollera att du är uppkopplad och försök igen om en stund.</p>${errHtml}
      <div class="form"><button class="btn block" type="button" data-act="plus-buy">Försök igen</button></div>`);
    return;
  }
  const rows = rcPkgs.map((pk, i) => {
    const p = pk.product || {};
    const yearly = pk.packageType === "ANNUAL";
    const intro = introText(p);
    const sub = [yearly && p.pricePerMonthString ? `${p.pricePerMonthString} i månaden` : "", intro].filter(Boolean).join(" · ");
    return `<button class="plus-pkg${yearly ? " best" : ""}" type="button" data-act="plus-pkg" data-i="${i}">
      <span><b>${yearly ? "Ett år" : pk.packageType === "MONTHLY" ? "En månad" : esc(p.title || "Plus")}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>
      <span class="plus-price">${esc(p.priceString || "")}<small>${yearly ? "per år" : pk.packageType === "MONTHLY" ? "per månad" : ""}</small></span></button>`;
  }).join("");
  openSheet("Skaffa Plus", `<p class="muted">Ett köp gäller alla i hushållet.</p>
    <div class="plus-pkgs">${rows}</div>
    <p class="hint">Betalningen dras från ditt Apple-konto när provperioden är slut. Prenumerationen förnyas automatiskt tills du avslutar den, senast ett dygn innan perioden tar slut. Du avslutar den när du vill under Inställningar → ditt namn → Prenumerationer.</p>
    <p class="hint"><a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/" target="_blank" rel="noopener">Användarvillkor</a> · <a href="${LANG === "en" ? "privacy.html" : "integritet.html"}" target="_blank" rel="noopener">Integritet</a></p>
    <div class="form"><button class="btn ghost block" type="button" data-act="plus-restore">Återställ tidigare köp</button></div>`);
}
// Efter köpet: servern slår på Plus när RevenueCat har hört av sig, oftast inom några sekunder.
function plusThanks() {
  openSheet("Tack!", `<p>Plus slås nu på för hela hushållet. Det tar oftast bara några sekunder.</p>
    <div class="form"><button class="btn primary block" type="button" data-act="close-sheet">Klart</button></div>`);
}
// Hushållets ägare: den som betalar för Plus (plus.by, skrivs av servern vid köpet), annars den som skapade
// hushållet. Bara ägaren kan ta bort andra (också i säkerhetsreglerna).
const ownerUid = (h = S.house) => h?.owner || h?.members?.[0] || null;
const isOwner = () => ownerUid() === uid();
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
const WORK_ACTIONS = { bytt: "Bytt", lagat: "Lagat", pafyllt: "Fyllt på", rengjort: "Rengjort", kontrollerat: "Kontrollerat" };
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
const NO_POSITION = ["olja", "luftfilter", "kupefilter", "bromsvatska", "kamrem", "tandstift", "ac", "batteri"];
// Menyn "Var på bilen" visas bara för delar som sitter på flera ställen. Appen känner igen dem på namnet.
// Allt annat (AC, batteri, vätskor, filter och liknande) får en liten länk för att ange det ändå.
const POS_FRONTBACK = /torkar|lamp|lykt|strålkastar|blinker/i;
const POS_CORNERS = /broms(?!vätsk|huvud|servo|olja)|belägg|skiv|bromsok|däck|hjul|fälg|stötdämp|dämpare|fjäder|länkarm|bussning|drivknut|drivaxel|spindel|styrled|kulled|krängning/i;
function posKind(itemId, name) {
  if (itemId && NO_POSITION.includes(itemId)) return null;
  if (itemId === "torkare" || POS_FRONTBACK.test(name || "")) return "fb";
  if (POS_CORNERS.test(name || "")) return "corners";
  return null;
}
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
  if (Array.isArray(e.work)) return e.work.some((w) => (w.action === "bytt" || ANY_WORK_ITEMS.has(item.id)) && workIsItem(w, item));
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
    case "kostnad": return isInspection(e) && e.result ? [INSP_RESULTS[e.result], e.defects?.length ? `${e.defects.length} ${e.defects.length === 1 ? "brist" : "brister"}` : ""].filter(Boolean).join(" · ") : e.title && e.category ? e.category : e.note || "";
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
  const dueMil = item.mil && lastMil != null ? lastMil + item.mil : null;
  return { item, last, lastDate, lastMil, remMil, remDays, dueDate, dueMil, frac, by, level, label };
}

// Senaste kontrollen ("ser bra ut") efter senaste bytet, för delar där det räcker.
function lastCheck(item, c, ents, afterDate) {
  if (!CHECK_ITEMS.has(item.id)) return null;
  let best = null;
  for (const e of ents) {
    if (!e.date || (afterDate && e.date <= afterDate)) continue;
    if (!workOf(e, c).some((w) => w.action === "kontrollerat" && workIsItem(w, item))) continue;
    if (!best || e.date > best.date) best = e;
  }
  return best;
}
function itemStatusWithCheck(item, c, ents) {
  const st = itemStatus(item, c, ents);
  const chk = lastCheck(item, c, ents, st.lastDate);
  if (!chk) return st;
  // Som om delen byttes vid kontrollen, men med den korta förlängningen som intervall.
  // Mätarställningen vid kontrollen: sparad på posten, annars den som var loggad närmast före (eller efter).
  let chkMil = chk.checkMil ?? chk.odometer ?? null;
  if (chkMil == null) {
    const odos = ents.filter((e) => e.odometer != null && e.date);
    const before = odos.filter((e) => e.date <= chk.date).sort((a, b) => b.date.localeCompare(a.date) || b.odometer - a.odometer)[0];
    const after = odos.filter((e) => e.date > chk.date).sort((a, b) => a.date.localeCompare(b.date) || a.odometer - b.odometer)[0];
    chkMil = (before || after)?.odometer ?? (chk.date >= todayStr() ? odoOf(c) : null);
  }
  const ext = itemStatus({ ...item, ...checkExtension(item), baseDate: chk.date, baseMil: chkMil }, c, ents.filter((e) => !entryCovers(e, item)));
  const left = (x) => (x.remDays != null ? x.remDays : x.remMil != null ? x.remMil * 3 : -Infinity); // ungefär 3 dagar per mil
  const use = st.unknown || left(ext) > left(st) ? ext : st;
  return { ...use, item, check: chk, last: st.last, replacedDate: st.lastDate, replacedMil: st.lastMil };
}
function allItemStatus(c = car()) {
  const ents = carEntries();
  return (c?.items || []).map((i) => itemStatusWithCheck(i, c, ents));
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

// Ny bil: uppskattad sista dag för nästa besiktning från senaste besiktningens månad,
// eller från månaden bilen kom i trafik (första besiktningen inom 36 månader).
// Första dagen i månaden används, så att förslaget hellre är för tidigt än för sent.
function estimateInspection(month, notInspected, year) {
  const m = String(month || "").match(/^(\d{4})-(\d{1,2})/);
  if (!m) return "";
  const first = `${m[1]}-${pad(Number(m[2]))}-01`;
  if (notInspected) { const d = parseDate(first); return ymd(new Date(d.getFullYear(), d.getMonth() + 36, 1)); }
  return nextInspectionDate(first, { year });
}
function updateInspectionEstimate() {
  const out = $("#cf-bes-out"), not = $("#cf-notInspected")?.checked;
  if (!out) return;
  $("#cf-bes-label").textContent = tr(not ? "I trafik sedan" : "Senast besiktad");
  const est = estimateInspection($("#cf-lastInspection").value, not, $("#cf-year")?.value);
  out.classList.toggle("warn", !!est && est < todayStr());
  out.textContent = !est
    ? tr(not ? "Månaden bilen registrerades första gången. Nya bilar besiktas första gången inom tre år." : "Månaden räcker, den står i besiktningsprotokollet. Då föreslår appen när nästa besiktning senast ska vara gjord.")
    : est < todayStr()
      ? tr("Då borde bilen redan ha besiktats igen. Fyll i den senaste besiktningen, eller lägg in datumet under Bilen.")
      : `${tr("Nästa besiktning senast")}: ${fmtDate(est)} (${tr("uppskattat")}). ${tr("Du får en påminnelse i god tid. Ändra under Bilen om det inte stämmer.")}`;
}
document.addEventListener("input", (ev) => { if (["cf-lastInspection", "cf-notInspected", "cf-year"].includes(ev.target.id)) updateInspectionEstimate(); });
document.addEventListener("change", (ev) => { if (["cf-lastInspection", "cf-notInspected"].includes(ev.target.id)) updateInspectionEstimate(); });

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
    if (t >= oct1 && t < dec1) return { key: "dack", date: dec1, calTitle: "Vinterdäck ska vara på", icon: "tire", title: "Vinterdäck på", sub: "Krävs vid vinterväglag från 1 december · sommardäck sitter på", days: daysUntil(dec1) };
    if (t >= dec1 || t < apr1) return { icon: "tire", title: "Vinterdäck på", sub: "Krävs vid vinterväglag 1 december–31 mars", days: -1, label: "Nu", level: "urgent" };
    // Sommardäcken sitter på och det är inte dags att byta: ingen rad (vilka däck som sitter på syns under Bilen → Däck).
    return null;
  }
  const mar15 = new Date(y, 2, 15), apr15 = new Date(y, 3, 15), oct1 = new Date(y, 9, 1);
  if (t > apr15 && t < oct1) {
    return studded
      ? { icon: "tire", title: "Dubbdäck av", sub: "Skulle av senast 15 april, om det inte är vinterväglag", days: -1, label: "Nu", level: "urgent" }
      : { icon: "tire", title: "Sommardäck på", sub: "Vinterdäcken sitter fortfarande på", days: 0, label: "Dags", level: "soon" };
  }
  if (t >= mar15 && t <= apr15) {
    return { key: "dack", date: apr15, calTitle: studded ? "Dubbdäcken ska vara av" : "Dags för sommardäck", icon: "tire", title: "Sommardäck på", sub: studded ? "Dubbdäck av senast 15 april, om det inte är vinterväglag" : "Byt när vårvädret är stabilt", days: daysUntil(apr15) };
  }
  // Vinterdäcken sitter på och det är inte dags att byta: ingen rad.
  return null;
}

function deadlines(c) {
  const out = [tireDeadline(c)].filter(Boolean);
  for (const k of ["vinter", "sommar"]) {
    const h = tireHealth(c, k);
    if (h?.lvl === "bad") out.push({ icon: "tire", title: k === "vinter" ? "Vinterdäcken bör bytas" : "Sommardäcken bör bytas", sub: h.why, days: -1, label: "Byt", level: "urgent" });
  }
  // Sista dagen för besiktning. Är en tid redan bokad (före sista dagen) syns den i bokningen i stället.
  const booked = (c.bookings || []).some((b) => b.kind === "besiktning" && b.date >= todayStr() && (!c.besiktning || b.date <= c.besiktning));
  if (c.besiktning && !booked) {
    const d = parseDate(c.besiktning);
    out.push({ key: "besiktning", date: d, calTitle: "Sista dag för besiktning", icon: "check", title: "Sista dag för besiktning", sub: [`Senast ${fmtDate(d)}`, c.besiktningPlats].filter(Boolean).join(" · "), place: c.besiktningPlats || null, days: daysUntil(d) });
  }
  if (c.efterkontroll?.by) {
    const d = parseDate(c.efterkontroll.by);
    out.push({ key: "efterkontroll", date: d, calTitle: "Efterkontroll på besiktningen", icon: "check", title: c.efterkontroll.result === "korforbud" ? "Efterkontroll (körförbud)" : "Efterkontroll", sub: `Senast ${fmtDate(d)}${c.besiktningPlats ? ` · ${c.besiktningPlats}` : ""}`, place: c.besiktningPlats || null, days: daysUntil(d), level: c.efterkontroll.result === "korforbud" || daysUntil(d) <= 7 ? "urgent" : undefined });
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

/* ------------------------------------------------------- fråga om bilen */
// Fråga om bilen (Bildagboken Plus): en chatt med AI om det ni har loggat. Appen räknar ut summor, snitt och
// förbrukning här, så att AI:n bara behöver läsa och förklara. Funktionen fragaBilen skickar det till Claude.
const CHAT_SUGGESTIONS = ["Vad har bilen kostat i år?", "När är det dags för service?", "Drar bilen mer bränsle än förut?", "Vad gjordes vid senaste servicen?"];
function carContext(c) {
  const ents = carEntries().filter((e) => e.date);
  const L = [];
  const v = (x) => x != null && x !== "";
  L.push(`Dagens datum: ${todayStr()}.`, "", "# Bilen");
  const facts = [["Bil", carName(c)], ["Årsmodell", c.year], ["Drivmedel", c.fuel], ["Registreringsnummer", c.plate], ["Färg", c.color],
    ["Kaross", c.bodyStyle], ["Antal säten", c.seats], ["I trafik första gången", c.firstReg], ["Koldioxid", c.co2 && `${c.co2} g/km`],
    ["Mätarställning", odoOf(c) != null ? `${fmt(odoOf(c))} mil` : null], ["Sista dag för besiktning", c.besiktning],
    ["Försäkring", [c.forsakringBolag, c.forsakringDatum ? `förnyas ${c.forsakringDatum}` : ""].filter(Boolean).join(", ")],
    ["Fordonsskatt betalas", taxMonth(c) ? MONTHS[taxMonth(c) - 1] : null]];
  for (const [k, x] of facts) if (v(x)) L.push(`${k}: ${x}`);
  for (const [k, x] of [["Växellåda", c.gearbox], ["Tankvolym", c.tankVolume && `${c.tankVolume} liter`], ["Max släpvagnsvikt (bromsat släp)", c.towMax && `${c.towMax} kg`],
    ["Bilens totalvikt", c.totalWeight && `${c.totalWeight} kg`], ["Tågvikt", c.trainWeight && `${c.trainWeight} kg`]]) if (v(x)) L.push(`${k}: ${x}`);
  if (c.towMax && c.totalWeight) L.push(`Släpets högsta totalvikt med körkort B: ${Math.max(750, 3500 - c.totalWeight)} kg, med utökad B (B96): ${Math.max(750, 4250 - c.totalWeight)} kg. Släp utan egna bromsar högst 750 kg.`);
  if (c.reg?.f?.length) {
    L.push("", `# Uppgifter från Transportstyrelsens register (hämtade ${ymd(new Date(c.reg.at || Date.now()))})`);
    for (const x of c.reg.f) L.push(`${x.k}: ${x.v}`);
  }
  for (const t of c.tires || []) L.push(`${t.kind === "vinter" ? "Vinterdäck" : "Sommardäck"}${t.on ? " (sitter på)" : ""}: ${[t.brand, t.size, t.year ? `tillverkade ${tireDotText(t.year)}` : "", t.depth != null ? `${fmt(t.depth, 1)} mm mönster` : ""].filter(Boolean).join(", ") || "inga uppgifter"}`);

  L.push("", "# Underhåll");
  for (const s of allItemStatus(c)) {
    const iv = [s.item.mil ? `var ${fmt(s.item.mil)} mil` : "", s.item.months ? `var ${s.item.months} månad${s.item.months === 1 ? "" : "er"}` : ""].filter(Boolean).join(" eller ");
    L.push(`- ${s.item.name}${iv ? ` (${iv})` : ""}: ${s.unknown && !s.lastDate ? "senaste byte okänt" : `senast ${s.lastDate || "okänt datum"}${s.lastMil != null ? ` vid ${fmt(s.lastMil)} mil` : ""}`}${s.label ? `. Status: ${s.label}` : ""}`);
  }
  const dl = deadlines(c);
  if (dl.length) { L.push("", "# Datum att hålla koll på"); for (const d of dl) L.push(`- ${d.title}: ${d.date instanceof Date ? ymd(d.date) : d.date || ""}${d.sub ? ` (${d.sub})` : ""}`); }
  const books = sortedBookings(c).filter((b) => b.date >= todayStr());
  if (books.length) { L.push("", "# Bokade tider"); for (const b of books) L.push(`- ${b.date}${b.time ? ` kl ${b.time}` : ""}: ${BOOK_KINDS[b.kind] || "Bokning"}${b.place ? ` hos ${b.place}` : ""}${b.addr ? ` (${b.addr})` : ""}${b.note ? `. ${b.note}` : ""}`); }
  const todos = (c.todos || []).filter((t) => !t.done);
  if (todos.length) { L.push("", "# Att göra"); for (const t of todos) L.push(`- ${t.text}`); }

  // Kostnader och körsträcka per år.
  const years = [...new Set(ents.map((e) => e.date.slice(0, 4)))].sort().reverse();
  if (years.length) {
    L.push("", "# Kostnader per år (uträknade av appen)");
    for (const y of years) {
      const ye = ents.filter((e) => e.date.startsWith(y));
      const paid = ye.filter((e) => e.amount > 0);
      const total = paid.reduce((a, e) => a + e.amount, 0);
      const cats = {};
      for (const e of paid) cats[catOf(e)] = (cats[catOf(e)] || 0) + e.amount;
      const odos = ye.filter((e) => e.odometer != null).map((e) => e.odometer);
      const driven = odos.length >= 2 ? Math.max(...odos) - Math.min(...odos) : null;
      L.push(`${y}: totalt ${fmt(Math.round(total))} kr${driven ? `, körsträcka ungefär ${fmt(driven)} mil, ${fmt(total / driven, 1)} kr per mil` : ""}. ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, x]) => `${k} ${fmt(Math.round(x))} kr`).join(", ")}.`);
    }
    // Förbrukning: tankad mängd delad med sträckan sedan förra tankningen, per år.
    const tanks = ents.filter((e) => e.type === "tank" && e.odometer != null && e.liters > 0).sort((a, b) => a.odometer - b.odometer);
    const per = {};
    for (let i = 1; i < tanks.length; i++) {
      const dist = tanks[i].odometer - tanks[i - 1].odometer;
      if (dist <= 0 || dist > 200) continue;
      const y = tanks[i].date.slice(0, 4);
      per[y] = per[y] || { l: 0, mil: 0, n: 0 };
      per[y].l += tanks[i].liters; per[y].mil += dist; per[y].n++;
    }
    const fy = Object.keys(per).sort().reverse();
    if (fy.length) {
      const unit = /kWh/.test(tanks[0]?.fuel || "") ? "kWh" : "liter";
      L.push("", "# Förbrukning (uträknad av appen från tankningarna)");
      for (const y of fy) L.push(`${y}: ungefär ${fmt(per[y].l / per[y].mil, 2)} ${unit} per mil (${per[y].n} tankningar)`);
    }
  }
  // Körjournalen per månad, det senaste året.
  const trips = carTrips(c.id).filter((t) => t.date && tripMil(t) != null);
  if (trips.length) {
    L.push("", "# Körjournal per månad (mil)");
    const months = [...new Set(trips.map((t) => t.date.slice(0, 7)))].sort().reverse().slice(0, 12);
    for (const m of months) { const mt = trips.filter((t) => t.date.startsWith(m)); L.push(`${m}: tjänst ${fmt(sumMil(mt, "tjanst"), 1)}, privat ${fmt(sumMil(mt, "privat"), 1)}`); }
  }

  // Sparade platser och resorna (vart och när), så att Glenn kan svara på frågor om körningen.
  if (S.places?.length) {
    L.push("", "# Sparade platser");
    for (const pl of S.places) L.push(`- ${pl.name}${pl.addr ? `, ${pl.addr}` : ""}${pl.kind ? ` (oftast ${pl.kind === "tjanst" ? "tjänst" : "privat"})` : ""}`);
  }
  const tripList = carTrips(c.id).filter((t) => t.date).sort((a, b) => tsMs(b.startedAt) - tsMs(a.startedAt));
  if (tripList.length) {
    const goals = {};
    for (const t of tripList) if (t.to) goals[t.to] = (goals[t.to] || 0) + 1;
    const top = Object.entries(goals).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) L.push("", "# Vanligaste målen i körjournalen", ...top.map(([k, n]) => `- ${k}: ${n} resor`));
    L.push("", "# Resor (nyast först, högst 150)");
    for (const t of tripList.slice(0, 150)) L.push([t.date, [t.from, t.to].filter(Boolean).join(" → ") || "okänd sträcka", tripMil(t) != null ? `${fmt(tripMil(t), 1)} mil` : "", t.kind ? TRIP_KINDS[t.kind] : "ej genomgången", t.purpose || "", t.driver ? `förare ${memberName(t.driver)}` : ""].filter(Boolean).join(" | "));
  }

  // Hela loggen, nyast först (högst 500 rader).
  L.push("", "# Loggen (nyast först)");
  for (const e of sortEntries([...ents]).slice(0, 500)) {
    const bits = [e.date, entryTitle(e), e.amount > 0 ? `${fmtKr(e.amount)} kr` : "", e.odometer != null ? `${fmt(e.odometer)} mil` : "", entryDetail(e, c), e.note || "", e.createdBy ? `av ${memberName(e.createdBy)}` : ""];
    L.push(bits.filter(Boolean).join(" | "));
  }
  return L.join("\n").slice(0, 280000);
}

const chatOn = () => aiOn();
const chatState = () => { if (!S.chat || S.chat.carId !== S.carId) S.chat = { carId: S.carId, msgs: [], busy: false }; return S.chat; };
const AI_NAME = "Glenn";
/* Glenns figur i pixelstil (icons/glenn): vanlig, blinkar eller tummen upp, var och en med stängd och öppen mun.
   Gesten kommer från svaret (taggen [tumme] eller [blink], som funktionen fragaBilen gör om till mood) och visas
   en stund när svaret kommer och medan det läses upp. Munnen rör sig bara när han pratar. */
const GLENN_FRAMES = ["base", "base-talk", "wink", "wink-talk", "thumb", "thumb-talk"];
// Små bilder (ansikte och axlar) och hela Glenn (i röstläget).
const glennSrc = (f, full = false) => `icons/glenn/${full ? "full-" : ""}${f}.png?v=3`;

/* Glenns väder och kläder. Bakgrunden visar vädret där man är (Open-Meteo, utan nyckel), och Glenn klär sig
   efter det: sydväst i regn, mössa i snö och kyla, solglasögon när det är soligt och varmt. På högtider har han
   högtidens kläder: julmössa, nyårshatt, stjärngossestrut på Lucia, blomsterkrans på midsommar och en kyckling
   på påsk. Platsen hämtas bara om appen redan har fått lov; annars blir det dag eller natt efter klockan. */
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
function holidayNow(now = new Date()) {
  const M = now.getMonth() + 1, D = now.getDate(), y = now.getFullYear();
  if ((M === 12 && D === 31) || (M === 1 && D === 1)) return "party";
  if (M === 12 && D === 13) return "lucia";
  if (M === 12 && D <= 26) return "santa";
  // Midsommarafton är fredagen mellan 19 och 25 juni; midsommardagen dagen efter.
  if (M === 6 && ((D >= 19 && D <= 25 && now.getDay() === 5) || (D >= 20 && D <= 26 && now.getDay() === 6))) return "midsummer";
  const e = easterSunday(y), day = Math.round((new Date(y, M - 1, D) - e) / 864e5);
  if (day >= -2 && day <= 1) return "easter";
  return null;
}
const WX_RAIN = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], WX_SNOW = [71, 73, 75, 77, 85, 86], WX_STORM = [95, 96, 99];
function glennLook() {
  const wx = S.wx;
  const hour = new Date().getHours();
  const day = wx ? wx.day : hour >= 7 && hour < 18;
  const code = wx?.code ?? 1;
  const kind = WX_STORM.includes(code) ? "storm" : WX_SNOW.includes(code) ? "snow" : WX_RAIN.includes(code) ? "rain" : [45, 48].includes(code) ? "fog" : code >= 2 ? "cloud" : "clear";
  const sky = day ? kind : kind === "clear" ? "night" : "night-cloud";
  const holiday = holidayNow();
  const acc = holiday || (kind === "rain" || kind === "storm" ? "rain" : kind === "snow" || (wx && wx.temp <= 0) ? "beanie" : kind === "clear" && day && wx && wx.temp >= 18 ? "sun" : null);
  const fx = holiday === "party" ? "party" : kind === "rain" || kind === "storm" ? "rain" : kind === "snow" ? "snow" : null;
  return { sky, acc, fx };
}
// Glenn med bakgrund och kläder. img är bilden av Glenn (som byts när han blinkar, pratar med mera).
function glennFig(img, full = false, cls = "") {
  const L = glennLook();
  const style = [`--sky:url(icons/glenn/sky-${L.sky}.png?v=3)`, L.acc ? `--acc:url(icons/glenn/acc-${full ? "full-" : ""}${L.acc}.png?v=3)` : "", L.fx ? `--fx:url(icons/glenn/fx-${L.fx}.png?v=3)` : ""].filter(Boolean).join(";");
  return `<span class="gfig${full ? " full" : ""}${L.fx ? ` fx-${L.fx}` : ""}${cls ? ` ${cls}` : ""}" style="${style}">${img}</span>`;
}
// Vädret där man är, högst en gång i halvtimmen. Platsen används bara om appen redan har fått lov.
async function loadWeather() {
  try {
    const cached = JSON.parse(pref.get("wx") || "null");
    if (cached && Date.now() - cached.at < 30 * 60000) { S.wx = cached; return; }
  } catch { /* ingen sparad */ }
  let loc = null;
  try { loc = JSON.parse(pref.get("lastLoc") || "null"); } catch { loc = null; }
  if (!loc) {
    let ok = false;
    try { ok = (await navigator.permissions?.query({ name: "geolocation" }))?.state === "granted"; } catch { ok = false; }
    if (!ok) return;
    loc = await Promise.race([tripPosition(), new Promise((r) => setTimeout(() => r(null), 6000))]);
    if (!loc) return;
    pref.set("lastLoc", JSON.stringify({ lat: Math.round(loc.lat * 100) / 100, lon: Math.round(loc.lon * 100) / 100 }));
  }
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day&timezone=auto`);
    if (!r.ok) return;
    const c = (await r.json()).current || {};
    S.wx = { code: c.weather_code ?? 1, temp: c.temperature_2m ?? 10, day: c.is_day !== 0, at: Date.now() };
    pref.set("wx", JSON.stringify(S.wx));
    render();
  } catch { /* utan nät: dag eller natt efter klockan */ }
}
let glennMouth = false;
function glennFrame(m) {
  const gesture = m?.mood && (m.speaking || (m.gestureUntil || 0) > Date.now()) ? m.mood : "base";
  return gesture + (m?.speaking && glennMouth ? "-talk" : "");
}
function refreshGlenn() {
  const st = chatState();
  document.querySelectorAll("img.glenn-av[data-i]").forEach((img) => {
    const src = glennSrc(glennFrame(st.msgs[Number(img.dataset.i)]));
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
  });
  const big = $("#voice-glenn");
  if (big) {
    const m = st.msgs.find((x) => x.speaking) || [...st.msgs].reverse().find((x) => x.role === "assistant" && !x.err);
    const src = glennSrc(glennFrame(m), true);
    if (big.getAttribute("src") !== src) big.setAttribute("src", src);
  }
}
function glennGesture(m, ms = 3500) {
  if (!m?.mood) return;
  m.gestureUntil = Date.now() + ms;
  refreshGlenn();
  setTimeout(refreshGlenn, ms + 50);
}
const callFn = async (name, payload) => {
  if (window.__fnMock) return window.__fnMock(name, payload); // bara i test
  const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js");
  return (await httpsCallable(getFunctions(fb, "europe-west1"), name, { timeout: 120000 })(payload)).data;
};

/* Diktering: i iPhone-appen (från 1.2) med Apples taligenkänning (SpeechInput i SceneDelegate.swift),
   i webbläsaren med webbläsarens. Texten kommer löpande, och det sista resultatet när man har slutat prata. */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const nativeSpeech = () => (NATIVE && !ANDROID ? nativePlugin("SpeechInput") : null);
const canDictate = () => !!nativeSpeech() || !!SpeechRec;
let dictStop = null;
function dictate(onText) {
  return new Promise((resolve, reject) => {
    let text = "", done = false, quiet = 0, max = 0, sub = null;
    const finish = () => { if (done) return; done = true; clearTimeout(quiet); clearTimeout(max); dictStop = null; try { sub?.remove?.(); } catch { /* redan borta */ } resolve(text.trim()); };
    const fail = (e) => { if (done) return; done = true; clearTimeout(quiet); clearTimeout(max); dictStop = null; try { sub?.remove?.(); } catch { /* redan borta */ } reject(e); };
    const lang = EN ? "en-GB" : "sv-SE";
    const ns = nativeSpeech();
    if (ns) {
      const stopNow = () => { Promise.resolve(ns.stop()).catch(() => {}); setTimeout(finish, 2500); };
      (async () => {
        try {
          // Glenns uppläsning måste vara helt stoppad innan mikrofonen startar, annars får iPhone inget ljud in.
          try { voiceAudio?.pause(); if (voiceAudio) voiceAudio.src = SILENT; } catch { /* inget ljud */ }
          try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch { /* ingen röst */ }
          await new Promise((r) => setTimeout(r, 350));
          sub = await ns.addListener("partial", (d) => {
            if (d?.text) { text = d.text; onText(text); }
            if (d?.final) return finish();
            // Färdig när det har varit tyst en stund efter att man har sagt något.
            clearTimeout(quiet); quiet = setTimeout(stopNow, text ? 1600 : 8000);
          });
          await ns.start({ lang });
          dictStop = stopNow;
          quiet = setTimeout(stopNow, 8000);
          max = setTimeout(stopNow, 45000);
        } catch (e) { fail(e); }
      })();
      return;
    }
    if (!SpeechRec) return fail(new Error("unsupported"));
    // iPhone slutar inte lyssna av sig själv, så appen avgör när man har pratat klart: en dryg sekunds
    // tystnad efter att man har sagt något (eller åtta sekunder utan att något sägs).
    const rec = new SpeechRec();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = true;
    const stopNow = () => { clearTimeout(quiet); try { rec.stop(); } catch { finish(); } setTimeout(finish, 2500); };
    rec.onresult = (ev) => {
      text = [...ev.results].map((r) => r[0].transcript).join("");
      onText(text);
      clearTimeout(quiet); quiet = setTimeout(stopNow, text.trim() ? 1500 : 8000);
    };
    rec.onerror = (ev) => { if (ev.error === "not-allowed" || ev.error === "service-not-allowed") fail(new Error("denied")); };
    rec.onend = finish;
    dictStop = stopNow;
    try { rec.start(); quiet = setTimeout(stopNow, 8000); max = setTimeout(stopNow, 45000); } catch (e) { fail(e); }
  });
}
function dictateError(e) {
  const m = String(e?.message || e?.code || "");
  if (/denied|tillåten/i.test(m)) return showToast("Tillåt mikrofonen och taligenkänning för Bildagboken i telefonens inställningar.", 6000);
  showToast(NATIVE ? "Prata in kräver den nya versionen av appen. Tryck på mikrofonen på tangentbordet så länge." : "Prata in fungerar inte i den här webbläsaren.", 6000);
}

/* Glenns röst: en naturlig röst från Google (funktionen glennPratar). Fungerar den inte används telefonens röst.
   Ljudet spelas i ett och samma ljudelement, som låses upp vid första trycket (krävs på iPhone). */
const canSpeak = () => true;
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
let voiceAudio = null, sayId = 0;
function unlockAudio() {
  try {
    if (!voiceAudio) { voiceAudio = new Audio(); voiceAudio.setAttribute("playsinline", ""); }
    if (!voiceAudio.src || voiceAudio.src === SILENT || voiceAudio.paused) { voiceAudio.src = SILENT; voiceAudio.play()?.catch?.(() => {}); }
  } catch { /* inget ljud */ }
  try { if ("speechSynthesis" in window && !speechSynthesis.speaking) speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch { /* ingen röst */ }
}
const stopSpeech = () => {
  sayId++;
  try { voiceAudio?.pause(); } catch { /* inget att stoppa */ }
  try { if ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel(); } catch { /* inget att stoppa */ }
  document.querySelectorAll(".chat-play.on").forEach((b) => b.classList.remove("on"));
  const st = S.chat;
  if (st?.msgs?.some((m) => m.speaking)) { st.msgs.forEach((m) => { m.speaking = false; }); glennMouth = false; setTimeout(refreshGlenn, 0); }
};
function playB64(b64, id) {
  return new Promise((resolve) => {
    if (id !== sayId) return resolve();
    if (!voiceAudio) voiceAudio = new Audio();
    voiceAudio.onended = () => resolve();
    voiceAudio.onerror = () => resolve();
    voiceAudio.src = "data:audio/mpeg;base64," + b64;
    try { voiceAudio.play()?.catch?.(() => resolve()); } catch { resolve(); }
  });
}
// Samma som spoken() i functions/index.js: tal och enheter som de ska låta när de läses upp.
const spokenText = (t) => String(t).replace(/[*#_`]/g, "")
  .replace(/(\d)[\s\u00a0\u202f](?=\d{3}\b)/g, "$1")
  .replace(/(\d+),00\s?kr\b/g, "$1 kronor")
  .replace(/(\d+),(\d\d)\s?kr\b/g, "$1 kronor och $2 öre")
  .replace(/(\d),(\d)/g, "$1 komma $2")
  .replace(/\bm\/s\b/g, "meter per sekund")
  .replace(/(\d)\s?kr\b/g, "$1 kronor")
  .replace(/(\d)\s?km\b/g, "$1 kilometer")
  .replace(/(-?\d+)\s?°C?/g, "$1 grader");
function speakDevice(text, id) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || id !== sayId) return resolve();
    const lang = EN ? "en" : "sv";
    const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(lang));
    const u = new SpeechSynthesisUtterance(EN ? text : spokenText(text));
    u.lang = EN ? "en-GB" : "sv-SE";
    u.voice = voices.find((v) => /premium|enhanced|förbättrad|natural/i.test(v.name)) || voices[0] || null;
    u.onend = () => resolve(); u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}
let warmAt = 0;
function warmVoice() {
  if (window.__ttsMock || Date.now() - warmAt < 120000) return;
  warmAt = Date.now();
  callFn("glennPratar", { warm: true }).catch(() => {});
}
// Delar upp svaret: första meningen för sig (så att Glenn börjar prata direkt), sedan bitar på upp till 300 tecken.
function speechChunks(text) {
  const sents = String(text).split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  if (!sents.length) return [];
  let first = sents.shift();
  if (first.length < 40 && sents.length) first += " " + sents.shift(); // "Tjenare!" ensamt blir för kort
  const out = [first];
  let cur = "";
  for (const x of sents) {
    if (cur && (cur + " " + x).length > 300) { out.push(cur); cur = x; } else cur = cur ? `${cur} ${x}` : x;
  }
  if (cur) out.push(cur);
  return out;
}
// Läser upp ett svar. Ljudet sparas med meddelandet, så att Lyssna igen inte kostar något.
// Bitarna hämtas samtidigt och spelas i ordning, så att uppläsningen börjar när den första biten är klar.
async function sayText(m) {
  stopSpeech();
  const id = sayId;
  const text = String(m?.text || "").replace(/[*#_`]/g, "");
  if (!text) return;
  let mouth = 0;
  const talk = () => {
    if (mouth) return;
    m.speaking = true;
    mouth = setInterval(() => { glennMouth = !glennMouth; refreshGlenn(); }, 160);
  };
  const fetchOne = (t) => (window.__ttsMock ? window.__ttsMock(t) : callFn("glennPratar", { hid: S.hid, text: t }).then((r) => r?.audio));
  try {
    try {
      if (!m.audios) {
        const chunks = speechChunks(text);
        const jobs = chunks.map((t) => fetchOne(t).catch(() => null));
        const got = [];
        for (let k = 0; k < jobs.length; k++) {
          const a = await jobs[k];
          if (id !== sayId) return;
          if (!a) {
            // En bit gick inte att få fram: läs resten med telefonens röst.
            talk(); await speakDevice(chunks.slice(k).join(" "), id);
            return;
          }
          got.push(a);
          talk();
          await playB64(a, id);
          if (id !== sayId) return;
        }
        m.audios = got;
        return;
      }
      talk();
      for (const a of m.audios) { if (id !== sayId) return; await playB64(a, id); }
      return;
    } catch (e) { console.warn("Glenns röst", e); }
    if (id === sayId) { talk(); await speakDevice(text, id); }
  } finally {
    clearInterval(mouth);
    if (m.speaking) { m.speaking = false; glennMouth = false; glennGesture(m, 900); }
  }
}

const micSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
const waveSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 10v4M9.5 7v10M14.5 5v14M19 9.5v5"/></svg>`;
const sendSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
const speakerOffSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>`;
const speakerSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;

// Rutan som i ChatGPT: samtalet, och längst ner en rad med fältet, mikrofonen (prata in text) och
// röstläget (prata med Glenn). När det står något i fältet blir röstknappen en skicka-knapp.
function chatSheet() {
  if (!chatOn()) return plusOnSale() ? plusUpsell("glenn") : null;
  const st = chatState();
  GLENN_FRAMES.forEach((f) => { new Image().src = glennSrc(f); new Image().src = glennSrc(f, true); });
  openSheet(`Fråga ${AI_NAME}`, `<div class="chat">
    <div class="chat-log" id="chat-log" aria-live="polite">${chatLogHtml(st)}</div>
    <form class="chat-bar" data-form="chat" novalidate>
      ${speakBtn()}
      <textarea id="chat-in" name="q" rows="1" placeholder="${esc(`Fråga ${AI_NAME}`)}" enterkeyhint="send"></textarea>
      ${canDictate() ? `<button class="cb-mic" type="button" data-act="chat-mic" aria-label="Prata in text">${micSvg}</button>` : ""}
      <button class="cb-go${canDictate() ? "" : " has-text"}" id="chat-go" type="button" data-act="chat-go" aria-label="${canDictate() ? `Prata med ${AI_NAME}` : "Skicka"}"><span class="go-voice">${waveSvg}</span><span class="go-send">${sendSvg}</span></button>
    </form>
    <div class="chat-foot">
      <p class="hint">${esc(`${AI_NAME} svarar utifrån det ni har loggat om ${carName(car())}. AI kan ha fel, så kontrollera viktiga saker.`)}</p>
    </div>
    <div class="voice" id="voice" hidden>
      <button class="voice-orb" type="button" data-act="voice-orb" aria-label="Prata">${glennFig(`<img id="voice-glenn" src="${glennSrc("base", true)}" alt="" width="128" height="136">`, true)}</button>
      <p class="voice-state" id="voice-state" aria-live="polite"></p>
      <p class="voice-text" id="voice-text" data-notr></p>
      <button class="btn-soft voice-end" type="button" data-act="voice-end">Avsluta</button>
    </div></div>`);
  scrollChat();
}
// Knappen längst till vänster i raden: Glenn läser upp svaren, eller inte.
const speakOn = () => pref.get("chatSpeak") === "1";
const speakBtn = () => `<button class="cb-speak${speakOn() ? " on" : ""}" type="button" data-act="chat-speak" aria-pressed="${speakOn()}" aria-label="${esc(`${AI_NAME} läser upp svaren`)}" title="${esc(`${AI_NAME} läser upp svaren`)}">${speakOn() ? speakerSvg.replace(/16/g, "22") : speakerOffSvg}</button>`;
// Tankningen som Glenn har fyllt i: ett kort med Spara och Ändra under hans svar.
function tankCardHtml(m, i) {
  const a = m.action;
  if (!a || a.type !== "tank") return "";
  const sum = [`${fmtKr(a.amount)} kr`, a.station, a.full ? "Full tank" : "Inte full tank", fmtDateShort(a.date), a.odometer ? `${fmt(a.odometer)} mil` : ""].filter(Boolean).join(" · ");
  return `<div class="glenn-card${m.actionDone === "saved" ? " done" : ""}"><div class="gc-t">${icon("fuel", 18)} Tankning</div><div class="gc-s">${esc(sum)}</div>
    ${m.actionDone === "saved" ? `<div class="gc-ok">${icon("check", 16)} Sparad</div>` : `<div class="review-btns"><button class="btn-soft" type="button" data-act="glenn-save" data-i="${i}">Spara</button><button class="link" type="button" data-act="glenn-edit" data-i="${i}">Ändra</button></div>`}</div>`;
}
// Vägbeskrivning: på iPhone öppnas Apple Kartor direkt, på Android Google Maps. Länken öppnas med ett tryck,
// eftersom telefonen inte låter en app öppna en annan av sig själv.
const isApple = () => (NATIVE && !ANDROID) || /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
function navUrl({ name, addr, lat, lon, pid }) {
  const dest = addr ? [name && !addr.toLowerCase().includes(name.toLowerCase()) ? name : "", addr].filter(Boolean).join(", ") : lat != null ? `${lat},${lon}` : name;
  if (isApple()) return `https://maps.apple.com/directions?${new URLSearchParams({ destination: lat != null && !addr ? `${lat},${lon}` : dest, ...(pid ? { "destination-place-id": pid } : {}), mode: "driving" }).toString().replace(/\+/g, "%20")}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat != null ? `${lat},${lon}` : dest)}&travelmode=driving`;
}
function navCardHtml(m) {
  const n = m.nav;
  if (!n) return "";
  return `<div class="glenn-card glenn-nav"><div class="gc-t">${icon("pin", 18)} ${esc(n.namn)}</div>${n.adress ? `<div class="gc-s">${esc(n.adress)}</div>` : ""}
    <a class="btn primary block" href="${esc(navUrl({ name: n.namn, addr: n.adress, lat: n.lat, lon: n.lon }))}" target="_blank" rel="noopener">${icon("route", 18)} Starta vägbeskrivning</a></div>`;
}
// Ställen som Glenn hittade i närheten, med vägbeskrivning.
function placesCardHtml(m, i) {
  if (!m.places?.length) return "";
  return `<div class="glenn-places">${m.places.map((p, k) => `<div class="gp-row"><div><b>${esc(p.namn || "")}</b><span>${esc([p.km != null ? `${fmt(p.km, 1)} km` : "", p.adress || "", p.oppet === "24/7" ? "Öppet dygnet runt" : ""].filter(Boolean).join(" · "))}</span></div><button class="btn-soft" type="button" data-act="glenn-route" data-i="${i}" data-k="${k}">${icon("pin", 16)} Kör dit</button></div>`).join("")}</div>`;
}
function glennTank(i, save) {
  const st = chatState();
  const m = st.msgs[i];
  if (!m?.action) return;
  const a = m.action;
  stopSpeech();
  entryForm("tank", { amount: a.amount, full: a.full, station: a.station, date: a.date, odometer: a.odometer ?? undefined });
  if (!save) return;
  $('form[data-form="entry"]')?.requestSubmit();
  // Sparades den stängs formuläret, och då går vi tillbaka till Glenn. Annars ligger formuläret kvar att rätta.
  setTimeout(() => {
    if ($('form[data-form="entry"]')) return;
    m.actionDone = "saved";
    st.msgs.push({ role: "assistant", text: a.full ? "Klart, tankningen är loggad! Gött med full tank." : "Klart, tankningen är loggad!", mood: "thumb", gestureUntil: Date.now() + 3500 });
    chatSheet();
    setTimeout(refreshGlenn, 3600);
  }, 700);
}
function chatLogHtml(st) {
  const av = (i) => glennFig(`<img class="glenn-av" ${i == null ? "" : `data-i="${i}" `}src="${glennSrc(i == null ? "base" : glennFrame(st.msgs[i]))}" alt="" width="52" height="52">`, false, "gfig-av");
  if (!st.msgs.length) return `<div class="ai-row">${av(null)}<div class="msg ai intro">${esc(`Tjenare! Jag är ${AI_NAME}. Jag har koll på allt ni har loggat om ${carName(car())}. Vad undrar du?`)}</div></div>
    <div class="chat-sugg">${CHAT_SUGGESTIONS.map((q) => `<button class="chip-btn" type="button" data-act="chat-ask" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;
  return st.msgs.map((m, i) => {
    const bubble = `<div class="msg ${m.role === "user" ? "me" : "ai"}${m.err ? " err" : ""}"${m.err ? "" : " data-notr"}>${esc(m.text).replace(/\n/g, "<br>")}</div>`;
    if (m.role === "user") return bubble;
    return `<div class="ai-row">${av(i)}${bubble}</div>${tankCardHtml(m, i)}${navCardHtml(m)}${m.nav ? "" : placesCardHtml(m, i)}${!m.err ? `<button class="link chat-play" type="button" data-act="chat-play" data-i="${i}">${speakerSvg} Lyssna</button>` : ""}`;
  }).join("")
    + (st.busy ? `<div class="ai-row">${av(null)}<div class="msg ai busy" aria-label="${esc(`${AI_NAME} tänker`)}"><span></span><span></span><span></span></div></div>` : "")
    + (st.left != null && st.left <= 5 ? `<p class="hint chat-left">${esc(`${st.left} frågor kvar den här månaden.`)}</p>` : "");
}
function scrollChat() { const l = $("#chat-log"); if (l) l.scrollTop = l.scrollHeight; }
function redrawChat() { const l = $("#chat-log"); if (l) { l.innerHTML = chatLogHtml(chatState()); if (EN && typeof trTree === "function") trTree(l); scrollChat(); } }
function chatInputChanged() {
  const i = $("#chat-in"), go = $("#chat-go");
  if (!i || !go) return;
  const has = !!i.value.trim() || !canDictate();
  go.classList.toggle("has-text", has);
  go.setAttribute("aria-label", has ? "Skicka" : `Prata med ${AI_NAME}`);
  // Fältet växer med texten, upp till några rader.
  i.style.height = "auto";
  i.style.height = Math.min(i.scrollHeight, 140) + "px";
}
// Var användaren är just nu, för Glenn (vädret och det som finns i närheten). Sparas i fem minuter.
// Får appen inte använda platsen svarar Glenn utan den.
let chatHere = null;
async function hereForChat() {
  if (window.__hereMock) return window.__hereMock;
  if (chatHere && Date.now() - chatHere.at < 300000) return chatHere.v;
  const loc = await Promise.race([tripPosition(), new Promise((r) => setTimeout(() => r(null), 6000))]);
  if (!loc) return chatHere?.v || null;
  const name = await Promise.race([reverseAddress(loc.lat, loc.lon).catch(() => ""), new Promise((r) => setTimeout(() => r(""), 3000))]);
  const v = { lat: Math.round(loc.lat * 1e4) / 1e4, lon: Math.round(loc.lon * 1e4) / 1e4, name: name || "" };
  chatHere = { v, at: Date.now() };
  pref.set("lastLoc", JSON.stringify({ lat: Math.round(loc.lat * 100) / 100, lon: Math.round(loc.lon * 100) / 100 }));
  return v;
}
// Skickar frågan och ger svaret (eller null). I röstläget läses svaret upp där, inte här.
async function askCar(q, { voice = false } = {}) {
  const st = chatState();
  q = String(q || "").trim();
  if (!q || st.busy) return null;
  if (!voice) unlockAudio();
  // Ska svaret läsas upp: väck Glenns röst redan nu, medan han tänker, så att den är redo när svaret kommer.
  if (voice || pref.get("chatSpeak") === "1") warmVoice();
  st.msgs.push({ role: "user", text: q });
  st.busy = true;
  redrawChat();
  const here = await hereForChat().catch(() => null);
  const payload = { hid: S.hid, context: carContext(car()), here, messages: st.msgs.filter((m) => !m.err).slice(-12).map((m) => ({ role: m.role, text: m.text })) };
  let answer = null;
  try {
    const res = window.__chatMock ? await window.__chatMock(payload) : await callFn("fragaBilen", payload);
    const m = { role: "assistant", text: res?.answer || "Jag hittade inget svar.", mood: res?.mood === "thumb" || res?.mood === "wink" ? res.mood : null, action: res?.action?.type === "tank" ? res.action : null, places: Array.isArray(res?.places) ? res.places.slice(0, 3) : null, nav: res?.nav?.namn ? res.nav : null };
    st.msgs.push(m);
    answer = m;
    if (m.mood) m.gestureUntil = Date.now() + 3500;
    if (res?.left != null) st.left = res.left;
  } catch (e) {
    const code = String(e?.code || e?.message || "").replace(/^functions\//, "");
    st.msgs.push({ role: "assistant", err: true, text: /resource-exhausted|permission-denied|failed-precondition|unavailable/.test(code) ? e.message : !navigator.onLine ? `${AI_NAME} behöver nät.` : `Det gick inte att få ett svar (${code || "okänt fel"}). Försök igen.` });
  } finally {
    st.busy = false;
    redrawChat();
  }
  if (answer?.mood) setTimeout(refreshGlenn, 3550);
  if (answer && !voice && pref.get("chatSpeak") === "1") sayText(answer);
  return answer;
}

// Röstläget: lyssna, skicka, läs upp svaret och lyssna igen, tills man trycker Avsluta.
function voiceUi(state, text = "") {
  const v = $("#voice");
  if (!v) return;
  v.hidden = false;
  v.dataset.state = state;
  const label = { listen: "Jag lyssnar … Tryck på mig när du är klar.", think: `${AI_NAME} tänker …`, talk: `${AI_NAME} pratar. Tryck på cirkeln för att avbryta.`, idle: "Tryck på cirkeln och prata." }[state] || "";
  $("#voice-state").textContent = EN ? tr(label) : label;
  $("#voice-text").textContent = text;
}
async function voiceLoop() {
  const st = chatState();
  if (st.voice) return;
  st.voice = true;
  unlockAudio();
  try {
    while (st.voice && $("#voice")) {
      voiceUi("listen");
      let q;
      try { q = await dictate((t) => voiceUi("listen", t)); } catch (e) { dictateError(e); break; }
      if (!st.voice) break;
      if (!q) { voiceUi("idle"); st.voice = false; return; }
      voiceUi("think", q);
      const ans = await askCar(q, { voice: true });
      if (!st.voice || !ans) break;
      voiceUi("talk", ans.text);
      await sayText(ans);
      if (ans.action || ans.nav) break;
    }
  } finally {
    if (st.voice) endVoice();
  }
}
function endVoice() {
  const st = chatState();
  st.voice = false;
  try { dictStop?.(); } catch { /* redan stoppad */ }
  stopSpeech();
  const v = $("#voice"); if (v) v.hidden = true;
  scrollChat();
}
// Prata in text i fältet (mikrofonen), som i ChatGPT. Texten går att ändra innan man skickar.
async function dictateField(btn) {
  if (dictStop) { dictStop(); return; }
  stopSpeech();
  const input = $("#chat-in");
  const before = input?.value.trim() ? input.value.trim() + " " : "";
  btn?.classList.add("on");
  try {
    const text = await dictate((t) => { if (input) { input.value = before + t; chatInputChanged(); } });
    // Har man pratat klart skickas frågan direkt, som om man hade tryckt på pilen.
    if (input && text) { const q = before + text; input.value = ""; chatInputChanged(); askCar(q); }
  } catch (e) { dictateError(e); }
  finally { btn?.classList.remove("on"); }
}

/* --------------------------------------------------------- glenns garage */
// Temat Glenns Garage: skylten på Översikt, saker från verkstaden på några av korten och ett easter egg.
const isGarage = () => !!document.documentElement.dataset.garage;
const GARAGE_QUIPS = [
  "Tjena! Ska vi kika på kärran?",
  "Kaffet är på och verktygen är framme.",
  "Gött väder för ett oljebyte, eller hur?",
  "Här lagar vi allt utom dåligt humör.",
  "Låter det konstigt? Fråga mig, så kollar vi.",
  "Har du kollat lufttrycket? Det är gratis på macken!",
];
const GARAGE_JOKES = [
  "Vad sa bromsen till gaspedalen? Ta't lugnt, jag stoppar dig ändå!",
  "Varför åkte bilbatteriet på semester? Det behövde bli laddat!",
  "Vad sa kamremmen till mig? Du har perfekt timing, Glenn!",
  "Varför är oljebyte som ett bra skämt? Det blir bättre ju oftare man gör det!",
  "Hur många mekaniker behövs för att byta en glödlampa? En, och tre som står och ger goda råd!",
  "Vad sa däcket till fälgen? Vi har det runt, du och jag!",
];
let garageTaps = 0, garageTapTimer = 0;
function garageSign() {
  const quip = GARAGE_QUIPS[new Date().getDate() % GARAGE_QUIPS.length];
  return `<div class="garage-sign" aria-label="Glenns Garage">
    <div class="gs-row">
      <div class="gs-board"><span class="gs-t" data-notr>GLENNS GARAGE</span><span class="gs-s">Service &amp; reparationer</span></div>
      <button class="gs-av" type="button" data-act="garage-glenn" aria-label="Glenn">${glennFig(`<img id="gs-glenn" src="${glennSrc("base")}" alt="" width="76" height="76">`)}</button>
    </div>
    <p class="gs-bubble" id="gs-bubble" data-notr>${esc(EN ? tr(quip) : quip)}</p>
    <div class="gs-props" aria-hidden="true"><img src="icons/garage/tire.png" alt=""><img src="icons/garage/cone.png" alt=""><img src="icons/garage/oil.png" alt=""><img src="icons/garage/toolbox.png" alt=""><img src="icons/garage/coffee.png" alt=""></div>
    <div class="hazard"></div>
  </div>`;
}
// Bilen på Översikt i pixelstil: bilden ritas i låg upplösning och förstoras med skarpa pixlar.
function pixelCar(root) {
  if (!isGarage()) return;
  const draw = (src, w, h, cls, replace) => {
    const img = new Image();
    img.onload = () => {
      const W = 96, H = Math.max(1, Math.round((W * (h || img.naturalHeight)) / (w || img.naturalWidth)));
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H; cv.className = cls + " car-px"; cv.setAttribute("aria-hidden", "true");
      const g = cv.getContext("2d");
      g.imageSmoothingEnabled = true;
      g.drawImage(img, 0, 0, W, H);
      if (document.contains(replace)) { replace.style.display = "none"; replace.insertAdjacentElement("afterend", cv); }
    };
    img.src = src;
  };
  root.querySelectorAll(".car-pick svg.car").forEach((svg) => {
    const css = getComputedStyle(document.documentElement);
    const vb = (svg.getAttribute("viewBox") || "0 0 320 112").split(/\s+/).map(Number);
    const xml = svg.outerHTML.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"').replace(/var\((--[\w-]+)\)/g, (m, v) => css.getPropertyValue(v).trim() || "#777");
    draw("data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml), vb[2], vb[3], "car", svg);
  });
  root.querySelectorAll(".car-pick img.car-photo").forEach((im) => {
    const go = () => draw(im.src, im.naturalWidth, im.naturalHeight, im.className, im);
    if (im.complete && im.naturalWidth) go(); else im.addEventListener("load", go, { once: true });
  });
}
// Glenns teman i Inställningar: ett eget kort med Glenn och en liten förhandsvisning av varje tema.
function garagePicker() {
  const list = Object.entries(COLORS).filter(([, t]) => t.garage);
  return `<div class="gp-pick">
    <div class="gp-head">${glennFig(`<img src="${glennSrc("base")}" alt="" width="56" height="56">`, false, "gp-fig")}<div><b>GLENNS GARAGE</b><span>${plusLock() ? "Tre teman i pixelstil · ingår i Plus" : "Tre teman i pixelstil"}</span></div>${plusLock() ? `<span class="plus-badge">Plus</span>` : ""}</div>
    <div class="gp-minis" role="group" aria-label="Glenns Garage">${list.map(([k, t]) => `<button class="gp-mini ${t.garage}${plusLock() ? " locked" : ""}" type="button" ${plusLock() ? `data-act="plus" data-f="garage"` : `data-act="theme-color" data-v="${k}"`} aria-pressed="${themePrefs().color === k}" aria-label="${esc(t.name.replace(/\u00ad/g, ""))}">
      <span class="gm-screen" aria-hidden="true"><span class="gm-sign"><img src="${glennSrc("base")}" alt="">GLENNS GARAGE</span><span class="gm-card"><i></i><i></i></span><span class="gm-card"><i></i></span><span class="gm-nav"><i></i></span></span>
      <span class="gm-name">${t.name}</span></button>`).join("")}</div>
  </div>`;
}
// Saker från verkstaden på korten, efter rubriken (svenska eller engelska).
const GARAGE_DECO = [[/^(däck|tyres)/i, "tire"], [/^(underhåll|maintenance)/i, "oil"], [/^(uppgifter|details)/i, "toolbox"], [/^(på gång|coming up)/i, "cone"], [/^(att göra|to do)/i, "coffee"], [/^(sparade platser|saved places)/i, "cone"], [/^(tankningar|refuelling)/i, "oil"]];
function garageDeco(root) {
  if (!isGarage()) return;
  root.querySelectorAll(".card > h2").forEach((h) => {
    const t = h.textContent.trim();
    const hit = GARAGE_DECO.find(([re]) => re.test(t));
    if (hit && !h.parentElement.querySelector(":scope > .deco")) h.parentElement.insertAdjacentHTML("afterbegin", `<img class="deco" src="icons/garage/${hit[1]}.png" alt="" aria-hidden="true">`);
  });
}
// Easter egget: tryck på Glenn fem gånger, så drar han en göteborgsvits, ger tummen upp och sprätter skruvar.
// Tio gånger, så lyfter han upp bilen på pelarlyften.
function garageEgg(btn) {
  garageTaps++;
  clearTimeout(garageTapTimer);
  garageTapTimer = setTimeout(() => { garageTaps = 0; }, 2500);
  const img = $("#gs-glenn"), bubble = $("#gs-bubble");
  if (img) { img.src = glennSrc("wink"); setTimeout(() => { img.src = glennSrc("base"); }, 500); }
  if (garageTaps === 5 || garageTaps === 10) {
    const joke = GARAGE_JOKES[Math.floor(Math.random() * GARAGE_JOKES.length)];
    if (bubble) bubble.textContent = EN ? tr(joke) : joke;
    if (img) { img.src = glennSrc("thumb"); setTimeout(() => { img.src = glennSrc("base"); }, 2500); }
    const r = btn.getBoundingClientRect();
    for (let k = 0; k < 14; k++) {
      const b = document.createElement("img");
      b.src = "icons/garage/bolt.png"; b.className = "bolt-fx"; b.alt = "";
      b.style.left = `${r.left + r.width / 2}px`; b.style.top = `${r.top + r.height / 2}px`;
      b.style.setProperty("--dx", `${Math.round((Math.random() - .5) * 260)}px`);
      b.style.setProperty("--dy", `${Math.round(-40 - Math.random() * 200)}px`);
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 1100);
    }
    if (garageTaps === 5 && !pref.get("garageEgg")) { pref.set("garageEgg", "1"); showToast("Du hittade Glenns hemliga vitslåda!"); }
  }
  if (garageTaps === 10) {
    const hero = $(".card.hero");
    if (hero) { hero.classList.remove("lift"); void hero.offsetWidth; hero.classList.add("lift"); setTimeout(() => hero.classList.remove("lift"), 2700); }
    if (bubble) bubble.textContent = EN ? "Up on the lift she goes! Looks good underneath." : "Upp på lyften med henne! Ser fint ut därunder.";
    garageTaps = 0;
  }
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
  markRequired(app);
  garageDeco(app);
  pixelCar(app);
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
  const resorTab = document.getElementById("tab-resor");
  if (resorTab) { const on = S.user && S.hid ? tripsVisible() : false; resorTab.hidden = !on; resorTab.parentElement.classList.toggle("with-resor", on); }
  // Glenn under sidomenyn på datorn och surfplattan på bredden, där knapparna uppe till höger är dolda.
  let navGlenn = document.getElementById("nav-glenn");
  const glennOn = !!(showNav && S.user && S.hid && (chatOn() || plusOnSale()));
  if (glennOn) {
    if (!navGlenn) { navGlenn = document.createElement("button"); navGlenn.id = "nav-glenn"; navGlenn.type = "button"; navGlenn.className = "nav-glenn"; navGlenn.dataset.act = "chat"; nav.appendChild(navGlenn); }
    const html = `${glennFig(`<img src="${glennSrc("base", true)}" alt="" width="128" height="136">`, true, "nav-glenn-fig")}<span>Fråga Glenn</span>`;
    if (navGlenn.dataset.html !== html) { navGlenn.innerHTML = html; navGlenn.dataset.html = html; }
  }
  if (navGlenn) navGlenn.hidden = !glennOn;
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
  bar.innerHTML = fuelBarInner(p);
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

// Widgeten på hemskärmen (iPhone-appen från 1.1): bilens namn, bränslet och det som är på gång.
// Skickas bara när något har ändrats. I äldre versioner av appen finns inte tillägget, och då händer inget.
let widgetSent = "";
function updateWidget() {
  if (!NATIVE || ANDROID) return;
  const c = car();
  if (!c) return;
  const iso = (d) => (typeof d === "string" ? d : d instanceof Date ? ymd(d) : null);
  const rows = [...bookingRows(c).filter((b) => b.days >= 0).map((b) => ({ t: b.kollTitle, d: b.tileDate })),
    ...docReminders(c).filter((x) => x.days >= 0).map((x) => ({ t: x.title, d: x.tileDate })),
    ...deadlines(c).filter((x) => x.days >= 0 && x.date).map((x) => ({ t: x.title, d: iso(x.date) }))]
    .filter((x) => x.d).sort((a, b) => a.d.localeCompare(b.d)).slice(0, 5);
  const pct = fuelPct(c.fuelLevel);
  const json = JSON.stringify({ lang: EN ? "en" : "sv", car: carName(c), fuel: pct == null ? null : Math.round(pct), items: rows.map((x) => ({ t: tr(x.t), d: x.d })) });
  if (json === widgetSent) return;
  widgetSent = json;
  try { Promise.resolve(nativePlugin("WidgetData")?.set({ json })).catch(() => {}); } catch { /* finns inte i den här versionen */ }
}

function render() {
  if (!S.user) return renderLogin();
  if (!S.hid) return;
  if (!S.loaded.house || !S.loaded.cars || !S.loaded.entries) {
    return setScreen("loading", `<p class="loading">Hämtar er bil …</p>`);
  }
  if (!S.cars.length) return renderCarSetup();
  // Den valda bilen kan ha lagts i papperskorgen (eller tagits bort) på en annan telefon.
  if (!car()) S.carId = S.cars.find((c) => c.id === pref.get("car"))?.id || S.cars[0].id;
  const views = { oversikt: viewOverview, logg: viewLog, ekonomi: viewEconomy, bilen: viewCar, resor: viewTrips, aviseringar: viewNotifications, installningar: viewSettings, admin: viewAdmin };
  if (S.view === "resor" && !tripsVisible()) S.view = "oversikt";
  // En låst bil visas bara om man själv har valt den. Annars hoppar appen till bilen som fungerar.
  if (carLocked(car()) && S.lockSeen !== S.carId) S.carId = activeCarId();
  const locked = carLocked(car()) && ["oversikt", "logg", "ekonomi", "bilen", "resor"].includes(S.view);
  document.body.classList.toggle("car-locked", locked);
  const fn = locked ? viewLocked : views[S.view] || viewOverview;
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
  // Vädret för Glenns bakgrund och kläder: en gång när appen öppnas, sedan varje halvtimme.
  if (!loadWeather.started) { loadWeather.started = true; loadWeather(); setInterval(loadWeather, 30 * 60000); }
  updateWidget();
  if (S.trips.some((t) => t.odoEnd == null)) setTimeout(updateTripEstimate, 500);
  renderTripBar();
  updateLiveActivity();
  if (autoAvailable() && !refreshAutoStatus.done) { refreshAutoStatus.done = true; refreshAutoStatus().then(render); }
  // Under Bilen hämtas PDF-verktyget i förväg, så att serviceboken kan delas direkt med ett tryck.
  if (S.view === "bilen" && !pdfReady()) setTimeout(() => loadPdfLibs().catch(() => {}), 800);
  runLaunchAction();
}

function renderLogin(error = "") {
  // Välkomstsidan: logotyp, rubrik, tre fördelar och inloggning längst ner.
  setScreen("login", `
    <section class="login-a">
      <h1 class="la-brand"><img class="logo-l" src="icons/logo.svg?v=4" alt="Bildagboken" width="936" height="200"><img class="logo-d" src="icons/logo-dark.svg?v=4" alt="" aria-hidden="true" width="936" height="200"></h1>
      <h2 class="la-title">Håll koll på bilen, tillsammans.</h2>
      <p class="la-sub">Bildagboken samlar allt om er bil på ett ställe, och alla ni som delar bilen ser samma sak.</p>
      <div class="la-feats">
        <div class="la-f"><span class="la-ic">${icon("fuel", 20)}</span><span><b>Logga på sekunder</b><small>Tankning, service, däck och kostnader</small></span></div>
        <div class="la-f"><span class="la-ic">${icon("calendar", 20)}</span><span><b>Påminnelser i tid</b><small>Besiktning, försäkring, skatt och bokade tider</small></span></div>
        <div class="la-f"><span class="la-ic">${icon("car", 20)}</span><span><b>Dela med de du kör med</b><small>Familj eller den du delar bil med</small></span></div>
      </div>
      <div class="la-btns">
        ${ANDROID ? "" : `<button class="btn apple block" type="button" data-act="login" data-provider="apple">${icon("apple", 20)} Fortsätt med Apple</button>`}
        <button class="btn google block" type="button" data-act="login" data-provider="google">${icon("google", 20)} Fortsätt med Google</button>
        ${error ? `<p class="err">${esc(error)}</p>` : ""}
        <p class="la-legal">Har du fått en inbjudan? Logga in först, sedan skriver du in koden.<br><a href="${LANG === "en" ? "privacy.html" : "integritet.html"}" target="_blank" rel="noopener">Så hanteras dina uppgifter</a>${NATIVE ? "" : ` · <a href="installera.html" target="_blank" rel="noopener">Lägg till på hemskärmen</a>`}</p>
      </div>
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
      <label class="field"><span>Vad heter hushållet?</span><input name="house" id="ob-house" maxlength="40"></label>
      <button class="btn primary block" type="submit">Skapa</button>
      <p class="hint">Sedan kan du bjuda in andra med en kod, till exempel familj eller den du delar bil med.</p>
    </form>
    ${code ? "" : joinForm}
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <button class="link" type="button" data-act="logout" style="align-self:center">Logga ut (${esc(S.user.email || "")})</button>`);
  if (join && !window.matchMedia("(pointer: coarse)").matches) $("#ob-code")?.focus();
}

// Chassinummer (VIN): 17 tecken utan I, O och Q. Tillverkaren står i de tre första tecknen och årsmodellen i det tionde.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const cleanVin = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const VIN_MAKERS = {
  YV1: "Volvo", YV4: "Volvo", YV2: "Volvo", LYV: "Volvo", "7JR": "Volvo", "7JD": "Volvo", YS3: "Saab", YS2: "Scania",
  WVW: "Volkswagen", WV1: "Volkswagen", WV2: "Volkswagen", WVG: "Volkswagen", WAU: "Audi", WUA: "Audi", WBA: "BMW", WBS: "BMW", WBY: "BMW",
  WDB: "Mercedes-Benz", WDD: "Mercedes-Benz", WDC: "Mercedes-Benz", W1K: "Mercedes-Benz", W1N: "Mercedes-Benz", W1V: "Mercedes-Benz", WMW: "Mini",
  WP0: "Porsche", WP1: "Porsche", TMB: "Skoda", VSS: "Seat", VSE: "Seat", VF1: "Renault", VF3: "Peugeot", VF7: "Citroën", VR3: "Peugeot", VR7: "Citroën", UU1: "Dacia",
  ZFA: "Fiat", ZAR: "Alfa Romeo", WF0: "Ford", WF1: "Ford", W0L: "Opel", W0V: "Opel", SAL: "Land Rover", SAJ: "Jaguar", SCC: "Lotus",
  JTD: "Toyota", JTE: "Toyota", JTN: "Toyota", JTM: "Toyota", SB1: "Toyota", NMT: "Toyota", VNK: "Toyota", JTH: "Lexus", JN1: "Nissan", SJN: "Nissan", VSK: "Nissan",
  JHM: "Honda", SHH: "Honda", SHS: "Honda", JMZ: "Mazda", JM1: "Mazda", JF1: "Subaru", JF2: "Subaru", JS2: "Suzuki", TSM: "Suzuki", JMB: "Mitsubishi", JMY: "Mitsubishi",
  KNA: "Kia", KNE: "Kia", KND: "Kia", U5Y: "Kia", U6Y: "Kia", KMH: "Hyundai", TMA: "Hyundai", NLH: "Hyundai", "5YJ": "Tesla", "7SA": "Tesla", XP7: "Tesla", LRW: "Tesla",
  LPS: "Polestar", L6T: "Lynk & Co", LGX: "BYD", LC0: "BYD", SDB: "MG", LSJ: "MG", LVV: "Chery", LB3: "Geely",
};
function vinMake(vin) { const v = cleanVin(vin); return VIN_MAKERS[v.slice(0, 3)] || null; }
// Årsmodell: tecknet går runt var 30:e år, så det senaste året som inte ligger i framtiden väljs.
function vinYear(vin) {
  const ch = cleanVin(vin)[9];
  const codes = "ABCDEFGHJKLMNPRSTVWXY123456789";
  const i = codes.indexOf(ch);
  if (i < 0) return null;
  const max = new Date().getFullYear() + 1;
  let y = 1980 + i;
  while (y + 30 <= max) y += 30;
  return y;
}
function vinInfo(vin) {
  const v = cleanVin(vin);
  if (!v) return "";
  if (v.length !== 17) return `${v.length} av 17 tecken`;
  if (!VIN_RE.test(v)) return "Innehåller I, O eller Q, som inte används i chassinummer. Kontrollera 0 (noll) och 1 (ett).";
  return [vinMake(v), vinYear(v) ? `årsmodell ${vinYear(v)}` : ""].filter(Boolean).join(" · ");
}
// Hitta ett chassinummer i text från kameran. Bokstäver som kameran ofta läser fel rättas (O → 0, I → 1, Q → 0).
function findVin(text) {
  const t = String(text || "").toUpperCase();
  const chunks = [...t.matchAll(/[A-Z0-9][A-Z0-9 ]{15,22}[A-Z0-9]/g)].map((m) => m[0].replace(/ /g, "")).concat(t.replace(/[^A-Z0-9]/g, " ").split(/\s+/));
  const fix = (x) => x.replace(/O/g, "0").replace(/I/g, "1").replace(/Q/g, "0");
  // Först: ett nummer som börjar med en känd tillverkarkod, var som helst i texten.
  for (const ch of chunks) {
    for (let i = 0; i + 17 <= ch.length; i++) {
      const cand = ch.slice(i, i + 17);
      const fixed = cand.slice(0, 3) + fix(cand.slice(3));
      if (VIN_RE.test(fixed) && vinMake(fixed)) return fixed;
    }
  }
  // Annars: ett ord som är exakt 17 tecken med både siffror och bokstäver.
  for (const w of t.split(/[^A-Z0-9]+/)) {
    const fixed = fix(w);
    if (w.length === 17 && VIN_RE.test(fixed) && /\d/.test(fixed) && /[A-Z]/.test(fixed) && vinYear(fixed)) return fixed;
  }
  return null;
}

// Förslag på märke och modell. Märken och modeller som redan finns i hushållet kommer först.
const findMake = (m) => Object.keys(CAR_MODELS).find((k) => k.toLowerCase() === String(m || "").trim().toLowerCase()) || null;
const modelList = (make) => (CAR_MODELS[findMake(make)] || []).map((x) => { const [name, fuel] = x.split(":"); return { name, fuel: fuel || null }; });
function makeOptions() {
  const own = [...new Set(S.cars.map((c) => c.make).filter(Boolean))];
  return [...own, ...Object.keys(CAR_MODELS).filter((k) => !own.includes(k))].map((k) => `<option value="${esc(k)}"></option>`).join("");
}
function modelOptions(make) {
  const own = S.cars.filter((c) => findMake(c.make) === findMake(make) && c.model).map((c) => c.model);
  const list = [...new Set([...own, ...modelList(make).map((m) => m.name)])];
  return list.map((m) => `<option value="${esc(m)}"></option>`).join("");
}
// När märke eller modell ändras: uppdatera modellförslagen och föreslå El för rena elbilar.
// Chassinummer: visa vad numret säger, och fyll i märke och årsmodell om de är tomma.
function applyVin(vin, fromScan = false) {
  const v = cleanVin(vin);
  const info = $("#cf-vin-info");
  if (info) { info.textContent = v ? vinInfo(v) : "Står längst ner i vindrutan på förarsidan och i registreringsbeviset. Tryck på kameran för att läsa av det."; info.classList.toggle("warn", !!v && !VIN_RE.test(v)); }
  if (!VIN_RE.test(v)) return;
  const mk = $("#cf-make"), yr = $("#cf-year");
  if (mk && !mk.value.trim() && vinMake(v)) { mk.value = vinMake(v); mk.classList.add("auto-filled"); mk.dispatchEvent(new Event("change", { bubbles: true })); }
  if (yr && !yr.value.trim() && vinYear(v)) { yr.value = vinYear(v); yr.classList.add("auto-filled"); }
  if (fromScan) showToast(`Chassinumret är avläst: ${v}. Kontrollera att det stämmer.`, 6000);
}
document.addEventListener("input", (ev) => { if (ev.target.id === "cf-vin") applyVin(ev.target.value); });
document.addEventListener("change", async (ev) => {
  if (ev.target.id !== "cf-vin-file") return;
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  const btn = $("#cf-vin-scan"), info = $("#cf-vin-info");
  btn?.classList.add("busy");
  if (info) info.textContent = "Läser av …";
  try {
    const text = await readReceiptText(file, (p) => { if ($("#cf-vin-info")) $("#cf-vin-info").textContent = `Läser av … ${Math.round(p * 100)} %`; });
    const vin = findVin(text);
    if (!vin) { if ($("#cf-vin-info")) $("#cf-vin-info").textContent = "Hittade inget chassinummer i bilden. Ta en ny bild närmare och rakt framifrån, eller skriv in det."; return; }
    const input = $("#cf-vin");
    if (input) input.value = vin;
    applyVin(vin, true);
  } catch {
    if ($("#cf-vin-info")) $("#cf-vin-info").textContent = "Det gick inte att läsa av bilden just nu. Skriv in numret i stället.";
  } finally { btn?.classList.remove("busy"); }
});

function onCarNameInput(ev) {
  if (ev.target.id === "cf-make") {
    const dl = $("#dl-model");
    if (dl) dl.innerHTML = modelOptions(ev.target.value);
    const mk = findMake(ev.target.value);
    if (mk && mk !== ev.target.value && ev.type === "change") ev.target.value = mk;
  }
  if (ev.target.id === "cf-model" || ev.target.id === "cf-make") {
    const m = modelList($("#cf-make")?.value).find((x) => x.name.toLowerCase() === String($("#cf-model")?.value || "").trim().toLowerCase());
    const fuel = $("#cf-fuel");
    if (m?.fuel === "El" && fuel && !fuel.dataset.touched && fuel.value !== "El") { fuel.value = "El"; fuel.classList.add("auto-filled"); }
  }
  if (ev.target.id === "cf-fuel") ev.target.dataset.touched = "1";
}
document.addEventListener("input", onCarNameInput);
document.addEventListener("change", onCarNameInput);

// Formuläret för bilen är uppdelat i delar, så att varje "Ändra" bara visar sin egen del.
const CAR_SECTIONS = {
  basic: "Uppgifter om bilen",
  photo: "Bild på bilen",
  dates: "Besiktning, försäkring och skatt",
  tires: "Däck",
  more: "Växellåda, tank och släp",
  specs: "Anteckningar",
};
// Däckens ålder: fyra siffror efter DOT på däckets sida, vecka och år. 4022 = vecka 40, 2022.
function tireDot(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 4 && +d.slice(0, 2) >= 1 && +d.slice(0, 2) <= 53 && !/^(19|20)/.test(d)) return { week: +d.slice(0, 2), year: 2000 + +d.slice(2) };
  if (d.length === 4 && /^(19|20)\d\d$/.test(d)) return { week: null, year: +d };
  return null;
}
const tireDotText = (v) => { const t = tireDot(v); return t ? (t.week ? `vecka ${t.week}, ${t.year}` : String(t.year)) : String(v ?? ""); };
function tireYearHint(v) {
  const t = tireDot(v);
  if (!t) return "Fyra siffror efter DOT på däckets sida: vecka och år. 4025 betyder vecka 40, 2025.";
  const age = new Date().getFullYear() - t.year;
  return `${t.week ? `Vecka ${t.week}, ${t.year}` : t.year}${age > 0 ? ` · ${age} år gamla` : ""}${age >= 8 ? ". Däck äldre än 8 år blir hårda och bör ses över, även om mönstret är bra." : ""}`;
}
// Mönsterdjup: lagkrav och rekommendation. Sommardäck minst 1,6 mm enligt lag, 3 mm rekommenderas.
// Vinterdäck minst 3 mm enligt lag när vinterdäck krävs (1 december–31 mars), 5 mm rekommenderas.
const TREAD = { sommar: { law: 1.6, rec: 3 }, vinter: { law: 3, rec: 5 } };
function tireDepthLevel(kind, v) {
  const d = num(v), t = TREAD[kind];
  if (d == null || !t) return null;
  return d < t.law ? "bad" : d < t.rec ? "warn" : "ok";
}
const mmTxt = (n) => (n % 1 ? fmt(n, 1) : String(n));
const TIRE_LAW_HTML = `<ul>
          <li>Vinterdäck krävs när det är vinterväglag (snö, is, snömodd eller frost) från 1 december till 31 mars, med minst 3 mm mönster.</li>
          <li>Dubbfria vinterdäck måste vara märkta med alptopp/snöflinga. Bara M+S räcker inte sedan 1 december 2024.</li>
          <li>Dubbdäck får användas 1 oktober–15 april, och även utanför den tiden om det är eller befaras bli vinterväglag.</li>
          <li>Sommardäck ska ha minst 1,6 mm mönster. 3 mm rekommenderas, eftersom greppet i regn blir mycket sämre.</li>
          <li>Drar du en släpvagn vid vinterväglag ska den också ha vinterdäck, och dubbdäck om bilen har det.</li>
          <li>Åldersgränserna i appen är rekommendationer, inte lag: gummit hårdnar med åren och greppar sämre.</li>
        </ul>
        <p class="hint">Källa: Transportstyrelsen.</p>`;
// En däcksats: uppgifterna, hälsan och allt som har loggats om den.
function tireSheet(kind) {
  const c = car();
  if (!c || !["sommar", "vinter"].includes(kind)) return;
  const t = (c.tires || []).find((x) => x.kind === kind) || {};
  const on = (c.tiresOn || "sommar") === kind;
  const h = tireHealth(c, kind);
  const dot = tireDot(t.year);
  const age = dot ? new Date().getFullYear() - dot.year : null;
  const mil = tireMil(c, kind);
  const d = num(t.depth);
  const rows = [
    ["Sitter på", on ? "Ja" : "Nej, i förrådet"],
    ["Märke", t.brand], ["Dimension", t.size],
    ["Tillverkade", dot ? `${tireDotText(t.year)}${age > 0 ? ` (${age} år)` : ""}` : ""],
    ["Mönsterdjup", d != null ? `${mmTxt(d)} mm${t.depthAt ? `, mätt ${fmtDateShort(t.depthAt)}` : ""}` : ""],
    ["Lufttryck", t.pressureFront != null || t.pressureRear != null ? `${t.pressureFront != null ? fmt(t.pressureFront, 1) : "–"} bar fram, ${t.pressureRear != null ? fmt(t.pressureRear, 1) : "–"} bar bak` : ""],
    kind === "vinter" ? ["Dubbade", t.studded ? "Ja" : "Nej"] : null,
    kind === "vinter" && !t.studded ? ["Alptopp/snöflinga", t.alpine === true ? "Ja" : t.alpine === false ? "Nej, bara M+S" : "Vet inte"] : null,
    ["Har rullat", mil != null && mil > 0 ? `cirka ${fmt(mil)} mil` : ""],
  ].filter((r) => r && r[1]);
  const other = kind === "vinter" ? "sommar" : "vinter";
  const hist = carEntries().filter((e) => e.type === "dack" && (e.tireKind === kind || e.tireAction === `till_${kind}` || e.tireAction === `till_${other}`))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  openSheet(kind === "sommar" ? "Sommardäck" : "Vinterdäck", `
    ${h ? `<div class="tire-health ${h.lvl}"><div class="th-top"><b>${esc(h.label)}</b><div class="tire-meter ${h.lvl}"><i style="width:${Math.max(4, Math.round(h.frac * 100))}%"></i></div></div><p>${esc(h.why)}</p></div>`
      : `<p class="muted">Lägg till tillverkningsår och mönsterdjup, så ser du hur däcken mår.</p>`}
    <dl class="detail-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${hist.length ? `<p class="label" style="margin:16px 0 6px">I loggen</p><div class="rows">${hist.slice(0, 8).map((e) => entryRow(e)).join("")}</div>` : ""}
    <div class="form" style="margin-top:14px">
      <button class="btn primary block" type="button" data-act="edit-car" data-section="tires">Ändra uppgifterna</button>
      <button class="btn block" type="button" data-act="new-entry" data-type="dack">${icon("tire", 18)} Logga däckbyte eller mätning</button>
    </div>
    <details class="more tire-law" style="margin-top:12px"><summary>Bra att veta om däck</summary>${TIRE_LAW_HTML}</details>`);
}
// Dubbfria vinterdäck räknas sedan 1 december 2024 bara som vinterdäck om de är märkta med alptopp/snöflinga
// (personbilar och släp till dem, högst 3,5 ton). Bara M+S räcker inte. Dubbdäck berörs inte.
const ALPINE_OPTS = [["", "Vet inte"], ["ja", "Ja, alptopp/snöflinga"], ["nej", "Nej, bara M+S"]];
const alpineVal = (t) => (t?.alpine === true ? "ja" : t?.alpine === false ? "nej" : "");
const alpineFrom = (v) => (v === "ja" ? true : v === "nej" ? false : null);
// Däckens hälsa: ålder (DOT), mönsterdjup och hur långt de har rullat. Det sämsta avgör.
// Vinterdäck tappar greppet med åldern fortare än sommardäck. Inga däck bör sitta på efter tio år.
const TIRE_AGE = { vinter: { warn: 5, bad: 6 }, sommar: { warn: 5, bad: 8 } };
const TIRE_NEW_MM = { vinter: 9, sommar: 8 };
const TIRE_MIL_WARN = 4000;
// Mätarställningen en viss dag: den som loggades närmast före (eller samma dag), annars närmast efter.
function odoAt(c, date) {
  const odos = S.entries.filter((e) => e.carId === c.id && e.odometer != null && e.date);
  const before = odos.filter((e) => e.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const after = odos.filter((e) => e.date > date).sort((a, b) => a.date.localeCompare(b.date))[0];
  return (before || after)?.odometer ?? null;
}
// Hur många mil en däcksats har rullat, räknat från däckbytena i loggen (sedan de köptes, om det är loggat).
function tireMil(c, kind) {
  const other = kind === "vinter" ? "sommar" : "vinter";
  const ents = S.entries.filter((e) => e.carId === c.id && e.type === "dack" && e.date).sort((a, b) => a.date.localeCompare(b.date) || tsMs(a.createdAt) - tsMs(b.createdAt));
  let on = null, total = 0, known = false;
  for (const e of ents) {
    const o = e.odometer ?? odoAt(c, e.date);
    if (e.tireAction === "nya" && e.tireKind === kind) { total = 0; known = true; if (on != null) on = o; }
    else if (e.tireAction === `till_${kind}`) { on = o; known = true; }
    else if (e.tireAction === `till_${other}` && on != null) { if (o != null && o > on) total += o - on; on = null; }
  }
  const now = odoOf(c);
  if (on != null && (c.tiresOn || "sommar") === kind && now != null && now > on) total += now - on;
  return known ? Math.round(total) : null;
}
function tireHealth(c, kind) {
  const t = (c.tires || []).find((x) => x.kind === kind) || {};
  const set = kind === "vinter" ? "Vinterdäcken" : "Sommardäcken";
  const parts = [];
  const dot = tireDot(t.year);
  if (dot) {
    const made = new Date(dot.year, dot.week ? Math.min(11, Math.floor((dot.week - 1) / 4.35)) : 6, 1);
    const age = Math.max(0, (Date.now() - made) / (365.25 * 864e5));
    const lim = TIRE_AGE[kind], yrs = Math.floor(age);
    const lvl = age >= 10 || age >= lim.bad ? "bad" : age >= lim.warn ? "warn" : "ok";
    parts.push({ lvl, f: 1 - age / lim.bad, why: lvl === "bad" ? `${set} är ${yrs} år. Gummit blir hårt och greppar sämre, även om mönstret ser bra ut.` : lvl === "warn" ? `${set} är ${yrs} år. Håll koll på greppet, de börjar bli gamla.` : `${yrs < 1 ? "Under 1 år" : `${yrs} år`} gamla` });
  }
  const d = num(t.depth);
  if (d != null && TREAD[kind]) {
    const tt = TREAD[kind], lvl = tireDepthLevel(kind, d);
    parts.push({ lvl, f: (d - tt.law) / (TIRE_NEW_MM[kind] - tt.law), why: lvl === "bad" ? `Mönsterdjupet ${mmTxt(d)} mm är under lagkravet på ${mmTxt(tt.law)} mm.` : lvl === "warn" ? `Mönsterdjupet ${mmTxt(d)} mm är under rekommenderade ${mmTxt(tt.rec)} mm.` : `${mmTxt(d)} mm mönster` });
  }
  if (kind === "vinter" && !t.studded && t.alpine === false) parts.push({ lvl: "bad", f: 0, why: "Vinterdäcken är bara märkta M+S och räknas inte som vinterdäck enligt lag. Dubbfria vinterdäck måste ha alptopp/snöflinga." });
  const mil = tireMil(c, kind);
  if (mil != null && mil > 0) {
    const lvl = mil >= TIRE_MIL_WARN ? "warn" : "ok";
    parts.push({ lvl, f: 1 - mil / 5000, why: lvl === "warn" ? `${set} har rullat omkring ${fmt(mil)} mil. Mät mönsterdjupet.` : `cirka ${fmt(mil)} mil` });
  }
  if (!parts.length) return null;
  const rank = { ok: 0, warn: 1, bad: 2 };
  if (kind === "vinter" && !t.studded && t.alpine == null && (t.brand || t.year || t.depth != null)) parts.push({ lvl: "ok", f: 1, why: "Kontrollera att de är märkta med alptopp/snöflinga" });
  const worst = parts.reduce((m, x) => (rank[x.lvl] > rank[m.lvl] ? x : m), parts[0]);
  const frac = Math.max(0, Math.min(1, Math.min(...parts.map((x) => x.f))));
  return { lvl: worst.lvl, frac, label: { ok: "Bra", warn: "Snart dags", bad: "Byt" }[worst.lvl], why: worst.lvl === "ok" ? parts.map((x) => x.why).join(" · ") : worst.why, oldDepth: d != null && t.depthAt && t.depthAt < ymd(addMonths(today0(), -13)) };
}
function tireDepthHint(kind, v) {
  const t = TREAD[kind], lvl = tireDepthLevel(kind, v);
  const base = kind === "vinter" ? `Lagkrav minst ${mmTxt(t.law)} mm (1 december–31 mars), rekommenderat minst ${mmTxt(t.rec)} mm.` : `Lagkrav minst ${mmTxt(t.law)} mm, rekommenderat minst ${mmTxt(t.rec)} mm.`;
  if (lvl === "bad") return `Under lagkravet på ${mmTxt(t.law)} mm. Däcken måste bytas.`;
  if (lvl === "warn") return `Under rekommenderade ${mmTxt(t.rec)} mm. Dags att byta snart, greppet blir sämre.`;
  return base;
}
// Hjälptexterna uppdateras medan man skriver.
document.addEventListener("input", (ev) => {
  const m = ev.target.id?.match(/^cf-([sw])_(year|depth)$/);
  if (!m) return;
  const hint = $(`#cf-${m[1]}_${m[2]}-hint`);
  if (!hint) return;
  if (m[2] === "year") hint.textContent = tireYearHint(ev.target.value);
  else {
    const kind = m[1] === "s" ? "sommar" : "vinter";
    hint.textContent = tireDepthHint(kind, ev.target.value);
    hint.dataset.level = tireDepthLevel(kind, ev.target.value) || "";
  }
  if (EN && typeof trTree === "function") trTree(hint.parentElement);
});
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
    <div class="field reg-look">
      <label for="cf-plate">Registreringsnummer</label>
      <span class="geo-row"><input name="plate" id="cf-plate" value="${esc(c.plate || "")}" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="8">
        <button class="btn-soft" type="button" data-act="reg-lookup">${icon("search", 16)} Hämta</button></span>
      <div id="cf-reg-status" class="reg-status" aria-live="polite"${isNew ? "" : ` data-plate="${esc(plateKey(c.plate))}"`}${!isNew && regFetchedPlate(c) ? ` data-fetched="${esc(regFetchedPlate(c))}"` : ""}><small>${isNew ? "Skriv registreringsnumret och tryck på Hämta, så fylls bilens uppgifter i." : regFetchedPlate(c) ? "Uppgifterna är redan hämtade. Har du skrivit fel registreringsnummer, rätta det och tryck på Hämta." : "Tryck på Hämta för att fylla i uppgifterna från registret."}</small></div>
      <input type="hidden" name="regJson" id="cf-regJson">
    </div>
    <div class="row2">
      ${inp("make", "Märke", c.make, 'required list="dl-make" autocomplete="off"')}
      ${inp("model", "Modell", c.model, 'required list="dl-model" autocomplete="off"')}
    </div>
    <datalist id="dl-make">${makeOptions()}</datalist>
    <datalist id="dl-model">${modelOptions(c.make)}</datalist>
    <div class="row2">
      ${inp("year", "Årsmodell", c.year, 'inputmode="numeric"')}
      ${inp("engine", "Motor", c.engine, '')}
    </div>
    <label class="field"><span>Drivmedel</span>${sel("fuel", FUELS, c.fuel || "Bensin")}</label>
    <div class="row2">
      ${inp("color", "Färg", c.color, '')}
      ${inp("bodyStyle", "Kaross", c.bodyStyle, 'autocomplete="off"')}
    </div>
    <div class="row2">
      ${inp("seats", "Antal säten", c.seats, 'inputmode="numeric" autocomplete="off"')}
      ${inp("co2", "Koldioxid (g/km)", c.co2, 'inputmode="numeric" autocomplete="off"')}
    </div>
    ${inp("firstReg", "I trafik sedan", c.firstReg, 'type="date"')}
    <label class="field"><span>Chassinummer (VIN)</span>
      <span class="geo-row"><input name="vin" id="cf-vin" value="${esc(c.vin || "")}" placeholder="17 tecken, valfritt" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="24">
      <label class="geo-btn" id="cf-vin-scan" aria-label="Läs av chassinumret med kameran" title="Läs av med kameran">${icon("camera", 20)}<input type="file" id="cf-vin-file" accept="image/*" class="vh"></label></span>
      <small id="cf-vin-info">${esc(c.vin ? vinInfo(c.vin) : "Står längst ner i vindrutan på förarsidan och i registreringsbeviset. Tryck på kameran för att läsa av det.")}</small></label>
    ${isNew ? "" : `<label class="check"><input type="checkbox" name="vinShare" id="cf-vinShare"${c.vinShare ? " checked" : ""}> Visa chassinumret i serviceboken som delas med en köpare</label>`}
    ${isNew
      ? inp("odometer", "Mätarställning (mil)", "", 'inputmode="numeric"') + `
        <div class="field">
          <span id="cf-bes-label">Senast besiktad</span>
          <input type="month" name="lastInspection" id="cf-lastInspection" max="${todayStr().slice(0, 7)}" placeholder="ÅÅÅÅ-MM">
          <label class="check"><input type="checkbox" name="notInspected" id="cf-notInspected"> Bilen är ny och har inte besiktats än</label>
          <small id="cf-bes-out">Månaden räcker, den står i besiktningsprotokollet. Då föreslår appen när nästa besiktning senast ska vara gjord.</small>
        </div>`
      : `<div class="field"><span>Mätarställning</span>
          <div class="odo-row"><b>${odoOf(c) != null ? `${fmt(odoOf(c))} mil` : "Inte angiven"}</b>
          <button class="btn-soft" type="button" data-act="odo-from-car">Uppdatera</button></div>
          <small>Hämtas från loggen. Har någon skrivit fel, ändra eller ta bort den posten i loggen.</small></div>`}`;
  parts.more = `
    <div class="row2">
      <label class="field"><span>Växellåda</span>${sel("gearbox", [["", "Vet inte"], ["Manuell", "Manuell"], ["Automat", "Automat"]], c.gearbox || "")}</label>
      ${inp("tankVolume", "Tankvolym (liter)", c.tankVolume, 'inputmode="numeric"')}
    </div>
    <p class="section-t">Släpvagn</p>
    <div class="row2">
      ${inp("towMax", "Max släpvagnsvikt (kg)", c.towMax, 'inputmode="numeric"')}
      ${inp("totalWeight", "Bilens totalvikt (kg)", c.totalWeight, 'inputmode="numeric"')}
    </div>
    ${inp("trainWeight", "Tågvikt (kg)", c.trainWeight, 'inputmode="numeric"')}
    <p class="hint">Vikterna står i registreringsbeviset. Max släpvagnsvikt gäller ett släp med egna bromsar. Tågvikten heter ibland max sammanlagd bruttovikt.</p>`;
  parts.photo = `
    <label class="photo-in">${icon("image", 22)}<span id="photo-label">${c.photoId ? "Eget foto används. Välj ett nytt för att byta." : "Ta eller välj ett eget foto på bilen"}</span><input type="file" name="carPhoto" id="cf-carPhoto" accept="image/*"></label>
    ${c.photoId ? `<label class="check"><input type="checkbox" name="removePhoto" id="cf-removePhoto"> Ta bort eget foto och använd bild från Wikipedia</label>`
      : `<p class="hint">Utan eget foto hämtas en bild på modellen från Wikipedia.</p>`}`;
  parts.dates = `
    <div class="row2">
      ${inp("besiktning", "Sista dag för besiktning", c.besiktning, 'type="date"')}
      ${inp("besiktningPlats", "Besiktningsstation", c.besiktningPlats, '')}
    </div>
    <div class="row2">
      ${inp("forsakringBolag", "Försäkringsbolag", c.forsakringBolag, '')}
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
      <label class="field"><span>Tillverkad (DOT)</span><input name="s_year" id="cf-s_year" value="${esc(summer.year ?? "")}" inputmode="numeric" autocomplete="off" maxlength="4"><small class="tire-hint" id="cf-s_year-hint">${esc(tireYearHint(summer.year))}</small></label>
      <label class="field"><span>Mönsterdjup (mm)</span><input name="s_depth" id="cf-s_depth" value="${esc(summer.depth ?? "")}" inputmode="decimal" autocomplete="off"><small class="tire-hint" id="cf-s_depth-hint" data-level="${tireDepthLevel("sommar", summer.depth) || ""}">${esc(tireDepthHint("sommar", summer.depth))}</small></label>
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
      <label class="field"><span>Tillverkad (DOT)</span><input name="w_year" id="cf-w_year" value="${esc(winter.year ?? "")}" inputmode="numeric" autocomplete="off" maxlength="4"><small class="tire-hint" id="cf-w_year-hint">${esc(tireYearHint(winter.year))}</small></label>
      <label class="field"><span>Mönsterdjup (mm)</span><input name="w_depth" id="cf-w_depth" value="${esc(winter.depth ?? "")}" inputmode="decimal" autocomplete="off"><small class="tire-hint" id="cf-w_depth-hint" data-level="${tireDepthLevel("vinter", winter.depth) || ""}">${esc(tireDepthHint("vinter", winter.depth))}</small></label>
    </div>
    <div class="row2">
      ${inp("w_pf", "Lufttryck fram (bar)", winter.pressureFront != null ? fmt(winter.pressureFront, 1) : "", 'inputmode="decimal" autocomplete="off"')}
      ${inp("w_pr", "Lufttryck bak (bar)", winter.pressureRear != null ? fmt(winter.pressureRear, 1) : "", 'inputmode="decimal" autocomplete="off"')}
    </div>
    <label class="check"><input type="checkbox" name="w_studded" id="cf-w_studded"${winter.studded ? " checked" : ""}> Vinterdäcken är dubbade</label>
    <label class="field"><span>Märkta med alptopp/snöflinga?</span><select name="w_alpine" id="cf-w_alpine">${ALPINE_OPTS.map(([v, l]) => `<option value="${v}"${alpineVal(winter) === v ? " selected" : ""}>${l}</option>`).join("")}</select><small>Dubbfria vinterdäck räknas bara som vinterdäck om de har symbolen med ett berg och en snöflinga. Bara M+S räcker inte sedan 1 december 2024.</small></label>
    <p class="hint">Dimensionen står på däckets sida, till exempel 205/55 R16. Rätt lufttryck står oftast på en dekal i förardörren eller i tanklocket. Sommar- och vinterdäcken sparas var för sig.</p>`;
  parts.specs = `
    <label class="field"><span>Anteckningar om bilen</span><textarea name="specsText" id="cf-specsText" rows="9">${esc(c.specsText ?? SPEC_TEMPLATE)}</textarea></label>
    <p class="hint">Skriv fritt. Rader som "Motorolja: 5W-30" visas som rutor, så har ni oljetyp, däckdimension och liknande till hands i butiken.</p>`;
  return sections.map((k) => head(k) + parts[k]).join("");
}

/* ------------------------------------------------------------ släpvagn */
// Vad bilen får dra, från vikterna man fyllt i under Ändra (registreringsbeviset). Kortet visar förslag med vanliga
// släp, så att man får ett svar utan att veta något om släpet, och en räknare för ett visst släp.
// Körkort (släpets och bilens totalvikter enligt registreringsbevisen): B räcker om släpet väger högst 750 kg
// eller om bil och släp tillsammans är högst 3 500 kg. Utökad B (B96) upp till 4 250 kg. Annars krävs BE.
const LICENSES = { B: "B", B96: "B96", BE: "BE" };
// Vanliga släp med ungefärliga vikter: [namn, totalvikt, tjänstevikt, egna bromsar].
const TRAILERS = [
  ["Litet släp utan bromsar", 750, 170, false],
  ["Mellanstort släp med bromsar", 1000, 250, true],
  ["Större släp med bromsar", 1300, 300, true],
  ["Kåpsläp", 1500, 450, true],
  ["Båttrailer", 1300, 250, true],
  ["Liten husvagn", 1200, 950, true],
  ["Stor husvagn", 1700, 1400, true],
  ["Hästtransport, en häst", 1500, 650, true],
  ["Hästtransport, två hästar", 2000, 900, true],
  ["Biltrailer", 2500, 550, true],
];
// Tre typer av släp med bild: [namn, egna bromsar, vanlig totalvikt från–till, bild].
const TRAILER_PICS = {
  small: `<svg viewBox="0 0 120 64" aria-hidden="true"><path d="M2 56h116" class="tp-ground"/><path d="M14 40h14M12 38v4" class="tp-line"/><rect x="28" y="30" width="56" height="14" rx="2" class="tp-body"/><path d="M32 34h48" class="tp-line"/><circle cx="56" cy="48" r="7" class="tp-wheel"/><circle cx="56" cy="48" r="2.5" class="tp-hub"/></svg>`,
  medium: `<svg viewBox="0 0 120 64" aria-hidden="true"><path d="M2 56h116" class="tp-ground"/><path d="M6 40h18M4 38v4" class="tp-line"/><rect x="12" y="36" width="8" height="5" rx="1" class="tp-brake"/><rect x="24" y="24" width="72" height="20" rx="2" class="tp-body"/><path d="M28 29h64" class="tp-line"/><circle cx="60" cy="48" r="8" class="tp-wheel"/><circle cx="60" cy="48" r="3" class="tp-hub"/></svg>`,
  large: `<svg viewBox="0 0 120 64" aria-hidden="true"><path d="M2 56h116" class="tp-ground"/><path d="M2 40h18M1 38v4" class="tp-line"/><rect x="8" y="36" width="8" height="5" rx="1" class="tp-brake"/><rect x="20" y="18" width="94" height="26" rx="2" class="tp-body"/><path d="M24 23h86" class="tp-line"/><circle cx="58" cy="48" r="7" class="tp-wheel"/><circle cx="76" cy="48" r="7" class="tp-wheel"/><circle cx="58" cy="48" r="2.5" class="tp-hub"/><circle cx="76" cy="48" r="2.5" class="tp-hub"/></svg>`,
};
// [bild, namn, egna bromsar, vanlig totalvikt (släp + last), vanlig tjänstevikt (släpet tomt)]
const TRAILER_TYPES = [["small", "Litet släp", false, 750, 170], ["medium", "Mellanstort släp", true, 1000, 250], ["large", "Stort släp", true, 1500, 350]];
// Varje ruta: vad släpet väger tomt + hur mycket du får lasta = vad det får väga totalt.
function trailerTiles(t, lic) {
  return `<div class="tow-tiles">${TRAILER_TYPES.map(([pic, name, braked, typTotal, typCurb]) => {
    const lmax = licenseMax(t, lic);
    const head = `<span class="tt-pic">${TRAILER_PICS[pic]}</span><span class="tt-txt"><b>${esc(name)}</b><span class="tt-brake">${braked ? "Med bromsar" : "Utan bromsar"}</span>`;
    // Körkortet räknas på släpets totalvikt i registreringsbeviset, även om man lastar mindre.
    if (lmax != null && typTotal > lmax) {
      const need = lic === "B" && t.b96 != null && typTotal <= t.b96 ? "B96" : "BE";
      return `<div class="tow-tile bad">${head}<span class="tt-kg">${esc(`Kräver körkort ${need}`)}</span>
        <span class="tt-sum">${esc(`Ett sådant släp brukar få väga ${fmt(typTotal)} kg med last`)}</span></span></div>`;
    }
    const max = trailerCarMax(t, braked);
    const total = Math.min(typTotal, max), load = total - typCurb;
    if (load < 50) return `<div class="tow-tile bad">${head}<span class="tt-kg">För tungt för bilen</span>
      <span class="tt-sum">${esc(`Bilen får bara dra ${fmt(max)} kg`)}</span></span></div>`;
    return `<div class="tow-tile ${total < typTotal ? "warn" : "ok"}">${head}
      <span class="tt-kg">${esc(`Lasta ca ${fmt(load)} kg`)}</span>
      <span class="tt-sum">${esc(`Släpet ca ${fmt(typCurb)} kg + last ${fmt(load)} kg = ${fmt(total)} kg totalt`)}</span>
      ${total < typTotal ? `<span class="tt-sub">${esc(`Fyll inte helt. Bilen får dra ${fmt(max)} kg.`)}</span>` : ""}</span></div>`;
  }).join("")}</div>`;
}
const licenseOf = () => (LICENSES[pref.get("license")] ? pref.get("license") : "B");
function trailerInfo(c) {
  const t = { braked: num(c.towMax), total: num(c.totalWeight), train: num(c.trainWeight) };
  if (t.total) { t.b = Math.max(750, 3500 - t.total); t.b96 = Math.max(750, 4250 - t.total); }
  // Med fullastad bil: tågvikten minus bilens totalvikt.
  t.byTrain = t.train && t.total ? t.train - t.total : null;
  return t.braked ? t : null;
}
// Hur tungt (lastat) ett släp får vara bakom bilen, med eller utan egna bromsar.
const trailerCarMax = (t, braked) => Math.min(...[braked ? t.braked : Math.min(750, t.braked), t.byTrain].filter((x) => x != null));
// Släpets högsta totalvikt (enligt registreringsbeviset) för ett körkort, eller null om bilens totalvikt saknas.
const licenseMax = (t, lic) => (lic === "BE" ? Infinity : t.total ? (lic === "B96" ? t.b96 : t.b) : null);
// Svar för ett släp: ok (true/false/"warn") och en text.
// Svar för ett släp: [ok (true/"warn"/false), rubrik, förklaring]. Rubriken säger hur mycket man får lasta.
// Totalvikt = släpet och lasten tillsammans. Tjänstevikt = släpet tomt.
function trailerVerdict(t, lic, total, curb, braked) {
  const ca = curb ? "ca " : "";
  const about = curb != null ? `Väger ${ca}${fmt(curb)} kg tomt och får väga ${fmt(total)} kg med last.` : `Får väga ${fmt(total)} kg med last.`;
  const lmax = licenseMax(t, lic);
  if (lmax != null && total > lmax) {
    const need = lic === "B" && t.b96 != null && total <= t.b96 ? "utökad B (B96)" : "BE";
    return [false, `Kräver körkort ${need}`, `${about} Med körkort ${lic} får släpets totalvikt vara högst ${fmt(lmax)} kg.`];
  }
  const max = trailerCarMax(t, braked);
  if (total <= max) return [true, curb != null ? `Du får lasta ${ca}${fmt(total - curb)} kg` : "Går bra fullastat", about];
  if (curb != null && max - curb >= 100) return ["warn", `Du får lasta ${ca}${fmt(max - curb)} kg`, `${about} Bakom din bil får det bara väga ${fmt(max)} kg, så du får inte fylla det helt.`];
  return [false, "För tungt för bilen", `${about} Bakom din bil får släpet väga högst ${fmt(max)} kg med lasten.`];
}
const verdictIcon = (ok) => (ok === true ? icon("check", 16) : ok === "warn" ? icon("gauge", 16) : icon("close", 16));
function trailerCard(c) {
  const t = trailerInfo(c);
  if (!t) return `<div class="card"><h2>Släpvagn</h2>
    <p class="muted">Fyll i bilens max släpvagnsvikt och totalvikt från registreringsbeviset, så visar appen vad bilen får dra.</p>
    <div class="ask"><button class="btn-soft" type="button" data-act="edit-car" data-section="more">Fyll i vikterna</button></div></div>`;
  const lic = licenseOf();
  const lmax = licenseMax(t, lic), carMax = trailerCarMax(t, true), nob = trailerCarMax(t, false);
  const most = lmax == null ? carMax : Math.min(carMax, lmax);
  const byLicense = lmax != null && lmax < carMax;
  // De tre vanliga släpen som rader: hur mycket man får lasta, eller vad som stoppar.
  const rows = TRAILER_TYPES.map(([pic, name, braked, typTotal, typCurb]) => {
    let pill, cls, sub;
    if (lmax != null && typTotal > lmax) {
      const need = lic === "B" && t.b96 != null && typTotal <= t.b96 ? "B96" : "BE";
      pill = `Kräver ${need}`; cls = "urgent"; sub = `Brukar väga ${fmt(typTotal)} kg med last`;
    } else {
      const max = trailerCarMax(t, braked), total = Math.min(typTotal, max), load = total - typCurb;
      if (load < 50) { pill = "För tungt"; cls = "urgent"; sub = `Bilen får dra ${fmt(max)} kg`; }
      else { pill = `${fmt(load)} kg last`; cls = total < typTotal ? "soon" : "ok"; sub = total < typTotal ? `Fyll inte helt · släpet ca ${fmt(typCurb)} kg` : `Släpet ca ${fmt(typCurb)} kg + last = ${fmt(total)} kg`; }
    }
    return `<div class="dl tow-type"><span class="tt-pic">${TRAILER_PICS[pic]}</span><span><span class="dl-t">${esc(name)}</span><span class="dl-s">${esc(`${braked ? "Med bromsar" : "Utan bromsar"} · ${sub}`)}</span></span><span class="pill ${cls}">${esc(pill)}</span></div>`;
  }).join("");
  return `<div class="card tow-card"><h2>Släpvagn <button class="link" type="button" data-act="edit-car" data-section="more">Ändra</button></h2>
    <div class="tow-top">
      <div class="tow-big"><span class="label">Släp + last, högst</span><b>${fmt(most)} <small>kg</small></b>
        <span class="tow-sub">${esc(byLicense ? `Gränsen för körkort ${lic}. Bilen orkar ${fmt(carMax)} kg.` : `Utan egna bromsar högst ${fmt(nob)} kg.`)}</span></div>
      <div class="tow-lic"><span class="label">Körkort</span><div class="seg seg-sm" role="group" aria-label="Ditt körkort">${Object.keys(LICENSES).map((k) => `<button type="button" data-act="license" data-v="${k}" aria-pressed="${k === lic}">${k}</button>`).join("")}</div></div>
    </div>
    ${byLicense ? `<p class="hint" style="margin:-4px 0 8px">${esc(`Utan egna bromsar högst ${fmt(nob)} kg.`)}</p>` : ""}
    <p class="label" style="margin:12px 0 2px">Så mycket får du lasta</p>
    <div class="rows">${rows}</div>
    <details class="more" style="margin-top:10px"><summary>Räkna på ditt släp</summary>
      <div class="form trailer-calc" style="margin-top:8px">
        <div class="row2">
          <label class="field"><span>Totalvikt (kg)</span><input id="tc-total" inputmode="numeric" placeholder="Släp + last"></label>
          <label class="field"><span>Tjänstevikt (kg)</span><input id="tc-curb" inputmode="numeric" placeholder="Tomt släp"></label>
        </div>
        <div id="tc-out" aria-live="polite"><p class="hint">Båda står i släpets registreringsbevis. Skillnaden är hur mycket du får lasta.</p></div>
      </div>
      <p class="label" style="margin:14px 0 2px">Fler exempel</p>
      <div class="rows tow-list">${TRAILERS.map(([name, total, curb, braked]) => {
        const [ok, head] = trailerVerdict(t, lic, total, curb, braked);
        return `<div class="dl"><span><span class="dl-t">${esc(name)}</span><span class="dl-s">${esc(`ca ${fmt(curb)} kg tomt, ${fmt(total)} kg med last`)}</span></span><span class="pill ${ok === true ? "ok" : ok === "warn" ? "soon" : "urgent"}">${esc(head.replace(/^Du får lasta /, "").replace(/^Kräver körkort /, "Kräver ").replace(/^Går bra fullastat$/, "Fullastat"))}</span></div>`;
      }).join("")}</div>
      <p class="hint" style="margin-top:6px">Vikterna är ungefärliga. Kolla alltid släpets registreringsbevis.</p>
    </details>
    ${!t.total || !t.train ? `<p class="hint" style="margin-top:8px">${esc(!t.total ? "Fyll i bilens totalvikt under Ändra, så räknas körkortet in." : "Fyll i tågvikten under Ändra, så blir svaret säkrare.")}</p>` : ""}
  </div>`;
}
// Ett visst släp. Upp till 750 kg räknas det som ett släp utan egna bromsar, som de flesta sådana släp är.
function trailerCalc() {
  const out = $("#tc-out"), c = car(), t = c && trailerInfo(c);
  if (!out || !t) return;
  const total = num($("#tc-total").value), curb = num($("#tc-curb").value);
  if (total == null) { out.innerHTML = `<p class="hint">Vikterna står i släpets registreringsbevis.</p>`; return; }
  const [ok, head, text] = trailerVerdict(t, licenseOf(), total, curb, total > 750);
  out.innerHTML = `<div class="tc-res"><p class="${ok === true ? "ok" : ok === "warn" ? "warn" : "bad"}">${verdictIcon(ok)} ${esc(head)}</p><p class="tc-sub">${esc(text)}</p></div>
    <p class="hint">Räknat på vikterna ni har fyllt i. Kontrollera alltid mot bilens och släpets registreringsbevis.</p>`;
}
document.addEventListener("input", (ev) => { if (["tc-total", "tc-curb"].includes(ev.target.id)) trailerCalc(); });

/* ---------------------------------------------- uppgifter från regnumret */
// Bilens uppgifter från registreringsnumret (funktionen hamtaFordon, via registreringsnummerapi.se).
// Svaret kommer som en lista { k, v } och sparas på bilen som reg = { f, at }. Vilka fält som finns varierar,
// så appen letar efter kända namn och fyller i det den hittar. Allt visas under "Visa alla uppgifter" och går till Glenn.
const plateKey = (p) => String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const plateOk = (p) => /^[A-Z]{3}[0-9]{2}[A-Z0-9]$/.test(plateKey(p));
const fmtPlate = (p) => (plateOk(p) ? `${plateKey(p).slice(0, 3)} ${plateKey(p).slice(3)}` : String(p || "").toUpperCase().trim());
const regKey = (k) => String(k).toLowerCase().split(".").pop().replace(/\[\d+\]/g, "").normalize("NFD").replace(/[^a-z0-9]/g, "");
function regGet(f, ...names) {
  for (const n of names) { const hit = (f || []).find((x) => regKey(x.k) === n); if (hit?.v) return String(hit.v).trim(); }
  return null;
}
const regNumber = (v) => { if (v == null) return null; const m = String(v).replace(/(\d)\s+(?=\d{3}\b)/g, "$1").match(/\d+(?:[.,]\d+)?/); return m ? Number(m[0].replace(",", ".")) : null; };
const regDay = (v) => { const m = String(v || "").match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const niceWord = (s) => String(s).split(/(\s+|-)/).map((w) => (/^[A-ZÅÄÖ]{4,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join("");
// Det som går att fylla i på bilen.
function regToCar(f) {
  const out = {};
  let make = regGet(f, "carmake", "makedescription", "make", "fabrikat", "marke");
  let model = regGet(f, "carmodel", "modeldescription", "model", "handelsbeteckning", "modell");
  const desc = regGet(f, "description", "beskrivning");
  if (!make && desc) { const w = desc.split(/\s+/); make = w[0]; model = model || w.slice(1).join(" "); }
  if (make) out.make = findMake(make) || niceWord(make);
  if (model) out.model = niceWord(model.replace(new RegExp(`^${make}\\s+`, "i"), ""));
  const year = (regGet(f, "modelyear", "arsmodell", "registrationyear", "year", "fordonsar", "manufactureyear") || "").match(/\b(19|20)\d{2}\b/);
  if (year) out.year = year[0];
  const color = regGet(f, "colour", "color", "farg");
  if (color) out.color = color[0].toUpperCase() + color.slice(1).toLowerCase();
  const fuel = (regGet(f, "fueltype", "fuel", "drivmedel", "bransle") || "").toLowerCase();
  if (fuel) out.fuel = /laddhybrid|plug/.test(fuel) ? "Laddhybrid" : /hybrid/.test(fuel) ? "Hybrid" : /etanol|e85|flex/.test(fuel) ? "Flexifuel (bensin/E85)"
    : /diesel/.test(fuel) ? "Diesel" : /^el\b|elektri|electric/.test(fuel) ? "El" : /bensin|petrol|gasoline/.test(fuel) ? "Bensin" : undefined;
  if (!out.fuel) delete out.fuel;
  const vin = cleanVin(regGet(f, "vechileidentificationnumber", "vehicleidentificationnumber", "vin", "chassisnumber", "chassinummer", "identifikationsnummer") || "");
  if (vin && vin.length >= 11) out.vin = vin;
  const ccm = regNumber(regGet(f, "enginesize", "cylindervolym", "enginecapacity"));
  if (ccm && ccm > 300 && ccm < 9000) out.engine = (Math.round(ccm / 100) / 10).toFixed(1);
  const bes = regDay(regGet(f, "nextinspection", "inspectiondeadline", "besiktigassenast", "besiktassenast", "nextinspectiondate"));
  if (bes) out.besiktning = bes;
  const last = regDay(regGet(f, "lastinspection", "lastinspectiondate", "senastbesiktning", "senastgodkandbesiktning"));
  if (last) out.lastInspection = last;
  const gear = (regGet(f, "transmission", "gearbox", "vaxellada", "gearboxtype") || "").toLowerCase();
  if (gear) out.gearbox = /auto/.test(gear) ? "Automat" : /man/.test(gear) ? "Manuell" : undefined;
  if (!out.gearbox) delete out.gearbox;
  const kg = (...n) => { const x = regNumber(regGet(f, ...n)); return x && x > 50 && x < 60000 ? Math.round(x) : null; };
  const tow = kg("maxtrailerweight", "maxslapvagnsvikt", "trailerweight", "towingcapacity", "maxtrailerweightbraked");
  const total = kg("grossweight", "totalvikt", "totalweight", "maxweight");
  const train = kg("trainweight", "tagvikt", "maxtrainweight", "combinedweight");
  if (tow) out.towMax = tow; if (total) out.totalWeight = total; if (train) out.trainWeight = train;
  const body = regGet(f, "bodystyle", "kaross", "bodytype");
  if (body && !/okänd|unknown/i.test(body)) out.bodyStyle = body[0].toUpperCase() + body.slice(1).toLowerCase();
  const seats = regNumber(regGet(f, "numberofseats", "seats", "passagerare", "antalpassagerare"));
  if (seats && seats > 0 && seats < 60) out.seats = seats;
  const first = regDay(regGet(f, "registrationdate", "firstregistration", "firstregistrationdate", "itrafikforstagangen"));
  if (first) out.firstReg = first;
  const co2 = regNumber(regGet(f, "co2", "co2emissions", "koldioxid"));
  if (co2 && co2 > 0 && co2 < 1000) out.co2 = Math.round(co2);
  // En bil som är yngre än tre år: första besiktningen ska vara gjord inom 36 månader från första registreringen.
  if (first && !out.besiktning) {
    const d = parseDate(first), due = new Date(d.getFullYear(), d.getMonth() + 37, 0);
    if (due >= new Date()) out.besiktning = ymd(due);
  }
  const tax = regNumber(regGet(f, "annualtax", "tax", "fordonsskatt", "arsskatt", "vehicletax"));
  if (tax && tax > 0 && tax < 100000) out.skattBelopp = Math.round(tax);
  return out;
}
// Söker och visar laddningssymbol i box. Lyckas det: onFound(fields). Annars en text om att fylla i själv.
// Högst en sökning var tionde sekund: knapparna räknar ner så länge.
const REG_WAIT_S = 10;
let regNextAt = 0, regTick = null;
function regCooldown() {
  regNextAt = Date.now() + REG_WAIT_S * 1000;
  clearInterval(regTick);
  const paint = () => {
    const left = Math.ceil((regNextAt - Date.now()) / 1000);
    document.querySelectorAll('[data-act="reg-lookup"], [data-act="reg-refresh"]').forEach((b) => {
      if (!b.dataset.label) b.dataset.label = b.innerHTML;
      b.disabled = left > 0;
      b.innerHTML = left > 0 ? `${icon("search", 16)} ${left}` : b.dataset.label;
      b.setAttribute("aria-label", left > 0 ? `Vänta ${left} sekunder` : "Hämta");
    });
    if (left <= 0) clearInterval(regTick);
  };
  paint();
  regTick = setInterval(paint, 500);
}
async function regLookup(box, plate, onFound) {
  const key = plateKey(plate);
  if (Date.now() < regNextAt) return;
  regCooldown();
  box.dataset.plate = key;
  box.innerHTML = `<div class="reg-busy" role="status"><span class="reg-spin" aria-hidden="true"></span><span>${esc(`Söker efter ${fmtPlate(key)} …`)}</span></div>`;
  // Samma regnummer i den här sessionen: använd svaret igen. Pågår redan en sökning på numret: vänta på den.
  let res = regMemo.get(key);
  if (!res) {
    let job = regPending.get(key);
    if (!job) {
      job = Promise.race([window.__regMock ? window.__regMock(key) : callFn("hamtaFordon", { hid: S.hid, plate: key }), new Promise((r) => setTimeout(() => r({ ok: false, reason: "timeout" }), 25000))]).catch(() => ({ ok: false, reason: "error" }));
      regPending.set(key, job);
    }
    res = await job;
    regPending.delete(key);
    if (res?.ok || res?.reason === "notfound") regMemo.set(key, res);
  }
  if (box.dataset.plate !== key) return; // man har hunnit skriva ett annat nummer
  if (res?.ok && res.fields?.length) {
    onFound(res.fields);
    if (res.left != null && res.left < 3) box.insertAdjacentHTML("beforeend", `<p class="hint" style="margin-top:6px">${esc(res.left ? `Du kan söka ${res.left} ${res.left === 1 ? "gång" : "gånger"} till i dag.` : "Det var din sista sökning för i dag.")}</p>`);
    return;
  }
  if (res?.reason === "daily") { box.innerHTML = `<div class="reg-fail"><p>Du har gjort 5 sökningar i dag. Du kan söka igen i morgon, eller fylla i uppgifterna själv.</p></div>`; return; }
  if (res?.reason === "wait") { box.innerHTML = `<div class="reg-fail"><p>${esc(`Vänta ${res.wait || REG_WAIT_S} sekunder mellan sökningarna.`)}</p></div>`; return; }
  const why = { limit: "Ni har gjort många sökningar den här månaden.", notfound: `Hittade inga uppgifter om ${fmtPlate(key)}.` }[res?.reason] || "Det gick inte att hämta uppgifterna just nu.";
  box.innerHTML = `<div class="reg-fail"><p>${esc(`${why} Fyll i uppgifterna själv.`)}</p></div>`;
}
const regMemo = new Map(), regPending = new Map();
function regFormLookup(force = false) {
  const inp = $("#cf-plate"), box = $("#cf-reg-status");
  if (!inp || !box) return;
  const key = plateKey(inp.value);
  if (!plateOk(key)) {
    if (force) { box.dataset.plate = ""; box.innerHTML = `<div class="reg-fail"><p>Skriv ett registreringsnummer, till exempel ABC 123.</p></div>`; }
    else { box.dataset.plate = ""; box.innerHTML = `<small>Skriv registreringsnumret och tryck på Hämta, så fylls bilens uppgifter i.</small>`; }
    return;
  }
  if (!force && box.dataset.plate === key) return;
  // En hämtning per bil. Har man skrivit fel registreringsnummer går det att hämta igen med det rätta.
  if (box.dataset.fetched && box.dataset.fetched === key) { box.innerHTML = `<div class="reg-fail"><p>${esc(`Uppgifterna för ${fmtPlate(key)} är redan hämtade.`)}</p></div>`; return; }
  regLookup(box, key, regFillForm);
}
// Sökningen görs bara när man trycker på Hämta (eller Enter i fältet), aldrig av sig själv.
document.addEventListener("keydown", (ev) => {
  if (ev.target.id !== "cf-plate" || ev.key !== "Enter" || !$("#cf-reg-status")) return;
  ev.preventDefault();
  regFormLookup(true);
});
function regFillForm(f) {
  const form = $("#cf-plate")?.form, box = $("#cf-reg-status");
  if (!form || !box) return;
  const d = regToCar(f);
  const set = (name, v) => {
    const el = form.elements.namedItem(name);
    if (!el || v == null || v === "") return;
    el.value = String(v);
    el.classList.add("auto-filled");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  ["make", "model", "year", "engine", "color", "vin", "fuel", "bodyStyle", "seats", "co2", "firstReg", "gearbox"].forEach((k) => set(k, d[k]));
  if (d.lastInspection) set("lastInspection", d.lastInspection.slice(0, 7));
  form.elements.namedItem("regJson").value = JSON.stringify(f);
  updateInspectionEstimate();
  const name = [d.make, d.model].filter(Boolean).join(" ") || "bilen";
  box.innerHTML = `<div class="reg-ok" role="status">${icon("check", 18)}<span>${esc(`Hittade ${name}${d.year ? ` (${d.year})` : ""}. Kolla att det stämmer och spara.`)}</span></div>`;
}
// Uppgifterna från det dolda fältet, för att spara på bilen.
function regFromForm(form) {
  try { const f = JSON.parse(form.elements.namedItem("regJson")?.value || "null"); return Array.isArray(f) && f.length ? { f: f.slice(0, 150), at: Date.now(), plate: plateKey(form.elements.namedItem("plate")?.value || "") } : null; } catch { return null; }
}
// Registreringsnumret som uppgifterna hämtades för (äldre bilar: det nuvarande).
const regFetchedPlate = (c) => (c?.reg?.f?.length ? c.reg.plate || plateKey(c.plate || "") : "");
const regCanFetch = (c) => plateOk(c.plate) && regFetchedPlate(c) !== plateKey(c.plate);
// Bilen: uppgifterna från registret, och hämta dem (igen) för en bil som redan finns.
function regCard(c) {
  if (!c.reg?.f?.length) {
    if (!plateOk(c.plate)) return "";
    return `<div class="card"><h2>Från registret</h2>
      <p class="muted">${esc(`Hämta bilens uppgifter från registreringsnumret ${fmtPlate(c.plate)}.`)}</p>
      <div id="reg-box-${esc(c.id)}"></div>
      <div class="ask"><button class="btn-soft" type="button" data-act="reg-refresh">${icon("search", 16)} Hämta uppgifterna</button></div></div>`;
  }
  return `<div class="card"><h2>Från registret${regCanFetch(c) ? ` <button class="link" type="button" data-act="reg-refresh">Hämta igen</button>` : ""}</h2>
    <div id="reg-box-${esc(c.id)}"></div>
    <details class="more"><summary>${esc(`Visa alla uppgifter (${c.reg.f.length})`)}</summary>
      <dl class="detail-list">${c.reg.f.map((x) => `<div><dt data-notr>${esc(x.k)}</dt><dd data-notr>${esc(x.v)}</dd></div>`).join("")}</dl></details>
    <p class="hint" style="margin-top:8px">${esc(`Hämtat ${fmtDate(ymd(new Date(c.reg.at || Date.now())))}.`)}</p></div>`;
}
async function regRefresh(c) {
  const box = $(`#reg-box-${c.id}`);
  if (!box) return;
  if (!regCanFetch(c)) { box.innerHTML = `<div class="reg-fail"><p>Uppgifterna är redan hämtade för den här bilen.</p></div>`; return; }
  await regLookup(box, c.plate, async (f) => {
    const d = regToCar(f);
    // Det man själv har skrivit står kvar. Besiktningen tas från registret.
    const upd = { reg: { f: f.slice(0, 150), at: Date.now(), plate: plateKey(c.plate) } };
    if (d.besiktning && !c.besiktning) upd.besiktning = d.besiktning;
    for (const k of ["vin", "color", "year", "engine", "fuel", "gearbox", "towMax", "totalWeight", "trainWeight", "skattBelopp", "bodyStyle", "seats", "firstReg", "co2"]) if (d[k] != null && (c[k] == null || c[k] === "")) upd[k] = d[k];
    try { await updateDoc(ref("cars", c.id), upd); Object.assign(c, upd); showToast("Uppgifterna är hämtade"); render(); } catch (e) { onWriteError(e); }
  });
}

function renderCarSetup() {
  setScreen("car-setup", `
    <header class="top"><div class="hello"><small>Ett sista steg</small><h1>Lägg till er bil</h1></div></header>
    <form class="card form" data-form="car-new" data-keep>
      ${carFormFields({}, { sections: ["basic"], isNew: true })}
      <button class="btn primary block" type="submit">Spara bilen</button>
      <p class="hint">Försäkring, skatt och däck lägger du till under Bilen efteråt.</p>
    </form>
    ${trashCard()}
    ${inviteCard()}
    <button class="link" type="button" data-act="logout" style="align-self:center;margin:6px auto 20px;display:block">Logga ut (${esc(S.user?.email || "")})</button>`, { keepForm: true });
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
// Färgen på bränslet: röd när tanken är tom, gul vid halv tank och grön när den är full, steglöst däremellan.
function fuelColor(p) {
  const stops = [[0, 9, 66, 47], [50, 38, 68, 46], [100, 138, 38, 39]];
  const [a, b] = p <= 50 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const t = (Math.max(0, Math.min(100, p)) - a[0]) / (b[0] - a[0]);
  const mix = (i) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `hsl(${mix(1)} ${mix(2)}% ${mix(3)}%)`;
}
// Bränsleruta: en liggande stapel med procenten i, att dra i från tom till full.
function fuelBarInner(p) {
  const v = Math.round(p ?? 0);
  // Stapeln är alltid minst en rund prick med pumpen i, så att även nästan tom tank syns.
  const w = `calc(34px + (100% - 34px) * ${v / 100})`;
  const inside = p != null && v >= 45;
  return `<i style="width:${p == null ? 0 : w};background:${fuelColor(v)}"></i>
    <span class="fuel-ic">${icon("fuel", 15)}</span>
    <b class="fuel-val${inside ? "" : " out"}"${p != null && !inside ? ` style="left:calc(${w} + 7px)"` : ""} id="fuel-pct">${p == null ? "Dra för att ange" : `${v} %`}</b>
    ${inside && v <= 62 ? "<em>Full</em>" : ""}`;
}
function fuelGauge(c) {
  const f = c.fuelLevel;
  const draft = S.fuelDraft && S.fuelDraft.carId === c.id ? S.fuelDraft.pct : null;
  const p = draft ?? fuelPct(f);
  return `<div class="hero-tile fuel-tile">
    <span class="label">Bränsle</span>
    <div class="fuel-e${p == null ? " unset" : ""}" id="fuel-v" role="slider" tabindex="0" aria-label="Bränsle kvar i tanken" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p ?? 0)}" aria-valuetext="${esc(p == null ? "Inte angivet" : pctText(p))}">${fuelBarInner(p)}</div>
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
  // Den sida man är inne på (Aviseringar eller Inställningar) är markerad.
  const on = (v) => (S.view === v ? ` aria-current="page"` : "");
  return `<div class="top-actions">
      ${chatOn() || plusOnSale() ? `<button class="icon-btn ai-btn glenn-btn" type="button" data-act="chat" aria-label="Fråga Glenn">${glennFig(`<img class="glenn-av" src="${glennSrc("base")}" alt="" width="44" height="44">`, false, "gfig-av gfig-btn")}</button>` : ""}
      <button class="icon-btn" type="button" data-go="aviseringar"${on("aviseringar")} aria-label="Aviseringar${n ? `, ${n} nya` : ""}">${icon("bell")}${n ? `<span class="badge">${n > 9 ? "9+" : n}</span>` : ""}</button>
      <button class="icon-btn" type="button" data-go="installningar"${on("installningar")} aria-label="Inställningar">${icon("gear")}</button>
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
    ${topActions()}
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
  if (NATIVE || standalone || pref.get("installDismissed")) return "";
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
      <span class="todo-t">${esc(t.text)}</span>${t.src === "besiktning" ? `<em class="todo-src">Besiktning</em>` : ""}<small>${esc(whoName(t.by))}</small></label>`).join("")}</div>`;
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
// En post kan ha flera bilder (photoIds). Äldre poster har bara photoId.
const photosOf = (e) => (Array.isArray(e?.photoIds) && e.photoIds.length ? e.photoIds : e?.photoId ? [e.photoId] : []);
// Varje bild i loggen för bilen, nyast först: [post, bildens id].
const carPhotoList = (c) => S.entries.filter((e) => e.carId === c.id && photosOf(e).length).sort((a, b) => (b.date || "").localeCompare(a.date || "")).flatMap((e) => photosOf(e).map((pid) => [e, pid]));
// Bilderna visas åtta i taget. Den nionde rutan är en pil till nästa åtta.
const PHOTO_PAGE = 8;
const photoPageOf = (c) => Math.min(S.photoPage || 0, Math.max(0, Math.ceil(carPhotoList(c).length / PHOTO_PAGE) - 1));
function photosCard(c) {
  const ents = carPhotoList(c);
  if (!ents.length) return "";
  const page = photoPageOf(c), pages = Math.ceil(ents.length / PHOTO_PAGE);
  const shown = ents.slice(page * PHOTO_PAGE, page * PHOTO_PAGE + PHOTO_PAGE);
  return `<div class="photos-part">
    <p class="label" style="margin:0 0 8px">Bilder från loggen</p>
    ${S.showPhotos ? `<div class="photo-grid">${shown.map(([e, pid]) => `<button type="button" class="pg" data-act="open-entry" data-id="${esc(e.id)}" aria-label="${esc(entryTitle(e))}, ${esc(fmtDateShort(e.date))}">
        ${gridPhotos.get(pid) ? `<img src="${esc(gridPhotos.get(pid))}" alt="">` : `<span class="pg-wait"></span>`}<span class="pg-d"><b>${esc(photoLabel(e))}</b>${esc(fmtDateShort(e.date))}</span></button>`).join("")}${page < pages - 1 ? `<button type="button" class="pg pg-next" data-act="photo-page" data-d="1" aria-label="Nästa ${PHOTO_PAGE} bilder">${icon("next", 28)}<span>Nästa</span></button>` : ""}</div>
      ${pages > 1 ? `<div class="pg-pages">${page > 0 ? `<button class="link" type="button" data-act="photo-page" data-d="-1">${icon("back", 14)} Föregående</button>` : "<span></span>"}<span class="hint">${esc(`Sida ${page + 1} av ${pages}`)}</span></div>` : ""}
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
  const page = photoPageOf(c);
  const ids = carPhotoList(c).slice(page * PHOTO_PAGE, page * PHOTO_PAGE + PHOTO_PAGE).map(([, pid]) => pid).filter((id) => !gridPhotos.has(id));
  await Promise.all(ids.map((id) => getDoc(ref("photos", id)).then((snap) => { if (snap.exists()) gridPhotos.set(id, snap.data().data); }).catch(() => {})));
  render();
}

// Servicebok och dokument i ett kort: serviceboken (PDF, dela med en köpare, säljpaket), sparade dokument
// och bilderna från loggen.
function docsCard(c) {
  const docs = [...(c.docs || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const photos = photosCard(c);
  const n = carEntries().filter((e) => ["service", "eget", "dack"].includes(e.type) || (e.type === "kostnad" && e.category === "Besiktning")).length;
  const row = (act, ic, t, sub, extra = "") => `<button class="dl as-btn" type="button" ${act}><span class="dl-ic">${icon(ic, 20)}</span><span><span class="dl-t">${t}</span><span class="dl-s">${esc(sub)}</span></span>${extra || '<span class="dl-v">›</span>'}</button>`;
  return `<div class="card book-card">
    <h2>Servicebok och dokument</h2>
    <div class="rows">
      ${row('data-act="print-book"', "print", "Servicebok", `${n === 1 ? "1 post" : `${n} poster`} · dela eller spara som PDF`)}
      ${c.shareToken
        ? row('data-act="share-menu"', "next", "Delad med en köpare", "Länken är aktiv · tryck för att kopiera, uppdatera eller sluta dela", '<span class="pill ok">Delad</span>')
        : row('data-act="share-book"', "next", "Dela med en köpare", "En länk där köparen kan läsa serviceboken")}
      ${plusFeat() ? row('data-act="sale-pack"', "receipt", "Säljpaket", "Serviceboken med kvitton och kostnader, som PDF")
        : plusLock() ? row('data-act="plus" data-f="salepack"', "receipt", "Säljpaket", "Serviceboken med kvitton och kostnader, som PDF", '<span class="plus-badge">Plus</span>') : ""}
    </div>
    <p class="label" style="margin:16px 0 4px">Dokument</p>
    ${docs.length ? `<div class="rows">${docs.map((d) => `<button class="dl as-btn" type="button" data-act="open-doc" data-id="${esc(d.id)}"><span class="dl-ic">${icon("doc", 20)}</span>
      <span><span class="dl-t">${esc(d.title)}</span><span class="dl-s">${esc(d.validTo ? `Gäller till ${fmtDateShort(d.validTo)}` : `Sparat ${fmtDateShort(d.date)} av ${whoName(d.by).replace(/^Du$/, "dig")}`)}</span></span>${docPill(d)}</button>`).join("")}</div>`
      : `<p class="muted" style="margin:0">Försäkringsbrev, registreringsbevis, garantier och kvitton ni vill spara. Med ett utgångsdatum får ni en påminnelse.</p>`}
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
      ${field("Vad är det?", `<input name="title" id="doc-title" required autocomplete="off" value="${esc(d?.title || "")}">`)}
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
function serviceBookData(c, { share = false } = {}) {
  const ents = carEntries().filter((e) => ["service", "eget", "dack"].includes(e.type) || (e.type === "kostnad" && e.category === "Besiktning"))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const what = (e) => {
    if (e.type === "kostnad") return [e.recheck ? "Efterkontroll" : "Besiktning", e.result ? INSP_RESULTS[e.result] : "", e.defects?.length ? `Brister: ${e.defects.join(", ")}` : ""].filter(Boolean).join(" · ");
    if (e.type === "dack") return [TIRE_ACTIONS[e.tireAction] || "Däck", e.tireBrand, e.tireSize, e.depth != null ? `${fmt(e.depth, 1)} mm` : ""].filter(Boolean).join(" · ");
    const w = workOf(e, c).map(workText).join(", ");
    return [e.type === "eget" ? e.title || "Eget jobb" : "Service", w].filter(Boolean).join(": ");
  };
  const st = allItemStatus(c).filter((x) => !x.unknown || x.lastDate);
  return {
    car: carName(c), plate: c.plate ? String(c.plate).toUpperCase() : "", made: todayStr(),
    facts: [["Registreringsnummer", c.plate ? String(c.plate).toUpperCase() : ""], ["Chassinummer", c.vin && (!share || c.vinShare) ? c.vin : ""], ["Årsmodell", c.year ? String(c.year) : ""], ["Motor", c.engine], ["Drivmedel", c.fuel], ["Färg", c.color], ["Mätarställning", odoOf(c) != null ? `${fmt(odoOf(c))} mil` : ""], ["Sista dag för besiktning", c.besiktning ? fmtDate(c.besiktning) : ""]].filter(([, v]) => v),
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
  await setDoc(doc(db, "shares", token), { householdId: S.hid, carId: c.id, createdBy: uid(), updatedAt: Date.now(), data: serviceBookToStore(serviceBookData(c, { share: true })) });
  if (!c.shareToken) { c.shareToken = token; await updateDoc(ref("cars", c.id), { shareToken: token }); }
  render();
  return token;
}
const shareUrl = (token) => `${location.origin}${location.pathname}?visa=${token}`;
function shareMenu() {
  const c = car();
  if (!c?.shareToken) return;
  openSheet("Delad med en köpare", `<p class="muted">Den som har länken kan läsa serviceboken, men inte se resten av appen eller ändra något. Tryck Uppdatera efter nya poster.</p>
    <p class="share-url" style="margin:12px 0">${esc(shareUrl(c.shareToken).replace(/^https?:\/\//, ""))}</p>
    <div class="form">
      <button class="btn primary block" type="button" data-act="share-copy">Kopiera länken</button>
      <button class="btn block" type="button" data-act="share-book">Uppdatera serviceboken</button>
      <button class="btn block solid-danger" type="button" data-act="share-stop">Sluta dela</button>
    </div>`);
}
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
function serviceBookPdf(d0, extra = null) {
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
  if (extra?.costs?.length) {
    pdf.addPage();
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(16); pdf.text(t("Kostnader"), 14, 20);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(110); pdf.text(t(`Allt som är loggat sedan ${fmtDate(extra.costFrom)}, per kategori.`), 14, 26); pdf.setTextColor(0);
    pdf.autoTable({ ...base, startY: 30, head: [["Kategori", "Senaste 12 månaderna", "Totalt"].map(t)], body: extra.costs.map((r) => r.map(t)), columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } } });
  }
  if (extra?.receipts?.length) {
    const H = pdf.internal.pageSize.getHeight();
    const boxW = W - 28, boxH = (H - 50) / 2 - 10;
    extra.receipts.forEach((r, i) => {
      if (i % 2 === 0) { pdf.addPage(); pdf.setFont("helvetica", "bold"); pdf.setFontSize(16); pdf.text(t(i === 0 ? "Kvitton och bilder" : "Kvitton och bilder (forts.)"), 14, 20); }
      const top = 28 + (i % 2) * (boxH + 14);
      const [w, h] = r.wh, k = Math.min(boxW / w, boxH / h);
      const iw = w * k, ih = h * k;
      try { pdf.addImage(r.src, /^data:image\/png/.test(r.src) ? "PNG" : "JPEG", 14 + (boxW - iw) / 2, top, iw, ih, undefined, "FAST"); } catch {}
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(80); pdf.text(t(r.caption), 14, top + ih + 5); pdf.setTextColor(0);
    });
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
// Säljpaket (Plus): serviceboken med en sammanställning av kostnaderna och bilderna från posterna, som PDF.
async function salePack(btn) {
  const c = car();
  if (!c) return;
  if (btn) btn.disabled = true;
  showToast("Gör i ordning säljpaketet …", 8000);
  try {
    await loadPdfLibs();
    const d = serviceBookData(c);
    const ents = carEntries().filter((e) => ["service", "eget", "dack"].includes(e.type) || (e.type === "kostnad" && e.category === "Besiktning"))
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const pics = [];
    for (const e of ents) for (const pid of photosOf(e)) if (pics.length < 60) pics.push({ e, pid });
    await Promise.all(pics.map(async (x) => { try { const sn = await getDoc(ref("photos", x.pid)); x.src = sn.exists() ? sn.data().data : null; } catch { x.src = null; } }));
    const size = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res(null); im.src = src; });
    for (const x of pics) if (x.src) x.wh = await size(x.src);
    // Kostnaderna per kategori: hela tiden och de senaste tolv månaderna.
    const paid = carEntries().filter((e) => e.amount > 0 && e.date);
    const since = ymd(addMonths(today0(), -12));
    const byCat = {};
    for (const e of paid) { const k = catOf(e); byCat[k] = byCat[k] || [0, 0]; byCat[k][0] += e.amount; if (e.date >= since) byCat[k][1] += e.amount; }
    const costs = Object.entries(byCat).sort((a, b) => b[1][0] - a[1][0]).map(([k, [all, y]]) => [k, `${fmtKr(y)} kr`, `${fmtKr(all)} kr`]);
    const first = paid.reduce((m, e) => (e.date < m ? e.date : m), todayStr());
    const blob = serviceBookPdf(d, { costs, costFrom: first, receipts: pics.filter((x) => x.src && x.wh).map((x) => ({ src: x.src, wh: x.wh, caption: `${fmtDate(x.e.date)} · ${entryTitle(x.e)}${x.e.amount ? ` · ${fmtKr(x.e.amount)} kr` : ""}` })) });
    pendingPdf = { blob, name: pdfName(d).replace(/\.pdf$/, " - säljpaket.pdf") };
    openSheet("Säljpaketet är klart", `<p class="muted">${esc(`Serviceboken, kostnaderna och ${pics.filter((x) => x.src).length === 1 ? "1 bild" : `${pics.filter((x) => x.src).length} bilder`} från posterna. Välj Spara i Filer, Skriv ut eller skicka den direkt.`)}</p>
      <button class="btn primary block" type="button" data-act="pdf-share" style="margin-top:14px">${icon("print", 18)} Dela eller spara PDF</button>`);
  } catch (e) { reportError(e, "sale-pack"); showToast("Säljpaketet gick inte att göra just nu."); }
  if (btn) btn.disabled = false;
}

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
// Med Plus läses kvittot, servicefakturan eller besiktningsprotokollet av med AI (Cloud Function lasDokument).
const aiOn = () => hasPlus() || (isAdmin() && !testMode());
function receiptButton() {
  return `<label class="btn ghost block receipt-btn" id="receipt-btn">${icon(aiOn() ? "spark" : "camera", 18)} <span id="receipt-label">${aiOn() ? "Läs av med AI" : "Läs av ett kvitto"}</span>
    <input type="file" id="ef-scan" accept="image/*" class="vh"></label>${!aiOn() && plusOnSale() ? `<p class="hint plus-hint" style="margin-top:6px">Med Plus fyller AI i allt från kvittot. <button class="link" type="button" data-act="plus" data-f="ai">Läs mer</button></p>` : ""}`;
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
  if (aiOn()) return aiReadDocument(file).finally(() => btn?.classList.remove("busy"));
  label.textContent = "Läser kvittot …";
  try {
    const text = await readReceiptText(file, (p) => { if ($("#receipt-label")) $("#receipt-label").textContent = `Läser kvittot … ${Math.round(p * 100)} %`; });
    const r = parseReceipt(text);
    const filled = [];
    const set = (id, v) => { const x = document.getElementById(id); if (x && v != null && v !== "") { x.value = v; x.classList.add("from-receipt"); x.dispatchEvent(new Event("input", { bubbles: true })); return true; } return false; };
    if (r.amount != null && set("ef-amount", fmtKr(r.amount).replace(/\s/g, " "))) filled.push(`${fmtKr(r.amount)} kr`);
    if (r.date && r.date <= todayStr() && set("ef-date", r.date)) filled.push(fmtDateShort(r.date));
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

// Skickar fotot till servern, som låter Claude läsa det, och fyller i formuläret med svaret.
async function aiReadDocument(file) {
  const label = () => $("#receipt-label");
  const form = $('form[data-form="entry"]');
  if (!form) return;
  const type = form.dataset.type;
  const cat = $("#ef-category")?.value || "";
  if (label()) label().textContent = "AI läser dokumentet …";
  let res;
  try {
    const data = await compressImage(file);
    if (!data) throw new Error("bild");
    const payload = { hid: S.hid, image: data.split(",")[1], mediaType: "image/jpeg", formType: cat === "Besiktning" ? "besiktning" : TYPE[type]?.label || type };
    if (window.__aiMock) res = await window.__aiMock(payload);
    else {
      const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js");
      res = (await httpsCallable(getFunctions(fb, "europe-west1"), "lasDokument", { timeout: 120000 })(payload)).data;
    }
  } catch (e) {
    console.warn("AI-läsningen misslyckades", e);
    const code = String(e?.code || e?.message || "").replace(/^functions\//, "");
    const msg = /resource-exhausted|permission-denied|failed-precondition|unavailable/.test(code) ? e.message : !navigator.onLine ? "Läsningen med AI behöver nät."
      : `Dokumentet gick inte att läsa (${code || "okänt fel"}). Fyll i själv.`;
    if (label()) label().textContent = msg;
    return;
  }
  if (!document.contains(form)) return;
  const d = res?.doc || {};
  const filled = [];
  const set = (id, v) => { const x = document.getElementById(id); if (!x || v == null || v === "") return false; x.value = v; x.classList.add("from-receipt"); x.dispatchEvent(new Event("input", { bubbles: true })); x.dispatchEvent(new Event("change", { bubbles: true })); return true; };
  if (d.amount != null && set("ef-amount", String(d.amount).replace(".", ","))) filled.push(`${fmtKr(d.amount)} kr`);
  if (d.date && d.date <= todayStr() && set("ef-date", d.date)) filled.push(fmtDateShort(d.date));
  if (d.odometerMil != null && set("ef-odometer", String(Math.round(d.odometerMil)))) filled.push(`${fmt(d.odometerMil)} mil`);
  if (d.place) {
    const id = ["ef-workshop", "ef-station", "ef-place"].find((x) => document.getElementById(x));
    if (id && set(id, d.place)) filled.push(d.place);
  }
  // Det som gjordes: kopplas till bilens underhållspunkter när namnet stämmer, annars läggs det till som en egen del.
  if (Array.isArray(d.work) && d.work.length && $("#work-rows")) {
    const items = car()?.items || [];
    for (const w of d.work.slice(0, 12)) {
      const n = normWord(w.name);
      const item = items.find((i) => { const m = normWord(i.name); return m === n || m.includes(n) || n.includes(m); });
      ACTIONS["w-add"]({ dataset: { item: item?.id || "", name: item?.name || w.name } });
      const key = item ? `item:${item.id}` : normWord(w.name);
      const sel = $(`#work-rows .work-row[data-key="${CSS.escape(key)}"] .w-action`);
      if (sel && w.action && WORK_ACTIONS[w.action]) sel.value = w.action;
    }
    filled.push(`${d.work.length} ${d.work.length === 1 ? "åtgärd" : "åtgärder"}`);
  }
  if (d.inspectionResult && document.querySelector(`input[name="result"][value="${d.inspectionResult}"]`)) {
    document.querySelector(`input[name="result"][value="${d.inspectionResult}"]`).click();
    filled.push(INSP_RESULTS[d.inspectionResult]);
  }
  if (Array.isArray(d.defects) && d.defects.length && set("ef-defects", d.defects.join("\n"))) filled.push(`${d.defects.length} ${d.defects.length === 1 ? "brist" : "brister"}`);
  set("ef-recheckBy", d.recheckBy);
  set("ef-nextBesiktning", d.nextInspection);
  if (d.note && !$("#ef-note")?.value.trim() && set("ef-note", d.note)) document.querySelector("#sheet details.more")?.setAttribute("open", "");
  if (label()) label().textContent = filled.length ? `Ifyllt med AI: ${filled.join(", ")}` : "Hittade inget att fylla i. Fyll i själv.";
  if (filled.length) showToast("Kontrollera det som fylldes i innan du sparar.");
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
  // Avsluta i Dynamic Island eller på låsskärmen: formuläret för att avsluta den pågående resan.
  // Resorna kan komma lite efter resten, så appen väntar upp till fem sekunder på dem.
  if (a === "avsluta-resa") {
    let tries = 0;
    const go = () => {
      const o = tripsOn() && openTrip();
      if (o) { if (S.view !== "resor" && tripsVisible()) setView("resor"); return tripForm(o, "end"); }
      if (++tries < 10) return setTimeout(go, 500);
      showToast("Ingen resa pågår just nu.");
    };
    return setTimeout(go, 0);
  }
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
    <details class="more" style="margin-top:10px"><summary>Visa genvägarna</summary>
    <div class="rows" style="margin-top:8px">${SHORTCUTS.map(([k, l]) => `<div class="dl"><span class="dl-ic">${icon(k === "bokning" ? "calendar" : k === "meny" ? "plus" : TYPE[k].icon, 20)}</span>
      <span><span class="dl-t">${esc(l)}</span><span class="dl-s">${esc(shortcutUrl(k).replace(/^https?:\/\//, ""))}</span></span>
      <button class="link" type="button" data-act="copy-shortcut" data-id="${k}">Kopiera</button></div>`).join("")}</div>
    <details class="more" style="margin-top:12px"><summary>Så gör du på iPhone</summary>
      <ol class="steps"><li>Kopiera länken du vill ha.</li><li>Öppna appen <b>Genvägar</b> och tryck på plus.</li><li>Lägg till åtgärden <b>Öppna URL:er</b> och klistra in länken.</li><li>Tryck på dela-knappen och välj <b>Lägg till på hemskärmen</b>.</li></ol>
      <p class="hint">Länken öppnas i Safari. Första gången behöver du logga in där också, sedan kommer Safari ihåg dig.</p>
    </details>
    </details>
  </div>`;
}

function viewOverview() {
  const c = car();
  const parts = [headerMain(), carChips(c)];
  if (isGarage()) parts.push(garageSign());
  // Utan Plus fungerar en bil. Har ägaren inte valt vilken än, får ägaren välja här.
  if (activeCarId() && !S.house?.activeCar && !pref.get("activeCarTip." + S.hid)) parts.push(`<article class="card locked-tip">
    <h2>${icon("lock", 18)} En bil fungerar utan Plus</h2>
    <p class="muted">${esc(`Ni har ${S.cars.length} bilar, och utan Plus fungerar en i taget. Just nu är det ${carName(S.cars.find((x) => x.id === activeCarId()))}. De andra är låsta, men allt på dem finns kvar.`)}</p>
    ${isOwner() ? `<p class="muted" style="margin-top:6px">Vill du hellre använda en annan bil? Välj den här. Sedan kan du byta en gång var 30:e dag.</p>
      <div class="ask">${S.cars.filter((x) => x.id !== activeCarId()).map((x) => `<button class="btn-soft" type="button" data-act="set-active-car" data-id="${esc(x.id)}">${icon("car", 16)} ${esc(carName(x))}</button>`).join("")}</div>`
      : `<p class="hint">${esc(`Det är hushållets ägare, ${memberName(ownerUid())}, som väljer vilken bil som fungerar.`)}</p>`}
    <div class="ask"><button class="btn-soft" type="button" data-act="plus">${icon("spark", 16)} Skaffa Plus</button><button class="hh-ghost" type="button" data-act="active-car-tip">Okej</button></div>
  </article>`);


  // Bilkortet: namn och regnummer, bilden, och under den två rutor: mätarställning och bränsle.
  parts.push(`<article class="card hero">
    <div class="hero-car">
      <div class="hero-name">${c.plate ? `<span class="plate">${esc(c.plate)}</span>` : ""}<b>${esc(carName(c))}</b></div>
      <div class="sub">${esc([c.year, c.fuel].filter(Boolean).join(" · "))}</div>
    </div>
    <label class="car-pick" title="Byt bild på bilen">
      ${carVisual(c)}
      <span class="cam${c.photoId ? "" : " cam-txt"}" aria-hidden="true">${icon("camera", 19)}${c.photoId ? "" : "<span>Lägg till foto</span>"}</span>
      <input type="file" accept="image/*" id="hero-photo" class="vh" aria-label="${c.photoId ? "Byt bild på bilen" : "Lägg till ett foto på er bil"}">
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
  parts.push(plusTipCard());

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
        <span class="dl-ic">${icon(partIcon(x.item.name, x.item.id), 20)}</span>
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
      <div class="stat"><div class="label">Snitt per månad</div><div class="n">${(() => { const y = yearAverage(carEntries().filter((e) => e.amount > 0 && e.date), new Date().getFullYear()); return y.total ? fmt(Math.round(y.avg)) : "–"; })()} <small>kr</small></div></div>
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
  bilen: { get names() { return { upp: "Uppgifter", maint: "Underhåll", dack: "Däck", media: "Servicebok och dokument", slap: "Släpvagn" }; }, pref: "cards.bilen", title: "Bilen" },
  ekonomi: { names: { month: "Kostnad per månad", year: "Hela året", compare: "Prognos och jämförelse", rec: "Återkommande kostnader", tank: "Tankningar", facts: "Bilåret i siffror" }, pref: "cards.ekonomi", title: "Ekonomi" },
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
const ARRANGE_VIEWS = { oversikt: "view-oversikt", bilen: "view-bilen", ekonomi: "view-ekonomi" };
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
    <h2>Anpassa sidorna</h2>
    <div class="seg" role="group" aria-label="Sida" style="margin-bottom:12px">
      ${Object.entries(CARD_VIEWS).map(([k, x]) => `<button type="button" data-act="cards-view" data-v="${k}" aria-pressed="${k === view}">${esc(x.title)}</button>`).join("")}
    </div>
    <p class="muted">Välj vilka kort som syns. Håll i handtaget och dra för att ändra ordningen.${view === "oversikt" ? " Du kan också hålla fingret på ett kort direkt på sidan." : ""} Gäller den här telefonen.</p>
    <div class="card-order" data-view="${view}">${order.map((k) => `<div class="card-row" data-key="${k}">
      <label class="check"><input type="checkbox" data-act="card-toggle" data-view="${view}" data-id="${k}"${hidden.includes(k) ? "" : " checked"}> ${esc(v.names[k])}</label>
      <button class="drag-handle" type="button" data-id="${k}" aria-label="Flytta ${esc(v.names[k])}. Dra, eller använd piltangenterna.">${icon("grip", 20)}</button>
    </div>`).join("")}</div>
  </div>`;
}

// "Uppdaterad för 3 veckor sedan" under mätarställningen. Orange efter en månad.
// Påminnelse när mätarställningen inte har uppdaterats på en månad, så att underhållet räknas rätt.
// Senaste mätarställningen som är avläst (inte beräknad från GPS-resor).
function realOdoEntry(carId) {
  const saved = S.trips;
  S.trips = saved.filter((t) => !t.odoEstimated);
  try { return latestOdoEntry(carId); } finally { S.trips = saved; }
}
function odoReminder(c) {
  // Med automatisk körjournal räknas mätaren fram från GPS-sträckorna. En gång i månaden: läs av den riktiga.
  const est = S.trips.filter((t) => t.carId === c.id && t.odoEstimated && t.odoEnd != null);
  const real = est.length ? realOdoEntry(c.id) : null;
  if (est.length && real?.date && -daysUntil(parseDate(real.date)) >= 30) {
    const since = est.filter((t) => (t.date || "") >= real.date);
    if (since.length) return [{ icon: "gauge", title: "Läs av mätaren", sub: `GPS-resorna har räknat fram ${fmt(since.reduce((a, t) => a + (tripMil(t) || 0), 0), 1)} mil sedan ${fmtDateShort(real.date)}. Med en riktig mätarställning stämmer körjournalen.`, level: "soon", label: "Läs av", act: "new-entry", type: "matare", always: true, days: 0 }];
  }
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
  return `${kollListHtml([...shown, ...(all ? later : [])])}
    ${later.length ? `<button class="link" type="button" data-act="toggle-koll" style="margin-top:10px">${all ? "Visa färre" : `Visa ${later.length} till`}</button>` : ""}`;
}
// Listan i På gång, Påminnelser och Kommande i loggen: sorterad efter när, med en liten rubrik för varje tidpunkt
// ("I morgon", "Om 33 dagar") och en datumbricka till vänster.
function kollListHtml(items) {
  const list = items.map((x, i) => ({ x, i })).sort((a, b) => (a.x.days ?? 0) - (b.x.days ?? 0) || a.i - b.i).map(({ x }) => x);
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
  return `<div class="koll">${html}</div>`;
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
      // Det andra har gjort sedan du var inne senast får etiketten Ny (samma som klockan räknar).
      const isNew = !mine && x.ts > lastSeenMs();
      return `<button class="dl as-btn" type="button" data-act="${x.act}" data-id="${esc(x.id)}">
        <span class="avatar${mine ? " me" : ""}">${esc((mine ? myName() : memberName(x.who)).slice(0, 1).toUpperCase())}</span>
        <span><span class="dl-t">${esc(x.text)}</span><span class="dl-s">${esc(timeAgo(x.ts) || fmtDateShort(x.date))}</span></span>
        <span>${isNew ? `<span class="new-pill">Ny</span>` : ""}</span></button>`;
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
  // Samma utseende som i På gång: datumbricka, rubrik efter när och knappar för vägbeskrivning och samtal.
  const ids = new Set(list.map((b) => b.id));
  const rows = bookingRows(c).filter((r) => ids.has(r.id)).map((r) => {
    const hot = r.level === "urgent";
    const b = (c.bookings || []).find((x) => x.id === r.id);
    return `<button class="entry log-row" type="button" data-act="open-booking" data-id="${esc(r.id)}">
      ${logTile(b?.date, hot)}
      <span class="dl-ic${hot ? " hot" : ""}">${icon("calendar", 20)}</span>
      <span><span class="t">${esc(r.kollTitle)}</span><span class="d"><b class="${hot ? "hot-t" : ""}">${esc(r.group)}</b>${r.kollSub ? ` · ${esc(r.kollSub)}` : ""}</span></span>
      <span class="amt chev">›</span>
    </button>`;
  }).join("");
  return { n: list.length, html: `<div class="month">Kommande</div><div class="card">${rows}</div>` };
}

// Ikonen för en post: samma som i plusmenyn och i Ekonomi.
function entryIcon(e) {
  if (e.type === "kostnad") return CAT_ICON[catOf(e)] || "receipt";
  return TYPE[e.type]?.icon || "list";
}
// En rad i loggen: datumbricka (som i På gång), ikonen för typen, rubrik och detaljer, belopp till höger.
function logTile(dateStr, urgent = false) {
  const dt = parseDate(dateStr);
  // Året visas när posten inte är från i år.
  const year = dt && dt.getFullYear() !== new Date().getFullYear() ? `<small class="kt-y">${dt.getFullYear()}</small>` : "";
  return dt ? `<span class="koll-tile${urgent ? " hot" : ""}${year ? " has-year" : ""}"><b>${dt.getDate()}</b><small>${esc(MONTHS_SHORT[dt.getMonth()])}</small>${year}</span>` : `<span class="koll-tile"></span>`;
}
function entryRow(e, fromCat = null) {
  const mine = e.createdBy === uid();
  const d = entryDetail(e);
  // Namnet syns bara när någon annan har loggat.
  const extra = [e.odometer != null && e.type !== "matare" ? `${fmt(e.odometer)} mil` : "", photosOf(e).length > 1 ? `${photosOf(e).length} bilder` : photosOf(e).length ? "bild" : ""].filter(Boolean).join(" · ");
  const sub = [d, extra].filter(Boolean).join(" · ");
  return `<button class="entry log-row" type="button" data-act="open-entry" data-id="${esc(e.id)}"${fromCat ? ` data-cat="${esc(fromCat)}"` : ""}>
    ${logTile(e.date)}
    <span class="dl-ic">${icon(entryIcon(e), 20)}</span>
    <span><span class="t">${esc(entryTitle(e))}</span>${sub || !mine ? `<span class="d">${mine ? "" : `<span class="who">${esc(whoName(e.createdBy))}</span> `}${esc(sub)}</span>` : ""}</span>
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
  // Månadens summa till höger om månadsrubriken.
  const monthSum = (g) => g.items.reduce((a, e) => a + (e.amount > 0 ? e.amount : 0), 0);
  return count + upcoming + groups.map((g) => `<div class="month log-month">${esc(monthLabel(g.key))}${monthSum(g) ? `<span>${fmtKr(monthSum(g))} kr</span>` : ""}</div><div class="card">${g.items.map((e) => entryRow(e)).join("")}</div>`).join("");
}

function viewLog() {
  const filters = [["alla", "Alla"], ...LOG_ORDER.map((k) => [k, typeLabel(k)])];
  return `${subHeader("Allt som hänt med bilen", "Logg")}
    <label class="search">${icon("search", 18)}
      <input type="search" id="log-search" placeholder="Sök" value="${esc(S.query || "")}" autocomplete="off" enterkeyhint="search" aria-label="Sök i loggen">
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

// Prognos för året och år mot år (Plus).
function compareCard(paid) {
  if (!plusFeat()) {
    if (!plusLock()) return "";
    return `<div class="card"><h2>Prognos och jämförelse <span class="plus-badge">Plus</span></h2>
      <p class="muted">Se vad bilen beräknas kosta i år, och jämför år mot år och kategori för kategori.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="plus" data-f="econ">${icon("spark", 16)} Ingår i Plus</button></div></div>`;
  }
  if (!paid.length) return "";
  const now = new Date(), y = now.getFullYear(), today = todayStr();
  const sumY = (yy, until = `${yy}-12-31`) => paid.filter((e) => e.date.startsWith(`${yy}-`) && e.date <= until).reduce((a, e) => a + e.amount, 0);
  const firstYear = Number(paid.reduce((m, e) => (e.date < m ? e.date : m), today).slice(0, 4));
  const years = [y - 3, y - 2, y - 1, y].filter((yy) => yy >= firstYear);
  const soFar = sumY(y);
  // Snittet per månad de senaste tolv månaderna (eller kortare om loggen är yngre), gånger det som är kvar av året.
  const since = addMonths(today0(), -12);
  const last12 = paid.filter((e) => parseDate(e.date) >= since);
  const firstD = paid.reduce((m, e) => (e.date < m ? e.date : m), today);
  const span = Math.max(1, Math.min(12, (now - parseDate(firstD)) / (30.44 * 864e5)));
  const avg = last12.reduce((a, e) => a + e.amount, 0) / span;
  const left = (new Date(y, 11, 31) - today0()) / (30.44 * 864e5);
  const forecast = span >= 2 ? Math.round((soFar + avg * left) / 100) * 100 : null;
  const max = Math.max(1, ...years.map((yy) => (yy === y && forecast ? Math.max(forecast, soFar) : sumY(yy))));
  // Kategorier: i år mot samma tid förra året.
  const cut = `${y - 1}-${today.slice(5)}`;
  const cats = {};
  for (const e of paid) {
    const k = catOf(e);
    if (e.date.startsWith(`${y}-`)) (cats[k] = cats[k] || [0, 0])[0] += e.amount;
    else if (e.date.startsWith(`${y - 1}-`) && e.date <= cut) (cats[k] = cats[k] || [0, 0])[1] += e.amount;
  }
  const catRows = Object.entries(cats).sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1])).slice(0, 6);
  return `<div class="card cmp">
    <h2>Prognos och jämförelse</h2>
    ${forecast ? `<div class="eco"><div class="stat"><div class="label">Hittills ${y}</div><div class="n">${fmtKr(soFar)} <small>kr</small></div></div>
      <div class="stat"><div class="label">Beräknat för hela ${y}</div><div class="n">${fmtKr(forecast)} <small>kr</small></div></div></div>
      <p class="hint" style="margin:6px 0 12px">${esc(`Räknat på ett snitt på ${fmtKr(Math.round(avg))} kr i månaden det senaste året.`)}</p>` : `<p class="muted">Prognosen visas när ni har loggat kostnader i minst två månader.</p>`}
    <div class="cmp-years">${years.map((yy) => {
      const v = sumY(yy);
      const f = yy === y && forecast ? forecast : null;
      return `<div class="cmp-row"><span class="cmp-y">${yy}</span><span class="cmp-bar">${f ? `<i class="fc" style="width:${Math.round((f / max) * 100)}%"></i>` : ""}<i style="width:${Math.round((v / max) * 100)}%"></i></span><span class="cmp-v">${fmtKr(v)} kr${f ? `<small>${esc(`ca ${fmtKr(f)}`)}</small>` : ""}</span></div>`;
    }).join("")}</div>
    ${catRows.length && years.includes(y - 1) ? `<p class="label" style="margin:16px 0 6px">${esc(`I år mot samma tid ${y - 1}`)}</p>
      <div class="rows">${catRows.map(([k, [a, b]]) => `<div class="dl"><div class="dl-ic">${icon("coin", 18)}</div><div><div class="dl-t">${esc(k)}</div><div class="dl-s">${esc(`${fmtKr(a)} kr i år · ${fmtKr(b)} kr ${y - 1}`)}</div></div><span class="pill ${!b ? "none" : a > b ? "soon" : "ok"}">${esc(b ? `${a >= b ? "+" : "−"}${Math.abs(Math.round(((a - b) / b) * 100))} %` : "Ny")}</span></div>`).join("")}</div>` : ""}
  </div>`;
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
  return arrangeCards(`${subHeader("Vad bilen kostar", "Ekonomi")}
    <!--card:month--><div class="card eco-month">
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
    <!--card:year--><div class="card">
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
        <div class="stat"><div class="label">Snitt per månad</div><div class="n">${yearTotal ? fmt(Math.round(yearAvg)) : "–"} <small>kr</small></div></div>
        <div class="stat"><div class="label">Kostnad per mil</div><div class="n">${driven && yearTotal ? fmt(yearTotal / driven, 2) : "–"} <small>kr</small></div>${driven && prevDriven && prevTotal ? delta(yearTotal / driven, prevTotal / prevDriven) : ""}</div>
        <div class="stat"><div class="label">Körsträcka</div><div class="n">${driven != null ? fmt(driven) : "–"} <small>mil</small></div>${delta(driven, prevDriven)}</div>
      </div>
      <p class="hint" style="margin-top:10px">Tryck på en stapel för att se den månaden. Kostnad per mil räknas på körsträckan mellan årets loggade mätarställningar.</p>
    </div>
    <!--card:rec-->${(c.recurring || []).length ? `<div class="card"><h2>Återkommande kostnader</h2><div class="rows">${c.recurring.map((r) => {
      const ended = r.end && r.end <= todayStr();
      return `<button class="dl as-btn" type="button" data-act="open-rec" data-id="${esc(r.id)}"><span class="dl-ic">${icon("parking", 20)}</span>
        <span><span class="dl-t">${esc(r.place || "Parkering")}</span><span class="dl-s">${esc(`${fmtKr(r.amount)} kr ${PERIODS[r.period]?.toLowerCase()} · ${ended ? `slutade ${fmtDateShort(r.end)}` : `sedan ${fmtDateShort(r.start)}`}`)}</span></span>
        <span class="pill ${ended ? "none" : "ok"}">${ended ? "Avslutad" : "Pågår"}</span></button>`;
    }).join("")}</div></div>` : ""}
    <!--card:tank-->${(() => {
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
        ${paidT.length ? `<div><dt>Snitt per tankning</dt><dd>${esc(fmt(Math.round(sum / paidT.length)))} kr</dd></div>` : ""}
        <div><dt>Tankar ungefär</dt><dd>${gap < 1.5 ? "varje dag" : `var ${Math.round(gap)}:e dag`}</dd></div>
        ${max ? `<div><dt>Dyraste</dt><dd>${esc(fmtKr(max.amount))} kr, ${esc(fmtDateShort(max.date))}</dd></div>` : ""}
        ${fav ? `<div><dt>Oftast hos</dt><dd>${esc(fav[0])} (${fav[1]} gånger)</dd></div>` : ""}
      </dl></div>`;
    })()}
    <!--card:compare-->${compareCard(paid)}
    <!--card:facts-->${yearTotal || yearFacts.length ? `<div class="card">
      <h2>Bilåret ${year} i siffror</h2>
      <dl class="detail-list">
        ${topCat ? `<div><dt>Mest pengar på</dt><dd>${esc(topCat[0])}, ${esc(fmtKr(topCat[1]))} kr (${Math.round((topCat[1] / yearTotal) * 100)} %)</dd></div>` : ""}
        ${topMonth.i >= 0 ? `<div><dt>Dyraste månaden</dt><dd>${esc(MONTHS[topMonth.i].replace(/^./, (x) => x.toUpperCase()))}, ${esc(fmtKr(topMonth.v))} kr</dd></div>` : ""}
        ${yearFacts.map(([k, n]) => `<div><dt>${esc(k)}</dt><dd>${n} st</dd></div>`).join("")}
        ${prevTotal ? `<div><dt>Jämfört med ${year === new Date().getFullYear() ? `samma tid ${year - 1}` : year - 1}</dt><dd>${yearTotal >= prevTotal ? `${esc(fmtKr(yearTotal - prevTotal))} kr mer` : `${esc(fmtKr(prevTotal - yearTotal))} kr mindre`}</dd></div>` : ""}
      </dl>
    </div>` : ""}`, "ekonomi");
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

// När en underhållspunkt beräknas bli aktuell (Plus): efter tid, eller efter mil räknat på hur mycket bilen körs.
// Bygger på mätarställningarna det senaste året (milPerDay). Utan sådana blir det ingen prognos för milen.
function itemForecast(s, c) {
  if (!s || s.unknown) return null;
  const rate = milPerDay(c);
  const list = [];
  if (s.dueDate) list.push({ d: s.dueDate, by: "time" });
  if (s.remMil != null && rate) list.push({ d: new Date(today0().getTime() + Math.max(0, s.remMil / rate) * 864e5), by: "mil" });
  if (!list.length) return null;
  list.sort((a, b) => a.d - b.d);
  return { ...list[0], rate };
}
const forecastText = (f) => (f.d <= today0() ? "Redan nu" : `Runt ${MONTHS[f.d.getMonth()]} ${f.d.getFullYear()}`);

// Kortare rad i listan: "Vid 23 120 mil · sep 2027" i stället för "Vid 23 120 mil eller senast september 2027".
const shortSub = (t) => String(t).replace(/ eller senast /, " · ").replace(/\b(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\b/g, (m) => (MONTHS_SHORT[MONTHS.indexOf(m)] || m).toLowerCase());
// Bläddra tio i taget: pil vänster, "11–20 av 34", pil höger.
const PAGE_SIZE = 10;
const MAINT_PAGE = 5;
function pager(act, page, total, size = PAGE_SIZE) {
  const pages = Math.ceil(total / size);
  if (pages < 2) return "";
  const from = page * size + 1, to = Math.min(total, from + size - 1);
  return `<div class="pager"><button class="pager-btn" type="button" data-act="${act}" data-d="-1" aria-label="Föregående"${page <= 0 ? " disabled" : ""}>${icon("back", 18)}</button>
    <span>${esc(`${from}–${to} av ${total}`)}</span>
    <button class="pager-btn" type="button" data-act="${act}" data-d="1" aria-label="Nästa"${page >= pages - 1 ? " disabled" : ""}>${icon("next", 18)}</button></div>`;
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
  return [s.dueMil != null ? `Vid ${fmt(s.dueMil)} mil` : "", s.dueDate ? `senast ${MONTHS[s.dueDate.getMonth()]} ${s.dueDate.getFullYear()}` : ""]
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
    const sub = [t.brand, t.size, t.year ? `tillverkade ${tireDotText(t.year)}` : "", t.depth != null && t.depth !== "" ? `${fmt(num(t.depth), 1)} mm` : "", pressure, k === "vinter" && t.studded ? "dubbade" : ""].filter(Boolean).join(" · ");
    const lvl = tireDepthLevel(k, t.depth);
    const h = tireHealth(c, k);
    const pill = h ? `<span class="pill ${h.lvl === "bad" ? "urgent" : h.lvl === "warn" ? "soon" : "ok"}">${esc(h.label)}</span>`
      : `<span class="pill ${lvl === "bad" ? "urgent" : lvl === "warn" ? "soon" : on ? "ok" : "none"}">${lvl === "bad" ? "Under lagkrav" : lvl === "warn" ? "Slitna" : on ? "På" : "Förråd"}</span>`;
    const meter = h ? `<div class="tire-meter ${h.lvl}" role="img" aria-label="${esc(`Däckens hälsa: ${h.label}`)}"><i style="width:${Math.max(4, Math.round(h.frac * 100))}%"></i></div><div class="tire-why">${esc(h.why)}${h.oldDepth ? ". Mönsterdjupet mättes för över ett år sedan" : ""}</div>` : "";
    return `<button class="dl as-btn" type="button" data-act="tire-sheet" data-k="${k}"><div class="dl-ic">${icon("tire", 20)}</div><div><div class="dl-t">${k === "sommar" ? "Sommardäck" : "Vinterdäck"}${on ? " · sitter på" : ""}</div><div class="dl-s">${esc(sub || "Inga uppgifter")}</div>${meter}</div>${pill}</button>`;
  }).join("");
  const tireMissing = ["sommar", "vinter"].some((k) => { const t = (c.tires || []).find((x) => x.kind === k) || {}; return !tireDot(t.year) && num(t.depth) == null; });
  return arrangeCards(`${subHeader([c.year, c.fuel].filter(Boolean).join(" · "), carName(c), false, "Bilen")}
    ${carChips(c)}
    <!--card:upp--><div class="card"><h2>Uppgifter <button class="link" type="button" data-act="edit-car" data-section="basic,more,photo,dates">Ändra</button></h2>
      <dl class="detail-list">
        ${c.vin ? `<div><dt>Chassinummer</dt><dd class="vin-dd"><span data-notr>${esc(c.vin)}</span><button class="link" type="button" data-act="copy-vin">Kopiera</button></dd></div>` : ""}
        ${[["Registreringsnummer", c.plate], ["Motor", c.engine], ["Färg", c.color], ["Kaross", [c.bodyStyle, c.seats ? `${c.seats} säten` : ""].filter(Boolean).join(", ")], ["Växellåda", c.gearbox], ["I trafik sedan", c.firstReg ? fmtDate(c.firstReg) : ""], ["Koldioxid", c.co2 ? `${c.co2} g/km` : ""], ["Tankvolym", c.tankVolume ? `${fmt(c.tankVolume)} liter` : ""], ["Mätarställning", odoOf(c) != null ? `${fmt(odoOf(c))} mil` : ""], ["Sista dag för besiktning", [c.besiktning ? fmtDate(c.besiktning) : "", c.besiktningPlats].filter(Boolean).join(", ")], ["Försäkringsbolag", [c.forsakringBolag, c.forsakringDatum ? `förnyas ${fmtDate(c.forsakringDatum)}` : ""].filter(Boolean).join(", ")], ["Skatt", [c.skattBelopp ? `${fmt(c.skattBelopp)} kr/år` : "", taxMonth(c) ? MONTHS[taxMonth(c) - 1] : ""].filter(Boolean).join(", ")]]
          .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v || "–")}</dd></div>`).join("")}
      </dl>
    </div>
    <!--card:slap-->${trailerCard(c)}
    <!--card:maint--><div class="card" id="underhall" style="scroll-margin-top:16px">
      <h2>Underhåll <button class="link" type="button" data-act="edit-items">Ändra</button></h2>
      ${(() => {
        // En lista: underhållspunkterna först, det som behöver bytas först överst (försenat, sedan närmast
        // i tid eller mil, okänt sist). Sedan annat som har gjorts, senast först. Fem åt gången med pilar.
        const items = st.filter((s) => s.item.mil || s.item.months || s.lastDate).sort((a, b) => daysToDue(a, c) - daysToDue(b, c));
        const extras = extraParts(c);
        const row = (s) => `<button class="dl as-btn" type="button" data-act="edit-item" data-id="${esc(s.item.id)}"><div class="dl-ic">${icon(partIcon(s.item.name, s.item.id), 20)}</div><div><div class="dl-t">${esc(s.item.name)}</div><div class="dl-s">${esc(shortSub(itemSubText(s)))}</div>${wearBar(s)}</div><span class="pill ${s.unknown ? "none" : s.level}">${esc(s.noInterval ? "Inget intervall" : s.unknown ? "Okänt" : s.label)}</span></button>`;
        const extraRow = (x) => `<button class="dl as-btn" type="button" data-act="open-part" data-id="${esc(x.key)}"><div class="dl-ic">${icon(partIcon(x.name), 20)}</div><div><div class="dl-t">${esc(x.name)}</div><div class="dl-s">${esc(`senast ${(WORK_ACTIONS[x.lastAction] || "Bytt").toLowerCase()} ${fmtDateShort(x.entries[0].date)}${x.entries.length > 1 ? ` · ${x.entries.length} gånger` : ""}`)}</div></div><span></span></button>`;
        const all = [...items.map(row), ...extras.map(extraRow)];
        if (!all.length) return `<div class="rows"><p class="muted">Inga punkter. Lägg till under Ändra.</p></div>`;
        const pages = Math.ceil(all.length / MAINT_PAGE), page = Math.min(S.maintPage || 0, pages - 1);
        // Alla rader är lika höga, och sista sidan fylls ut, så att pilarna står still när man bläddrar.
        const shown = all.slice(page * MAINT_PAGE, page * MAINT_PAGE + MAINT_PAGE);
        const pad = pages > 1 ? MAINT_PAGE - shown.length : 0;
        return `<div class="rows maint-rows">${shown.join("")}${'<div class="dl maint-pad" aria-hidden="true"></div>'.repeat(pad)}</div>${pager("maint-page", page, all.length, MAINT_PAGE)}`;
      })()}
      <p class="hint" style="margin-top:10px">Intervallen är vanliga riktvärden. Kontrollera mot bilens servicebok.</p>
    </div>
    <!--card:dack--><div class="card"><h2>Däck <button class="link" type="button" data-act="edit-car" data-section="tires">Ändra</button></h2><div class="rows">${tires}</div>${tireMissing ? `<p class="hint" style="margin-top:8px">Lägg till tillverkningsår och mönsterdjup under Ändra, så ser du hur däcken mår.</p>` : ""}
      <p class="hint" style="margin-top:8px">Tryck på däcken för mer om dem och vad som gäller enligt lag.</p></div>
    <!--card:media-->${docsCard(c)}
    <!--card:end--><div class="car-danger">${isOwner()
      ? `<button class="link danger" type="button" data-act="delete-car" data-id="${esc(c.id)}">${icon("close", 14)} ${esc(`Ta bort ${carName(c)}`)}</button>
        <p class="hint">${esc(`Bilen flyttas till papperskorgen under Inställningar och kan återställas i ${TRASH_DAYS} dagar.`)}</p>`
      : `<p class="hint">${esc(`Bara hushållets ägare, ${memberName(ownerUid())}, kan ta bort bilen.`)}</p>`}</div>`, "bilen");
}

function viewNotifications() {
  const seen = lastSeenMs();
  const c = car();
  const fl = fuelPct(c.fuelLevel);
  const reminders = [
    ...(fl != null && fl <= 25 ? [{ icon: "fuel", title: "Tanka snart", sub: `Bränslet är på ${pctText(fl).toLowerCase()}`, group: "Nu", level: "urgent", days: 0 }] : []),
    ...bookingRows(c).filter((b) => b.days <= 1),
    ...deadlines(c).filter((d) => d.level === "urgent"),
    ...allItemStatus(c).filter((s) => !s.unknown && s.level === "urgent").map((s) => ({ icon: "wrench", title: `Dags för ${s.item.name.toLowerCase()}`, sub: s.label, group: "Nu", level: "urgent", days: 0, act: "edit-item", id: s.item.id })),
  ];
  const feed = [...S.entries, ...bookingFeed()].sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)).slice(0, 40);
  const perm = NATIVE ? (pref.get("pushPerm") || "default") : "Notification" in window ? Notification.permission : "unsupported";
  return `${subHeader("Det ni gjort med bilen", "Aviseringar", true)}
    ${!pushOn() && perm !== "denied" ? `<div class="card"><h2>Få notiser i telefonen</h2><p class="muted">Påminnelser om bokade tider och datum, och en notis när någon av de andra loggar något. Även när appen är stängd.</p><div class="ask"><button class="btn-soft" type="button" data-act="enable-notif">Slå på notiser</button></div></div>` : ""}
    ${reminders.length ? `<div class="card"><h2>Påminnelser</h2>${kollListHtml(reminders)}</div>` : ""}
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
  const perm = NATIVE ? (pref.get("pushPerm") || "default") : "Notification" in window ? Notification.permission : "unsupported";
  const permText = { granted: "Påslagna", denied: "Avstängda i telefonens inställningar", default: "Inte påslagna", unsupported: "Stöds inte här. På iPhone: lägg först till appen på hemskärmen." }[perm];
  return `${subHeader(S.house?.name || "Hushållet", "Inställningar", true)}
    <div class="card">
      <div class="hh-title"><h2>${esc(S.house?.name || "Hushållet")}</h2><button class="icon-btn hh-edit" type="button" data-act="rename-house" aria-label="Byt namn på hushållet">${icon("pen", 16)}</button></div>
      <p class="label" style="margin:12px 0 2px">Ni som delar</p>
      <div class="rows">${members.map((m) => `<div class="dl"><div class="avatar${m === uid() ? " me" : ""}">${esc(memberName(m).slice(0, 1).toUpperCase())}</div><div><div class="dl-t">${m === uid()
          ? `<button class="hh-me" type="button" data-act="rename-me" aria-label="Byt ditt namn">${esc(memberName(m))} (du) <span class="hh-pen">${icon("pen", 14)}</span></button>`
          : esc(memberName(m))}${m === ownerUid() ? ` <span class="pill ok">Ägare</span>` : ""}${m === S.house?.plus?.by && hasPlus() ? ` <span class="pill">Betalar för Plus</span>` : ""}</div><div class="dl-s">${esc(S.house.memberInfo?.[m]?.email || "")}</div></div>
        <span class="row-actions">${members.length > 1 ? (m === uid()
          ? `<button class="link danger" type="button" data-act="leave-house">Lämna</button>`
          : isOwner() ? `<button class="link danger" type="button" data-act="remove-member" data-id="${esc(m)}" aria-label="Ta bort ${esc(memberName(m))}">Ta bort</button>` : "") : ""}</span></div>`).join("")}</div>
      ${members.length > 1 ? `<p class="hint" style="margin-top:6px">${esc(isOwner() ? "Du är hushållets ägare och den enda som kan ta bort bilar och andra personer. Lämnar du hushållet väljer du vem som tar över." : `${memberName(ownerUid())} är hushållets ägare och den enda som kan ta bort bilar och andra personer.`)}</p>` : ""}
      ${membersFull() ? `<div class="hh-invite"><div class="hh-grow"><span class="label">Hushållet är fullt</span><span class="dl-s">${esc(caps() === PLUS ? `Bildagboken Plus har plats för ${PLUS.members} personer.` : `Gratisversionen har plats för ${FREE.members} personer. Med Plus kan ni vara upp till ${PLUS.members}.`)}</span></div>${caps() === PLUS ? "" : `<button class="btn-soft" type="button" data-act="plus" data-f="members">Läs om Plus</button>`}</div>` : `      <div class="hh-invite">
        <div class="hh-grow"><span class="label">Inbjudningskod</span><span class="hh-code" data-notr>${esc(S.house?.inviteCode || "")}</span></div>
        <button class="btn-soft" type="button" data-act="copy-invite">Kopiera länk</button>
        <button class="hh-ghost" type="button" data-act="new-invite-code">Byt kod</button>
      </div>`}
      ${membersFull() ? "" : `<p class="hint" style="margin-top:8px">Den som har koden kan gå med. Byt kod om den har kommit på villovägar, då slutar den gamla att fungera.</p>`}
    </div>
    ${plusOnSale() ? `<div class="card plus-card"><h2>Bildagboken Plus</h2>
      <div class="rows"><button class="dl as-btn" type="button" data-act="plus"><div class="dl-ic">${icon("spark", 20)}</div><div><div class="dl-t">${hasPlus() ? esc(plusUntilText()) : limited() ? "Ni har gratisversionen" : "Ingen gräns för ert hushåll"}</div><div class="dl-s">${hasPlus() ? "Körjournal, läsning med AI, upp till 6 bilar och 6 personer. Gäller alla i hushållet." : "Körjournal, läsning med AI, fler bilar, fler i hushållet och fler bilder."}</div></div><span class="dl-v">›</span></button></div></div>` : ""}
    <div class="card">
      <h2>Notiser</h2>
      ${pushOn()
        ? `<p class="muted">Påslagna på den här enheten. Välj vad du vill få notiser om:</p>
          <div class="push-kinds">${PUSH_KINDS.filter(([k]) => k !== "letter" || plusFeat()).map(([k, l, d]) => `<label class="ios-switch-row push-kind"><span><b>${esc(l)}</b><small>${esc(d)}</small></span><input type="checkbox" class="ios-switch" data-push-kind="${k}"${pushPrefs()[k] ? " checked" : ""}></label>`).join("")}</div>
          <div class="ask"><button class="link" type="button" data-act="push-off">Stäng av alla notiser på den här enheten</button></div>`
        : `<p class="muted">${perm === "denied" ? "Notiserna är avstängda i telefonens inställningar för den här appen." : "Få påminnelser om bokade tider, besiktning, försäkring och däckbyte, och en notis när någon av de andra loggar något. Även när appen är stängd."}</p>
          ${perm !== "denied" ? `<div class="ask"><button class="btn-soft" type="button" data-act="push-on">${icon("bell", 16)} Slå på notiser</button></div>` : ""}
          ${!NATIVE && /iphone|ipad/i.test(navigator.userAgent) && !(window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) ? `<p class="hint" style="margin-top:10px">På iPhone fungerar notiser bara när appen är tillagd på hemskärmen och öppnad därifrån.</p>` : ""}`}
    </div>
    <div class="card">
      <h2>Utseende och språk</h2>
      <p class="label" style="margin:12px 0 8px">Ljust eller mörkt</p>
      <div class="seg" role="group" aria-label="Ljust eller mörkt">
        ${Object.entries(MODES).map(([k, l]) => `<button type="button" data-act="theme-mode" data-v="${k}" aria-pressed="${themePrefs().mode === k}">${l}</button>`).join("")}
      </div>
      <p class="hint" style="margin-top:8px">${COLORS[themePrefs().color]?.garage ? "Glenns Garage har egna färger och följer inte ljust och mörkt läge." : "Automatiskt följer telefonen: ljust på dagen och mörkt när telefonen har mörkt läge påslaget."}</p>
      <p class="label" style="margin:16px 0 8px">Färg</p>
      <div class="theme-grid colors" role="group" aria-label="Färg">
        ${Object.entries(COLORS).filter(([, t]) => !t.garage).map(([k, t]) => { const v = t[isDarkNow() ? "dark" : "light"]; return `<button class="theme-btn" type="button" data-act="theme-color" data-v="${k}" aria-pressed="${themePrefs().color === k}">
          <span class="theme-sw" style="background:${v.sw}" aria-hidden="true"><i style="background:${v.dot}"></i></span>${t.name}</button>`; }).join("")}
      </div>
      ${garagePicker()}
      <p class="label" style="margin:16px 0 8px">Språk</p>
      <div class="seg" role="group" aria-label="Språk">
        ${[["sv", "Svenska"], ["en", "English"]].map(([k, l]) => `<button type="button" data-act="lang" data-v="${k}" aria-pressed="${LANG === k}" data-notr>${l}</button>`).join("")}
      </div>
    </div>
    ${trashCard()}
    ${cardsSettingsCard(S.cardsView || "oversikt")}
    ${shortcutsCard()}
    <div class="card">
      <h2>Dina uppgifter</h2>
      <p class="muted"><b>Loggen</b> som kalkylark, med bokade tider, för Excel eller Numbers. Bra att ha med vid försäljning av bilen.</p>
      <p class="muted"><b>Allt</b> i en fil: uppgifter, datum, däck, underhåll, anteckningar, bokningar och hela loggen. Bilder kommer inte med.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="export-log">Ladda ner loggen</button><button class="btn-soft" type="button" data-act="export-all">Ladda ner allt</button></div>
      <div class="ask"><a class="link" href="${LANG === "en" ? "privacy.html" : "integritet.html"}" target="_blank" rel="noopener">Så hanteras dina uppgifter</a></div>
    </div>
    <div class="card">
      <h2>Konto</h2>
      <p class="muted">Inloggad som ${esc(S.user.email || "")}</p>
      <div class="rows" style="margin-top:8px">${Object.keys(PROVIDER_IDS).filter((k) => !(ANDROID && k === "apple" && !linkedProviders().includes(k))).map((k) => {
        const on = linkedProviders().includes(k);
        return `<div class="dl"><div class="dl-ic">${icon(k, 20)}</div><div><div class="dl-t">${PROVIDER_NAMES[k]}</div><div class="dl-s">${on ? "Kopplat, du kan logga in med det" : "Inte kopplat"}</div></div>
          ${on ? `<span class="pill ok">Kopplat</span>` : `<button class="link" type="button" data-act="link-provider" data-provider="${k}">Koppla</button>`}</div>`;
      }).join("")}</div>
      <p class="hint" style="margin-top:10px">Koppla både Google och Apple så kan du logga in med vilket du vill och ändå se samma bilar och logg.</p>
      <div class="ask"><button class="btn ghost block" type="button" data-act="logout">Logga ut</button></div>
      <div class="ask"><button class="link danger" type="button" data-act="delete-account">Radera mitt konto</button></div>
    </div>
    ${isAdmin() ? `<div class="card"><h2>Testläge</h2><p class="muted">Visa appen som en vanlig användare ser den. Gäller bara på den här enheten, och inget ändras för andra.</p>
      <div class="checks" role="radiogroup" aria-label="Visa appen som" style="margin-top:12px">${[["", "Som vanligt"], ["free", "Gratis"], ["plus", "Plus"]].map(([k, l]) => `<label class="check"><input type="radio" name="testMode" value="${k}" data-act="test-mode"${testMode() === k ? " checked" : ""}> ${l}</label>`).join("")}</div>
      <p class="hint" style="margin-top:8px">Gratis: gränserna (${FREE.cars} bil, ${FREE.members} personer, ${FREE.photos} bilder) och tipsen om Plus är påslagna. Plus: allt som ingår i Plus, med Plus-gränserna (${PLUS.cars} bilar, ${PLUS.members} personer, ${fmt(PLUS.photos)} bilder).</p></div>` : ""}
    ${isAdmin() ? `<div class="card"><h2>Användare</h2><p class="muted">Alla hushåll och användare, och vilka funktioner de använder. Bara du ser det här.</p><div class="ask"><button class="btn-soft" type="button" data-act="open-admin">Visa översikten</button></div></div>` : ""}
    <p class="hint" style="text-align:center">Bildagboken ${VERSION} · <span>Frågor eller idéer?</span> <a class="link" href="mailto:kontakt@bildagboken.com" data-notr>kontakt@bildagboken.com</a></p>`;
}

/* ------------------------------------------------------------ pushnotiser */

// Notiser även när appen är stängd. Telefonens adress för notiser (en token från Firebase) sparas i hushållet,
// och en funktion hos Firebase skickar påminnelser varje morgon och när någon av de andra loggar något.
const VAPID_KEY = "BHLhh-EYDJjPAQMpNMjAjM_brJKBw9Iik4lO7JIf4QeT4UMiRIq9ZKy885ug7POzXcqA5DrU5aqexV3EauRA70E";
const pushSupported = () => NATIVE || ("Notification" in window && "serviceWorker" in navigator && "PushManager" in window);
const pushOn = () => pushSupported() && (NATIVE || Notification.permission === "granted") && !!pref.get("pushToken");
async function pushToken() {
  if (NATIVE) return (await nativePlugin("FirebaseMessaging").getToken()).token;
  const m = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging.js");
  if (!(await m.isSupported())) throw new Error("unsupported");
  const reg = await navigator.serviceWorker.ready;
  return m.getToken(m.getMessaging(fb), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
}
// Vilka notiser den här enheten vill ha. Sparas i telefonen och på enhetens adress i databasen, där funktionerna läser dem.
const PUSH_KINDS = [
  ["bookings", "Bokade tider", "Dagen innan och samma dag"],
  ["dates", "Datum att hålla koll på", "Besiktning, försäkring, skatt, dokument och däckbyte"],
  ["activity", "När någon annan loggar", "Till exempel en tankning eller service"],
  ["letter", "Glenns månadsbrev", "Den första i månaden: vad bilen kostade och hur mycket ni körde"],
];
function pushPrefs() {
  let p = {};
  try { p = JSON.parse(pref.get("pushPrefs") || "{}"); } catch { p = {}; }
  return Object.fromEntries(PUSH_KINDS.map(([k]) => [k, p[k] !== false]));
}
async function setPushPref(kind, on) {
  const p = { ...pushPrefs(), [kind]: on };
  pref.set("pushPrefs", JSON.stringify(p));
  const t = pref.get("pushToken");
  if (t && S.hid) await updateDoc(doc(db, "households", S.hid, "tokens", t), { prefs: p }).catch(onWriteError);
  showToast(on ? "Påslaget" : "Avstängt");
}
async function savePushToken(token) {
  if (!token || !S.hid) return;
  const old = pref.get("pushToken");
  await setDoc(doc(db, "households", S.hid, "tokens", token), { token, uid: uid(), lang: LANG, platform: NATIVE ? "ios" : "web", ua: navigator.userAgent.slice(0, 120), prefs: pushPrefs(), updatedAt: serverTimestamp() });
  if (old && old !== token) deleteDoc(doc(db, "households", S.hid, "tokens", old)).catch(() => {});
  pref.set("pushToken", token);
  pref.set("pushDay", todayStr());
}
async function enablePush() {
  if (!pushSupported()) return showToast(/iphone|ipad/i.test(navigator.userAgent) ? "Lägg först till appen på hemskärmen och öppna den därifrån, sedan kan du slå på notiser." : "Notiser stöds inte i den här webbläsaren.", 7000);
  const p = NATIVE
    ? ({ granted: "granted", denied: "denied" }[(await nativePlugin("FirebaseMessaging").requestPermissions()).receive] || "default")
    : await Notification.requestPermission();
  if (NATIVE) pref.set("pushPerm", p);
  if (p !== "granted") { render(); return showToast(p === "denied" ? "Notiserna är avstängda i telefonens inställningar." : "Notiser slogs inte på"); }
  try {
    await savePushToken(await pushToken());
    showToast("Pushnotiser är påslagna på den här enheten");
  } catch (e) {
    console.error(e);
    showToast("Kunde inte slå på pushnotiser just nu. Försök igen om en stund.", 6000);
  }
  render();
}
async function disablePush() {
  const t = pref.get("pushToken");
  pref.set("pushToken", "");
  if (t && S.hid) await deleteDoc(doc(db, "households", S.hid, "tokens", t)).catch(() => {});
  try {
    if (NATIVE) await nativePlugin("FirebaseMessaging").deleteToken();
    else { const m = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging.js"); await m.deleteToken(m.getMessaging(fb)); }
  } catch { /* redan borta */ }
  render();
  showToast("Pushnotiser är avstängda på den här enheten");
}
// En gång per dag: hämta adressen igen (den kan bytas) och spara språket.
if (NATIVE) {
  nativePlugin("FirebaseMessaging")?.addListener("notificationActionPerformed", (ev) => {
    const hash = String(ev?.notification?.data?.url || "").split("#")[1];
    if (hash) location.hash = hash;
  });
}
function refreshPush() {
  if (!pushOn() || pref.get("pushDay") === todayStr()) return;
  pushToken().then(savePushToken).catch(() => {});
}

/* ---------------------------------------------------- översikt för ägaren */

// Bara appens ägare ser översiktssidan. Firestore-reglerna ger samma konto rätt att läsa alla hushåll, men inte ändra något.
const ADMIN_UID = "mjQJQzsMCpVURkuVSyK5ctKVhG23";
const isAdmin = () => uid() === ADMIN_UID;
async function loadAdmin() {
  S.adminData = { loading: true };
  try {
    const hs = await getDocs(collection(db, "households"));
    const houses = await Promise.all(hs.docs.map(async (h) => {
      const [cars, ents] = await Promise.all([
        getDocs(collection(db, "households", h.id, "cars")),
        getDocs(collection(db, "households", h.id, "entries")),
      ]);
      return { id: h.id, ...h.data(), cars: cars.docs.map((d) => ({ id: d.id, ...d.data() })), entries: ents.docs.map((d) => ({ id: d.id, ...d.data() })) };
    }));
    const errs = await getDocs(collection(db, "errors")).then((q) => q.docs.map((d) => ({ id: d.id, ...d.data() }))).catch(() => []);
    const regStats = await getDoc(doc(db, "regstats", todayStr().slice(0, 7))).then((d) => d.data() || {}).catch(() => null);
    S.adminData = { houses, regStats, errors: errs.sort((x, y) => tsMs(y.at) - tsMs(x.at)), at: Date.now() };
  } catch (e) {
    console.error(e);
    S.adminData = { error: e.code === "permission-denied" ? "Firestore-reglerna ger inte ditt konto läsrätt till alla hushåll än. Publicera de nya reglerna och försök igen." : (e.code || e.message) };
  }
  if (S.view === "admin") render();
}
// Fel som har hänt hos användarna, nyast först. Samma fel grupperas.
function adminErrorsCard(errs, users) {
  const groups = new Map();
  for (const e of errs) { const g = groups.get(e.msg) || { ...e, n: 0, who: new Set() }; g.n++; g.who.add(e.uid); groups.set(e.msg, g); }
  const list = [...groups.values()].slice(0, 25);
  const name = (id) => users.find((u) => u.id === id)?.name || "Okänd";
  return `<div class="card"><h2>Fel i appen ${errs.length ? `<button class="link danger" type="button" data-act="admin-clear-errors">Rensa</button>` : ""}</h2>
    ${list.length ? `<div class="rows">${list.map((g) => `<div class="admin-house" data-notr>
        <div class="dl-t" style="word-break:break-word">${esc(g.msg)}</div>
        <div class="dl-s">${g.n > 1 ? `${g.n} gånger · ` : ""}${esc([...g.who].map(name).join(", "))} · ${esc(timeAgo(tsMs(g.at)).toLowerCase())}${g.where ? ` · ${esc(g.where)}` : ""} · ${esc(g.native || "webb")} ${esc(g.ver || "")}</div>
      </div>`).join("")}</div>` : `<p class="muted">Inga fel har rapporterats. Bra!</p>`}
    <p class="hint" style="margin-top:10px">Appen skickar hit fel som inträffar hos användarna, utan något av det de har skrivit. Skicka gärna ett fel till Claude om du vill att det ska rättas.</p>
  </div>`;
}

// "sv-SE-Chirp3-HD-Charon" blir "Charon (Chirp 3 HD)".
const voiceLabel = (n) => { const m = String(n).match(/^sv-SE-(.+)-([^-]+)$/); return m ? `${m[2]} (${m[1].replace(/-/g, " ").replace(/Chirp3/, "Chirp 3")})` : n; };
function renderVoiceAdmin() {
  const v = S.voiceAdmin, box = $("#av-box");
  if (!v || !box) return;
  const rates = [[0.9, "Lugnare"], [1, "Normal"], [1.1, "Lite snabbare"], [1.2, "Snabbare"]];
  const row = (x) => {
    const sel = x.name === v.current;
    const btn = v.loading === x.name ? "Hämtar …" : v.playing === x.name ? "Stoppa" : "Lyssna";
    return `<div class="dl voice-row${sel ? " sel" : ""}"><span class="dl-ic">${icon(sel ? "check" : "spark", 18)}</span>
    <span><span class="dl-t">${esc(voiceLabel(x.name))}${sel ? ` <span class="pill ok">${v.auto ? "Vald automatiskt" : "Glenns röst"}</span>` : ""}</span><span class="dl-s">${x.gender === "MALE" ? "Man" : x.gender === "FEMALE" ? "Kvinna" : "Neutral"}${!v.auto && x.name === v.autoVoice ? " · Glenns röst från början" : ""}</span></span>
    <span class="trash-acts"><button class="btn-soft${v.playing === x.name ? " on" : ""}" type="button" data-act="admin-voice-play" data-v="${esc(x.name)}"${v.loading === x.name ? " disabled" : ""}>${btn}</button>${x.name === v.current && !v.auto ? (Math.abs(v.rate - v.savedRate) > 0.01 ? `<button class="link" type="button" data-act="admin-voice-set" data-v="${esc(x.name)}">Spara takt</button>` : "") : `<button class="link" type="button" data-act="admin-voice-set" data-v="${esc(x.name)}">Välj</button>`}</span></div>`;
  };
  box.innerHTML = `<p class="label" style="margin:0 0 6px">Takt</p>
    <div class="seg" role="group" aria-label="Takt">${rates.map(([r, l]) => `<button type="button" data-act="admin-voice-rate" data-v="${r}" aria-pressed="${Math.abs(v.rate - r) < 0.01}">${l}</button>`).join("")}</div>
    <p class="hint" style="margin:6px 0 12px">Lyssna med den takt du har valt. Takten sparas när du trycker på Välj.</p>
    <div class="rows">${v.voices.map(row).join("")}</div>
    ${v.auto ? "" : `<div class="form" style="margin-top:12px"><button class="btn ghost block" type="button" data-act="admin-voice-set" data-v="">Tillbaka till automatiskt val</button></div>`}`;
}
function viewAdmin() {
  const head = subHeader("Bara du ser det här", "Användare", true);
  if (!isAdmin()) return `${head}<div class="card empty"><b>Inte tillgängligt</b></div>`;
  const a = S.adminData;
  if (!a) { loadAdmin(); return `${head}<p class="loading">Hämtar alla hushåll …</p>`; }
  if (a.loading) return `${head}<p class="loading">Hämtar alla hushåll …</p>`;
  if (a.error) return `${head}<div class="card empty"><b>Kunde inte hämta</b>${esc(a.error)}<div class="ask" style="justify-content:center"><button class="btn" type="button" data-act="admin-reload">Försök igen</button></div></div>`;
  const H = a.houses;
  const users = H.flatMap((h) => (h.members || []).map((m) => ({ id: m, ...(h.memberInfo?.[m] || {}), house: h.name })));
  const seen = (u) => Math.max(tsMs(u.lastActive), tsMs(u.lastSeen));
  const ago = (days) => users.filter((u) => seen(u) > Date.now() - days * 864e5).length;
  const n = H.length || 1;
  const has = (fn) => H.filter(fn).length;
  const ent = (h, f) => h.entries.some(f);
  const car = (h, f) => h.cars.some(f);
  const features = [
    ["Tankning", has((h) => ent(h, (e) => e.type === "tank"))],
    ["Mätarställning", has((h) => ent(h, (e) => e.type === "matare"))],
    ["Service och egna jobb", has((h) => ent(h, (e) => e.type === "service" || e.type === "eget"))],
    ["Däck", has((h) => ent(h, (e) => e.type === "dack"))],
    ["Parkering", has((h) => ent(h, (e) => e.type === "parkering") || car(h, (c) => (c.recurring || []).length))],
    ["Tvätt", has((h) => ent(h, (e) => e.type === "tvatt"))],
    ["Andra kostnader", has((h) => ent(h, (e) => e.type === "kostnad"))],
    ["Bokade tider", has((h) => car(h, (c) => (c.bookings || []).length))],
    ["Återkommande kostnader", has((h) => car(h, (c) => (c.recurring || []).length))],
    ["Att göra", has((h) => car(h, (c) => (c.todos || []).length))],
    ["Dokument", has((h) => car(h, (c) => (c.docs || []).length))],
    ["Bilder i loggen", has((h) => ent(h, (e) => e.photoId))],
    ["Eget foto på bilen", has((h) => car(h, (c) => c.photoId))],
    ["Delad servicebok", has((h) => car(h, (c) => c.shareToken))],
    ["Fler än en i hushållet", has((h) => (h.members || []).length > 1)],
    ["Flera bilar", has((h) => h.cars.length > 1)],
  ].sort((x, y) => y[1] - x[1]);
  const stat = (label, v) => `<div class="stat"><div class="label">${esc(label)}</div><div class="n">${fmt(v)}</div></div>`;
  const lastEntry = (h) => h.entries.reduce((m, e) => (e.date > m ? e.date : m), "");
  return `${head}
    <div class="card"><h2>Totalt <button class="link" type="button" data-act="admin-reload">Uppdatera</button></h2>
      <div class="admin-stats">${stat("Hushåll", H.length)}${stat("Användare", users.length)}${stat("Bilar", H.reduce((x, h) => x + h.cars.length, 0))}${stat("Poster", H.reduce((x, h) => x + h.entries.length, 0))}${stat("Aktiva 7 dagar", ago(7))}${stat("Aktiva 30 dagar", ago(30))}</div>
      <p class="hint" style="margin-top:10px">Aktiv betyder att personen har öppnat appen. Hämtat ${esc(timeAgo(a.at)).toLowerCase()}.</p>
    </div>
    ${a.regStats ? `<div class="card"><h2>Sökningar på regnummer</h2>
      <div class="admin-stats">${stat("I dag", a.regStats.days?.[todayStr()] || 0)}${stat("Den här månaden", a.regStats.n || 0)}${stat("Kostnad i månaden (ca kr)", (a.regStats.n || 0) * 2)}</div>
      ${a.regStats.lastError ? `<p class="err" style="margin-top:8px">${esc(`${a.regStats.lastError} (${timeAgo(a.regStats.lastErrorAt).toLowerCase()})`)}</p>` : ""}
      <p class="hint" style="margin-top:8px">Räknar varje fråga till registreringsnummerapi.se. Samma regnummer igen inom 30 dagar kostar inget. Tak: 5 sökningar per person och dag (en var tionde sekund), 10 frågor per hushåll och månad, 150 om dagen totalt. Gäller inte dig.</p></div>` : ""}
    <div class="card"><h2>Glenns röst</h2>
      <p class="muted">Provlyssna på Googles svenska röster och välj vilken Glenn ska ha, och hur fort han pratar. Det gäller alla användare.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="admin-voice">${icon("spark", 16)} Välj röst</button></div></div>
    ${adminErrorsCard(a.errors || [], users)}
    <div class="card"><h2>Funktioner</h2><p class="muted" style="margin-bottom:8px">Hur många hushåll som har använt varje funktion.</p>
      <div class="rows">${features.map(([l, v]) => `<div class="admin-feat"><span>${esc(l)}</span><span class="wear ok"><i style="width:${Math.round((v / n) * 100)}%"></i></span><b>${v} av ${H.length}</b></div>`).join("")}</div>
    </div>
    <div class="card"><h2>Hushåll</h2>
      <div class="rows">${H.sort((x, y) => (lastEntry(y) || "").localeCompare(lastEntry(x) || "")).map((h) => `<div class="admin-house">
        <div class="dl-t">${esc(h.name || "Utan namn")}</div>
        <div class="dl-s">${h.cars.map((c) => esc(carName(c))).join(", ") || "Ingen bil"} · ${h.entries.length === 1 ? "1 post" : `${h.entries.length} poster`}${lastEntry(h) ? ` · senast loggat ${esc(fmtDateShort(lastEntry(h)))}` : ""}</div>
        ${(h.members || []).map((m) => { const i = h.memberInfo?.[m] || {}; return `<div class="admin-user" data-notr><span>${esc(i.name || "Okänt namn")}</span><small>${esc(i.email || "")}</small><small>${seen(i) ? `öppnade appen ${esc(timeAgo(seen(i)).toLowerCase())}` : ""}</small></div>`; }).join("")}
        <div class="admin-plus">${tsMs(h.plus?.until) > Date.now() ? `<span class="pill ok">${esc(`Plus till ${fmtDate(ymd(new Date(tsMs(h.plus.until))))}${h.plus.by ? "" : " (gåva)"}`)}</span>` : `<span class="pill none">${limited(h) ? "Gratis" : "Inga gränser (från före gratisgränserna)"}</span>`}
          <button class="link" type="button" data-act="admin-plus" data-id="${esc(h.id)}">Ändra Plus</button>
          <button class="link" type="button" data-act="admin-rewind" data-id="${esc(h.id)}">Spola tillbaka</button></div>
        <div class="hint" data-notr style="font-size:11px">${esc(h.id)}</div>
      </div>`).join("")}</div>
      <p class="hint" style="margin-top:10px">Behöver du ändra något åt någon: Firebase → Firestore → households → id:t ovan. Fråga personen först.</p>
    </div>`;
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
  markRequired(sheet);
  sheet.hidden = false;
  scrim.hidden = false;
  sheet.scrollTop = 0;
  lockScroll();
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
let nudgeTimer = 0;
window.visualViewport?.addEventListener("resize", () => { clearTimeout(nudgeTimer); nudgeTimer = setTimeout(nudgeFixed, 120); });

// Rutan ska alltid få plats ovanför tangentbordet och under klockan, så att både krysset och
// det understa fältet går att nå. iPhone krymper bara den synliga ytan när tangentbordet visas.
function fitSheet() {
  const vv = window.visualViewport;
  if (!vv || sheet.hidden) return;
  // iPhone skjuter undan hela sidan för att visa fältet. Sidan bakom är låst, så den förskjutningen tas bort.
  if (lockedY != null && window.scrollY > 1) window.scrollTo(0, 0);
  const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  const typing = sheet.contains(document.activeElement) && document.activeElement.matches("input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea");
  // Ändra bara när något har ändrats. Diktering ändrar tangentbordets höjd många gånger i rad, och varje
  // ändring av rutan får iPhone att räkna om sidan, vilket annars kan bli en slinga som låser skärmen.
  const bottom = kb > 0 ? kb + "px" : "";
  const maxH = `min(90vh, calc(${Math.round(vv.height)}px - env(safe-area-inset-top, 0px) - 8px))`;
  if (sheet.style.bottom !== bottom) sheet.style.bottom = bottom;
  if (sheet.dataset.maxH !== maxH) { sheet.dataset.maxH = maxH; sheet.style.maxHeight = maxH; }
  const kbOn = typing && vv.height < window.screen.height * 0.75;
  if (sheet.classList.contains("kb") !== kbOn) sheet.classList.toggle("kb", kbOn);
  // I chatten: samtalet får plats ovanför tangentbordet, och det senaste meddelandet och fältet syns.
  if (document.activeElement?.id === "chat-in") {
    const vvh = Math.round(vv.height) + "px";
    if (sheet.style.getPropertyValue("--vvh") !== vvh) sheet.style.setProperty("--vvh", vvh);
    sheet.scrollTop = sheet.scrollHeight;
    scrollChat();
  }
}
// Högst en gång per bildruta.
let fitQueued = false;
const fitSheetSoon = () => { if (fitQueued) return; fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitSheet(); }); };
window.visualViewport?.addEventListener("resize", fitSheetSoon);
window.visualViewport?.addEventListener("scroll", fitSheetSoon);
// Fältet man skriver i flyttas fram i rutan när tangentbordet har kommit upp.
sheet.addEventListener("focusin", (ev) => {
  if (!ev.target.matches?.("input, textarea, select")) return;
  fitSheet();
  setTimeout(fitSheet, 150);
  // Chattens fält ligger redan längst ner i rutan och ska inte skrollas fram (det störde dikteringen).
  setTimeout(() => { fitSheet(); if (ev.target.id !== "chat-in") ev.target.scrollIntoView({ block: "center", behavior: "smooth" }); }, 400);
});
sheet.addEventListener("focusout", () => setTimeout(fitSheet, 150));
window.addEventListener("pageshow", nudgeFixed);

// Sidan bakom rutan ska stå still. På iPhone räcker inte overflow: hidden, så sidan låses på sin plats.
let lockedY = null;
function lockScroll() {
  if (lockedY != null) return;
  lockedY = window.scrollY;
  Object.assign(document.body.style, { position: "fixed", top: `-${lockedY}px`, left: "0", right: "0", width: "100%", overflow: "hidden" });
}
function unlockScroll() {
  if (lockedY == null) return;
  const y = lockedY;
  lockedY = null;
  Object.assign(document.body.style, { position: "", top: "", left: "", right: "", width: "", overflow: "" });
  window.scrollTo(0, y);
}
let reloadWhenClosed = false;
function closeSheet(fromBack = false) {
  if (S.chat?.voice) endVoice();
  if (typeof stopSpeech === "function") stopSpeech();
  // Vänta en stund, så att det som just sparades hinner skrivas innan sidan laddas om.
  if (reloadWhenClosed) { reloadWhenClosed = false; setTimeout(() => location.reload(), 900); }
  if (sheetHistory) {
    if (!fromBack && history.state?.bdSheet) { ignorePops++; history.back(); }
    sheetHistory = null;
  }
  sheet.hidden = true;
  scrim.hidden = true;
  sheet.innerHTML = "";
  sheet.style.bottom = ""; sheet.style.maxHeight = ""; sheet.classList.remove("kb");
  unlockScroll();
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
  ${!tripsOn() && plusOnSale() ? `<p class="types-head">Körjournal</p><div class="types"><button type="button" data-act="plus" data-f="trips" class="plus-teaser">${icon("car", 26)}Resa<span class="plus-badge">Plus</span></button></div>` : ""}
  ${tripsOn() && !tripsVisible() ? `<p class="types-head">Körjournal</p><div class="types"><button type="button" data-act="trips-on">${icon("route", 26)}Slå på körjournalen</button></div>` : ""}
  ${tripsVisible() ? `<p class="types-head">Körjournal</p><div class="types"><button type="button" data-act="trip-menu">${icon("car", 26)}${openTrip() ? "Avsluta resa" : "Resa"}</button></div>` : ""}
  <p class="types-head">Boka</p><button class="btn primary block" type="button" data-act="new-booking">${icon("calendar", 18)} Lägg in bokad tid</button>
  <p class="hint" style="margin-top:14px">Det du sparar syns direkt för alla ni som delar bilen.</p>`);
}

// Förslag i textfälten från det ni har skrivit förut: verkstäder, mackar och platser, de vanligaste först.
const SUGGEST_FIELDS = { "ef-workshop": ["workshop"], "ef-station": ["station"], "ef-place": ["place"], "ef-handler": ["handler"] };
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
        // Datum och tid på en rad, som i Apples Kalender. Tryck på tiden för att öppna ett litet snurrhjul. Heldag betyder ingen tid.
        const t = b.time || "";
        const allDay = !!b.id && !t;
        const shown = allDay ? "Heldag" : t || "09:00";
        return `<div class="field"><span>Datum och tid</span>
            <div class="dt-row">
              <input type="date" name="date" id="bk-date" required value="${esc(b.date || "")}" aria-label="Datum">
              <button class="dt-time" type="button" id="bk-time-btn" data-act="bk-time-toggle" aria-expanded="false" aria-controls="bk-time-pop">${esc(shown)}</button>
            </div>
            <div class="dt-pop" id="bk-time-pop" hidden>
              <label class="ios-switch-row"><span>Heldag</span><input type="checkbox" id="bk-allday" class="ios-switch"${allDay ? " checked" : ""}></label>
              <div class="wheel compact" id="bk-wheel"${allDay ? " hidden" : ""} aria-label="Välj tid">
                <div class="wheel-band" aria-hidden="true"></div>
                ${wheelCol("h", Array.from({ length: 24 }, (_, i) => pad(i)), "Timme")}
                <span class="wheel-sep" aria-hidden="true">:</span>
                ${wheelCol("m", wheelMinutes(t), "Minut")}
              </div>
            </div>
            <input type="hidden" name="time" id="bk-time" value="${esc(t || (b.id ? "" : "09:00"))}"></div>`;
      })()}
      ${field("Var", `<input name="place" id="bk-place" value="${esc(b.place || "")}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="bk-suggest" aria-expanded="false">
        <span class="suggest" id="bk-suggest" role="listbox" hidden></span>`)}
      ${field("Adress", `<input name="placeAddr" id="bk-addr" value="${esc(b.addr || "")}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="bk-addr-suggest" aria-expanded="false">
        <input type="hidden" name="placeLat" id="bk-lat" value="${b.lat ?? ""}">
        <input type="hidden" name="placeLon" id="bk-lon" value="${b.lon ?? ""}">
        <input type="hidden" name="placeId" id="bk-pid" value="${esc(b.placeId || "")}">
        <input type="hidden" name="placeSrc" id="bk-src" value="${esc(b.geoSrc || "")}">
        <span class="suggest" id="bk-addr-suggest" role="listbox" hidden></span>`, "Med gatuadress hittar kartan rätt när bokningen ligger i kalendern.")}
      ${field("Telefon", `<input type="tel" name="phone" id="bk-phone" value="${esc(b.phone || "")}" placeholder="Fylls i från kartan om det finns" autocomplete="off">`)}
      ${handlerField(b.handler ?? lastHandler(b.place), "bk-handler")}
      <div class="bk-map" id="bk-map" hidden>
        <div class="bk-map-inner" id="bk-map-inner"></div>
        <button class="bk-map-open" type="button" data-act="map-open" aria-label="Öppna platsen i en kartapp"><span>${icon("pin", 14)} Öppna i kartan</span></button>
      </div>
      ${field("Anteckning", `<textarea name="note" id="bk-note" rows="2">${esc(b.note || "")}</textarea>`)}
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
  wheelTimer = setTimeout(() => {
    const v = wheelValue(); const hid = $("#bk-time");
    if (hid && !$("#bk-allday")?.checked) { hid.value = v; const btn = $("#bk-time-btn"); if (btn) btn.textContent = v; }
  }, 90);
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
    note: str("note") || null, phone: str("phone") || null, handler: str("handler") || null,
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

/* -------------------------------------------------------------- körjournal */
// Körjournal (ingår i Plus): resor med datum, mätarställning vid start och slut, mål, ärende, förare och
// om resan var i tjänsten. Sparas i households/{hid}/trips, en resa per dokument.
// Milersättning för egen bil enligt Skatteverkets schablon: 25 kr per mil skattefritt.
const MIL_RATE = 25;
const TRIP_KINDS = { tjanst: "Tjänsteresa", privat: "Privat" };
function tripsOn() { return hasPlus() || (isAdmin() && !testMode()); }
// Fliken Resor syns när körjournalen är påslagen (per person, under Inställningar eller på Plus-sidan).
// Den som redan har resor men aldrig har valt räknas som påslagen.
function tripsVisible() {
  if (!tripsOn()) return false;
  const v = S.house?.memberInfo?.[uid()]?.trips;
  return v === true || (v == null && S.trips.length > 0);
}
function setTripsVisible(on) {
  if (S.house?.memberInfo?.[uid()]) S.house.memberInfo[uid()].trips = on;
  updateDoc(doc(db, "households", S.hid), { [`memberInfo.${uid()}.trips`]: on }).catch(onWriteError);
  render();
}
const carTrips = (cid = S.carId) => S.trips.filter((t) => t.carId === cid)
  .sort((a, b) => (b.date || "").localeCompare(a.date || "") || tsMs(b.startedAt || b.createdAt) - tsMs(a.startedAt || a.createdAt));
const tripMil = (t) => (t.odoEnd != null && t.odoStart != null ? Math.max(0, Math.round((t.odoEnd - t.odoStart) * 10) / 10)
  : t.auto && t.autoMeters ? Math.round(t.autoMeters / 1000) / 10 : null);
const openTrip = () => carTrips().find((t) => t.odoEnd == null && !t.auto);
const sumMil = (list, kind) => Math.round(list.filter((t) => t.kind === kind).reduce((a, t) => a + (tripMil(t) || 0), 0) * 10) / 10;
const editedText = (t) => { const e = t.edits?.at(-1); return e ? `Ändrad ${fmtDateShort(ymd(new Date(tsMs(e.at))))} av ${whoName(e.by).replace(/^Du$/, "dig")}` : ""; };
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };


// Svep en resa att gå igenom: höger blir Tjänst, vänster Privat. Ett kort svep glider tillbaka.
(() => {
  let row = null, x0 = 0, y0 = 0, dx = 0, lock = null;
  document.addEventListener("touchstart", (ev) => {
    const r = ev.target.closest?.(".swipe-row");
    if (!r || ev.target.closest("button")) return;
    row = r; x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; lock = null;
    row.style.transition = "none";
  }, { passive: true });
  document.addEventListener("touchmove", (ev) => {
    if (!row) return;
    const mx = ev.touches[0].clientX - x0, my = ev.touches[0].clientY - y0;
    if (lock == null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) lock = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    if (lock !== "x") return;
    dx = mx;
    row.style.transform = `translateX(${dx}px)`;
    row.parentElement.classList.toggle("sw-right", dx > 0);
    row.parentElement.classList.toggle("sw-left", dx < 0);
    row.parentElement.classList.toggle("sw-armed", Math.abs(dx) > 90);
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (!row) return;
    const r = row; row = null;
    r.style.transition = "transform .2s ease";
    if (lock === "x" && Math.abs(dx) > 90) {
      r.style.transform = `translateX(${dx > 0 ? "110%" : "-110%"})`;
      navigator.vibrate?.(10);
      setTimeout(() => ACTIONS["trip-kind"]({ dataset: { id: r.dataset.id, kind: dx > 0 ? "tjanst" : "privat" } }), 180);
    } else { r.style.transform = ""; r.parentElement.classList.remove("sw-right", "sw-left", "sw-armed"); }
  });
})();

// Fliken Resor: allt som har med körjournalen att göra.
// Tjänst och Privat för en automatisk resa. Det som de sparade platserna föreslår är markerat.
const reviewBtns = (t) => `<div class="review-btns">${["tjanst", "privat"].map((k) => `<button class="btn-soft${t.suggestKind === k ? " sug" : ""}" type="button" data-act="trip-kind" data-id="${esc(t.id)}" data-kind="${k}">${k === "tjanst" ? "Tjänst" : "Privat"}</button>`).join("")}<button class="link" type="button" data-act="edit-trip" data-id="${esc(t.id)}">Mer</button></div>${t.suggestKind ? `<p class="hint sug-t">${esc(`Förslag: ${t.suggestKind === "tjanst" ? "Tjänst" : "Privat"}, ${t.suggestFrom === "hours" ? "från dina arbetstider" : "från dina sparade platser"}`)}</p>` : ""}`;

function viewTrips() {
  const c = car();
  const open = openTrip();
  const m = todayStr().slice(0, 7);
  const list = carTrips(c.id);
  const month = list.filter((t) => (t.date || "").startsWith(m));
  const work = sumMil(month, "tjanst"), priv = sumMil(month, "privat");
  const review = toReview(c.id).sort((a, b) => tsMs(b.startedAt) - tsMs(a.startedAt));
  const recent = list.filter((t) => !(t.auto && !t.kind) && t !== open).slice(0, 5);
  const gaps = tripGaps(c.id);
  const row = (t) => `<button class="dl as-btn" type="button" data-act="edit-trip" data-id="${esc(t.id)}"><div class="dl-ic">${icon("car", 20)}</div><div><div class="dl-t">${esc([t.purpose, t.from && t.to ? `${t.from.split(",")[0]} → ${t.to}` : t.to].filter(Boolean).join(", ") || (t.kind === "privat" ? "Privat resa" : "Tjänsteresa"))}</div><div class="dl-s">${esc([fmtDateShort(t.date), t.kind ? TRIP_KINDS[t.kind] : "Ej genomgången", t.auto ? "GPS" : ""].filter(Boolean).join(" · "))}</div></div><span class="dl-v">${esc(tripMil(t) != null ? `${fmt(tripMil(t), 1)} mil` : "")}</span></button>`;
  const old = open && Date.now() - tsMs(open.startedAt) >= 4 * 36e5;
  return `${subHeader(`Körjournal · ${carName(c)}`, "Resor")}
    <article class="card rz-hero">${open
      ? `<div class="rz-live"><span class="k${old ? " old" : ""}">${old ? "Glömde du avsluta?" : "Resa pågår"}</span><span class="big" data-trip-bar>${esc(tripBarText(open))}</span>
          <span class="s">${esc([open.to ? `Mot ${open.to}` : "", `Startade ${clock(tsMs(open.startedAt))} vid ${fmt(open.odoStart, 1)} mil`].filter(Boolean).join(" · "))}</span>
          <div class="row"><button class="rz-stop" type="button" data-act="start-trip"><span class="tb-sq"></span> Avsluta</button>${open.to ? `<button class="rz-ghost" type="button" data-act="trip-nav">Vägbeskrivning</button>` : ""}</div></div>`
      : `<button class="rz-start" type="button" data-act="trip-start-now">${icon("gauge", 24)} Starta resa</button><button class="link rz-link" type="button" data-act="new-trip">Logga en resa i efterhand</button>`}</article>
    ${review.length ? `<article class="card"><h2>${esc(`${review.length} ${review.length === 1 ? "resa" : "resor"} att gå igenom`)}</h2><div class="rows">${review.map((t) => `<div class="swipe-wrap"><span class="sw-bg sw-work">Tjänst</span><span class="sw-bg sw-priv">Privat</span><div class="dl swipe-row" data-id="${esc(t.id)}"><div class="dl-ic">${icon("car", 20)}</div><div><div class="dl-t">${esc([t.from, t.to].filter(Boolean).join(" → ") || "Resa")}</div><div class="dl-s">${esc(`${fmtDateShort(t.date)} ${clock(tsMs(t.startedAt))}–${clock(tsMs(t.endedAt))} · ${fmt(tripMil(t), 1)} mil · GPS`)}</div>
      ${reviewBtns(t)}</div></div></div>`).join("")}</div>
      <p class="hint" style="margin-top:8px">Svep åt höger för Tjänst och åt vänster för Privat.</p></article>` : ""}
    ${gaps.length ? `<article class="card gap-card"><h2>${esc(gaps.length === 1 ? "En lucka i körjournalen" : `${gaps.length} luckor i körjournalen`)}</h2>
      <p class="muted" style="margin-top:0">Mätaren har gått längre mellan resorna än det som är loggat.</p>
      <div class="rows">${gaps.slice(0, 3).map((g) => `<div class="dl"><div class="dl-ic">${icon("gauge", 20)}</div><div><div class="dl-t">${esc(gapText(g))}</div><div class="dl-s">${esc(`Mätaren ${fmt(num(g.a.odoEnd), 1)} → ${fmt(num(g.b.odoStart), 1)} mil`)}</div>
        <div class="review-btns"><button class="btn-soft" type="button" data-act="gap-add" data-a="${esc(g.a.id)}" data-b="${esc(g.b.id)}">Lägg till resa</button><button class="link" type="button" data-act="gap-ok" data-b="${esc(g.b.id)}">Det stämmer</button></div></div></div>`).join("")}</div></article>` : ""}
    <article class="card"><h2>${esc(MONTHS[new Date().getMonth()].replace(/^./, (x) => x.toUpperCase()))}</h2><div class="rz-tiles">
      <div class="rz-tile"><small>I tjänsten</small><b>${esc(fmt(work, 1))}</b> mil</div>
      <div class="rz-tile"><small>Ersättning</small><b>${esc(fmtKr(work * MIL_RATE))}</b> kr</div>
      <div class="rz-tile"><small>Privat</small><b>${esc(fmt(priv, 1))}</b> mil</div></div>
      <p class="hint" style="margin-top:10px">${esc(`Ersättningen räknas med ${MIL_RATE} kr per mil, Skatteverkets skattefria belopp för egen bil.`)}</p></article>
    <article class="card"><h2>Senaste resorna ${list.length ? `<button class="link" type="button" data-act="trips">Alla</button>` : ""}</h2>
      ${recent.length ? `<div class="rows">${recent.map(row).join("")}</div>` : `<p class="muted">Inga resor än. Tryck på Starta resa när du åker.</p>`}
      ${list.length ? `<div class="ask"><button class="btn-soft" type="button" data-act="trip-year">${icon("print", 16)} Årsrapport (PDF)</button><button class="btn-soft" type="button" data-act="export-trips">Ladda ner som kalkylark</button></div>` : ""}</article>
    <article class="card"><h2>Sparade platser</h2>
      <p class="muted" style="margin-top:0">Resor som börjar eller slutar vid en sparad plats får platsens namn, och appen föreslår tjänst eller privat.</p>
      ${S.places.length ? `<div class="rows">${S.places.map((p) => `<button class="dl as-btn" type="button" data-act="edit-place" data-id="${esc(p.id)}"><div class="dl-ic">${icon("pin", 20)}</div><div><div class="dl-t">${esc(p.name)}</div><div class="dl-s">${esc([p.addr, p.kind ? PLACE_KINDS[p.kind] : ""].filter(Boolean).join(" · "))}</div></div></button>`).join("")}</div>` : ""}
      <div class="ask"><button class="btn-soft" type="button" data-act="new-place">${icon("plus", 16)} Lägg till plats</button></div></article>
    <article class="card trip-settings"><h2>Inställningar för körjournalen</h2>
      ${autoTripsHtml()}
      ${workHoursHtml()}
      <button class="dl as-btn" type="button" data-act="trips-off"><span class="dl-ic">${icon("close", 18)}</span><span><span class="dl-t">Dölj fliken Resor</span><span class="dl-s">Resorna finns kvar. Slå på den igen under Inställningar → Bildagboken Plus.</span></span><span class="dl-v">›</span></button></article>`;
}

/* Automatisk körjournal (iPhone-appen från 1.2): telefonen känner av när bilen körs och mäter vägen med GPS.
   Resorna sparas i telefonen (TripTracker.swift) och läggs in här när appen öppnas. Mätarställningen räknas
   ut från den senast kända och den körda sträckan, och markeras som beräknad. */
const autoAvailable = () => NATIVE && !ANDROID && tripsOn();
const tracker = () => nativePlugin("TripTracker");
const toReview = (cid = S.carId) => S.trips.filter((t) => t.carId === cid && t.auto && !t.kind);

// Mina inställningar för körjournalen (sparas på mig i hushållet): arbetstider och bara resor i mina bilar.
const myInfo = () => S.house?.memberInfo?.[uid()] || {};
const saveMyInfo = (k, v) => {
  if (!S.house) return;
  S.house.memberInfo = { ...(S.house.memberInfo || {}), [uid()]: { ...myInfo(), [k]: v } };
  updateDoc(doc(db, "households", S.hid), { [`memberInfo.${uid()}.${k}`]: v }).catch(onWriteError);
};
/* Arbetstider: resor inom tiden föreslås som Tjänst, utanför som Privat (om ingen sparad plats säger något annat). */
const WORK_DEFAULT = { on: false, days: [1, 2, 3, 4, 5], from: "07:00", to: "17:00" };
const workHours = () => ({ ...WORK_DEFAULT, ...(myInfo().workHours || {}) });
const hm = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
function kindFromHours(ms) {
  const w = workHours();
  if (!w.on || !ms) return null;
  const d = new Date(ms), min = d.getHours() * 60 + d.getMinutes();
  return w.days.includes(d.getDay()) && min >= hm(w.from) && min < hm(w.to) ? "tjanst" : "privat";
}
const WORK_DAYS = [[1, "Mån"], [2, "Tis"], [3, "Ons"], [4, "Tor"], [5, "Fre"], [6, "Lör"], [0, "Sön"]];

// Vägen som telefonen mätte, som en kort textsträng (Googles format för linjer). Avkodas till [[lat, lon], ...].
function decodePath(str) {
  const out = [];
  if (typeof str !== "string" || !str) return out;
  let i = 0, lat = 0, lon = 0;
  const next = () => { let r = 0, sh = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < str.length); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < str.length) { lat += next(); lon += next(); out.push([lat / 1e5, lon / 1e5]); }
  return out;
}
function encodePath(pts) {
  let out = "", pLat = 0, pLon = 0;
  const enc = (v) => { let x = v < 0 ? ~(v << 1) : v << 1; while (x >= 0x20) { out += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; } out += String.fromCharCode(x + 63); };
  for (const [a, b] of pts) { const la = Math.round(a * 1e5), lo = Math.round(b * 1e5); enc(la - pLat); enc(lo - pLon); pLat = la; pLon = lo; }
  return out;
}
const pathLen = (pts) => pts.reduce((s2, p, i) => (i ? s2 + distM({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: p[0], lon: p[1] }) : 0), 0);

// Bilens Bluetooth eller CarPlay: kopplas till en bil, så att GPS-resor hamnar på rätt bil.
const carByBt = (name) => (name ? S.cars.find((x) => !x.deletedAt && (x.btNames || []).includes(name)) || null : null);
const btLabel = (name) => String(name || "").replace(/^CarPlay: /, "CarPlay · ");

/* Sparade platser: Hem, Kontoret, Kund: Volvo och så vidare. En resa som börjar eller slutar inom 250 meter
   från en sparad plats får platsens namn. Är platsen markerad som tjänst eller privat föreslås det för resan. */
const PLACE_NEAR = 250;
function placeAt(loc) {
  if (!loc || loc.lat == null || loc.lon == null) return null;
  let best = null, bestD = PLACE_NEAR;
  for (const p of S.places) { const d = distM(p, loc); if (d <= bestD) { best = p; bestD = d; } }
  return best;
}
// Tjänst om någon av platserna är en tjänsteplats, annars privat om någon är privat.
const kindFromPlaces = (...ps) => (ps.some((p) => p?.kind === "tjanst") ? "tjanst" : ps.some((p) => p?.kind === "privat") ? "privat" : null);
const placeByName = (name) => { const n = String(name || "").trim().toLowerCase(); return n ? S.places.find((p) => String(p.name).toLowerCase() === n) || null : null; };
const PLACE_KINDS = { "": "Inget förslag", tjanst: "Tjänst", privat: "Privat" };

// Telefonen får platserna, så att notisen efter en automatisk resa kan skriva "Hem → Kontoret".
let placesSent = "";
function sendPlacesToPhone() {
  if (!autoAvailable()) return;
  const json = JSON.stringify({ places: S.places.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, kind: p.kind || "" })), lang: EN ? "en" : "sv" });
  if (json === placesSent) return;
  placesSent = json;
  try { Promise.resolve(tracker()?.setPlaces(JSON.parse(json))).catch(() => {}); } catch { /* äldre version av appen */ }
}

/* Luckor: mätaren vid starten av en resa jämförs med mätaren när förra resan slutade. Skillnaden är mil som
   inte finns i körjournalen. Från en halv mil räknas det som en lucka, om man inte har sagt att det stämmer. */
const GAP_MIN = 0.5;
function tripGaps(cid = S.carId) {
  const list = carTrips(cid).filter((t) => num(t.odoStart) != null).sort((a, b) => num(a.odoStart) - num(b.odoStart) || tsMs(a.startedAt) - tsMs(b.startedAt));
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    const end = num(a.odoEnd);
    if (end == null || b.gapOk) continue;
    const mil = Math.round((num(b.odoStart) - end) * 10) / 10;
    if (mil >= GAP_MIN) out.push({ a, b, mil });
  }
  return out.reverse();
}
const gapText = (g) => {
  const d1 = fmtDateShort(g.a.date), d2 = fmtDateShort(g.b.date);
  return `${fmt(g.mil, 1)} mil som inte är loggade ${d1 === d2 ? `den ${d1}` : `mellan ${d1} och ${d2}`}`;
};
function autoTripsHtml() {
  if (!tripsOn()) return "";
  if (!NATIVE || ANDROID) return `<div class="dl"><span class="dl-ic">${icon("phone", 18)}</span><span><span class="dl-t">Automatisk körjournal</span><span class="dl-s">Finns i iPhone-appen. Den känner av när bilen körs och mäter vägen själv.</span></span><span></span></div>`;
  const st = S.autoStatus;
  if (!st) return "";
  const on = !!st.enabled;
  const sw = `<label class="ios-switch-row auto-row"><span><b>Automatisk körjournal</b><small>${esc(on
    ? st.driving ? `Kör nu${st.meters ? ` · ${fmt(st.meters / 1000, 1)} km` : ""}` : "Känner av när bilen körs och mäter vägen, även när appen är stängd."
    : "Känner av när bilen körs och mäter vägen, även när appen är stängd. Du väljer tjänst eller privat efteråt.")}</small></span>
    <input type="checkbox" class="ios-switch" data-act="auto-toggle"${on ? " checked" : ""} aria-label="Automatisk körjournal"></label>`;
  if (!on) return sw;
  // Det som saknas för att resorna ska mätas i bakgrunden, med en knapp som rättar det.
  let fix = "";
  if (st.auth === "denied") fix = autoFix("Appen får inte använda platsen", "Utan platsen kan resorna inte mätas. Tryck nedan och välj Plats → Alltid.", "Öppna inställningar", "settings");
  else if (st.auth !== "always") fix = autoFix("Platsen behöver vara på Alltid", "Nu mäts resor bara när appen är öppen. Med Alltid mäts de även när telefonen ligger i fickan.", "Tillåt Alltid", "always");
  else if (st.precise === false) fix = autoFix("Exakt plats är avstängd", "Då blir sträckorna fel. Tryck nedan och slå på Exakt plats under Plats.", "Öppna inställningar", "settings");
  const ok = !fix ? `<div class="auto-ok">${icon("check", 16)} Resorna mäts i bakgrunden</div>` : "";
  return `${sw}${fix}${ok}${btHtml(st)}${autoLogHtml(st)}`;
}

// Bilens Bluetooth eller CarPlay: kopplade bilar, förslag att koppla den som telefonen är ansluten till nu,
// och hur man gör en genväg som startar mätningen direkt när telefonen ansluts till bilen.
function btHtml(st) {
  const cars = S.cars.filter((x) => !x.deletedAt);
  const linked = cars.flatMap((x) => (x.btNames || []).map((n) => [x, n]));
  const seen = [st.carNow, ...S.trips.filter((t) => t.auto && t.btName).sort((a, b) => tsMs(b.startedAt) - tsMs(a.startedAt)).map((t) => t.btName)];
  const fresh = [...new Set(seen.filter((n) => n && !carByBt(n)))].slice(0, 2);
  const c = car();
  return `<div class="auto-sub"><b>Bilens Bluetooth och CarPlay</b>
    <p class="hint" style="margin:2px 0 8px">Kopplar du bilens Bluetooth eller CarPlay till en bil hamnar GPS-resorna på rätt bil.</p>
    ${linked.length ? `<div class="rows">${linked.map(([x, n]) => `<div class="dl"><span class="dl-ic">${icon("car", 18)}</span><span><span class="dl-t">${esc(btLabel(n))}</span><span class="dl-s">${esc(carName(x))}</span></span><button class="link" type="button" data-act="bt-unlink" data-car="${esc(x.id)}" data-name="${esc(n)}">Ta bort</button></div>`).join("")}</div>` : ""}
    ${fresh.map((n) => `<div class="bt-new"><span>${esc(`${n === st.carNow ? "Ansluten nu" : "Sedd under en resa"}: ${btLabel(n)}`)}</span>${cars.length > 1
      ? `<div class="review-btns">${cars.map((x) => `<button class="btn-soft${x.id === c.id ? " sug" : ""}" type="button" data-act="bt-link" data-car="${esc(x.id)}" data-name="${esc(n)}">${esc(carName(x))}</button>`).join("")}</div>`
      : `<div class="review-btns"><button class="btn-soft" type="button" data-act="bt-link" data-car="${esc(c.id)}" data-name="${esc(n)}">${esc(`Koppla till ${carName(c)}`)}</button></div>`}</div>`).join("")}
    ${!linked.length && !fresh.length ? `<p class="hint" style="margin:0">Sätt dig i bilen med telefonen ansluten och öppna den här sidan, så kan du koppla den.</p>` : ""}
    ${linked.length ? `<label class="ios-switch-row auto-row"><span><b>Bara resor i mina bilar</b><small>Resor utan någon av bilarna ovan sparas inte, till exempel med buss eller i någon annans bil. Kräver att telefonen ansluts till bilen varje gång.</small></span>
      <input type="checkbox" class="ios-switch" data-act="bt-only"${myInfo().autoOnlyCars ? " checked" : ""} aria-label="Bara resor i mina bilar"></label>` : ""}
    <details class="more"><summary>Starta direkt när du sätter dig i bilen</summary>
      <p class="hint">Med en automation i appen Genvägar startar mätningen så fort telefonen ansluts till bilen, i stället för när du har kört en bit.</p>
      <ol class="steps">
        <li>Öppna appen <b>Genvägar</b> och tryck på <b>Automation</b> längst ned.</li>
        <li>Tryck på <b>+</b> och välj <b>Bluetooth</b> (eller <b>CarPlay</b>).</li>
        <li>Välj bilen, markera <b>Är ansluten</b> och <b>Kör omedelbart</b>. Tryck på <b>Nästa</b>.</li>
        <li>Välj <b>Ny tom automation</b>, tryck på <b>Lägg till åtgärd</b>, sök på <b>Bildagboken</b> och välj <b>Bilen är ansluten</b>.</li>
        <li>Gör gärna en till för <b>Är frånkopplad</b> med <b>Bilen är frånkopplad</b>. Då avslutas resan direkt när du stänger av bilen.</li>
      </ol>
      <p class="hint">Kräver den senaste versionen av appen.</p>
    </details></div>`;
}
// Vad den automatiska körjournalen har gjort senast, för att se varför en resa inte kom med.
const AUTO_LOG_EN = { "Appen startades i bakgrunden av iOS": "iOS started the app in the background", "GPS på, letar efter en bilresa": "GPS on, looking for a drive", "Ingen bilresa, GPS av": "No drive, GPS off", "Resa startad": "Trip started", "Lämnade parkeringen": "Left the parking spot", "Lämnade ett besök": "Left a place", "Bilen ansluten (genväg)": "Car connected (shortcut)", "Bilen frånkopplad (genväg)": "Car disconnected (shortcut)" };
function autoLogHtml(st) {
  const list = Array.isArray(st.log) ? st.log.slice().reverse() : null;
  if (!list) return "";
  const when = (ms) => { const d = new Date(ms); return `${ymd(d) === todayStr() ? "" : `${fmtDateShort(ymd(d))} `}${clock(ms)}`; };
  return `<details class="more auto-log"><summary>Felsökning</summary>
    ${list.length ? `<ul class="auto-log-list">${list.map((x) => `<li><span>${esc(when(x.t))}</span>${esc(EN ? AUTO_LOG_EN[x.m] || x.m : x.m)}</li>`).join("")}</ul>` : `<p class="hint">Inget har hänt än. Här syns när telefonen väcker appen, när en resa startar och varför en förflyttning inte sparades.</p>`}
    <p class="hint">${esc(st.watching ? "GPS:en är på just nu." : "GPS:en är av och väntar på att telefonen ska flytta sig.")}</p></details>`;
}
function workHoursHtml() {
  if (!tripsOn()) return "";
  const w = workHours();
  const days = WORK_DAYS.filter(([d]) => w.days.includes(d)).map(([, l]) => l.toLowerCase());
  const daysTxt = days.length === 5 && !w.days.includes(0) && !w.days.includes(6) ? "mån–fre" : days.join(", ");
  return `<div class="auto-sub work-sub"><label class="ios-switch-row auto-row"><span><b>Arbetstider</b><small>${esc(w.on ? `Resor ${daysTxt} ${w.from}–${w.to} föreslås som Tjänst, övriga som Privat. Sparade platser går före.` : "Resor under arbetstid föreslås som Tjänst, övriga som Privat.")}</small></span>
    <input type="checkbox" class="ios-switch" data-act="work-toggle"${w.on ? " checked" : ""} aria-label="Arbetstider"></label>
    ${w.on ? `<div class="work-hours"><div class="day-chips" role="group" aria-label="Arbetsdagar">${WORK_DAYS.map(([d, l]) => `<button type="button" class="chip-btn" data-act="work-day" data-d="${d}" aria-pressed="${w.days.includes(d)}">${l}</button>`).join("")}</div>
      <div class="row2"><label class="field"><span>Från</span><input type="time" id="wh-from" value="${esc(w.from)}"></label><label class="field"><span>Till</span><input type="time" id="wh-to" value="${esc(w.to)}"></label></div></div>` : ""}</div>`;
}
document.addEventListener("change", (ev) => {
  if (ev.target.id !== "wh-from" && ev.target.id !== "wh-to") return;
  const from = $("#wh-from")?.value || WORK_DEFAULT.from, to = $("#wh-to")?.value || WORK_DEFAULT.to;
  if (hm(to) <= hm(from)) { showToast("Sluttiden ska vara efter starttiden."); return; }
  saveMyInfo("workHours", { ...workHours(), from, to });
  render();
});
function autoFix(title, text, btn, mode) {
  return `<div class="auto-fix"><b>${esc(title)}</b><p>${esc(text)}</p><button class="btn primary" type="button" data-act="auto-allow" data-mode="${mode}">${esc(btn)}</button></div>`;
}
async function refreshAutoStatus() {
  if (!autoAvailable()) return;
  try { S.autoStatus = await tracker().status(); } catch { S.autoStatus = null; return; }
  sendPlacesToPhone();
  await importAutoTrips();
}
// Hämtar resorna som telefonen har mätt och lägger in dem i körjournalen, en gång var.
const autoId = (nid) => "a" + String(nid).replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
// En resa man har startat själv (pågående eller avslutad) som till största delen täcker samma tid som en GPS-resa.
function manualTripAt(start, end) {
  const len = Math.max(60000, end - start);
  return S.trips.find((t) => {
    if (t.auto || !t.startedAt || (t.driver || t.createdBy) !== uid()) return false;
    const a = tsMs(t.startedAt), b = t.odoEnd == null ? Date.now() : tsMs(t.endedAt || t.startedAt);
    return Math.min(b, end) - Math.max(a, start) >= len * 0.4;
  }) || null;
}
async function importAutoTrips() {
  if (importAutoTrips.busy || !autoAvailable() || !S.loaded.entries) return;
  importAutoTrips.busy = true;
  try {
    const res = (await tracker().trips()) || {};
    const list = (res.trips || []).sort((a, b) => a.start - b.start);
    // Tjänst eller Privat som man har tryckt på i notisen, för resor som redan finns i körjournalen.
    const kinds = res.kinds || {};
    const applied = [];
    for (const [nid, k] of Object.entries(kinds)) {
      const t = S.trips.find((x) => x.id === autoId(nid));
      if (t && !t.kind && (k === "tjanst" || k === "privat")) {
        t.kind = k;
        await updateDoc(doc(col("trips"), t.id), { kind: k, reviewedAt: Date.now() });
      }
      if (t || !list.some((r) => r.id === nid)) applied.push(nid);
    }
    if (!list.length) { if (applied.length) { await tracker().clear({ ids: applied }); render(); } return; }
    const odoBy = new Map();
    const done = [...applied];
    for (const r of list) {
      const id = autoId(r.id);
      if (S.trips.some((t) => t.id === id)) { done.push(r.id); continue; }
      // Samma sträcka som en resa man har startat själv: ingen ny resa. GPS-punkterna läggs i den resan
      // om den saknar dem, och mätarställningen man läste av gäller.
      const own = manualTripAt(r.start, r.end);
      if (own) {
        const add = clean({ startLoc: okLoc(own.startLoc) ? undefined : { lat: r.startLat, lon: r.startLon }, endLoc: okLoc(own.endLoc) || own.odoEnd == null ? undefined : { lat: r.endLat, lon: r.endLon }, autoMeters: r.meters });
        Object.assign(own, add);
        await updateDoc(doc(col("trips"), own.id), add).catch(() => {});
        done.push(r.id);
        continue;
      }
      // Rätt bil: den som bilens Bluetooth eller CarPlay är kopplad till, annars den som är vald.
      const byBt = carByBt(r.car);
      if (myInfo().autoOnlyCars && !byBt) { done.push(r.id); continue; }
      const c = byBt || car();
      if (!odoBy.has(c.id)) odoBy.set(c.id, odoOf(c));
      let odo = odoBy.get(c.id);
      const mil = Math.round(r.meters / 1000) / 10;
      const startLoc = { lat: r.startLat, lon: r.startLon }, endLoc = { lat: r.endLat, lon: r.endLon };
      const pFrom = placeAt(startLoc), pTo = placeAt(endLoc);
      const picked = r.kind || kinds[r.id];
      const kind = picked === "tjanst" || picked === "privat" ? picked : null;
      const odoStart = odo != null ? Math.round(odo * 10) / 10 : null;
      const odoEnd = odoStart != null ? Math.round((odoStart + mil) * 10) / 10 : null;
      const data = clean({
        carId: c.id, date: ymd(new Date(r.start)), odoStart, odoEnd, auto: true, odoEstimated: true, autoMeters: r.meters,
        startLoc, endLoc,
        from: pFrom?.name || null, to: pTo?.name || null, purpose: null, kind, driver: uid(),
        suggestKind: kind ? null : kindFromPlaces(pFrom, pTo) || kindFromHours(r.start), reviewedAt: kind ? Date.now() : null,
        suggestFrom: kind ? null : kindFromPlaces(pFrom, pTo) ? "places" : kindFromHours(r.start) ? "hours" : null,
        path: typeof r.path === "string" && r.path.length < 60000 ? r.path : null, btName: r.car || null,
        startedAt: r.start, endedAt: r.end, createdBy: uid(), createdAt: Date.now(),
      });
      await setDoc(doc(col("trips"), id), data);
      S.trips = [...S.trips, { id, ...data }];
      if (odoEnd != null) odoBy.set(c.id, odoEnd);
      done.push(r.id);
      // Adresserna fylls i efteråt, en i taget (OpenStreetMap vill inte ha för många frågor på en gång).
      // Sparade platser har redan sina namn.
      if (!pFrom || !pTo) (async () => {
        const from = pFrom ? "" : await reverseAddress(r.startLat, r.startLon).catch(() => "");
        const to = pTo ? "" : await reverseAddress(r.endLat, r.endLon).catch(() => "");
        if (from || to) updateDoc(doc(col("trips"), id), clean({ from: from || undefined, to: to || undefined })).catch(() => {});
      })();
    }
    if (done.length) await tracker().clear({ ids: done });
    render();
  } catch { /* försöker igen nästa gång appen öppnas */ } finally { importAutoTrips.busy = false; }
}
// Tillbaka i appen, till exempel från Inställningar: kolla om platsen nu är på Alltid.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const before = S.autoStatus;
  refreshAutoStatus().then(() => {
    const now = S.autoStatus;
    if (before?.enabled && now?.enabled && (before.auth !== "always" || before.precise === false) && now.auth === "always" && now.precise !== false) showToast("Klart! Resorna mäts nu i bakgrunden.", 5000);
    if (S.view === "bilen" || S.view === "resor") render();
  });
});

// Gå igenom automatiska resor: tjänst eller privat med ett tryck, eller öppna resan för att fylla i mer.
function reviewSheet() {
  const list = toReview().sort((a, b) => tsMs(a.startedAt) - tsMs(b.startedAt));
  if (!list.length) { closeSheet(); return showToast("Alla resor är genomgångna"); }
  openSheet("Resor att gå igenom", `<p class="muted" style="margin-top:0">Resorna har mätts med GPS. Mätarställningen är beräknad från den senast kända och sträckan.</p>
    <div class="rows">${list.map((t) => `<div class="dl review-row"><div class="dl-ic">${icon("car", 20)}</div><div><div class="dl-t">${esc([t.from, t.to].filter(Boolean).join(" → ") || "Resa")}</div><div class="dl-s">${esc(`${fmtDateShort(t.date)} ${clock(tsMs(t.startedAt))}–${clock(tsMs(t.endedAt))} · ${fmt(tripMil(t), 1)} mil`)}</div>
      ${reviewBtns(t)}</div></div>`).join("")}</div>`);
}

// Raden för pågående resa (som i Spotify): syns ovanför menyn i hela appen så länge en resa pågår.
// Efter fyra timmar frågar den om man glömde avsluta. Tid och ungefärlig sträcka uppdateras av tickTrip().
const hmm = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
function tripBarText(o) {
  const est = S.tripEst?.id === o.id ? S.tripEst.mil : null;
  return `${hmm(Date.now() - tsMs(o.startedAt))}${est != null ? ` · ca ${fmt(est, 1)} mil` : ""}`;
}
function renderTripBar() {
  const o = S.user && S.hid && S.loaded.entries && tripsOn() && S.view !== "resor" ? openTrip() : null;
  let bar = document.getElementById("tripbar");
  document.body.classList.toggle("has-tripbar", !!o);
  if (!o) { bar?.remove(); return; }
  const old = Date.now() - tsMs(o.startedAt) >= 4 * 36e5;
  const html = `<button class="tb-main" type="button" ${tripsVisible() ? `data-go="resor"` : `data-act="start-trip"`} aria-label="Pågående resa. Tryck för att se resan.">
      <span class="tb-ic">${icon("car", 22)}<span class="tb-dot"></span></span>
      <span class="tb-txt"><span class="tb-k${old ? " old" : ""}">${old ? "Glömde du avsluta?" : "Resa pågår"}</span><span class="tb-t" data-trip-bar>${esc(tripBarText(o))}</span>${o.to ? `<span class="tb-s">${esc(`Mot ${o.to}`)}</span>` : ""}</span>
    </button>
    <button class="tb-stop" type="button" data-act="start-trip"><span class="tb-sq"></span>Avsluta</button>`;
  if (!bar) { document.body.insertAdjacentHTML("beforeend", `<div class="tripbar" id="tripbar">${html}</div>`); bar = document.getElementById("tripbar"); }
  else if (bar.dataset.key !== `${o.id}|${o.to}|${old}`) bar.innerHTML = html;
  bar.dataset.key = `${o.id}|${o.to}|${old}`;
  if (EN && typeof trTree === "function") trTree(bar);
}


// Pågående resa i Dynamic Island och på låsskärmen (iPhone-appen från 1.2). Visas bara för den som kör,
// och klockan räknar själv i telefonen, så den går även när appen är stängd. Skickas bara när något ändras.
let liveSent = null;
function updateLiveActivity() {
  if (!NATIVE || ANDROID || !S.user || !S.hid || !S.loaded.entries) return;
  const o = tripsOn() ? S.trips.find((t) => t.odoEnd == null && !t.auto && (t.driver || t.createdBy) === uid()) : null;
  const c = o && S.cars.find((x) => x.id === o.carId);
  const trip = o ? { id: o.id, start: tsMs(o.startedAt), from: o.from || "", to: o.to || "", car: c ? carName(c) : "", kind: o.kind === "privat" ? "privat" : "tjanst", lang: EN ? "en" : "sv" } : null;
  const key = JSON.stringify(trip);
  if (key === liveSent) return;
  liveSent = key;
  try { Promise.resolve(nativePlugin("TripActivity")?.sync(trip ? { trip } : {})).catch(() => {}); } catch { /* finns inte i den här versionen */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { liveSent = null; updateLiveActivity(); } });

// Mode: "new" (hela resan), "start" (bara början) eller "end" (avsluta en pågående resa).
function tripForm(t = {}, mode = "new") {
  const c = car();
  const prev = carTrips()[0];
  const members = S.house?.members || [uid()];
  const count = (k) => { const m = new Map(); for (const x of S.trips) { const v = String(x[k] || "").trim(); if (v) m.set(v, (m.get(v) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v]) => v); };
  const list = (id, vals) => `<datalist id="${id}">${vals.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;
  // Mätarställningen läses av i bilen varje gång. Senast kända står som ledtext, så att man ser om något verkar fel.
  const odoStart = t.odoStart;
  const lastOdo = odoOf(c);
  const kind = t.kind || (!t.id ? kindFromHours(Date.now()) : null) || prev?.kind || "tjanst";
  const title = mode === "start" ? "Starta resa" : mode === "end" ? "Avsluta resan" : t.id ? "Ändra resa" : "Resa";
  openSheet(title, `
    <form class="form" data-form="trip" data-mode="${mode}"${t.gap ? ` data-gap="1"` : ""} data-start="${odoStart ?? ""}"${t.id ? ` data-id="${esc(t.id)}"` : ""} novalidate>
      ${mode === "end" ? `<p class="muted" style="margin-top:0">${esc(`Startade ${clock(tsMs(t.startedAt))} vid ${fmt(t.odoStart, 1)} mil.`)}</p>` : ""}
      ${mode === "new" && t.id && tripEnds(t) ? `<div class="bk-map trip-map" id="tr-map"><div class="bk-map-inner" id="tr-map-inner"></div>
        <button class="bk-map-open" type="button" data-act="trip-map-open" data-id="${esc(t.id)}" aria-label="Visa resan i en kartapp"><span>${icon("pin", 14)} Öppna i kartan</span></button></div>
        <div class="trip-ends"><span><i class="te-a"></i>${esc(t.from || "Start")}${t.startedAt ? ` · ${clock(tsMs(t.startedAt))}` : ""}</span><span><i class="te-b"></i>${esc(t.to || "Mål")}${t.endedAt ? ` · ${clock(tsMs(t.endedAt))}` : ""}</span></div>` : ""}
      ${t.edits?.length ? `<div class="hint" style="margin-top:0"><b>Ändrad i efterhand</b>${t.edits.slice(-5).reverse().map((e) => `<br>${esc(editLine(e))}`).join("")}</div>` : ""}
      ${mode === "end" ? "" : `<div class="row2">
        ${field("Datum", `<input type="date" name="date" id="tr-date" value="${esc(t.date || todayStr())}">`)}
        ${field("Mätare vid start (mil)", `<input name="odoStart" id="tr-odoStart" inputmode="decimal" required value="${odoStart != null ? esc(String(odoStart).replace(".", ",")) : ""}" placeholder="${lastOdo != null ? esc(`Senast ${fmt(lastOdo, 1)}`) : ""}">`)}
      </div>
      ${t.id ? "" : `<p class="hint" style="margin-top:-6px">Läs av mätaren i bilen${lastOdo != null ? esc(`. Senast kända är ${fmt(lastOdo, 1)} mil`) : ""}.</p>`}`}
      ${mode === "start" ? "" : field("Mätare vid slut (mil)", `<input name="odoEnd" id="tr-odoEnd" inputmode="decimal" required value="${t.odoEnd != null ? esc(String(t.odoEnd).replace(".", ",")) : ""}" placeholder="Läs av mätaren i bilen">`, `<span id="tr-dist">${t.odoEnd != null ? esc(`${fmt(tripMil(t), 1)} mil`) : "Mil med en decimal. 1,2 mil är 12 km."}</span>`)}
      ${mode === "end" ? `<div id="tr-route" hidden></div><input type="hidden" name="endPos" id="tr-endPos">` : ""}
      ${mode === "start" ? `<input type="hidden" name="startPos" id="tr-startPos">` : ""}
      ${field("Från", `<span class="geo-row"><input name="from" id="tr-from" value="${esc(t.from ?? (mode === "new" && !t.id ? prev?.to || "" : ""))}" placeholder="Ort, adress eller företag" autocomplete="off"><button class="geo-btn" type="button" data-act="trip-here" aria-label="Använd min plats" title="Använd min plats">${icon("pin", 20)}</button></span><span class="suggest" id="tr-from-suggest" role="listbox" hidden></span><input type="hidden" name="fromLoc" id="tr-fromLoc" value="${t.fromLoc ? esc(JSON.stringify(t.fromLoc)) : ""}">`)}
      ${field("Vart", `<input name="to" id="tr-to" value="${esc(t.to || "")}" placeholder="Ort, adress eller företag" autocomplete="off"><span class="suggest" id="tr-to-suggest" role="listbox" hidden></span><input type="hidden" name="toLoc" id="tr-toLoc" value="${t.toLoc ? esc(JSON.stringify(t.toLoc)) : ""}">`)}
      ${field("Ärende", `<input name="purpose" id="tr-purpose" value="${esc(t.purpose || "")}" list="tr-purpose-list" autocomplete="off">${list("tr-purpose-list", count("purpose"))}`)}
      <div class="row2">
        ${field("Typ av resa", `<select name="kind" id="tr-kind">${Object.entries(TRIP_KINDS).map(([k, l]) => `<option value="${k}"${kind === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
        ${field("Förare", `<select name="driver" id="tr-driver">${members.map((m) => `<option value="${esc(m)}"${(t.driver || uid()) === m ? " selected" : ""}>${esc(m === uid() ? `${memberName(m)} (du)` : memberName(m))}</option>`).join("")}</select>`)}
      </div>
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">${mode === "start" ? "Starta resan" : mode === "end" ? "Avsluta och spara" : "Spara"}</button>
      ${mode === "new" && t.id && t.odoEnd != null ? (() => {
        const nx = nextTripOf(t);
        return `<div class="trip-tools">${nx ? `<button class="btn ghost" type="button" data-act="trip-merge" data-id="${esc(t.id)}">${esc(`Slå ihop med nästa (${clock(tsMs(nx.startedAt))})`)}</button>` : ""}${tripMil(t) >= 0.2 ? `<button class="btn ghost" type="button" data-act="trip-split" data-id="${esc(t.id)}">Dela resan</button>` : ""}</div>`;
      })() : ""}
      ${t.id ? `<button class="btn danger block" type="button" data-act="delete-trip" data-id="${esc(t.id)}" style="margin-top:10px">Ta bort resan</button>` : ""}
      ${mode === "start" ? `<p class="hint">Fyll i mätarställningen när du kommer fram, under Bilen eller i plusmenyn.</p>` : ""}
      ${mode === "start" && S.autoStatus?.enabled ? `<p class="hint">Den automatiska körjournalen är på. Den sparar ingen egen resa för samma sträcka, den här gäller.</p>` : ""}
    </form>`, { back: t.id && mode === "new" ? "trips" : null });
  if (mode === "end" && !window.matchMedia("(pointer: coarse)").matches) $("#tr-odoEnd")?.focus({ preventScroll: true });
  if (mode === "end") suggestTripDistance(t);
  if (mode === "new" && t.id && tripEnds(t)) tripMap($("#tr-map-inner"), ...tripEnds(t), decodePath(t.path));
  if (mode === "start" && !t.from) fillTripFrom(false);
}

// En sparad plats som Från eller Vart: platsens namn, och förslag på tjänst eller privat (om man inte själv har valt).
const placeLoc = (name) => { const p = placeByName(name); return p ? clean({ name: p.name, addr: p.addr || null, lat: p.lat, lon: p.lon }) : null; };
function tripPlaceOf(which) {
  const name = $(`#tr-${which}`)?.value;
  let loc = null; try { loc = JSON.parse($(`#tr-${which}Loc`)?.value || "null"); } catch { /* inget */ }
  return placeByName(name) || placeAt(loc);
}
function suggestTripKind() {
  const sel = $("#tr-kind");
  if (!sel || sel.dataset.touched) return;
  const k = kindFromPlaces(tripPlaceOf("from"), tripPlaceOf("to"));
  if (k) sel.value = k;
}

// Sparade platser: namn, adress (sök eller använd min plats) och om resor dit brukar vara tjänst eller privat.
function placeForm(p = {}) {
  openSheet(p.id ? "Ändra plats" : "Ny plats", `
    <form class="form" data-form="place"${p.id ? ` data-id="${esc(p.id)}"` : ""} novalidate>
      ${field("Namn", `<input name="name" id="pl-name" required value="${esc(p.name || "")}" autocomplete="off">`)}
      ${field("Adress", `<span class="geo-row"><input name="addr" id="pl-addr" required value="${esc(p.addr || "")}" placeholder="Sök adress eller företag" autocomplete="off"><button class="geo-btn" type="button" data-act="place-here" aria-label="Använd min plats" title="Använd min plats">${icon("pin", 20)}</button></span><span class="suggest" id="pl-addr-suggest" role="listbox" hidden></span>
        <input type="hidden" name="lat" id="pl-lat" value="${p.lat ?? ""}"><input type="hidden" name="lon" id="pl-lon" value="${p.lon ?? ""}">`, "Välj i listan, eller tryck på nålen när du är på platsen.")}
      ${field("Resor hit är oftast", `<select name="kind" id="pl-kind">${Object.entries(PLACE_KINDS).map(([k, l]) => `<option value="${k}"${(p.kind || "") === k ? " selected" : ""}>${l}</option>`).join("")}</select>`, "Till exempel Tjänst för kontoret och kunder. Hem kan stå på Inget förslag.")}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button>
      ${p.id ? `<button class="btn danger block" type="button" data-act="delete-place" data-id="${esc(p.id)}" style="margin-top:10px">Ta bort platsen</button>` : ""}
    </form>`);
}
function savePlace(form) {
  const fd = new FormData(form);
  const name = String(fd.get("name") || "").trim(), addr = String(fd.get("addr") || "").trim();
  const lat = num(fd.get("lat")), lon = num(fd.get("lon"));
  if (!name) return formError("Skriv ett namn på platsen.");
  if (lat == null || lon == null) return formError("Välj adressen i listan, eller tryck på nålen när du är på platsen.");
  if (S.places.some((p) => p.id !== form.dataset.id && p.name.toLowerCase() === name.toLowerCase())) return formError("Det finns redan en plats med det namnet.");
  const id = form.dataset.id || "p" + randomId(10);
  const old = S.places.find((p) => p.id === id);
  const data = clean({ name, addr: addr || null, lat, lon, kind: fd.get("kind") || null, createdBy: old?.createdBy || uid(), createdAt: old?.createdAt || Date.now() });
  setDoc(doc(col("places"), id), data).catch(onWriteError);
  S.places = [...S.places.filter((p) => p.id !== id), { id, ...data }].sort((a, b) => a.name.localeCompare(b.name, "sv"));
  sendPlacesToPhone();
  closeSheet(); render();
  showToast(old ? "Platsen är ändrad" : `${name} är sparad`);
}

// Från: adressen där man är. Automatiskt när en resa startas (skriver inte över det man själv har skrivit), eller med knappen.
async function fillTripFrom(manual) {
  const input = $("#tr-from");
  if (!input) return;
  // När en resa startas: en ny GPS-position (inte en sparad), som blir resans startpunkt och ger adressen.
  const start = $("#tr-startPos");
  const loc = start ? await freshTripPosition() : await tripPosition();
  if (loc && start && document.contains(start)) start.value = tripLocJson(loc);
  if (!loc) { if (manual) showToast("Kunde inte hitta din position. Skriv var du startar.", 5000); return; }
  const saved = placeAt(loc);
  const addr = saved?.name || await reverseAddress(loc.lat, loc.lon).catch(() => "");
  if (!addr || !document.contains(input) || (!manual && (input.value.trim() || input.dataset.touched))) return;
  input.value = addr;
  const h = $("#tr-fromLoc"); if (h) h.value = JSON.stringify({ addr, lat: loc.lat, lon: loc.lon });
}

// Senaste målen, när fältet Vart är tomt.
const savedPlaceBtns = (field, list = S.places) => list.map((p) => `<button type="button" role="option" data-act="place-pick" data-kind="${field}" data-place="${esc(p.id)}" data-name="${esc(p.name)}" data-addr="${esc(p.addr || "")}" data-lat="${p.lat}" data-lon="${p.lon}"><b>${esc(p.name)}</b>${p.addr ? `<span>${esc(p.addr)}</span>` : ""}</button>`).join("");
function recentTripTargets(field = "tr-to") {
  const box = $(`#${field}-suggest`);
  if (!box) return;
  const seen = new Set(S.places.map((p) => p.name));
  const recent = field === "tr-to" ? carTrips().filter((t) => t.to && !seen.has(t.to) && seen.add(t.to)).slice(0, 5) : [];
  if (!recent.length && !S.places.length) { box.hidden = true; return; }
  box.innerHTML = (S.places.length ? `<p class="hint">Sparade platser</p>${savedPlaceBtns(field)}` : "") + (recent.length ? `<p class="hint">Senaste målen</p>` : "") + recent.map((t) => `<button type="button" role="option" data-act="place-pick" data-kind="tr-to" data-name="${esc(t.to)}" data-addr="${esc(t.toLoc?.addr || "")}" data-lat="${t.toLoc?.lat ?? ""}" data-lon="${t.toLoc?.lon ?? ""}" data-pid="${esc(t.toLoc?.pid || "")}"><b>${esc(t.to)}</b>${t.toLoc?.addr && t.toLoc.addr !== t.to ? `<span>${esc(t.toLoc.addr)}</span>` : ""}</button>`).join("");
  box.hidden = false;
}

// Var man är just nu, för körjournalen. Ger null om platsen inte går att få (tillåts inte, eller tar för lång tid).
const tripPosition = () => currentPosition().then((p) => ({ lat: p.coords.latitude, lon: p.coords.longitude })).catch(() => null);
// Vid start och slut av en resa: en ny GPS-position, aldrig en sparad. Lyssnar några sekunder och tar den
// säkraste, så att punkten inte är var man var för en stund sedan (eller där resan startade).
function freshTripPosition(maxWait = 12000, good = 25) {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    let best = null, id = null;
    const done = () => { if (id != null) navigator.geolocation.clearWatch(id); clearTimeout(timer); resolve(best); };
    const timer = setTimeout(done, maxWait);
    id = navigator.geolocation.watchPosition((p) => {
      const acc = p.coords.accuracy ?? 9999;
      if (!best || acc < best.acc) best = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(acc), at: p.timestamp || Date.now() };
      if (acc <= good) done();
    }, () => { if (!best) done(); }, { enableHighAccuracy: true, maximumAge: 0, timeout: maxWait });
  });
}
const tripLocJson = (loc) => (loc ? JSON.stringify(loc) : "");

// Förslag på mätarställning vid slut: körsträckan enligt Apple Kartor, från där resan startade till där man är nu
// (eller till målet). Mätaren gäller alltid; förslaget går att trycka på för att fylla i.
// Körsträckan med bil mellan två platser enligt Apple Kartor, i mil med en decimal.
async function routeMil(from, to) {
  const mk = await loadMapKit();
  const route = await new Promise((resolve, reject) => {
    new mk.Directions().route({
      origin: new mk.Coordinate(from.lat, from.lon),
      destination: new mk.Coordinate(to.lat, to.lon),
      transportType: mk.Directions.Transport.Automobile,
    }, (err, data) => (err ? reject(err) : resolve(data?.routes?.[0])));
  });
  return route?.distance ? Math.round(route.distance / 1000) / 10 : null;
}

// Medan en resa pågår: hur länge den har pågått, och ungefär hur långt det är från start till där man är nu.
// Tiden uppdateras när appen är öppen. Sträckan räknas om högst varannan minut, bara när appen syns.
const durText = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} tim ${m % 60} min`; };
function tripLiveText(o) {
  const est = S.tripEst?.id === o.id ? S.tripEst.mil : null;
  return [`Pågått ${durText(Date.now() - tsMs(o.startedAt))}`, est != null ? `ca ${fmt(est, 1)} mil från start` : ""].filter(Boolean).join(" · ");
}
async function updateTripEstimate() {
  const o = tripsOn() && openTrip();
  if (!o?.startLoc || document.hidden || updateTripEstimate.busy) return;
  if (S.tripEst?.id === o.id && Date.now() - S.tripEst.at < 120000) return;
  updateTripEstimate.busy = true;
  try {
    const here = await tripPosition();
    if (!here) return;
    const near = distM(o.startLoc, here) < 300;
    const mil = near ? 0 : await routeMil(o.startLoc, here).catch(() => null);
    if (mil != null) S.tripEst = { id: o.id, mil, at: Date.now() };
  } finally { updateTripEstimate.busy = false; }
  tickTrip();
}
function tickTrip() {
  const o = tripsOn() && openTrip();
  if (!o) return;
  const text = tripLiveText(o), bar = tripBarText(o);
  document.querySelectorAll("[data-trip-live]").forEach((el) => { el.textContent = EN ? tr(text) : text; });
  document.querySelectorAll("[data-trip-bar]").forEach((el) => { el.textContent = EN ? tr(bar) : bar; });
}
setInterval(() => { tickTrip(); updateTripEstimate(); }, 20000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { tickTrip(); updateTripEstimate(); } });

async function suggestTripDistance(t) {
  const box = $("#tr-route");
  if (!box) return;
  if (!t.startLoc || t.odoStart == null) {
    // Ingen startpunkt: spara ändå var resan slutade.
    const here = await freshTripPosition(), pos = $("#tr-endPos");
    if (here && pos && document.contains(pos)) pos.value = tripLocJson(here);
    return;
  }
  const here = await freshTripPosition();
  const pos = $("#tr-endPos");
  if (here && pos && document.contains(pos)) pos.value = tripLocJson(here);
  const end = here || t.toLoc;
  if (!end || !document.contains(box)) return;
  try {
    const mil = await routeMil(t.startLoc, end);
    if (mil == null || mil < 0.1 || !document.contains(box)) return;
    const odo = Math.round((t.odoStart + mil) * 10) / 10;
    // Bara en kontroll: mätaren i bilen gäller, men kartan visar om siffran verkar rimlig.
    box.innerHTML = `<p class="hint">${icon("pin", 14)} ${esc(`Enligt kartan ca ${fmt(mil, 1)} mil från start, alltså runt ${fmt(odo, 1)} på mätaren.`)}</p>`;
    box.hidden = false;
  } catch { /* utan karta får man läsa av mätaren */ }
}

// Vad som ändrades i en avslutad resa, för att det ska synas om körjournalen har rättats i efterhand.
const TRIP_FIELDS = { date: "datum", odoStart: "mätare start", odoEnd: "mätare slut", from: "från", to: "vart", purpose: "ärende", kind: "typ", driver: "förare" };
function tripChanges(a, b) {
  const show = (k, v) => (v == null || v === "" ? "–" : k.startsWith("odo") ? fmt(v, 1) : k === "kind" ? TRIP_KINDS[v] || v : k === "driver" ? memberName(v) : k === "date" ? fmtDateShort(v) : String(v));
  return Object.keys(TRIP_FIELDS).filter((k) => (a[k] ?? null) !== (b[k] ?? null)).map((k) => `${TRIP_FIELDS[k]} ${show(k, a[k])} → ${show(k, b[k])}`);
}
const editLine = (e) => `${fmtDateShort(ymd(new Date(tsMs(e.at))))} av ${whoName(e.by).replace(/^Du$/, "dig")}${e.changes?.length ? `: ${e.changes.join(", ")}` : ""}`;

const parsePos = (v) => { try { const p = JSON.parse(v || "null"); return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null; } catch { return null; } };
async function saveTrip(form) {
  const c = car();
  const fd = new FormData(form);
  const mode = form.dataset.mode;
  const str = (k) => String(fd.get(k) || "").trim();
  const old = form.dataset.id ? S.trips.find((x) => x.id === form.dataset.id) : null;
  const odoStart = mode === "end" ? old?.odoStart : num(fd.get("odoStart"));
  const odoEnd = mode === "start" ? null : num(fd.get("odoEnd"));
  if (odoStart == null) return formError("Fyll i mätarställningen vid start.");
  if (mode !== "start" && odoEnd == null) return formError("Fyll i mätarställningen vid slut.");
  if (odoEnd != null && odoEnd < odoStart) return formError("Mätarställningen vid slut ska vara högre än vid start.");
  if (odoEnd != null && odoEnd - odoStart > 300) return formError("Sträckan ser för lång ut. Mätarställningen anges i mil, till exempel 21 480,6.");
  // En ny resa som startar lägre än senast kända mätarställning: fråga, det är oftast en felskrivning.
  const lastOdo = odoOf(c);
  if (!old && !form.dataset.gap && lastOdo != null && odoStart < lastOdo - 0.05) {
    const ok = await confirmDialog({ title: "Stämmer mätarställningen?", lines: [`${fmt(odoStart, 1)} mil är lägre än senast kända, ${fmt(lastOdo, 1)} mil.`], okLabel: "Ja, spara", warn: "" });
    if (!ok) return;
  }
  const data = clean({
    carId: old?.carId || c.id,
    date: mode === "end" ? old.date : str("date") || todayStr(),
    odoStart, odoEnd,
    from: mode === "end" ? (str("from") || old?.from || null) : str("from") || null,
    fromLoc: (() => { try { return JSON.parse(str("fromLoc") || "null"); } catch { return null; } })() || (str("from") === old?.from ? old?.fromLoc || null : null) || placeLoc(str("from")),
    to: str("to") || null, toLoc: (() => { try { return JSON.parse(str("toLoc") || "null"); } catch { return null; } })() || (str("to") === old?.to ? old?.toLoc || null : null) || placeLoc(str("to")),
    purpose: str("purpose") || null,
    startLoc: (mode === "start" ? parsePos(str("startPos")) : null) || old?.startLoc || null,
    kind: str("kind") || "tjanst", driver: str("driver") || uid(),
    startedAt: old?.startedAt || Date.now(),
    endedAt: odoEnd != null ? old?.endedAt || Date.now() : null,
    createdBy: old?.createdBy || uid(), createdAt: old?.createdAt || Date.now(),
    // Ändringar i en avslutad resa sparas (vem och när), så att det syns om körjournalen har ändrats i efterhand.
    edits: old?.edits || null,
    // Automatiska resor behåller sina GPS-uppgifter. Ändras mätaren är den inte längre beräknad.
    auto: old?.auto || undefined, autoMeters: old?.autoMeters ?? undefined,
    endLoc: (mode === "end" ? parsePos(str("endPos")) : null) || old?.endLoc || undefined,
    odoEstimated: old?.odoEstimated ? odoStart === old.odoStart && odoEnd === old.odoEnd : undefined,
    reviewedAt: old?.auto && !old.kind ? Date.now() : old?.reviewedAt ?? undefined,
    gapOk: old?.gapOk || undefined, suggestKind: old?.suggestKind || undefined,
  });
  // Ändringar i en avslutad resa sparas: vem, när och vad som ändrades.
  if (old?.odoEnd != null && !(old.auto && !old.kind)) {
    const changes = tripChanges(old, data);
    if (changes.length) data.edits = [...(old.edits || []), { at: Date.now(), by: uid(), changes }].slice(-20);
  }
  const id = old?.id || "t" + randomId(10);
  setDoc(doc(col("trips"), id), data).catch(onWriteError);
  S.trips = [...S.trips.filter((x) => x.id !== id), { id, ...data }];
  closeSheet(); render();
  // Var resan startade, för förslaget på sträcka när den avslutas. Hämtas i bakgrunden och sparas om det går.
  // Hann positionen inte komma medan rutan var öppen hämtas en ny nu.
  if (mode === "start" && !data.startLoc) freshTripPosition().then((loc) => { if (loc) { updateDoc(doc(col("trips"), id), { startLoc: loc }).catch(() => {}); const t = S.trips.find((x) => x.id === id); if (t) t.startLoc = loc; } });
  if (mode === "end" && !data.endLoc) freshTripPosition().then((loc) => { if (loc) { updateDoc(doc(col("trips"), id), { endLoc: loc }).catch(() => {}); const t = S.trips.find((x) => x.id === id); if (t) t.endLoc = loc; } });
  showToast(mode === "start" ? "Resan är startad" : `${old && mode === "new" ? "Resan är ändrad" : "Resan är sparad"}: ${fmt(tripMil({ odoStart, odoEnd }) ?? 0, 1)} mil`);
}

// Nästa resa med samma bil som startar inom 45 minuter efter att den här slutade.
function nextTripOf(t) {
  const end = tsMs(t.endedAt || t.startedAt);
  if (!end) return null;
  return S.trips.filter((x) => x.id !== t.id && x.carId === t.carId && x.odoEnd != null && tsMs(x.startedAt) >= end - 60000 && tsMs(x.startedAt) - end <= 45 * 60000)
    .sort((a, b) => tsMs(a.startedAt) - tsMs(b.startedAt))[0] || null;
}
async function mergeTrips(a, b) {
  const ok = await confirmDialog({ title: "Slå ihop resorna?", lines: [`${[a.from, a.to].filter(Boolean).join(" → ") || "Resan"} och ${[b.from, b.to].filter(Boolean).join(" → ") || "nästa resa"} blir en resa på ${fmt((num(b.odoEnd) - num(a.odoStart)) || 0, 1)} mil.`], okLabel: "Slå ihop", warn: "" });
  if (!ok) return;
  const pa = decodePath(a.path), pb = decodePath(b.path);
  const data = clean({
    odoEnd: b.odoEnd, to: b.to || null, toLoc: b.toLoc || null, endLoc: b.endLoc || null, endedAt: b.endedAt || null,
    purpose: [a.purpose, b.purpose].filter(Boolean).filter((v, i, l) => l.indexOf(v) === i).join(", ") || null,
    autoMeters: a.autoMeters != null && b.autoMeters != null ? a.autoMeters + b.autoMeters : null,
    path: pa.length && pb.length ? encodePath([...pa, ...pb]) : null,
    odoEstimated: a.odoEstimated && b.odoEstimated ? true : null,
    edits: [...(a.edits || []), { at: Date.now(), by: uid(), changes: [`ihopslagen med resan ${clock(tsMs(b.startedAt))}`] }].slice(-20),
  });
  const gone = ["to", "toLoc", "endLoc", "purpose", "autoMeters", "path", "odoEstimated"].filter((k) => !(k in data));
  const local = { ...a, ...data }; for (const k of gone) delete local[k];
  await updateDoc(doc(col("trips"), a.id), { ...data, ...Object.fromEntries(gone.map((k) => [k, deleteField()])) }).catch(onWriteError);
  await deleteDoc(doc(col("trips"), b.id)).catch(onWriteError);
  S.trips = S.trips.filter((x) => x.id !== b.id).map((x) => (x.id === a.id ? local : x));
  closeSheet(); render();
  showToast("Resorna är ihopslagna");
}
function splitSheet(t) {
  const mid = Math.round(((num(t.odoStart) + num(t.odoEnd)) / 2) * 10) / 10;
  openSheet("Dela resan", `<form class="form" data-form="trip-split" data-id="${esc(t.id)}" novalidate>
    <p class="muted" style="margin-top:0">${esc(`Resan går från ${fmt(t.odoStart, 1)} till ${fmt(t.odoEnd, 1)} mil. Den delas i två där du stannade.`)}</p>
    ${field("Mätare där du stannade (mil)", `<input name="odo" id="sp-odo" inputmode="decimal" required value="${esc(String(mid).replace(".", ","))}">`)}
    ${field("Var stannade du?", `<input name="place" id="sp-place" placeholder="Till exempel Macken eller Kunden" autocomplete="off">`)}
    <p class="err" id="form-err" hidden></p>
    <button class="btn primary block" type="submit">Dela i två resor</button></form>`, { back: "edit-trip", backId: t.id });
}
async function saveSplit(form) {
  const t = S.trips.find((x) => x.id === form.dataset.id);
  if (!t) return closeSheet();
  const fd = new FormData(form);
  const odo = num(fd.get("odo")), place = String(fd.get("place") || "").trim() || null;
  if (odo == null || odo <= num(t.odoStart) || odo >= num(t.odoEnd)) return formError(`Skriv en mätarställning mellan ${fmt(t.odoStart, 1)} och ${fmt(t.odoEnd, 1)}.`);
  const f = (odo - num(t.odoStart)) / (num(t.odoEnd) - num(t.odoStart));
  const a0 = tsMs(t.startedAt), b0 = tsMs(t.endedAt || t.startedAt);
  const at = a0 && b0 ? Math.round(a0 + (b0 - a0) * f) : null;
  // Vägen delas där sträckan når samma andel.
  const pts = decodePath(t.path);
  let p1 = [], p2 = [], cut = null;
  if (pts.length >= 2) {
    const total = pathLen(pts); let acc = 0, i = 1;
    for (; i < pts.length; i++) { acc += distM({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }); if (acc >= total * f) break; }
    p1 = pts.slice(0, i + 1); p2 = pts.slice(i); cut = { lat: pts[Math.min(i, pts.length - 1)][0], lon: pts[Math.min(i, pts.length - 1)][1] };
  }
  const placeLocV = placeLoc(place) || (cut ? { lat: cut.lat, lon: cut.lon } : null);
  const id2 = "t" + randomId(10);
  const second = clean({
    ...Object.fromEntries(Object.entries(t).filter(([k]) => !["id", "edits", "startLoc", "fromLoc", "from", "odoStart", "startedAt", "path", "autoMeters", "gapOk"].includes(k))),
    from: place, fromLoc: placeLocV, startLoc: cut || null, odoStart: odo, startedAt: at || t.startedAt,
    path: p2.length >= 2 ? encodePath(p2) : null, autoMeters: t.autoMeters != null ? Math.round(t.autoMeters * (1 - f)) : null,
    edits: [{ at: Date.now(), by: uid(), changes: ["delad från en längre resa"] }], createdAt: Date.now(),
  });
  const first = clean({ odoEnd: odo, to: place, toLoc: placeLocV, endLoc: cut || null, endedAt: at || t.endedAt,
    path: p1.length >= 2 ? encodePath(p1) : null, autoMeters: t.autoMeters != null ? Math.round(t.autoMeters * f) : null,
    edits: [...(t.edits || []), { at: Date.now(), by: uid(), changes: [`delad vid ${fmt(odo, 1)} mil`] }].slice(-20) });
  const gone = ["to", "toLoc", "endLoc", "path", "autoMeters"].filter((k) => !(k in first));
  const local = { ...t, ...first }; for (const k of gone) delete local[k];
  await updateDoc(doc(col("trips"), t.id), { ...first, ...Object.fromEntries(gone.map((k) => [k, deleteField()])) }).catch(onWriteError);
  await setDoc(doc(col("trips"), id2), second).catch(onWriteError);
  S.trips = [...S.trips.map((x) => (x.id === t.id ? local : x)), { id: id2, ...second }];
  closeSheet(); render();
  showToast("Resan är delad i två");
}

// Årsrapport: allt som Skatteverket brukar vilja se för ett år, som PDF.
function tripYearPdf(year) {
  const c = car();
  const list = carTrips(c.id).filter((t) => (t.date || "").startsWith(String(year)) && t.odoEnd != null).sort((a, b) => (a.date || "").localeCompare(b.date || "") || tsMs(a.startedAt) - tsMs(b.startedAt));
  const t = (x) => tr(String(x ?? "")).replace(/[–—]/g, "-").replace(/→/g, "->").replace(/›/g, ">");
  const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(22); pdf.text(t(`Körjournal ${year}`), 14, 20);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(12); pdf.text(t(`${carName(c)}${c.plate ? ` · ${c.plate}` : ""}${c.year ? ` · årsmodell ${c.year}` : ""}`), 14, 27);
  pdf.setFontSize(9); pdf.setTextColor(110); pdf.text(t(`Utskriven ${fmtDate(todayStr())} · Bildagboken`), W - 14, 20, { align: "right" }); pdf.setTextColor(0);
  pdf.setDrawColor(30); pdf.setLineWidth(0.6); pdf.line(14, 31, W - 14, 31);
  const base = { margin: { left: 14, right: 14 }, styles: { font: "helvetica", fontSize: 9, cellPadding: 1.8, textColor: 20 }, headStyles: { fillColor: [35, 34, 33], textColor: 255, fontStyle: "bold" }, alternateRowStyles: { fillColor: [246, 243, 240] } };
  const work = sumMil(list, "tjanst"), priv = sumMil(list, "privat");
  const first = list[0], last = list.at(-1);
  pdf.autoTable({ ...base, startY: 35, theme: "plain", columnStyles: { 0: { textColor: 110, cellWidth: 70 } }, body: [
    ["Mätarställning vid årets första resa", first ? `${fmt(first.odoStart, 1)} mil (${fmtDateShort(first.date)})` : "-"],
    ["Mätarställning vid årets sista resa", last ? `${fmt(last.odoEnd, 1)} mil (${fmtDateShort(last.date)})` : "-"],
    ["Körda mil enligt mätaren", first && last ? `${fmt(num(last.odoEnd) - num(first.odoStart), 1)} mil` : "-"],
    ["Tjänsteresor", `${fmt(work, 1)} mil`], ["Privata resor", `${fmt(priv, 1)} mil`],
    ["Antal resor", String(list.length)],
    ["Milersättning", `${fmtKr(work * MIL_RATE)} kr (${MIL_RATE} kr per mil)`],
  ].map(([k, v]) => [t(k), t(v)]) });
  let y = pdf.lastAutoTable.finalY + 8;
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.text(t("Per månad"), 14, y);
  const months = MONTHS.map((m, i) => { const key = `${year}-${pad(i + 1)}`; const ml = list.filter((x) => x.date.startsWith(key)); return [m.replace(/^./, (x) => x.toUpperCase()), fmt(sumMil(ml, "tjanst"), 1), fmt(sumMil(ml, "privat"), 1), fmtKr(sumMil(ml, "tjanst") * MIL_RATE)]; });
  pdf.autoTable({ ...base, startY: y + 3, head: [["Månad", "Tjänst (mil)", "Privat (mil)", "Ersättning (kr)"].map(t)], body: months.map((r) => r.map(t)), columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } } });
  pdf.addPage();
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(16); pdf.text(t("Alla resor"), 14, 20);
  pdf.autoTable({ ...base, startY: 25, styles: { ...base.styles, fontSize: 8 }, head: [["Datum", "Mätare start", "Mätare slut", "Mil", "Från - till", "Ärende", "Typ", "Förare"].map(t)],
    body: list.map((x) => [x.date, fmt(x.odoStart, 1), fmt(x.odoEnd, 1), fmt(tripMil(x), 1), [x.from, x.to].filter(Boolean).join(" -> "), x.purpose || "", TRIP_KINDS[x.kind] || "Ej genomgången", memberName(x.driver)].map(t)),
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } } });
  const estimated = list.filter((x) => x.odoEstimated).length;
  if (estimated) { const yy = pdf.lastAutoTable.finalY + 6; pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(110); pdf.text(t(`${estimated} resor är mätta med GPS. Där är mätarställningen beräknad från den senast avlästa och sträckan.`), 14, yy); pdf.setTextColor(0); }
  return pdf.output("blob");
}
async function exportTripYear(year) {
  const name = `Körjournal ${carName(car())} ${year}.pdf`;
  if (pdfReady()) return sharePdf(tripYearPdf(year), name);
  showToast("Gör i ordning PDF:en …");
  try { await loadPdfLibs(); } catch { return showToast("PDF:en gick inte att göra just nu. Prova igen, eller ladda ner som kalkylark."); }
  pendingPdf = { blob: tripYearPdf(year), name };
  openSheet("Årsrapporten är klar", `<p class="muted">PDF:en är klar att dela. Välj Spara i Filer, Skriv ut eller skicka den direkt.</p>
    <button class="btn primary block" type="button" data-act="pdf-share" style="margin-top:14px">${icon("print", 18)} Dela eller spara PDF</button>`);
}

function tripsSheet() {
  const list = carTrips();
  const y = String(new Date().getFullYear());
  const year = list.filter((t) => (t.date || "").startsWith(y));
  const yWork = sumMil(year, "tjanst");
  const months = [...new Set(list.map((t) => (t.date || "").slice(0, 7)))];
  openSheet("Körjournal", `
    <dl class="detail-list">
      <div><dt>${esc(`I tjänsten ${y}`)}</dt><dd>${esc(`${fmt(yWork, 1)} mil`)}</dd></div>
      <div><dt>Milersättning</dt><dd>${esc(`${fmtKr(yWork * MIL_RATE)} kr`)}</dd></div>
      <div><dt>${esc(`Privat ${y}`)}</dt><dd>${esc(`${fmt(sumMil(year, "privat"), 1)} mil`)}</dd></div>
    </dl>
    <p class="hint">${esc(`Milersättningen räknas med ${MIL_RATE} kr per mil, Skatteverkets skattefria belopp för egen bil.`)}</p>
    ${months.length ? months.map((m) => {
      const ts = list.filter((t) => (t.date || "").startsWith(m));
      const [yy, mm] = m.split("-");
      return `<h3 class="section-t" style="margin-top:18px">${esc(`${MONTHS[+mm - 1].replace(/^./, (x) => x.toUpperCase())} ${yy}`)} <span class="muted" style="font-weight:400">${esc(`${fmt(sumMil(ts, "tjanst"), 1)} mil i tjänsten`)}</span></h3>
        <div class="rows">${ts.map((t) => `<button class="dl as-btn" type="button" data-act="edit-trip" data-id="${esc(t.id)}"><div class="dl-ic">${icon("car", 20)}</div><div><div class="dl-t">${esc([t.purpose, t.from && t.to ? `${t.from.split(",")[0]} → ${t.to}` : t.to].filter(Boolean).join(", ") || (t.kind === "privat" ? "Privat resa" : "Tjänsteresa"))}</div><div class="dl-s">${esc([fmtDateShort(t.date), t.kind ? TRIP_KINDS[t.kind] : "Ej genomgången", t.auto ? "GPS" : "", S.house?.members?.length > 1 ? memberName(t.driver) : "", t.edits?.length ? editedText(t).toLowerCase() : ""].filter(Boolean).join(" · "))}</div></div><span class="dl-v">${esc(tripMil(t) != null ? `${fmt(tripMil(t), 1)} mil` : "Pågår")}</span></button>`).join("")}</div>`;
    }).join("") : `<p class="muted" style="margin-top:16px">Inga resor än.</p>`}
    <div class="form" style="margin-top:18px">
      <button class="btn primary block" type="button" data-act="new-trip">Logga resa</button>
      ${list.length ? `<button class="btn ghost block" type="button" data-act="export-trips">Ladda ner som kalkylark</button>` : ""}
    </div>`);
}

function exportTrips() {
  const c = car();
  const list = [...carTrips()].reverse();
  if (!list.length) return showToast("Det finns inga resor att ladda ner än.");
  const cell = (v) => {
    if (v == null || v === "") return "";
    const t = typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ["Datum", "Bil", "Reg.nr", "Mätare start (mil)", "Mätare slut (mil)", "Sträcka (mil)", "Sträcka (km)", "Från", "Vart", "Ärende", "Typ", "Förare", "Milersättning (kr)", "Ändrad i efterhand", "Mätt med", "Starttid", "Sluttid"];
  const rows = list.map((t) => {
    const mil = tripMil(t);
    return [t.date, carName(c), c.plate, t.odoStart, t.odoEnd, mil, mil != null ? Math.round(mil * 10) : null, t.from, t.to, t.purpose, TRIP_KINDS[t.kind], memberName(t.driver), t.kind === "tjanst" && mil != null ? Math.round(mil * MIL_RATE) : null, t.edits?.length ? t.edits.map(editLine).join("; ") : "",
      t.auto ? (t.odoEstimated ? "GPS, mätaren beräknad" : "GPS") : "Mätaren avläst", t.startedAt ? clock(tsMs(t.startedAt)) : "", t.endedAt ? clock(tsMs(t.endedAt)) : ""].map(cell).join(";");
  });
  downloadFile(`Körjournal ${carName(c)} ${todayStr()}.csv`, "\ufeff" + [head.join(";"), ...rows].join("\r\n"), "text/csv;charset=utf-8");
  showToast(`Körjournalen är nedladdad (${list.length} ${list.length === 1 ? "resa" : "resor"}).`);
}

/* ---------------------------------------------------------- säkerhetskopia */

// Hela loggen som en CSV-fil som Excel, Numbers och Google Kalkylark öppnar direkt (semikolon och decimalkomma).
async function downloadFile(name, text, type) {
  // I iPhone-appen och på telefoner går det inte att ladda ner som på datorn. Där delas filen i stället,
  // så att man kan spara den i Filer, skicka den eller öppna den i Numbers eller Excel.
  const file = new File([text], name, { type });
  if ((NATIVE || /iPhone|iPad|iPod|Android/.test(navigator.userAgent)) && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  if (NATIVE) { showToast("Filen gick inte att dela här. Logga in på bildagboken.com på datorn och ladda ner den där.", 6000); return; }
  showToast(`${name} laddas ner`);
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
  const head = ["Bil", "Reg.nr", "Datum", "Typ", "Vad", "Detaljer", "Belopp (kr)", "Mätarställning (mil)", "Mängd", "Drivmedel", "Verkstad", "Station eller plats", "Handläggare", "Anteckning", "Loggad av"];
  const rows = [...S.entries, ...S.cars.flatMap((x) => recurringEntries(x))].sort((a, b) => (a.date || "").localeCompare(b.date || "")).map((e) => {
    const c = S.cars.find((x) => x.id === e.carId);
    return [
      c ? carName(c) : "Borttagen bil", c?.plate, e.date, TYPE[e.type]?.label || e.type, entryTitle(e), entryDetail(e, c),
      e.amount, e.odometer, e.liters, e.fuel, e.workshop, e.station || e.place, e.handler, e.note, memberName(e.createdBy),
    ].map(cell).join(";");
  });
  const bookRows = bookings.sort((x, y) => (x.b.date || "").localeCompare(y.b.date || "")).map(({ c, b }) => [
    carName(c), c.plate, b.date, "Bokad tid", BOOK_KINDS[b.kind] || "Bokning", [b.time ? `kl ${b.time}` : "", b.addr].filter(Boolean).join(" · "),
    "", "", "", "", "", b.place, b.handler, b.note, memberName(b.createdBy),
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
    ...(S.trips.length ? { trips: S.trips.map((t) => plain(t)) } : {}),
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
    efterkontroll: "Bilen blev underkänd vid besiktningen och ska tillbaka för efterkontroll senast det här datumet. Åtgärda bristerna först, de finns i Att göra. När efterkontrollen är klar loggar ni den som en besiktning.",
    besiktning: "Det här är sista dagen bilen måste vara besiktigad. Datumet står i besiktningsprotokollet och hos Transportstyrelsen. När du har bokat en tid hos stationen, lägg in den som bokad tid, så visas den i stället.",
    forsakring: "Dagen då försäkringen förnyas. Bra tillfälle att jämföra priser några veckor innan.",
    skatt: "Månaden då fordonsskatten ska betalas, senast sista dagen i månaden. Den styrs av sista siffran i registreringsnumret, men går att ändra under Ändra datum.",
    dack: "Räknas ut från årstiden och vilka däck som sitter på.",
  }[key];
  const removable = key === "besiktning" || key === "forsakring" || key === "skatt" || key === "efterkontroll";
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
      ${key === "besiktning" || key === "efterkontroll" ? `<button class="btn primary block" type="button" data-act="book-inspection">${icon("calendar", 18)} Lägg in bokad tid</button>` : ""}
      <button class="btn ${key === "besiktning" || key === "efterkontroll" ? "ghost" : "primary"} block" type="button" data-act="deadline-calendar" data-id="${esc(key)}">${icon("calendar", 18)} Lägg till i kalendern</button>
      ${key === "efterkontroll" ? "" : `<button class="btn ghost block" type="button" data-act="edit-car" data-section="${section}">Ändra datum</button>`}
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
  // Väljer man ett datum framåt i tiden är det troligen en bokning: då visas en knapp som byter till Bokad tid.
  const bookKind = { service: "service", dack: "dack" }[type] || (type === "kostnad" && e.category === "Besiktning" ? "besiktning" : null);
  const date = field("Datum", `<input type="date" name="date" id="ef-date" required value="${esc(e.date || todayStr())}">`)
    + (bookKind && !e.id ? `<div class="future-hint" id="ef-future" data-kind="${bookKind}" hidden><span>Datumet är framåt i tiden. Vill du boka en tid i stället?</span><button class="btn-soft" type="button" data-act="to-booking">${icon("calendar", 16)} Lägg in som bokad tid</button></div>` : "");
  const odo = (required = false) => field("Mätarställning (mil)", `<input name="odometer" id="ef-odometer" inputmode="numeric" ${required ? "required" : ""} placeholder="${odoOf(c) != null ? `Senast ${fmt(odoOf(c))}` : ""}" value="${e.odometer ?? ""}">`);
  const amount = (example, label = "Kostnad (kr)", extra = "", hint = "") => field(label, `<input name="amount" id="ef-amount" inputmode="decimal"${extra} value="${e.amount ?? ""}">`, hint);
  const note = field("Anteckning", `<textarea name="note" id="ef-note" rows="2">${v("note")}</textarea>`);
  // Bilder: flera går att lägga till, en i taget eller många på en gång, och var och en går att ta bort.
  pendingPhotos = [];
  const photo = `<div class="photo-multi" id="ef-photos" data-keep="${esc(photosOf(e).join(","))}"></div>
    <label class="photo-in">${icon("image", 22)}<span id="photo-label">${photosOf(e).length ? "Lägg till fler bilder" : "Lägg till kvitto eller bild"}</span><input type="file" id="ef-photo" accept="image/*" multiple></label>
    <p class="hint" id="ef-quota" hidden></p>
    <input type="hidden" name="keepPhotos" id="ef-keep" value="${esc(photosOf(e).join(","))}">`;
  // "Det här gjordes": underhållspunkterna (som förut) och egna delar. Ikryssad rad visar åtgärd och, där det passar, position.
  const workSection = ["service", "eget"].includes(type) ? workFormHtml(c, workOf(e, c)) : "";
  const items = workSection, parts = "";
  // Anteckning och bild ligger under "Fler detaljer" i alla formulär, öppet om något redan är ifyllt.
  const more = (extra = "", open = false) => `<details class="more"${open || e.note || photosOf(e).length ? " open" : ""}>
          <summary>Fler detaljer (valfritt)</summary>
          <div class="form">${extra}${note}${photo}</div>
        </details>`;
  let body = "";
  switch (type) {
    case "tank": {
      const fuels = fuelOptions(c);
      body = `${amount("579", "Kostnad (kr)", " required", "Läs av pumpen med kameran: tryck i fältet, välj <b>Skanna text</b> och peka på totalsumman.")}
        <label class="check"><input type="checkbox" name="full" id="ef-full"${e.full === false ? "" : " checked"}> Tankade fullt</label>
        ${placeField("station", "ef-station", e.station, "fuel", "Circle K")}
        ${odo(false)}
        ${date}
        ${more(field("Drivmedel", `<select name="fuel" id="ef-fuel">${fuels.map((f) => `<option${(e.fuel || pref.get("fuel." + c.id) || fuels[0]) === f ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>`))}`;
      break;
    }
    case "matare":
      body = `${odo(true)}${date}`;
      break;
    // Samma ordning i alla formulär: vad → belopp → mätarställning → datum → detaljer.
    case "service":
      body = `${items}${parts}
        ${placeField("workshop", "ef-workshop", e.workshop, "car_repair", "Mekonomen")}
        ${handlerField(e.handler ?? (e.id ? "" : lastHandler(e.workshop)))}
        ${amount("2 500")}${odo(false)}${date}${more()}`;
      break;
    case "eget":
      body = `${field("Vad gjorde du?", `<input name="title" id="ef-title" required value="${v("title")}">`)}
        ${items}${parts}${amount("450", "Kostnad för delar (kr)")}${odo(false)}${date}${more()}`;
      break;
    case "dack": {
      const actDefault = e.tireAction || ((c.tiresOn || "sommar") === "sommar" ? "till_vinter" : "till_sommar");
      body = `${field("Vad gjordes?", `<select name="tireAction" id="ef-tireAction">${Object.entries(TIRE_ACTIONS).map(([k, l]) => `<option value="${k}"${actDefault === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
        <div class="row2" id="ef-tire-row">
          <div id="ef-tirekind-box"${isSwap(actDefault) ? " hidden" : ""}>${field("Vilka däck?", `<select name="tireKind" id="ef-tireKind" required><option value="">Välj</option><option value="sommar"${e.tireKind === "sommar" ? " selected" : ""}>Sommardäck</option><option value="vinter"${e.tireKind === "vinter" ? " selected" : ""}>Vinterdäck</option></select>`)}</div>
          ${field(isSwap(actDefault) ? "Mönsterdjup, däcken som sätts på (mm)" : "Mönsterdjup (mm)", `<input name="depth" id="ef-depth" inputmode="decimal" value="${e.depth ?? ""}" placeholder="Till exempel 6,5">`)}
          <div id="ef-depthoff-box"${isSwap(actDefault) ? "" : " hidden"}>${field("Mönsterdjup, däcken som tas av (mm)", `<input name="depthOff" id="ef-depthOff" inputmode="decimal" value="${e.depthOff ?? ""}" placeholder="Till exempel 4">`)}</div>
        </div>
        <p class="hint" id="ef-depth-hint"${isSwap(actDefault) ? "" : " hidden"}>${icon("tire", 14)} Mät mönsterdjupet på båda uppsättningarna när ni byter. Då vet ni i god tid om det behövs nya däck till nästa säsong.</p>
        <div id="ef-newtire-box"${actDefault === "nya" ? "" : " hidden"}>
          <div class="row2">
            ${field("Märke", `<input name="tireBrand" id="ef-tireBrand" value="${v("tireBrand")}" autocomplete="off">`)}
            ${field("Dimension", `<input name="tireSize" id="ef-tireSize" value="${v("tireSize")}" autocomplete="off">`)}
          </div>
          <div class="row2">
            ${field("Tillverkningsår", `<input name="tireYear" id="ef-tireYear" inputmode="numeric" value="${v("tireYear")}" autocomplete="off">`, "Står efter DOT på däckets sida, till exempel 2425 = vecka 24 år 2025.")}
            <div id="ef-studded-box"${e.tireKind === "vinter" ? "" : " hidden"} style="align-self:center"><label class="check"><input type="checkbox" name="studded" id="ef-studded"${e.studded ? " checked" : ""}> Dubbade</label></div>
          </div>
          <div id="ef-alpine-box"${e.tireKind === "vinter" && !e.studded ? "" : " hidden"}>
            ${field("Märkta med alptopp/snöflinga?", `<select name="alpine" id="ef-alpine">${ALPINE_OPTS.map(([v, l]) => `<option value="${v}"${alpineVal(e) === v ? " selected" : ""}>${l}</option>`).join("")}</select>`, "Dubbfria vinterdäck måste ha den symbolen för att räknas som vinterdäck.")}
          </div>
        </div>
        ${placeField("place", "ef-place", e.place, "tyres", "Däckia")}
        ${amount("800")}${odo(false)}${date}${more()}`;
      break;
    }
    case "tvatt":
      body = `${placeField("place", "ef-place", e.place ?? (e.id ? "" : pref.get("wash." + c.id) || ""), "car_wash", "Circle K")}
        ${amount("149")}
        ${date}${more()}`;
      break;
    case "parkering":
      body = `${placeField("place", "ef-place", e.place, "parking", "Kungsgatan")}
        ${amount("45", "Kostnad (kr)", opts.recurringId ? " required" : "")}
        <label class="check"><input type="checkbox" name="fine" id="ef-fine"${e.fine ? " checked" : ""}> P-bot eller felparkeringsavgift</label>
        ${!e.id ? `<label class="check"><input type="checkbox" name="recurring" id="ef-recurring"${opts.recurringId ? " checked" : ""}> Återkommande (hyrd plats)</label>
        <div id="ef-rec-box"${opts.recurringId ? "" : " hidden"}>
          <div class="row2">
            ${field("Hur ofta", `<select name="period" id="ef-period">${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}"${String(e.period || 1) === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
            ${field("Slutar", `<input type="date" name="endDate" id="ef-endDate" value="${esc(e.end || "")}">`, "Lämna tom om den fortsätter.")}
          </div>
          <p class="hint">Kostnaden ovan gäller per gång, och första betalningen anges nedanför. Den räknas in i Ekonomi och loggen varje gång, utan att du behöver logga den igen.</p>
        </div>${recSplitBox(c, opts.recurringId)}` : ""}
        ${date}${more()}`;
      break;
    case "kostnad":
      // Besiktning har en egen knapp i plusmenyn: då finns ingen Typ-lista, och Besiktning finns inte bland andra kostnader.
      body = `${e.category === "Besiktning"
        ? `<input type="hidden" name="category" id="ef-category" value="Besiktning">`
        : field("Typ", `<select name="category" id="ef-category">${COST_CATS.filter((k) => !["Tvätt", "Parkering", "Besiktning"].includes(k) || e.category === k).map((k) => `<option${e.category === k ? " selected" : ""}>${k}</option>`).join("")}</select>`)}
        ${e.category === "Besiktning"
          ? `${placeField("place", "ef-place", e.place || (e.title || "").replace(/^Besiktning hos /, "") || "", "vehicle_inspection", "Bilprovningen")}
             ${handlerField(e.handler ?? (e.id ? "" : lastHandler(e.place || (e.title || "").replace(/^Besiktning hos /, ""))))}
             <input type="hidden" name="title" value="${v("title")}">
             ${inspectionFields(e, c)}`
          : field("Beskrivning", `<input name="title" id="ef-title" value="${v("title")}" placeholder="Valfritt">`)}
        ${amount(e.category === "Besiktning" ? "520" : "3 200", "Kostnad (kr)", e.category === "Besiktning" ? "" : " required")}${e.category === "Besiktning" ? odo(false) : ""}${date}
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
      <input type="hidden" name="loc" id="ef-loc" value="${e.loc ? esc(JSON.stringify(e.loc)) : ""}">
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button>
    </form>`, opts.back ? { back: opts.back, backId: opts.backId } : isEdit ? { back: "open-entry", backId: e.id } : { back: opts.bookingId ? null : "new-entry" });
  if (opts.recurringId) { const lab = $("#ef-date")?.closest("label")?.querySelector("span"); if (lab) lab.textContent = "Första betalningen"; }
  const ef = $('form[data-form="entry"]');
  if (ef) attachSuggestions(ef, type);
  renderPhotoThumbs();
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
  // Var-fälten i posterna söker företag på samma sätt.
  "ef-station": { input: "ef-station", box: "ef-station-suggest", search: "poi" },
  "ef-place": { input: "ef-place", box: "ef-place-suggest", search: "poi" },
  "ef-workshop": { input: "ef-workshop", box: "ef-workshop-suggest", search: "poi" },
  // Målet för en resa i körjournalen: orter, adresser och företag.
  "tr-to": { input: "tr-to", box: "tr-to-suggest", search: "any" },
  "tr-from": { input: "tr-from", box: "tr-from-suggest", search: "any" },
  "pl-addr": { input: "pl-addr", box: "pl-addr-suggest", search: "any" },
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
  // Positionen hämtas i bakgrunden, så att första sökningen inte behöver vänta på den.
  if (pref.get("searchPosDenied") !== "1" && "geolocation" in navigator && !searchCenter.pending) {
    searchCenter.pending = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      searchCenter.pending = false;
      searchCenterCache = { lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now(), gps: true };
      pref.set("searchPos", JSON.stringify(searchCenterCache));
    }, (e) => { searchCenter.pending = false; if (e?.code === 1) pref.set("searchPosDenied", "1"); }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60000 });
  }
  // Mitten av de platser ni har sparat (bokningar och poster med position).
  const pts = [...S.cars.flatMap((c) => (c.bookings || []).filter((b) => b.lat != null).map((b) => [b.lat, b.lon])), ...S.entries.filter((e) => e.loc?.lat != null).map((e) => [e.loc.lat, e.loc.lon])];
  if (pts.length) {
    const mid = (i) => pts.map((p) => p[i]).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
    return (searchCenterCache = { lat: mid(0), lon: mid(1), at: Date.now() });
  }
  return null;
}
async function appleSearch(kind, q, quick = false) {
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
  // Ett förslag utan position söks upp, så att det får adress och plats på kartan. Alla samtidigt.
  const extra = (await Promise.all(suggestions.slice(0, quick ? 3 : 4).map((r) => run(r).then((p) => p[0]).catch(() => null)))).filter(Boolean);
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
    if (kind === "any") { const nm = pl.name || addr.split(", ")[0]; return { title: nm, sub: addr === nm ? "" : addr, name: nm, addr, lat, lon, pid, src: "apple" }; }
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

async function placeSearch(field, q) {
  const f = PLACE_FIELDS[field];
  const kind = f.search || field;
  const input = document.getElementById(f.input), box = document.getElementById(f.box);
  if (!box || !input) return;
  placeAbort?.abort();
  placeAbort = new AbortController();
  const signal = placeAbort.signal;
  try {
    let found;
    try { found = await appleSearch(kind, q, field.startsWith("ef-")); } catch { found = null; }
    if (signal.aborted) return;
    // Hittar Apple inget, eller svarar inte, provas OpenStreetMap.
    if (!found || !found.length) found = await photonSearch(kind, q, signal).catch(() => found || []);
    if (input.value.trim() !== q) return;
    const seen = new Set();
    const list = found.filter((x) => x.title && !seen.has(x.title + x.sub) && seen.add(x.title + x.sub)).slice(0, 6);
    const ql = q.toLowerCase();
    const mine = field.startsWith("tr-") ? S.places.filter((p) => p.name.toLowerCase().includes(ql) || String(p.addr || "").toLowerCase().includes(ql)) : [];
    box.innerHTML = mine.length || list.length
      ? savedPlaceBtns(field, mine) + list.map((x) => `<button type="button" role="option" data-act="place-pick" data-kind="${field}" data-name="${esc(x.name)}" data-addr="${esc(x.addr)}" data-lat="${x.lat ?? ""}" data-lon="${x.lon ?? ""}" data-pid="${esc(x.pid || "")}" data-tel="${esc(x.tel || "")}" data-src="${x.src || ""}"><b>${esc(x.title)}</b>${x.sub ? `<span>${esc(x.sub)}</span>` : ""}</button>`).join("")
      : field.startsWith("ef-") ? `<p class="hint">Hittade inget med det namnet. Det du har skrivit sparas ändå.</p>`
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
// Start och mål för en resa: GPS-punkterna, annars de valda platserna.
const okLoc = (l) => (l && Number.isFinite(l.lat) && Number.isFinite(l.lon) ? l : null);
function tripEnds(t) {
  const a = okLoc(t.startLoc) || okLoc(t.fromLoc), b = okLoc(t.endLoc) || okLoc(t.toLoc);
  return a && b ? [a, b] : null;
}
// Karta med start (grön) och mål (orange) och vägen mellan dem. Apple Maps om det går, annars OpenStreetMap.
let tripMapObj = null;
async function tripMap(inner, a, b, path = []) {
  if (!inner) return;
  try { tripMapObj?.destroy?.(); } catch { /* redan borta */ }
  tripMapObj = null;
  try {
    const mk = await loadMapKit();
    if (!document.contains(inner)) return;
    const dark = DARK_THEMES.includes(document.documentElement.dataset.theme) || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    const map = tripMapObj = new mk.Map(inner, {
      isScrollEnabled: false, isZoomEnabled: false, isRotationEnabled: false,
      showsMapTypeControl: false, showsZoomControl: false, showsUserLocationControl: false,
      showsCompass: mk.FeatureVisibility?.Hidden, showsScale: mk.FeatureVisibility?.Hidden,
      colorScheme: dark ? mk.Map?.ColorSchemes?.Dark : mk.Map?.ColorSchemes?.Light,
      padding: new mk.Padding(36, 28, 36, 28),
    });
    const pins = [
      new mk.MarkerAnnotation(new mk.Coordinate(a.lat, a.lon), { title: "Start", glyphText: "A", color: "#2f9e5b" }),
      new mk.MarkerAnnotation(new mk.Coordinate(b.lat, b.lon), { title: EN ? "End" : "Mål", glyphText: "B", color: "#E77026" }),
    ];
    map.showItems(pins, { animate: false, padding: new mk.Padding(40, 30, 40, 30) });
    if (distM(a, b) < 150) map.cameraDistance = 900;
    const lineStyle = new mk.Style({ strokeColor: "#E77026", lineWidth: 5, lineCap: "round", lineJoin: "round", strokeOpacity: 0.85 });
    // Den väg som telefonen mätte under resan.
    if (path.length >= 2 && mk.PolylineOverlay) {
      const line = new mk.PolylineOverlay(path.map(([la, lo]) => new mk.Coordinate(la, lo)), { style: lineStyle });
      map.addOverlay(line);
      map.showItems([...pins, line], { animate: false, padding: new mk.Padding(40, 30, 40, 30) });
      return;
    }
    // Annars vägen enligt Apple Kartor, som en linje mellan punkterna.
    new mk.Directions().route({ origin: pins[0].coordinate, destination: pins[1].coordinate, transportType: mk.Directions.Transport.Automobile }, (err, data) => {
      const line = data?.routes?.[0]?.polyline;
      if (err || !line || tripMapObj !== map) return;
      line.style = lineStyle;
      map.addOverlay(line);
      map.showItems([...pins, line], { animate: false, padding: new mk.Padding(40, 30, 40, 30) });
    });
  } catch (err) {
    console.warn("Apple-kartan kunde inte visas", err);
    const pad = Math.max(0.004, Math.abs(a.lat - b.lat) * 0.25, Math.abs(a.lon - b.lon) * 0.25);
    const [w, e] = [Math.min(a.lon, b.lon) - pad, Math.max(a.lon, b.lon) + pad], [so, n] = [Math.min(a.lat, b.lat) - pad, Math.max(a.lat, b.lat) + pad];
    inner.innerHTML = `<iframe title="Karta" loading="lazy" referrerpolicy="no-referrer" src="https://www.openstreetmap.org/export/embed.html?bbox=${w},${so},${e},${n}&layer=mapnik&marker=${b.lat},${b.lon}"></iframe>`;
  }
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
    const dark = DARK_THEMES.includes(document.documentElement.dataset.theme) || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
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
// Samma fält för plats i alla formulär: "Var", med knapp som hittar närmaste ställe av rätt sort.
// Handläggare: den man hade kontakt med på verkstaden eller besiktningen.
// Besiktningens resultat, brister och efterkontroll. Bristerna och efterkontrollen visas bara när de behövs.
function inspectionFields(e, c) {
  const res = e.result || "godkand";
  const recheckBy = e.recheckBy || ymd(addMonths(parseDate(e.date || todayStr()), 1));
  const pending = !e.id && c.efterkontroll?.by;
  return `<div class="field"><span>Resultat</span>
      <div class="seg res-seg" role="radiogroup" aria-label="Resultat">${Object.entries(INSP_SHORT).map(([k, l]) => `<label class="res-${k}"><input type="radio" class="vh" name="result" value="${k}"${res === k ? " checked" : ""}><span>${l}</span></label>`).join("")}</div></div>
    ${pending ? `<label class="check"><input type="checkbox" name="recheck" id="ef-recheck" checked> Det här var efterkontrollen</label>` : e.recheck ? `<input type="hidden" name="recheck" value="on">` : ""}
    <div id="ef-defects-box"${res === "godkand" ? " hidden" : ""}>${field("Brister", `<textarea name="defects" id="ef-defects" rows="3" placeholder="En brist per rad">${esc((e.defects || []).join("\n"))}</textarea>`, e.id ? "" : "Varje brist hamnar i Att göra, så att ni inte glömmer att åtgärda den.")}</div>
    <div id="ef-recheck-box"${inspFailed(res) ? "" : " hidden"}>${field("Efterkontroll senast", `<input type="date" name="recheckBy" id="ef-recheckBy" value="${esc(recheckBy)}">`, "Står på protokollet. Appen påminner er i tid.")}</div>`;
}

const handlerField = (value, id = "ef-handler") => field("Handläggare", `<input name="handler" id="${id}" value="${esc(value || "")}" placeholder="Valfritt" autocomplete="off">`);
// Senaste handläggaren på samma ställe, så att den kan föreslås.
function lastHandler(place) {
  const p = String(place || "").trim().toLowerCase();
  if (!p) return "";
  const hits = [
    ...S.entries.filter((e) => e.handler && [e.workshop, e.place].some((x) => String(x || "").trim().toLowerCase() === p)).map((e) => [e.date || "", e.handler]),
    ...S.cars.flatMap((c) => (c.bookings || []).filter((b) => b.handler && String(b.place || "").trim().toLowerCase() === p).map((b) => [b.date || "", b.handler])),
  ].sort((a, b) => b[0].localeCompare(a[0]));
  return hits[0]?.[1] || "";
}
function suggestHandler(placeId, handlerId) {
  const h = document.getElementById(handlerId), pl = document.getElementById(placeId);
  if (!h || !pl || h.dataset.touched || h.value.trim()) return;
  const name = lastHandler(pl.value);
  if (name) { h.value = name; h.classList.add("auto-filled"); }
}
document.addEventListener("input", (ev) => { if (["ef-handler", "bk-handler"].includes(ev.target.id) && ev.isTrusted) ev.target.dataset.touched = "1"; });
document.addEventListener("change", (ev) => {
  if (["ef-workshop", "ef-place"].includes(ev.target.id)) suggestHandler(ev.target.id, "ef-handler");
  if (ev.target.id === "bk-place") suggestHandler("bk-place", "bk-handler");
});

function placeField(name, id, value, kind, example) {
  return field("Var", geoInput(name, id, value, kind, ""));
}
function geoInput(name, id, value, kind, placeholder) {
  return `<span class="geo-row"><input name="${name}" id="${id}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}" autocomplete="off">
    <button class="geo-btn" type="button" data-act="geo-fill" data-kind="${kind}" data-target="${id}" aria-label="Använd min plats" title="Använd min plats">${icon("pin", 20)}</button></span>
    <span class="suggest" id="${id}-suggest" role="listbox" hidden></span>`;
}

const distM = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Biltvättar eller mackar nära positionen, närmast först, från OpenStreetMap (Overpass).
async function nearbyPlaces(kind, lat, lon, radius) {
  // Verkstäder och däckfirmor är butiker i OpenStreetMap, resten är "amenity".
  const tag = ["car_repair", "tyres"].includes(kind) ? `shop=${kind}` : `amenity=${kind}`;
  const q = `[out:json][timeout:10];(node(around:${radius},${lat},${lon})[${tag}];way(around:${radius},${lat},${lon})[${tag}];);out center tags 20;`;
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
  // Bara gata och ort: närmaste namngivna ställe kan vara en butik, och det blir fel som mack eller verkstad.
  return [road, area].filter(Boolean).join(", ");
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject({ code: "unsupported" });
    // En position från de senaste två minuterna duger, så att svaret kommer direkt.
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000, maximumAge: 120000 });
  });
}
const fmtDist = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace(".", ",")} km`);

// De närmaste ställena av ett slag från Apple Maps, närmast först, med namn, adress och plats.
async function appleNearby(kind, lat, lon) {
  const mk = await loadMapKit();
  const word = { fuel: "bensinstation", parking: "parkering", car_wash: "biltvätt", car_repair: "bilverkstad", tyres: "däckverkstad", vehicle_inspection: "bilbesiktning" }[kind] || "bilverkstad";
  const cat = { fuel: "GasStation", parking: "Parking", car_repair: "AutomotiveRepair", car_wash: "CarWash" }[kind];
  const opts = { language: "sv-SE", region: new mk.CoordinateRegion(new mk.Coordinate(lat, lon), new mk.CoordinateSpan(0.05, 0.09)) };
  const c = cat && mk.PointOfInterestCategory?.[cat];
  if (c && mk.PointOfInterestFilter?.including) opts.pointOfInterestFilter = mk.PointOfInterestFilter.including([c]);
  const search = new mk.Search(opts);
  const places = await new Promise((resolve) => {
    const t = setTimeout(() => resolve([]), 8000);
    try { search.search(word, (err, d) => { clearTimeout(t); resolve(err ? [] : d?.places || []); }, { limitToCountries: "SE" }); } catch { clearTimeout(t); resolve([]); }
  });
  const seen = new Set();
  return places.filter((pl) => pl.name && pl.coordinate).map((pl) => ({
    name: pl.name,
    addr: stripCountry(pl.formattedAddress) || "",
    lat: pl.coordinate.latitude, lon: pl.coordinate.longitude, pid: pl.id || "",
    d: distM({ lat, lon }, { lat: pl.coordinate.latitude, lon: pl.coordinate.longitude }),
  })).filter((x) => x.d < 15000 && !seen.has(x.name + x.addr) && seen.add(x.name + x.addr)).sort((a, b) => a.d - b.d);
}

// En rad i "Det här gjordes": namnet, vad som gjordes och var på bilen (menyer), och ett kryss för att ta bort raden.
function posOptions(itemId, chosen, kind = itemId === "torkare" ? "fb" : "corners") {
  const val = (a) => a.join("|");
  const opts = kind === "fb"
    ? [["Fram", ["Fram"]], ["Bak", ["Bak"]], ["Fram och bak", ["Fram", "Bak"]]]
    : [["Fram", ["Vänster fram", "Höger fram"]], ["Bak", ["Vänster bak", "Höger bak"]], ["Alla fyra", CORNERS], ...CORNERS.map((x) => [x, [x]])];
  const cur = val([...chosen].sort());
  const known = opts.some(([, a]) => val([...a].sort()) === cur);
  const all = [["Var?", []], ...opts, ...(chosen.length && !known ? [[sidesText(chosen).replace(/^./, (x) => x.toUpperCase()), chosen]] : [])];
  return all.map(([l, a]) => `<option value="${esc(val(a))}"${val([...a].sort()) === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
}
function workRowHtml(r, w) {
  const kind = posKind(r.itemId, r.name);
  const sides = sidesOf(w);
  const showPos = !!kind || sides.length > 0;
  const action = w?.action || "bytt";
  return `<div class="work-row" data-key="${esc(r.key)}" data-item="${esc(r.itemId || "")}" data-name="${esc(r.name)}">
    <input type="checkbox" class="w-on vh" checked tabindex="-1" aria-hidden="true">
    <span class="w-name">${esc(r.name)}</span>
    <span class="w-sel"><select class="w-action" aria-label="Vad gjordes med ${esc(r.name.toLowerCase())}">${Object.entries(WORK_ACTIONS).map(([k, l]) => `<option value="${k}"${action === k ? " selected" : ""}>${l}</option>`).join("")}</select>
    <select class="w-pos" aria-label="Var på bilen"${showPos ? "" : " hidden"}>${posOptions(r.itemId, sides, kind || (sides.some((x) => x === "Fram" || x === "Bak") ? "fb" : "corners"))}</select>
    </span>
    <button class="w-del" type="button" data-act="w-remove" aria-label="Ta bort ${esc(r.name)}">${icon("close", 14)}</button>
    ${showPos || (r.itemId && NO_POSITION.includes(r.itemId)) ? "" : `<button class="link w-posbtn" type="button" data-act="w-pos-show">Ange var på bilen</button>`}
  </div>`;
}
// Förslag under knappen: underhållspunkter som inte redan är tillagda.
function workChipsHtml(c = car()) {
  const present = new Set([...document.querySelectorAll("#work-rows .work-row")].map((r) => r.dataset.key));
  const items = (c.items || []).filter((i) => !present.has(`item:${i.id}`)).slice(0, 6);
  return items.length ? `<span class="w-sug-l">Förslag:</span>${items.map((i) => `<button type="button" class="w-chip" data-act="w-add" data-item="${esc(i.id)}" data-name="${esc(i.name)}">${esc(i.name)}</button>`).join("")}` : "";
}
function refreshWorkUi() {
  const chips = $("#w-chips");
  if (chips) chips.innerHTML = workChipsHtml();
  const empty = $("#w-empty");
  if (empty) empty.hidden = !!document.querySelector("#work-rows .work-row");
}
function workFormHtml(c, work) {
  const rows = work.map((w) => ({ key: w.itemId ? `item:${w.itemId}` : normWord(w.name), itemId: w.itemId || null, name: w.name || (c.items || []).find((i) => i.id === w.itemId)?.name || "", w }));
  const present = new Set(rows.map((r) => r.key));
  const sug = (c.items || []).filter((i) => !present.has(`item:${i.id}`)).slice(0, 6);
  return `<fieldset><legend>Det här gjordes</legend>
    <div id="work-rows">${rows.map((r) => workRowHtml(r, r.w)).join("")}</div>
    <p class="hint" id="w-empty"${rows.length ? " hidden" : ""}>Lägg till det som gjordes. Bara Bytt räknas som nytt byte för underhållet.</p>
    <div class="w-add">
      <button class="btn-soft" type="button" data-act="w-open" id="w-open">${icon("plus", 16)} Lägg till del</button>
      <div id="w-searchbox" hidden>
        <input id="w-search" placeholder="Sök eller skriv en del" autocomplete="off" aria-label="Sök eller lägg till en del">
        <span class="suggest" id="w-suggest" role="listbox" hidden></span>
      </div>
      <div class="w-chips" id="w-chips">${sug.length ? `<span class="w-sug-l">Förslag:</span>${sug.map((i) => `<button type="button" class="w-chip" data-act="w-add" data-item="${esc(i.id)}" data-name="${esc(i.name)}">${esc(i.name)}</button>`).join("")}` : ""}</div>
    </div>
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
  // Det man skrivit går alltid att lägga till som egen del, utom när det är exakt samma namn som något som redan finns.
  const exact = known.some((x) => x.key === t) || (itemHit && normWord(itemHit.name) === t) || present.has(t);
  const itemThere = itemHit && present.has(`item:${itemHit.id}`);
  // Vanliga delar ur katalogen som inte redan är använda, tillagda eller samma som en underhållspunkt.
  // Delar med sida (Bromsbelägg fram) visas även om delen redan används, eftersom sidan läggs till på samma rad.
  const taken = new Set([...known.map((x) => x.key), ...extraParts(c).map((x) => x.key), ...(c.items || []).map((i) => normWord(i.name))]);
  const common = catalogMatches(q).filter((x) => (x.side || (!taken.has(normWord(x.name)) && !present.has(normWord(x.name)))) && !(c.items || []).some((i) => nameMatchesItem(x.name, i))).slice(0, Math.max(0, 6 - known.length));
  const exactAll = exact || common.some((x) => normWord(x.name) === t);
  const sug = (ic, title, sub, attrs) => `<button type="button" class="sg-ic" data-act="w-add" ${attrs}><span class="sg-i">${icon(ic, 18)}</span><span class="sg-t"><b>${title}</b><span>${sub}</span></span></button>`;
  box.innerHTML = [
    ...known.map((x) => sug(partIcon(x.name), esc(x.name), "Använd förut", `data-name="${esc(x.name)}"`)),
    itemHit && !itemThere ? sug(partIcon(itemHit.name, itemHit.id), esc(itemHit.name), "Underhållspunkt", `data-item="${esc(itemHit.id)}" data-name="${esc(itemHit.name)}"`) : "",
    ...common.map((x) => sug(x.icon, esc(x.name), "Vanlig del", `data-name="${esc(x.add || x.name)}"${x.side ? ` data-sides="${esc(PART_SIDES[x.side].join("|"))}"` : ""}`)),
    itemThere ? `<p class="hint">${esc(itemHit.name)} finns redan i listan ovanför.</p>` : "",
    !exactAll ? sug(partIcon(q), `Lägg till ”${esc(q.trim())}”`, "Ny del", `data-name="${esc(q.trim().replace(/^./, (x) => x.toUpperCase()))}"`) : "",
  ].join("");
  box.hidden = !box.innerHTML;
}

function formError(msg) {
  const el = $("#form-err");
  if (el) { el.textContent = msg; el.hidden = false; }
  // Tomma fält som måste fyllas i blir röda, och det första visas.
  const form = el?.closest("form");
  if (!form) return;
  form.querySelectorAll("[required]").forEach((x) => x.classList.toggle("invalid", !String(x.value || "").trim() && !!x.offsetParent));
  form.querySelector(".invalid")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// Fält som måste fyllas i (attributet required) får en röd stjärna vid namnet, och formuläret en rad som förklarar den.
// Körs när en ruta eller sida ritas, och när ett fält blir obligatoriskt eller frivilligt.
function markRequired(root = document) {
  root.querySelectorAll("label.field, div.field").forEach((f) => {
    const req = f.querySelector("input[required], select[required], textarea[required]");
    const span = f.querySelector(":scope > span");
    if (!span) return;
    const mark = span.querySelector(".req");
    if (req && !mark) span.insertAdjacentHTML("beforeend", ' <em class="req" aria-hidden="true">*</em>');
    if (!req && mark) mark.remove();
  });
  root.querySelectorAll("form").forEach((form) => {
    const any = form.querySelector("[required]");
    const note = form.querySelector(":scope > .req-note");
    if (any && !note) form.insertAdjacentHTML("afterbegin", '<p class="req-note"><em class="req" aria-hidden="true">*</em> Måste fyllas i</p>');
    if (!any && note) note.remove();
  });
}

// Bilder som väntar på att sparas med posten, och miniatyrerna i formuläret.
const MAX_PHOTOS = 10;
let pendingPhotos = [];
const thumbUrls = new Map();
function renderPhotoThumbs() {
  const box = $("#ef-photos"), keepIn = $("#ef-keep"), lab = $("#photo-label");
  if (!box || !keepIn) return;
  // Gratisversionen: hur många bilder hushållet har, och från 80 % ett tips om Plus.
  const quota = $("#ef-quota");
  if (quota) {
    const used = photoCount() + pendingPhotos.length;
    const c = caps();
    // Med Plus visas räknaren först när det börjar bli fullt.
    quota.hidden = !c || (c === PLUS && used < c.photos * 0.8);
    if (c) quota.textContent = c === PLUS ? `${fmt(Math.min(used, c.photos))} av ${fmt(c.photos)} bilder` : `${Math.min(used, c.photos)} av ${c.photos} bilder i gratisversionen${used >= c.photos * 0.8 ? `. Med Plus får ni plats för ${fmt(PLUS.photos)}.` : "."}`;
  }
  const keep = keepIn.value.split(",").filter(Boolean);
  const urlOf = (f) => { if (!thumbUrls.has(f)) thumbUrls.set(f, URL.createObjectURL(f)); return thumbUrls.get(f); };
  box.innerHTML = [
    ...keep.map((pid) => `<span class="pm-t" data-pid="${esc(pid)}">${gridPhotos.get(pid) ? `<img src="${esc(gridPhotos.get(pid))}" alt="">` : `<span class="pg-wait"></span>`}<button type="button" class="pm-x" data-act="photo-rm" data-pid="${esc(pid)}" aria-label="Ta bort bilden">${icon("close", 12)}</button></span>`),
    ...pendingPhotos.map((f, i) => `<span class="pm-t"><img src="${esc(urlOf(f))}" alt=""><button type="button" class="pm-x" data-act="photo-rm" data-i="${i}" aria-label="Ta bort bilden">${icon("close", 12)}</button></span>`),
  ].join("");
  box.hidden = !box.innerHTML;
  const n = keep.length + pendingPhotos.length;
  if (lab) lab.textContent = n ? `${n} ${n === 1 ? "bild" : "bilder"} · Lägg till fler` : "Lägg till kvitto eller bild";
  // Sparade bilder hämtas för miniatyrerna.
  const missing = keep.filter((pid) => !gridPhotos.has(pid));
  if (missing.length) Promise.all(missing.map((pid) => getDoc(ref("photos", pid)).then((s) => { if (s.exists()) gridPhotos.set(pid, s.data().data); }).catch(() => {}))).then(() => { if ($("#ef-photos")) renderPhotoThumbs(); });
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
  const typedPlace = str("workshop") || str("place") || str("station");
  if (data.loc?.name && typedPlace && typedPlace !== data.loc.name) data.loc = null;
  data.odometer = num(fd.get("odometer"));
  if (fd.has("amount")) data.amount = num(fd.get("amount"));
  if (fd.has("handler")) data.handler = str("handler") || null;

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
          action: row.querySelector(".w-action")?.value || "bytt",
          sides: (row.querySelector(".w-pos")?.value || "").split("|").filter(Boolean),
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
      data.depthOff = isSwap(str("tireAction")) ? num(fd.get("depthOff")) : null;
      data.tireKind = data.tireAction === "till_vinter" ? "vinter" : data.tireAction === "till_sommar" ? "sommar" : str("tireKind") || null;
      data.place = str("place") || null;
      // Köpte nya däck: däckens uppgifter sparas på posten och på bilen.
      if (data.tireAction === "nya") {
        if (!data.tireKind) return formError("Välj om det är sommar- eller vinterdäck.");
        // Årtal (2025), DOT-kod med vecka och år (2425 = vecka 24 år 2025) eller bara två siffror (25).
        const yr = str("tireYear").replace(/\D/g, "");
        const now = new Date().getFullYear();
        const tireYear = yr.length === 4 && +yr >= 1990 && +yr <= now + 1 ? yr
          : yr.length === 4 ? `20${yr.slice(2)}`
          : yr.length === 2 ? `20${yr}` : null;
        if (tireYear && (+tireYear < 1990 || +tireYear > now + 1)) return formError("Tillverkningsåret ser fel ut. Skriv till exempel 2025, eller DOT-koden 2425.");
        Object.assign(data, {
          tireBrand: str("tireBrand") || null, tireSize: str("tireSize") || null,
          tireYear,
          studded: data.tireKind === "vinter" ? fd.get("studded") === "on" : null,
          alpine: data.tireKind === "vinter" && fd.get("studded") !== "on" ? alpineFrom(str("alpine")) : null,
        });
      }
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
        const rule = clean({ id: rid, type: "parkering", place: data.place, amount: data.amount, period: Number(str("period")) || 1, start: data.date, end, note: data.note, prev: prev?.prev, createdBy: prev?.createdBy || uid(), createdAt: prev?.createdAt || Date.now() });
        let list = [...(c.recurring || []).filter((x) => x.id !== rid), rule];
        if (prev && prev.amount !== rule.amount && $("#ef-rec-split") && str("recSplit") !== "all") {
          const from = str("splitDate");
          if (!from) return formError("Välj från vilket datum det nya beloppet gäller.");
          if (end && from > end) return formError("Datumet ligger efter att parkeringen slutar.");
          const { id, createdBy, createdAt, prev: _p, ...changes } = rule;
          list = splitRecurring(c, prev, from, changes);
        }
        // Plats och anteckning gäller hela parkeringen, även tidigare priser.
        if (prev) {
          const ids = new Set(recChain(c, rid).map((x) => x.id));
          list = list.map((x) => (ids.has(x.id) ? clean({ ...x, place: rule.place, note: rule.note }) : x));
        }
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
      data.place = data.category === "Besiktning" ? str("place") || null : null;
      if (data.amount == null && data.category !== "Besiktning") return formError("Fyll i kostnaden.");
      if (data.category === "Besiktning") {
        data.result = str("result") || "godkand";
        data.defects = data.result === "godkand" ? null : str("defects").split(/\n+/).map((x) => x.trim()).filter(Boolean);
        if (data.defects && !data.defects.length) data.defects = null;
        data.recheckBy = inspFailed(data.result) ? str("recheckBy") || null : null;
        data.recheck = fd.get("recheck") === "on" || null;
        if (data.recheckBy && data.recheckBy <= data.date) return formError("Efterkontrollen ska ligga efter besiktningen.");
        if (!inspFailed(data.result) && str("nextBesiktning") && str("nextBesiktning") <= data.date) return formError("Nästa besiktning ska ligga efter den här.");
      }
      break;
  }

  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = "Sparar …"; }

  // Bilder: de som fanns och inte togs bort, och de nya. Borttagna raderas.
  const keep = str("keepPhotos").split(",").filter(Boolean);
  const newIds = [];
  try {
    for (const file of pendingPhotos) {
      const dataUrl = await compressImage(file);
      if (!dataUrl) throw new Error("för stor");
      const pRef = doc(col("photos"));
      setDoc(pRef, { data: dataUrl, carId: data.carId, createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
      newIds.push(pRef.id);
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Spara"; }
    return formError("En bild gick inte att läsa in. Prova en annan bild eller ta ett nytt foto.");
  }
  for (const old of photosOf(existing)) if (!keep.includes(old)) deleteDoc(ref("photos", old)).catch(() => {});
  const allPhotos = [...keep, ...newIds];
  data.photoIds = allPhotos.length ? allPhotos : null;
  data.photoId = allPhotos[0] || null;
  pendingPhotos = [];

  const payload = clean(data);
  if (existing) {
    updateDoc(ref("entries", existing.id), { ...payload, updatedAt: serverTimestamp() }).catch(onWriteError);
  } else {
    setDoc(doc(col("entries")), { ...payload, createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
  }

  // Håll bilens uppgifter i takt med loggen.
  const carTarget = S.cars.find((x) => x.id === data.carId) || c;
  const carUpdate = {};
  let extraNote = "";
  if (type === "dack" && !existing) {
    if (data.tireAction === "till_vinter") carUpdate.tiresOn = "vinter";
    if (data.tireAction === "till_sommar") carUpdate.tiresOn = "sommar";
  }
  if (type === "dack" && data.tireAction === "nya" && data.tireKind) {
    // Nya däck ersätter den gamla uppsättningen. Lufttrycket hör till bilen och behålls.
    const tires = [...(carTarget.tires || [])];
    const i = tires.findIndex((t) => t.kind === data.tireKind);
    const old = i >= 0 ? tires[i] : {};
    const fresh = clean({ kind: data.tireKind, brand: data.tireBrand, size: data.tireSize || old.size || null, year: data.tireYear, depth: data.depth, studded: data.tireKind === "vinter" ? !!data.studded : null, alpine: data.alpine ?? null, pressureFront: old.pressureFront ?? null, pressureRear: old.pressureRear ?? null });
    if (i >= 0) tires[i] = fresh; else tires.push(fresh);
    carUpdate.tires = tires;
  } else if (type === "dack" && data.tireKind && (data.depth != null || data.depthOff != null)) {
    // Mönsterdjupet vid bytet: på däcken som sätts på och de som tas av.
    const tires = [...(carTarget.tires || [])];
    const setDepth = (kind, depth) => {
      if (depth == null) return;
      const i = tires.findIndex((t) => t.kind === kind);
      if (i >= 0) tires[i] = { ...tires[i], depth, depthAt: data.date }; else tires.push({ kind, depth, depthAt: data.date });
    };
    setDepth(data.tireKind, data.depth);
    setDepth(data.tireKind === "vinter" ? "sommar" : "vinter", data.depthOff);
    carUpdate.tires = tires;
  }
  if (type === "dack" && !existing && data.tireAction === "till_vinter" && (carTarget.tires || []).some((t) => t.kind === "vinter" && t.studded)) {
    const md = (data.date || todayStr()).slice(5);
    if (md < "10-01" && md > "04-15") extraNote = "Dubbdäck får bara användas före 1 oktober om det är eller befaras bli vinterväglag.";
  }
  if (type === "dack" && !existing && isSwap(data.tireAction) && data.depth == null && data.depthOff == null && !extraNote) extraNote = "Glöm inte att mäta mönsterdjupet, det kan du lägga till under Bilen → Däck.";
  // Fulltankning sätter bränslemätaren till Full.
  if (type === "tank" && data.full && !existing) {
    carUpdate.fuelLevel = { level: 8, pct: 100, by: uid(), at: serverTimestamp(), via: "tank" };
  }
  // Gjord besiktning: flytta "Besiktning senast" till nästa datum.
  // Bara om det nya datumet är senare än det som redan finns, så att en gammal besiktning inte flyttar sista dagen bakåt.
  if (type === "kostnad" && data.category === "Besiktning") {
    // Godkänd: nästa besiktning sätts och en väntande efterkontroll är klar. Underkänd: efterkontrollen läggs in.
    if (!inspFailed(data.result) && str("nextBesiktning") && str("nextBesiktning") > (carTarget.besiktning || "")) carUpdate.besiktning = str("nextBesiktning");
    if (inspFailed(data.result) && data.recheckBy) carUpdate.efterkontroll = { by: data.recheckBy, result: data.result, date: data.date };
    else if (carTarget.efterkontroll && (data.recheck || !existing)) carUpdate.efterkontroll = deleteField();
    // Bristerna läggs i Att göra, utan dubbletter.
    if (data.defects?.length) {
      const todos = [...(carTarget.todos || [])];
      const have = new Set(todos.filter((t) => !t.done).map((t) => normWord(t.text)));
      const add = data.defects.filter((d) => !have.has(normWord(d))).map((d) => ({ id: "t" + randomId(8), text: d, done: false, by: uid(), at: Date.now(), src: "besiktning" }));
      if (add.length) { carUpdate.todos = [...todos, ...add]; extraNote = `${add.length === 1 ? "Bristen" : `${add.length} brister`} har lagts i Att göra.`; }
    }
  }
  // Service som byter en del bockar av samma brist från besiktningen i Att göra.
  if ((type === "service" || type === "eget") && data.work?.length && (carTarget.todos || []).some((t) => t.src === "besiktning" && !t.done)) {
    const stem = (x) => normWord(x).slice(0, 6);
    const names = data.work.map((w) => stem(w.name)).filter((x) => x.length >= 4);
    let n = 0;
    const todos = (carUpdate.todos || carTarget.todos).map((t) => (t.src === "besiktning" && !t.done && names.some((x) => stem(t.text).startsWith(x) || x.startsWith(stem(t.text))) ? (n++, { ...t, done: true, doneAt: Date.now(), doneBy: uid() }) : t));
    if (n) { carUpdate.todos = todos; extraNote = n === 1 ? "En brist från besiktningen är avbockad i Att göra." : `${n} brister från besiktningen är avbockade i Att göra.`; }
  }
  if (form.dataset.booking) {
    carUpdate.bookings = (carTarget.bookings || []).filter((x) => x.id !== form.dataset.booking);
  }
  if (Object.keys(carUpdate).length) updateDoc(ref("cars", carTarget.id), carUpdate).catch(onWriteError);

  closeSheet();
  showToast(extraNote ? `${existing ? "Ändringen är sparad" : `${isInspection(data) ? "Besiktning" : TYPE[type].label} sparad`}. ${extraNote}` : existing ? "Ändringen är sparad" : `${TYPE[type].label} sparad${type === "tank" ? ". De andra ser den direkt." : ""}`, extraNote ? 6000 : undefined);
  if (!existing && S.view !== "oversikt" && S.view !== "logg") setView("logg");
}

// Var något gjordes: verkstaden, platsen eller namnet från bokningen.
const PLACE_TYPES = ["tank", "service", "dack", "kostnad", "tvatt", "parkering"];
function entryPlaceName(e) {
  if (!PLACE_TYPES.includes(e.type) && !e.loc) return "";
  return e.loc?.name || e.workshop || e.station || e.place || (e.type === "kostnad" && e.category === "Besiktning" ? (e.title || "").replace(/^Besiktning hos /, "") : "") || "";
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
      // Visa att adressen letas upp, och säg till om den inte hittas, i stället för att inget händer.
      const note = $("#en-map-note");
      if (note) { note.hidden = false; note.textContent = "Letar upp adressen …"; }
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
        // Återkommande parkeringar räknas fram och finns inte som egna poster, så där sparas inget.
        if (loc) { if (!String(e.id).startsWith("rec:")) updateDoc(ref("entries", e.id), { loc }).catch(onWriteError); e.loc = loc; }
        // Visa adressen i listan ovanför kartan när den har hittats.
        const dd = [...document.querySelectorAll("#sheet .detail-list dt")].find((d) => d.textContent === "Adress");
        if (hit && dd) dd.nextElementSibling.textContent = hit.addr;
        else if (hit) document.querySelector("#sheet .detail-list")?.insertAdjacentHTML("beforeend", `<div><dt>Adress</dt><dd>${esc(hit.addr)}</dd></div>`);
        if (!hit) dd?.parentElement.remove();
        if (note) {
          note.hidden = !!hit;
          if (!hit) note.textContent = `Hittade ingen adress för ”${name}”. Tryck Ändra och skriv med orten, till exempel ”${name} Uppsala”.`;
        }
      } catch {
        if (note) note.textContent = "Kunde inte leta upp adressen just nu. Öppna posten igen om en stund.";
        if (loc?.lat == null) return;
      }
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
    e.station || e.place || e.workshop ? ["Plats", e.station || e.place || e.workshop] : null,
    e.handler ? ["Handläggare", e.handler] : null,
    e.type === "parkering" && e.fine ? ["Typ", "P-bot eller felparkeringsavgift"] : null,
    hasStreet(e.loc?.addr) ? ["Adress", e.loc.addr] : null,
    e.category && e.type === "kostnad" ? ["Typ", e.recheck ? "Besiktning, efterkontroll" : e.category] : null,
    isInspection(e) && e.result ? ["Resultat", INSP_RESULTS[e.result]] : null,
    isInspection(e) && e.defects?.length ? ["Brister", e.defects.join("\n")] : null,
    isInspection(e) && e.recheckBy ? ["Efterkontroll senast", fmtDate(e.recheckBy)] : null,
    e.tireBrand ? ["Märke", e.tireBrand] : null,
    e.tireSize ? ["Dimension", e.tireSize] : null,
    e.tireYear ? ["Tillverkningsår", e.tireYear] : null,
    e.type === "dack" && e.tireKind === "vinter" && e.studded != null ? ["Dubbade", e.studded ? "Ja" : "Nej"] : null,
    e.depth != null ? ["Mönsterdjup", `${fmt(e.depth, 1)} mm`] : null,
    ["service", "eget"].includes(e.type) && workOf(e, c).length ? ["Gjordes", workOf(e, c).map(workText).join(", ")] : null,
    e.note ? ["Anteckning", e.note] : null,
  ].filter(Boolean);
  openSheet(entryTitle(e), `
    <dl class="detail-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${entryPlaceName(e) && e.loc?.lat == null ? `<p class="hint" id="en-map-note" hidden style="margin-top:10px"></p>` : ""}
    ${entryPlaceName(e) ? `<div class="bk-map" id="en-map"${e.loc?.lat != null ? "" : " hidden"} style="margin-top:14px">
      <div class="bk-map-inner" id="en-map-inner"></div>
      <button class="bk-map-open" type="button" data-act="entry-map" data-id="${esc(e.id)}" aria-label="Öppna platsen i en kartapp"><span>${icon("pin", 14)} Öppna i kartan</span></button>
    </div>` : ""}
    ${photosOf(e).length ? `<div id="photo-box" style="margin-top:14px"><p class="hint">Hämtar ${photosOf(e).length > 1 ? "bilderna" : "bilden"} …</p></div>` : ""}
    <div class="btn-row" style="margin-top:18px">
      <button class="btn primary" type="button" data-act="edit-entry" data-id="${esc(e.id)}">Ändra</button>
      <button class="btn danger" type="button" data-act="delete-entry" data-id="${esc(e.id)}">Ta bort</button>
    </div>
`, fromCat?.startsWith("item:") ? { back: "edit-item", backId: fromCat.slice(5) } : fromCat?.startsWith("part:") ? { back: "open-part", backId: fromCat.slice(5) } : fromCat ? { back: "open-cat", backId: fromCat } : {});
  if (entryPlaceName(e)) showEntryMap(e);
  if (photosOf(e).length) {
    Promise.all(photosOf(e).map((pid) => getDoc(ref("photos", pid)).then((s) => (s.exists() ? s.data().data : null)).catch(() => null))).then((list) => {
      const box = $("#photo-box");
      if (!box) return;
      const ok = list.filter(Boolean);
      box.innerHTML = ok.length
        ? `<div class="${ok.length > 1 ? "photo-stack" : ""}">${ok.map((d, i) => `<button class="photo-zoom" type="button" data-act="photo-zoom" aria-label="Visa bild ${i + 1} större"><img class="photo" src="${esc(d)}" alt="Bild ${i + 1} för ${esc(entryTitle(e))}"></button>`).join("")}</div>`
        : `<p class="hint">${list.length > 1 ? "Bilderna finns" : "Bilden finns"} inte längre.</p>`;
    });
  }
}

// Bra att veta för varje underhållspunkt: vad den gör, hur man vet att det är dags och vanliga tecken på fel.
const ITEM_INFO = {
  olja: {
    sv: ["Oljan smörjer och kyler motorn. Gammal olja skyddar sämre och kan ge slitage.", "Kolla nivån med oljestickan ungefär en gång i månaden, på plan mark och med kall motor. Nivån ska vara mellan min och max.", "Använd den olja som står i instruktionsboken (till exempel 5W-30). Skriv in den under Anteckningar på Bilen, så har du den till hands i butiken.", "Tecken på problem: oljelampan lyser, oljan är svart och tjock, motorn låter mer än vanligt eller det droppar under bilen."],
    en: ["The oil lubricates and cools the engine. Old oil protects less and can cause wear.", "Check the level with the dipstick about once a month, on level ground with a cold engine. It should be between min and max.", "Use the oil in the owner's manual (for example 5W-30). Add it under Notes on the Car page so you have it at hand in the shop.", "Signs of trouble: the oil light is on, the oil is black and thick, the engine sounds louder than usual or it drips under the car."],
  },
  luftfilter: {
    sv: ["Luftfiltret håller damm och smuts borta från motorn.", "Kör du mycket på grusvägar eller i dammiga miljöer kan det behöva bytas oftare.", "Det är oftast lätt att byta själv: filterlådan sitter under motorhuven och öppnas med några clips.", "Tecken på ett igensatt filter: sämre kraft, högre bränsleförbrukning eller att motorn tvekar när du gasar."],
    en: ["The air filter keeps dust and dirt out of the engine.", "If you drive a lot on gravel roads or in dusty conditions it may need changing more often.", "It is usually easy to change yourself: the filter box is under the bonnet and opens with a few clips.", "Signs of a clogged filter: less power, higher fuel consumption or the engine hesitating when you accelerate."],
  },
  kupefilter: {
    sv: ["Kupéfiltret renar luften som kommer in i bilen från pollen, damm och avgaser.", "Byt gärna inför våren om någon i familjen är pollenallergisk. Ett kolfilter tar också bort lukt.", "Det sitter oftast bakom handskfacket och går ofta att byta själv på några minuter.", "Tecken på att det är dags: dålig lukt när fläkten går, sämre luftflöde eller att rutorna immar igen lätt."],
    en: ["The cabin filter cleans the air that comes into the car of pollen, dust and exhaust fumes.", "Change it before spring if someone in the family has a pollen allergy. A carbon filter also removes smells.", "It is usually behind the glove box and can often be changed yourself in a few minutes.", "Signs it's time: a bad smell when the fan runs, weaker airflow or windows fogging up easily."],
  },
  tandstift: {
    sv: ["Tändstiften tänder bränslet i motorn. Slitna tändstift ger sämre tändning.", "Bilar som kör mycket på E85 sliter ofta tändstiften fortare.", "Byt alla på en gång, och använd den sort som står i instruktionsboken.", "Tecken på slitna tändstift: motorn går ojämnt, startar sämre, hackar när du gasar eller drar mer bränsle."],
    en: ["The spark plugs ignite the fuel in the engine. Worn plugs give weaker ignition.", "Cars that run a lot on E85 often wear their plugs faster.", "Change all of them at once, and use the type in the owner's manual.", "Signs of worn plugs: the engine runs unevenly, starts poorly, stutters when you accelerate or uses more fuel."],
  },
  bromsvatska: {
    sv: ["Bromsvätskan drar till sig fukt med tiden. Då kan den börja koka vid hårda inbromsningar och bromsarna blir sämre.", "Därför byts den efter tid, inte efter hur långt bilen har gått. Det görs oftast på verkstad i samband med service.", "Kolla nivån i behållaren under motorhuven ibland. Sjunker den kan bromsklossarna vara slitna eller något läcka.", "Tecken på problem: bromspedalen känns mjuk eller går långt ner, eller bromsvarningslampan lyser. Kör då försiktigt till en verkstad."],
    en: ["Brake fluid absorbs moisture over time. It can then boil during hard braking and the brakes get worse.", "That's why it is changed by time, not by distance. It is usually done at a workshop during a service.", "Check the level in the reservoir under the bonnet now and then. If it drops, the brake pads may be worn or something may be leaking.", "Signs of trouble: the brake pedal feels soft or goes far down, or the brake warning light is on. Drive carefully to a workshop."],
  },
  torkare: {
    sv: ["Torkarbladen slits av sol, frost och smuts, även om de inte används så mycket.", "Byt gärna inför hösten, när det regnar mer och blir mörkare.", "Torka av bladen med en fuktig trasa ibland, och lyft upp dem från rutan när det är minusgrader.", "Tecken på att det är dags: ränder på rutan, att bladet hoppar eller gnisslar, eller att gummit har sprickor."],
    en: ["Wiper blades are worn by sun, frost and dirt, even if they aren't used much.", "Change them before autumn, when there's more rain and it gets darker.", "Wipe the blades with a damp cloth now and then, and lift them off the windscreen in freezing weather.", "Signs it's time: streaks on the windscreen, the blade jumping or squeaking, or cracks in the rubber."],
  },
  ac: {
    sv: ["AC-service betyder att anläggningen kontrolleras och att köldmediet fylls på eller byts. Det försvinner lite varje år.", "En kontroll eller påfyllning räknas också som AC-service här.", "Kör gärna AC:n en stund varje månad, även på vintern. Det håller tätningarna smorda och torkar ur luften så att rutorna immar mindre.", "Tecken på att den behöver service: den kyler dåligt, det luktar unket när den startar, eller det låter när den går."],
    en: ["An AC service means the system is checked and the refrigerant is topped up or replaced. A little is lost every year.", "A check or top-up also counts as an AC service here.", "Run the AC for a while every month, even in winter. It keeps the seals lubricated and dries the air so the windows fog up less.", "Signs it needs a service: it cools poorly, there's a musty smell when it starts, or it makes noise when running."],
  },
  batteri: {
    sv: ["Ett bilbatteri behöver inte bytas så länge det fungerar bra. Kontrollera det i stället, gärna varje höst. Trycker du på Kontrollerat – ser bra ut får det ett år till.", "Låt kontrollera spänningen inför vintern, på en verkstad eller med en egen mätare. Fulladdat ligger det på cirka 12,6 volt med motorn avstängd. Under 12,4 volt är det dags att ladda, och under 12,0 volt är det i dåligt skick.", "Kyla tar hårt på batteriet. Ett batteri som är äldre än fem år kan svikta en kall morgon.", "Tecken på ett dåligt batteri: motorn drar runt långsamt vid start, lamporna blir svaga vid start, klockan eller radion nollställs, eller batterilampan lyser. Korta resor laddar dåligt, så kör en längre sträcka ibland."],
    en: ["A car battery doesn't need replacing as long as it works well. Check it instead, preferably every autumn. If you tap Checked – looks good, it gets another year.", "Have the voltage checked before winter, at a workshop or with your own meter. Fully charged it is about 12.6 volts with the engine off. Below 12.4 volts it should be charged, and below 12.0 volts it is in poor condition.", "Cold is hard on the battery. A battery older than five years may fail on a cold morning.", "Signs of a bad battery: the engine cranks slowly when starting, the lights dim when starting, the clock or radio resets, or the battery light is on. Short trips charge poorly, so take a longer drive now and then."],
  },
  kamrem: {
    sv: ["Kamremmen styr motorns ventiler. Går den av kan motorn få allvarliga skador.", "Följ tillverkarens intervall noga, både mil och år. Gummit åldras även om bilen inte körs så mycket.", "Byt vattenpumpen och sträckarna samtidigt om verkstaden rekommenderar det. Det blir ofta billigare än att göra det i två omgångar.", "Kamremmen ger sällan varning innan den går av. Har du köpt bilen begagnad och vet inte när den byttes, låt byta den för säkerhets skull."],
    en: ["The timing belt controls the engine's valves. If it breaks, the engine can be seriously damaged.", "Follow the manufacturer's interval closely, both distance and years. The rubber ages even if the car isn't driven much.", "Change the water pump and tensioners at the same time if the workshop recommends it. It is often cheaper than doing it twice.", "A timing belt rarely gives a warning before it breaks. If you bought the car used and don't know when it was changed, have it changed to be safe."],
  },
};
// Punkter där en kontroll, påfyllning eller lagning också räknas, inte bara ett byte.
const ANY_WORK_ITEMS = new Set(["ac"]);
const LAST_LABEL = { ac: "Senaste service" };
// Delar som kan sitta kvar så länge de är bra. En kontroll ("ser bra ut") ger ett år till, eller en fjärdedel av
// milintervallet, räknat från kontrollen. Ett byte nollställer som vanligt.
const CHECK_ITEMS = new Set(["batteri", "torkare", "luftfilter", "kupefilter"]);
const checkExtension = (item) => ({ months: item.months ? 12 : null, mil: item.mil ? Math.max(500, Math.round(item.mil / 4 / 100) * 100) : null });
// En underhållspunkt: status, alla loggade byten (ikryssade eller skrivna i Annat som byttes) och knappar för att logga eller ändra.
function itemSheet(id) {
  const c = car();
  const item = (c.items || []).find((i) => i.id === id);
  if (!item) return;
  const st = itemStatusWithCheck(item, c, carEntries());
  const fc = item.mil && plusFeat() ? itemForecast(st, c) : null;
  const history = carEntries().filter((e) => entryTouches(e, item)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const interval = intervalText(item) === "inget intervall" ? "" : intervalText(item);
  const manual = item.baseDate && !history.some((e) => e.date >= item.baseDate);
  const anyWork = ANY_WORK_ITEMS.has(item.id);
  // Senaste gången punkten berördes, om det var något annat än ett byte (kontrollerat, fyllt på …).
  const touch = history[0];
  const touchAction = touch ? workOf(touch, c).find((w) => workIsItem(w, item))?.action || "bytt" : null;
  const otherWork = touch && !anyWork && !st.check && touchAction !== "bytt" && (!st.lastDate || touch.date > st.lastDate);
  const info = ITEM_INFO[item.id]?.[EN ? "en" : "sv"] || partInfo(item.name);
  openSheet(item.name, `
    <dl class="detail-list">
      <div><dt>Intervall</dt><dd>${esc(interval || "–")}</dd></div>
      ${otherWork ? `<div><dt>Senast gjort</dt><dd>${esc(`${WORK_ACTIONS[touchAction] || "Gjort"} ${fmtDate(touch.date)}`)}<br><span class="hint">Räknas inte som byte</span></dd></div>` : ""}
      ${st.check ? `<div><dt>Senast kontrollerat</dt><dd>${esc(fmtDate(st.check.date))}<br><span class="hint">Såg bra ut, fick ${esc(checkExtension(item).months ? "ett år" : `${fmt(checkExtension(item).mil)} mil`)} till</span></dd></div>` : ""}
      <div><dt>${LAST_LABEL[item.id] || "Senast bytt"}</dt><dd>${esc((st.check ? st.replacedDate : st.lastDate) ? [fmtDate(st.check ? st.replacedDate : st.lastDate), (st.check ? st.replacedMil : st.lastMil) != null ? `vid ${fmt(st.check ? st.replacedMil : st.lastMil)} mil` : ""].filter(Boolean).join(", ") : "Okänt")}${manual ? `<br><span class="hint">Ifyllt för hand, inte från loggen</span>` : ""}</dd></div>
      ${!st.unknown ? `<div><dt>Nästa</dt><dd>${esc(dueText(st) || "–")}</dd></div><div><dt>Kvar</dt><dd>${esc(st.label)}</dd></div>` : ""}
      ${!st.unknown && item.mil ? (plusFeat()
        ? `<div><dt>Beräknat</dt><dd>${fc && fc.rate ? `${esc(forecastText(fc))}<br><span class="hint">${esc(`Ni kör ungefär ${fmt(Math.round(fc.rate * 30.44))} mil i månaden`)}</span>` : `<span class="hint">Logga mätarställningen några gånger, så räknas det ut.</span>`}</dd></div>`
        : plusLock() ? `<div><dt>Beräknat</dt><dd><button class="link" type="button" data-act="plus" data-f="forecast">Se när <span class="plus-badge">Plus</span></button></dd></div>` : "") : ""}
    </dl>
    ${wearBar(st) ? `<div style="margin-top:12px">${wearBar(st)}</div>` : ""}
    ${info ? `<details class="more item-info" style="margin-top:16px"${st.unknown ? " open" : ""}><summary>Bra att veta</summary><ul data-notr>${info.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : ""}
    <h3 class="section-t" style="margin-top:20px">I loggen</h3>
    ${manual ? `<div class="manual-base">
      <p><b>${esc(`Ifyllt för hand: ${fmtDate(item.baseDate)}${item.baseMil != null ? ` vid ${fmt(item.baseMil)} mil` : ""}`)}</b></p>
      <p class="hint">${esc(history.length ? `Datumet är nyare än det som står i loggen, så det räknas som senaste byte. Stämmer det inte, ta bort det så räknar appen från loggen (${fmtDate(history[0].date)}).` : "Det finns inget i loggen, så datumet räknas som senaste byte.")}</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="edit-item-form" data-id="${esc(id)}">Ändra</button>${history.length ? `<button class="link danger" type="button" data-act="clear-item-base" data-id="${esc(id)}">Ta bort datumet</button>` : ""}</div>
    </div>` : ""}
    ${history.length
      ? `<div class="rows" style="margin-top:6px">${history.map((e) => entryRow(e, `item:${id}`)).join("")}</div>`
      : manual ? "" : `<p class="muted" style="margin-top:6px">Inga loggade byten än. Kryssa i ${esc(item.name.toLowerCase())} när du loggar en service eller ett eget jobb, så hamnar det här.</p>`}
    <div class="form" style="margin-top:18px">
      <button class="btn primary block" type="button" data-act="log-item" data-id="${esc(id)}">Logga byte</button>
      ${CHECK_ITEMS.has(id) ? `${st.check?.date === todayStr() ? `<button class="btn block check-done" type="button" disabled>${icon("check", 18)} Kontrollerat i dag</button>` : `<button class="btn block" type="button" data-act="item-checked" data-id="${esc(id)}">${icon("check", 18)} Kontrollerat – ser bra ut</button>`}
      <p class="hint" style="margin-top:-4px">${st.check?.date === todayStr() ? "Kontrollen är sparad i loggen. Blev det fel kan du ta bort den där." : esc(`Behöver inte bytas? Då får den ${checkExtension(item).months ? "ett år" : `${fmt(checkExtension(item).mil)} mil`} till från i dag, och kontrollen syns i loggen.`)}</p>` : ""}
      <button class="btn ghost block" type="button" data-act="edit-item-form" data-id="${esc(id)}">Ändra intervall</button>
    </div>`);
}

function recurringSheet(rid) {
  const c = car();
  const chain = recChain(c, rid);
  if (!chain.length) return;
  const first = chain[0], last = chain.at(-1), today = todayStr();
  const now = chain.find((x) => x.start <= today && (!x.end || x.end >= today)) || last;
  const before = chain.filter((x) => x !== now && x.end && x.end < today);
  const paid = recurringEntries({ ...c, recurring: chain });
  const sum = paid.reduce((a, e) => a + (e.amount || 0), 0);
  const ended = last.end && last.end <= today;
  const id = esc(first.id);
  openSheet(last.place ? `Parkering · ${last.place}` : "Återkommande parkering", `
    <dl class="detail-list">
      <div><dt>Kostnad</dt><dd>${esc(recPeriod(now))}</dd></div>
      ${last !== now && last.start > today ? `<div><dt>Nytt pris</dt><dd>${esc(`${fmtKr(last.amount)} kr från ${fmtDate(last.start)}`)}</dd></div>` : ""}
      ${before.length ? `<div><dt>Tidigare pris</dt><dd>${before.map((x) => esc(`${fmtKr(x.amount)} kr till ${fmtDate(x.end)}`)).join("<br>")}</dd></div>` : ""}
      <div><dt>Började</dt><dd>${esc(fmtDate(first.start))}</dd></div>
      <div><dt>Slutar</dt><dd>${esc(last.end ? fmtDate(last.end) : "Pågår")}</dd></div>
      <div><dt>Betalt hittills</dt><dd>${esc(`${fmtKr(sum)} kr · ${paid.length} ${paid.length === 1 ? "gång" : "gånger"}`)}</dd></div>
      ${last.note ? `<div><dt>Anteckning</dt><dd>${esc(last.note)}</dd></div>` : ""}
    </dl>
    <div class="form" style="margin-top:18px">
      <button class="btn primary block btn-2l" type="button" data-act="edit-rec" data-id="${id}">Ändra<span class="btn-sub">Plats, belopp eller hur ofta</span></button>
      ${!ended ? `<button class="btn ghost block btn-2l" type="button" data-act="rec-price" data-id="${id}">Byt pris från ett datum<span class="btn-sub">Tidigare betalningar behåller sitt pris</span></button>
      <button class="btn ghost block btn-2l" type="button" data-act="end-rec" data-id="${id}">Sluta betala från i dag<span class="btn-sub">${paid.length ? esc(`${paid.length === 1 ? "Betalningen" : `De ${paid.length} betalningarna`} (${fmtKr(sum)} kr) finns kvar`) : "Inget har betalats än"}</span></button>` : ""}
      <button class="btn danger block btn-2l" type="button" data-act="delete-rec" data-id="${id}">Radera helt<span class="btn-sub">${paid.length ? esc(`Tar bort ${paid.length === 1 ? "betalningen" : `alla ${paid.length} betalningar`}, som om den aldrig fanns`) : "Som om den aldrig fanns"}</span></button>
    </div>`);
}

// Ändras beloppet på en regel som redan har betalningar: fråga om det gäller framåt eller alla.
function recSplitBox(c, rid) {
  const r = rid && (c.recurring || []).find((x) => x.id === rid);
  if (!r || !recurringEntries({ ...c, recurring: [r] }).length) return "";
  return `<div id="ef-rec-split" data-orig="${esc(r.amount)}" hidden>
    <p class="rec-split-t">Det nya beloppet gäller</p>
    <label class="check"><input type="radio" name="recSplit" value="from" checked> Från ett datum. Tidigare betalningar behåller sitt pris</label>
    ${field("Från", `<input type="date" name="splitDate" id="ef-splitDate" value="${esc(nextRecDate(r) || todayStr())}" min="${esc(r.start)}">`)}
    <label class="check"><input type="radio" name="recSplit" value="all"> Alla betalningar. Jag skrev fel från början</label>
  </div>`;
}
function recPriceSheet(rid) {
  const r = recChain(car(), rid).at(-1);
  if (!r) return;
  const next = nextRecDate(r) || todayStr();
  openSheet("Byt pris", `
    <form class="form" data-form="rec-price" data-id="${esc(r.id)}" novalidate>
      <p class="hint" style="margin-top:0">Nu: ${esc(`${fmtKr(r.amount)} kr, ${PERIODS[r.period]?.toLowerCase()}`)}</p>
      ${field("Nytt pris per gång (kr)", `<input name="amount" id="rp-amount" inputmode="decimal" required autocomplete="off" placeholder="${esc(fmtKr(r.amount))}">`)}
      ${field("Gäller från", `<input type="date" name="from" id="rp-from" required value="${esc(next)}" min="${esc(r.start)}">`, "Förslaget är nästa betalning. Betalningar före det datumet behåller det gamla priset.")}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara nytt pris</button>
    </form>`, { back: "open-rec", backId: rid });
}
function saveRecPrice(form) {
  const c = car();
  const r = (c.recurring || []).find((x) => x.id === form.dataset.id);
  if (!r) return;
  const fd = new FormData(form);
  const amount = num(fd.get("amount"));
  const from = String(fd.get("from") || "");
  if (!amount || amount < 0) return formError("Fyll i det nya priset.");
  if (!from) return formError("Välj från vilket datum det nya priset gäller.");
  if (r.end && from > r.end) return formError("Datumet ligger efter att parkeringen slutar.");
  const list = splitRecurring(c, r, from, { amount });
  updateDoc(ref("cars", c.id), { recurring: list }).catch(onWriteError);
  c.recurring = list;
  closeSheet(); render();
  showToast(`Nytt pris ${fmtKr(amount)} kr från ${fmtDate(from)}`, 5000);
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
    ${(() => { const info = partInfo(x.name); return info ? `<details class="more item-info" style="margin-top:16px"><summary>Bra att veta</summary><ul data-notr>${info.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : ""; })()}
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
      ${edit && sections.includes("basic") ? `<p class="hint">Vill du ta bort bilen? Det gör du längst ner på sidan Bilen.</p>` : ""}
    </form>`);
}

async function deleteCar(carId) {
  const ents = (S.allEntries || S.entries).filter((e) => e.carId === carId);
  const carPhoto = [...S.cars, ...(S.trash || [])].find((x) => x.id === carId)?.photoId;
  const ops = [ref("cars", carId), ...ents.map((e) => ref("entries", e.id)), ...ents.flatMap((e) => photosOf(e).map((pid) => ref("photos", pid)))];
  if (carPhoto) ops.push(ref("photos", carPhoto));
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
}

// Teman: bakgrundsfärgen (bar) används också för telefonens statusrad.
// Utseende: en färg och ett läge (Automatiskt följer telefonen, Ljust eller Mörkt). Varje färg finns i ljust och mörkt.
// Förr var det ett enda val (pref "theme"); det översätts till färg och läge första gången.
const COLORS = {
  orange: { name: "Orange", light: { theme: "light", sw: "#E9E4DF", dot: "#E77026" }, dark: { theme: "dark", sw: "#171514", dot: "#F08443" } },
  gron: { name: "Grön", light: { theme: "gron", sw: "#E1E8DE", dot: "#2E7D4F" }, dark: { theme: "gron-dark", sw: "#121914", dot: "#4FBF7E" } },
  hav: { name: "Blå", light: { theme: "hav", sw: "#E0E7EF", dot: "#2563EB" }, dark: { theme: "hav-dark", sw: "#10161F", dot: "#5B8DEF" } },
  lila: { name: "Lila", light: { theme: "lila", sw: "#E8E6F3", dot: "#6D5BD8" }, dark: { theme: "natt", sw: "#12131C", dot: "#8B7CF6" } },
  // Glenns Garage: tre teman i pixelstil som Glenn. De har egna färger och följer inte ljust och mörkt läge.
  garage: { name: "Femtiotals\u00admack", garage: "g-diner", light: { theme: "garage", sw: "#bfe3d0", dot: "#d7263d" }, dark: { theme: "garage", sw: "#bfe3d0", dot: "#d7263d" } },
  "garage-neon": { name: "Neonnatt", garage: "g-neon", light: { theme: "garage-neon", sw: "#2a1446", dot: "#ff4fd8" }, dark: { theme: "garage-neon", sw: "#2a1446", dot: "#ff4fd8" } },
  "garage-cozy": { name: "Mysig verkstad", garage: "g-cozy", light: { theme: "garage-cozy", sw: "#efe2c8", dot: "#5d7a3a" }, dark: { theme: "garage-cozy", sw: "#efe2c8", dot: "#5d7a3a" } },
};
const MODES = { auto: "Automatiskt", light: "Ljust", dark: "Mörkt" };
const DARK_THEMES = ["dark", "gron-dark", "hav-dark", "natt", "garage-neon"];
const darkMq = matchMedia("(prefers-color-scheme: dark)");
function themePrefs() {
  const old = { auto: ["orange", "auto"], light: ["orange", "light"], dark: ["orange", "dark"], gron: ["gron", "light"], hav: ["hav", "light"], natt: ["lila", "dark"] }[pref.get("theme") || "auto"] || ["orange", "auto"];
  const c = pref.get("themeColor") || old[0], m = pref.get("themeMode") || old[1];
  // Glenns Garage ingår i Plus. Utan Plus blir det vanliga färger igen.
  const ok = COLORS[c] && !(COLORS[c].garage && S.house && plusLock());
  return { color: ok ? c : "orange", mode: MODES[m] ? m : "auto" };
}
const isDarkNow = () => { const { mode } = themePrefs(); return mode === "dark" || (mode === "auto" && darkMq.matches); };
function applyTheme() {
  const { color } = themePrefs();
  const v = COLORS[color][isDarkNow() ? "dark" : "light"];
  document.documentElement.dataset.theme = v.theme;
  if (COLORS[color].garage) document.documentElement.dataset.garage = "1"; else delete document.documentElement.dataset.garage;
  swapIcons();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = v.sw; });
}
// Följer telefonen när den byter mellan ljust och mörkt (vid läget Automatiskt).
darkMq.addEventListener?.("change", () => { applyTheme(); if (S.view === "installningar") render(); });

// Läser bara de fält som finns i formuläret, så att en del aldrig skriver över en annan.
function readCarForm(form) {
  const fd = new FormData(form);
  const has = (k) => !!form.elements.namedItem(k);
  const str = (k) => String(fd.get(k) ?? "").trim();
  const data = {};
  if (has("make")) {
    Object.assign(data, {
      make: str("make"), model: str("model"), year: str("year") || null, engine: str("engine") || null,
      fuel: str("fuel"), color: str("color") || null, plate: (plateOk(str("plate")) ? fmtPlate(str("plate")) : str("plate").toUpperCase()) || null,
      vin: cleanVin(str("vin")) || null, vinShare: fd.get("vinShare") === "on" || null,
      bodyStyle: str("bodyStyle") || null, seats: num(fd.get("seats")), co2: num(fd.get("co2")), firstReg: str("firstReg") || null,
    });
  }
  // Bara för en ny bil: blir bilens första loggpost.
  if (has("odometer")) data.odometer = num(fd.get("odometer"));
  if (has("lastInspection")) {
    const est = estimateInspection(str("lastInspection"), fd.get("notInspected") === "on", str("year"));
    if (est && est >= todayStr()) data.besiktning = est;
  }
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
  if (has("gearbox")) {
    Object.assign(data, {
      gearbox: str("gearbox") || null, tankVolume: num(fd.get("tankVolume")),
      towMax: num(fd.get("towMax")), totalWeight: num(fd.get("totalWeight")), trainWeight: num(fd.get("trainWeight")),
    });
  }
  if (has("tiresOn")) {
    // När mönsterdjupet mättes: i dag om det har ändrats, annars som förut.
    const prevTires = (S.cars.find((x) => x.id === form.dataset.id) || (form.dataset.form === "car-new" ? null : car()))?.tires || [];
    const depthAtOf = (kind, depth) => { const o = prevTires.find((t) => t.kind === kind) || {}; return depth == null ? null : num(o.depth) === depth ? o.depthAt || null : todayStr(); };
    Object.assign(data, {
      tiresOn: str("tiresOn") || "sommar",
      tires: [
        clean({ kind: "sommar", brand: str("s_brand") || null, size: str("s_size") || null, year: str("s_year") || null, depth: num(fd.get("s_depth")), depthAt: depthAtOf("sommar", num(fd.get("s_depth"))), pressureFront: num(fd.get("s_pf")), pressureRear: num(fd.get("s_pr")) }),
        clean({ kind: "vinter", brand: str("w_brand") || null, size: str("w_size") || null, year: str("w_year") || null, depth: num(fd.get("w_depth")), depthAt: depthAtOf("vinter", num(fd.get("w_depth"))), pressureFront: num(fd.get("w_pf")), pressureRear: num(fd.get("w_pr")), studded: fd.get("w_studded") === "on", alpine: fd.get("w_studded") === "on" ? null : alpineFrom(str("w_alpine")) }),
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
    if (NATIVE) {
      try { await signInWithCredential(auth, await nativeCredential(el?.dataset.provider || "google")); }
      catch (e) { if (!nativeCancelled(e)) renderLogin(authError(e)); }
      return;
    }
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
      if (NATIVE) await linkWithCredential(auth.currentUser, await nativeCredential(name));
      else await linkWithPopup(auth.currentUser, provider);
      await auth.currentUser.reload?.();
      S.user = auth.currentUser;
      showToast(`${PROVIDER_NAMES[name]} är kopplat. Nu kan du logga in med det också.`, 5000);
      render();
    } catch (e) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)) {
        try { await linkWithRedirect(auth.currentUser, provider); } catch (e2) { showToast(authError(e2), 8000); }
      } else if (e.code !== "auth/popup-closed-by-user" && !(NATIVE && nativeCancelled(e))) {
        showToast(authError(e, name), 9000);
      }
    }
  },
  async "delete-account"(el) {
    const others = (S.house?.members || []).filter((m) => m !== uid());
    // Ägaren väljer först vem som tar över hushållet.
    const next = el?.dataset?.next || "";
    if (isOwner() && others.length && !others.includes(next)) return pickNextOwner("delete-account", others);
    if (!sheet.hidden) closeSheet();
    const house = S.house?.name || "hushållet";
    const ok = await confirmDialog({
      title: "Radera ditt konto?",
      lines: others.length
        ? [`Ditt konto och din inloggning tas bort, och du lämnar ${house}.`, "Det du har loggat finns kvar för de andra.", next ? `${memberName(next)} blir hushållets ägare.` : null]
        : [`Ditt konto och ${house} tas bort, med allt som är loggat: bilar, logg, bilder, dokument och delade serviceböcker.`, "Ladda gärna ner en säkerhetskopia först, under Säkerhetskopia."],
      okLabel: "Radera",
    });
    if (!ok) return;
    // Firebase kräver en färsk inloggning för att radera ett konto. Logga in en gång till först, innan något tas bort.
    const signedInAgo = Date.now() - Date.parse(auth.currentUser?.metadata?.lastSignInTime || 0);
    if (!(signedInAgo < 4 * 60e3)) {
      try {
        if (NATIVE) await reauthenticateWithCredential(auth.currentUser, await nativeCredential(linkedProviders()[0] || "google"));
        else await reauthenticateWithPopup(auth.currentUser, authProvider(linkedProviders()[0] || "google"));
      } catch (e) {
        if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request" || (NATIVE && nativeCancelled(e))) return showToast("Kontot är inte raderat.");
        return showToast("Logga ut och logga in igen, och radera sedan kontot direkt efteråt.", 7000);
      }
    }
    showToast("Raderar …", 20000);
    try {
      await deleteAccountData(others.length > 0, next);
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
    if (NATIVE) await nativePlugin("FirebaseAuthentication")?.signOut().catch(() => {});
    await signOut(auth);
  },
  "close-sheet"() { closeSheet(); },
  "new-entry"(el) {
    if (carLocked(car())) return render();
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
  "rec-price"(el) { recPriceSheet(el.dataset.id); },
  "edit-rec"(el) {
    const r = recChain(car(), el.dataset.id).at(-1);
    if (r) entryForm("parkering", { place: r.place, amount: r.amount, date: r.start, period: r.period, end: r.end, note: r.note }, { recurringId: r.id, back: "open-rec", backId: el.dataset.id });
  },
  async "end-rec"(el) {
    const c = car();
    const chain = recChain(c, el.dataset.id);
    if (!chain.length) return;
    const ok = await confirmDialog({ title: "Sluta betala från i dag?", lines: ["Inga fler betalningar räknas efter i dag. Det som redan har betalats finns kvar i loggen och Ekonomi."], okLabel: "Sluta betala", warn: "" });
    if (!ok) return;
    // Delar som inte har börjat än tas bort, den som gäller nu slutar i dag.
    const today = todayStr(), ids = new Set(chain.map((x) => x.id));
    const list = (c.recurring || []).filter((x) => !(ids.has(x.id) && x.start > today)).map((x) => (ids.has(x.id) && (!x.end || x.end > today) ? { ...x, end: today } : x));
    updateDoc(ref("cars", c.id), { recurring: list }).catch(onWriteError);
    c.recurring = list;
    closeSheet(); render(); showToast("Inga fler betalningar efter i dag");
  },
  async "delete-rec"(el) {
    const c = car();
    const chain = recChain(c, el.dataset.id);
    if (!chain.length) return;
    const ids = new Set(chain.map((x) => x.id));
    const paid = recurringEntries({ ...c, recurring: chain });
    if (paid.length) {
      const sum = paid.reduce((a, e) => a + (e.amount || 0), 0);
      const ended = chain.at(-1).end && chain.at(-1).end <= todayStr();
      const ok = await confirmDialog({ title: "Radera parkeringen helt?", lines: [`${paid.length === 1 ? "Betalningen" : `Alla ${paid.length} betalningar`}, ${fmtKr(sum)} kr, försvinner från loggen och Ekonomi.`, ended ? "" : "Har du sagt upp platsen, välj Sluta betala i stället."], okLabel: "Radera", warn: "" });
      if (!ok) return;
    }
    const list = (c.recurring || []).filter((x) => !ids.has(x.id));
    updateDoc(ref("cars", c.id), { recurring: list }).catch(onWriteError);
    c.recurring = list;
    closeSheet(); render();
    showToast("Parkeringen är raderad", 6000, () => {
      const again = [...(c.recurring || []).filter((x) => !ids.has(x.id)), ...chain];
      c.recurring = again;
      updateDoc(ref("cars", c.id), { recurring: again }).catch(onWriteError);
      render();
    });
  },
  "new-booking"() { bookingForm(); },
  "to-booking"() {
    // Ta med det som redan är ifyllt till formuläret för bokad tid.
    const box = $("#ef-future");
    const date = $("#ef-date")?.value || "";
    const place = ($("#ef-workshop") || $("#ef-place"))?.value || "";
    const note = $("#ef-note")?.value || "";
    bookingForm({ kind: box?.dataset.kind || "service", date, place: place || undefined, note: note || undefined });
  },
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
    const id = el.dataset.target, kind = el.dataset.kind;
    const input = document.getElementById(id);
    const box = document.getElementById(id + "-suggest");
    if (!input || el.disabled) return;
    const what = { fuel: "mackar", parking: "parkeringar", vehicle_inspection: "besiktningsstationer", car_repair: "verkstäder", tyres: "däckverkstäder" }[kind] || "biltvättar";
    el.disabled = true;
    el.classList.add("busy");
    // Visa direkt att något händer.
    if (box) { box.innerHTML = `<p class="hint">Söker närmaste ${what} …</p>`; box.hidden = false; }
    try {
      let pos;
      try {
        pos = await currentPosition();
      } catch (err) {
        if (box) box.hidden = true;
        const msg = err.code === 1 ? "Appen fick inte använda din plats. Tillåt plats för Bildagboken i telefonens inställningar och försök igen."
          : err.code === "unsupported" ? "Den här webbläsaren kan inte ange plats."
          : "Kunde inte hitta din position. Försök igen, gärna utomhus.";
        return showToast(msg, 7000);
      }
      const { latitude: lat, longitude: lon } = pos.coords;
      searchCenterCache = { lat, lon, at: Date.now(), gps: true };
      // Apple Maps först (snabbast och bäst på svenska företag), OpenStreetMap om Apple inte svarar.
      let list = await appleNearby(kind, lat, lon).catch(() => []);
      if (!list.length) list = (await nearbyPlaces(kind, lat, lon, 2000).catch(() => [])).map((n) => ({ name: n }));
      if (list.length) {
        if (box) {
          box.innerHTML = list.slice(0, 6).map((x) => `<button type="button" role="option" data-act="place-pick" data-kind="${esc(id)}" data-name="${esc(x.name)}" data-addr="${esc(x.addr || "")}" data-lat="${x.lat ?? ""}" data-lon="${x.lon ?? ""}" data-pid="${esc(x.pid || "")}"><b>${esc(x.name)}</b><span>${esc([x.d != null ? fmtDist(x.d) : "", x.addr || ""].filter(Boolean).join(" · "))}</span></button>`).join("");
          box.hidden = false;
        }
        return;
      }
      if (box) box.hidden = true;
      const addr = await reverseAddress(lat, lon).catch(() => "");
      if (!addr) return showToast(`Hittade inga ${what} i närheten. Skriv in stället själv.`, 5000);
      input.value = addr;
      showToast(`Hittade inga ${what} i närheten, så gatan är ifylld. Ändra om det behövs.`, 6000);
    } finally {
      el.disabled = false;
      el.classList.remove("busy");
    }
  },
  "place-pick"(el) {
    const set = (id, v) => { const x = document.getElementById(id); if (x) x.value = v; };
    const hideAll = () => Object.values(PLACE_FIELDS).forEach((x) => {
      const b = document.getElementById(x.box); if (b) b.hidden = true;
      document.getElementById(x.input)?.setAttribute("aria-expanded", "false");
    });
    if (el.dataset.kind === "tr-to" || el.dataset.kind === "tr-from") {
      const d = el.dataset, lat = num(d.lat), lon = num(d.lon);
      // Ligger det man valde vid en sparad plats får det platsens namn.
      const saved = S.places.find((p) => p.id === d.place) || (lat != null && lon != null ? placeAt({ lat, lon }) : null);
      const name = saved?.name || d.name || d.addr;
      set(d.kind, name);
      set(d.kind + "Loc", lat != null && lon != null ? JSON.stringify(clean({ name, addr: d.addr || null, lat, lon, pid: d.pid || null })) : "");
      hideAll();
      suggestTripKind();
      return;
    }
    if (el.dataset.kind === "pl-addr") {
      const d = el.dataset;
      set("pl-addr", d.addr || d.name);
      set("pl-lat", d.lat); set("pl-lon", d.lon);
      const n = $("#pl-name"); if (n && !n.value.trim() && d.name) n.value = d.name;
      hideAll();
      return;
    }
    // Var-fälten i en post: namnet i fältet, och platsen sparas med posten så att kartan blir rätt.
    if (el.dataset.kind.startsWith("ef-")) {
      const d = el.dataset;
      set(d.kind, d.name);
      const lat = num(d.lat), lon = num(d.lon);
      set("ef-loc", lat != null && lon != null ? JSON.stringify(clean({ name: d.name, addr: d.addr || null, lat, lon, pid: d.pid || null })) : "");
      suggestHandler(d.kind, "ef-handler");
      hideAll();
      return;
    }
    if (el.dataset.kind === "poi") set("bk-place", el.dataset.name);
    // Ett företag utan adress i kartan lämnar en adress man redan har skrivit orörd.
    if (el.dataset.addr || el.dataset.kind === "addr") set("bk-addr", el.dataset.addr);
    set("bk-lat", el.dataset.lat);
    set("bk-lon", el.dataset.lon);
    set("bk-pid", el.dataset.pid || "");
    set("bk-src", el.dataset.src || "");
    if (el.dataset.tel && !$("#bk-phone")?.value.trim()) set("bk-phone", el.dataset.tel);
    if (el.dataset.kind === "poi") suggestHandler("bk-place", "bk-handler");
    showBookingMap();
    Object.values(PLACE_FIELDS).forEach((x) => {
      const b = document.getElementById(x.box); if (b) b.hidden = true;
      document.getElementById(x.input)?.setAttribute("aria-expanded", "false");
    });
  },
  "work-toggle"(el) { saveMyInfo("workHours", { ...workHours(), on: el.checked }); render(); },
  "work-day"(el) {
    const d = Number(el.dataset.d), w = workHours();
    const days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d];
    if (!days.length) return showToast("Välj minst en dag.");
    saveMyInfo("workHours", { ...w, days }); render();
  },
  "bt-link"(el) {
    const c = S.cars.find((x) => x.id === el.dataset.car), name = el.dataset.name;
    if (!c || !name) return;
    for (const x of S.cars) if ((x.btNames || []).includes(name) && x.id !== c.id) { x.btNames = x.btNames.filter((n) => n !== name); updateDoc(ref("cars", x.id), { btNames: x.btNames }).catch(onWriteError); }
    c.btNames = [...new Set([...(c.btNames || []), name])];
    updateDoc(ref("cars", c.id), { btNames: c.btNames }).catch(onWriteError);
    render(); showToast(`${btLabel(name)} är kopplad till ${carName(c)}`);
  },
  "bt-unlink"(el) {
    const c = S.cars.find((x) => x.id === el.dataset.car);
    if (!c) return;
    c.btNames = (c.btNames || []).filter((n) => n !== el.dataset.name);
    updateDoc(ref("cars", c.id), { btNames: c.btNames }).catch(onWriteError);
    render();
  },
  "bt-only"(el) { saveMyInfo("autoOnlyCars", el.checked); render(); },
  "trip-merge"(el) { const t = S.trips.find((x) => x.id === el.dataset.id), nx = t && nextTripOf(t); if (nx) mergeTrips(t, nx); },
  "trip-split"(el) { const t = S.trips.find((x) => x.id === el.dataset.id); if (t) splitSheet(t); },
  "trip-year"() {
    const y = new Date().getFullYear();
    const years = [...new Set(carTrips().map((t) => Number((t.date || "").slice(0, 4))).filter(Boolean))].sort((a, b) => b - a);
    if (years.length <= 1) return exportTripYear(years[0] || y);
    openSheet("Årsrapport", `<p class="muted" style="margin-top:0">Välj år. Rapporten visar mätarställning, tjänste- och privatmil, milersättning per månad och alla resor.</p>
      <div class="form">${years.map((yr) => `<button class="btn ${yr === (new Date().getMonth() < 3 ? y - 1 : y) ? "primary" : "ghost"} block" type="button" data-act="trip-year-go" data-y="${yr}">${yr}</button>`).join("")}</div>`);
  },
  "trip-year-go"(el) { closeSheet(); exportTripYear(Number(el.dataset.y)); },
  "trip-map-open"(el) {
    const t = S.trips.find((x) => x.id === el.dataset.id), ends = t && tripEnds(t);
    if (!ends) return;
    const [a, b] = ends.map((l) => `${l.lat},${l.lon}`);
    mapChoiceDialog("Resan i kartan", [t.from, t.to].filter(Boolean).join(" → "),
      `https://maps.apple.com/directions?${new URLSearchParams({ source: a, destination: b, mode: "driving" })}`,
      `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(a)}&destination=${encodeURIComponent(b)}&travelmode=driving`);
  },
  "map-open"() {
    openMapChooser({ name: $("#bk-place")?.value.trim(), addr: $("#bk-addr")?.value.trim(), lat: num($("#bk-lat")?.value), lon: num($("#bk-lon")?.value), pid: $("#bk-pid")?.value || "" });
  },
  "map-choice-close"() {
    document.getElementById("map-choice")?.remove();
    document.getElementById("map-choice-scrim")?.remove();
  },
  "w-pos-show"(el) {
    const sel = el.closest(".work-row")?.querySelector(".w-pos");
    if (sel) { sel.hidden = false; sel.focus(); }
    el.remove();
  },
  "toggle-koll"() { S.kollAll = !S.kollAll; render(); nudgeFixed(); },
  "toggle-maint"() { S.maintAll = !S.maintAll; render(); },
  "hide-maint-hint"(el) { pref.set("maintHintHidden." + S.carId, el.dataset.n); render(); },
  "book-inspection"() { bookingForm({ kind: "besiktning" }); },
  "deadline-remove"(el) {
    const key = el.dataset.id;
    const fields = { besiktning: { besiktning: null }, forsakring: { forsakringDatum: null }, skatt: { skattManad: "av" }, efterkontroll: { efterkontroll: null } }[key];
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
        return entryForm("service", { date, workshop: b.place, note, loc, handler: b.handler || null, title: b.kind === "reparation" ? "Reparation" : null }, { bookingId: b.id });
      case "dack":
        return entryForm("dack", { date, place: b.place || null, note, loc }, { bookingId: b.id });
      case "besiktning":
        return entryForm("kostnad", { date, category: "Besiktning", title: b.place ? `Besiktning hos ${b.place}` : "Besiktning", note, loc, handler: b.handler || null }, { bookingId: b.id });
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
  "photo-rm"(el) {
    if (el.dataset.pid) { const k = $("#ef-keep"); if (k) k.value = k.value.split(",").filter((x) => x && x !== el.dataset.pid).join(","); }
    else pendingPhotos.splice(Number(el.dataset.i), 1);
    renderPhotoThumbs();
  },
  "photo-zoom"(el) { openLightbox(el.querySelector("img")?.src, el.querySelector("img")?.alt); },
  "lightbox-close"() { $("#lightbox")?.remove(); },
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
  "bk-time-toggle"(el) {
    const pop = $("#bk-time-pop");
    if (!pop) return;
    pop.hidden = !pop.hidden;
    el.setAttribute("aria-expanded", String(!pop.hidden));
    el.classList.toggle("open", !pop.hidden);
    if (!pop.hidden && !$("#bk-allday")?.checked) requestAnimationFrame(() => setWheel($("#bk-time")?.value || "09:00"));
  },
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
  "edit-doc"(el) { const d = (car()?.docs || []).find((x) => x.id === el.dataset.id); if (d) docForm(d); },
  "hide-photos"() { S.showPhotos = false; render(); },
  async "show-photos"() { S.showPhotos = true; S.photoPage = 0; render(); await loadPhotoGrid(); },
  async "photo-page"(el) {
    S.photoPage = Math.max(0, photoPageOf(car()) + Number(el.dataset.d));
    render();
    await loadPhotoGrid();
  },
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
  "share-menu"() { shareMenu(); },
  "tire-sheet"(el) { tireSheet(el.dataset.k); },
  "sale-pack"(el) { salePack(el); },
  async "copy-vin"() { const v = car()?.vin; if (!v) return; const ok = await copyText(v); showToast(ok ? "Chassinumret är kopierat" : v, ok ? 3000 : 8000); },
  async "copy-shortcut"(el) {
    const ok = await copyText(shortcutUrl(el.dataset.id));
    showToast(ok ? "Länken är kopierad" : shortcutUrl(el.dataset.id), ok ? 3500 : 9000);
  },
  "edit-entry"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (e) entryForm(e.type, e);
  },
  // En borttagen post läggs i papperskorgen i 30 dagar (med bilder), och kan återställas av alla i hushållet.
  "delete-entry"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (!e) return closeSheet();
    updateDoc(ref("entries", e.id), { deletedAt: serverTimestamp(), deletedBy: uid() }).catch(onWriteError);
    closeSheet();
    showToast(`${TYPE[e.type]?.label || "Posten"} ligger i papperskorgen`, 6000, () => restoreEntry(e.id));
  },
  "trash-entry"(el) { restoreEntry(el.dataset.id); },
  filter(el) { S.filter = el.dataset.f; render(); },
  "clear-search"() {
    S.query = "";
    render();
    $("#log-search")?.focus();
  },
  // Kontrollerat – ser bra ut: ett eget jobb i loggen, som ger delen en förlängning.
  async "item-checked"(el) {
    const c = car(), id = el.dataset.id;
    const item = (c?.items || []).find((i) => i.id === id);
    if (!item) return;
    el.disabled = true;
    const eid = doc(col("entries")).id;
    const data = clean({ type: "eget", carId: c.id, date: todayStr(), title: `${item.name} kontrollerat`, note: "Ser bra ut",
      checkMil: odoOf(c) ?? null,
      work: [{ key: `item:${id}`, itemId: id, name: item.name, action: "kontrollerat", sides: [] }], createdBy: uid(), createdAt: serverTimestamp() });
    try {
      await setDoc(ref("entries", eid), data);
      if (!S.entries.some((e) => e.id === eid)) S.entries = sortEntries([{ id: eid, ...data, createdAt: Date.now() }, ...S.entries]);
      itemSheet(id); render();
      showToast(`${item.name}: kontrollerat, ${checkExtension(item).months ? "ett år" : `${fmt(checkExtension(item).mil)} mil`} till`, 6000, () => {
        deleteDoc(ref("entries", eid)).catch(onWriteError);
        S.entries = S.entries.filter((e) => e.id !== eid);
        if (!sheet.hidden && $("#sheet .check-done")) itemSheet(id);
        render();
      });
    } catch (e) { onWriteError(e); el.disabled = false; }
  },
  // Ta bort ett senaste byte som fyllts i för hand, så att appen räknar från loggen.
  async "clear-item-base"(el) {
    const c = car(), id = el.dataset.id;
    const item = (c?.items || []).find((i) => i.id === id);
    if (!item) return;
    const before = c.items;
    const items = c.items.map((i) => (i.id === id ? clean({ ...i, baseDate: null, baseMil: null }) : i));
    try {
      await updateDoc(ref("cars", c.id), { items });
      c.items = items;
      // Ångra: lägg tillbaka datumet som fanns.
      showToast(`${item.name}: räknas nu från loggen`, 6000, () => {
        updateDoc(ref("cars", c.id), { items: before }).then(() => { c.items = before; const cur = S.cars.find((x) => x.id === c.id); if (cur) cur.items = before; render(); if (!sheet.hidden) itemSheet(id); }).catch(onWriteError);
      });
      itemSheet(id);
      render();
    } catch (e) { onWriteError(e); }
  },
  "edit-car"(el) {
    const sections = (el.dataset.section || "basic,photo,dates").split(",").filter((k) => CAR_SECTIONS[k]);
    carSheet(true, sections.length ? sections : ["basic"]);
  },
  plus(el) { if (el?.dataset?.f) plusUpsell(el.dataset.f); else plusSheet(); },
  "test-mode"(el) {
    pref.set("testMode", el.value);
    pref.set("plusTip." + S.hid, "");
    render();
    showToast(el.value === "free" ? "Testläge: gratisversionen" : el.value === "plus" ? "Testläge: Plus" : "Testläget är avstängt");
  },
  "new-trip"() { tripForm(); },
  // En knapp för resor: pågår en resa avslutas den, annars väljer man att starta nu eller logga i efterhand.
  "trip-menu"() {
    const o = openTrip();
    if (o) return tripForm(o, "end");
    openSheet("Resa", `<div class="choice">
      <button class="primary-c" type="button" data-act="trip-start-now"><span class="c-ic">${icon("gauge", 24)}</span><span><b>Starta resa nu</b><span>Tryck när du åker och avsluta när du kommer fram. Appen visar resan medan du kör.</span></span></button>
      <button type="button" data-act="new-trip"><span class="c-ic q">${icon("pen", 24)}</span><span><b>Logga en resa i efterhand</b><span>Om du glömde starta. Du fyller i allt på en gång.</span></span></button>
    </div>
    ${NATIVE && !ANDROID ? "" : `<p class="hint" style="margin-top:14px">Med automatisk körjournal i iPhone-appen behöver du inte trycka alls.</p>`}`);
  },
  "trip-start-now"() { tripForm({}, "start"); },
  "trips-on"() { setTripsVisible(true); closeSheet(); setView("resor"); showToast("Körjournalen är påslagen. Den finns under Resor i menyn."); },
  async "auto-toggle"(el) { const want = el.checked; await ACTIONS[want ? "auto-on" : "auto-off"](el); render(); },
  async "auto-allow"(el) {
    const t = tracker();
    try {
      const r = el.dataset.mode === "settings" ? (await t.openSettings(), { result: "settings" }) : await t.askAlways();
      if (r?.result === "settings") showToast("Välj Plats → Alltid, och kontrollera att Exakt plats är på. Gå sedan tillbaka till appen.", 8000);
      else setTimeout(() => refreshAutoStatus().then(render), 1500);
    } catch {
      // Äldre version av appen, utan knappen: beskriv vägen.
      showToast("Öppna telefonens Inställningar → Bildagboken → Plats och välj Alltid. Uppdatera appen för att få en knapp för det.", 9000);
    }
  },
  async "trips-off"() {
    const ok = await confirmDialog({ title: "Dölja fliken Resor?", lines: ["Resorna finns kvar. Du kan slå på körjournalen igen med plusknappen i menyn."], okLabel: "Dölj", warn: "" });
    if (!ok) return;
    setTripsVisible(false); setView("oversikt");
  },
  "trips-review"() { reviewSheet(); },
  async "trip-kind"(el) {
    const t = S.trips.find((x) => x.id === el.dataset.id);
    if (!t) return;
    t.kind = el.dataset.kind;
    updateDoc(doc(col("trips"), t.id), { kind: t.kind, reviewedAt: Date.now() }).catch(onWriteError);
    render();
    if (!sheet.hidden) reviewSheet();
  },
  async "auto-on"() {
    try { S.autoStatus = await tracker().enable(); } catch { return showToast("Den automatiska körjournalen finns i iPhone-appen från version 1.2."); }
    render();
    showToast("Automatisk körjournal är på. Välj Alltid när telefonen frågar om platsen.", 7000);
  },
  async "auto-off"() {
    const ok = await confirmDialog({ title: "Stänga av automatisk körjournal?", lines: ["Resor som redan är mätta finns kvar. Nya resor mäts inte förrän du slår på den igen."], okLabel: "Stäng av", warn: "" });
    if (!ok) return;
    try { S.autoStatus = await tracker().disable(); } catch { /* finns inte */ }
    render();
  },
  "trip-here"() { fillTripFrom(true); },
  chat() { chatSheet(); },
  "chat-ask"(el) { askCar(EN ? el.textContent : el.dataset.q); },
  "chat-mic"(el) { dictateField(el); },
  "chat-go"() {
    const i = $("#chat-in");
    if (i?.value.trim() || !canDictate()) return i?.form?.requestSubmit();
    voiceLoop();
  },
  "voice-orb"() {
    const st = chatState();
    const state = $("#voice")?.dataset.state;
    if (state === "listen") return dictStop?.();
    if (state === "talk") return stopSpeech();
    if (state === "idle" && !st.voice) voiceLoop();
  },
  "voice-end"() { endVoice(); },
  "glenn-save"(el) { glennTank(Number(el.dataset.i), true); },
  "glenn-route"(el) {
    const p = chatState().msgs[Number(el.dataset.i)]?.places?.[Number(el.dataset.k)];
    if (!p) return;
    if (isApple() || ANDROID) return void window.open(navUrl({ name: p.namn, addr: p.adress || "", lat: p.lat, lon: p.lon }), "_blank", "noopener");
    openMapChooser({ name: p.namn, addr: p.adress || "", lat: p.lat, lon: p.lon, directions: true });
  },
  "glenn-edit"(el) { glennTank(Number(el.dataset.i), false); },
  "chat-speak"(el) {
    const on = !speakOn();
    pref.set("chatSpeak", on ? "1" : "0");
    el.outerHTML = speakBtn();
    if (!on) return stopSpeech();
    unlockAudio();
    const last = [...chatState().msgs].reverse().find((m) => m.role === "assistant" && !m.err);
    if (last) sayText(last);
  },
  "chat-play"(el) {
    const m = chatState().msgs[Number(el.dataset.i)];
    if (!m) return;
    if (el.classList.contains("on")) return stopSpeech();
    unlockAudio();
    stopSpeech();
    el.classList.add("on");
    sayText(m).finally(() => el.classList.remove("on"));
    refreshGlenn();
  },
  "new-place"() { placeForm(); },
  "edit-place"(el) { const p = S.places.find((x) => x.id === el.dataset.id); if (p) placeForm(p); },
  async "place-here"(el) {
    el.disabled = true;
    try {
      const loc = await tripPosition();
      if (!loc) return showToast("Kunde inte hitta din position. Sök adressen i stället.", 5000);
      $("#pl-lat").value = loc.lat; $("#pl-lon").value = loc.lon;
      const addr = await reverseAddress(loc.lat, loc.lon).catch(() => "");
      const a = $("#pl-addr"); if (a) a.value = addr || "Min plats";
    } finally { el.disabled = false; }
  },
  async "delete-place"(el) {
    const p = S.places.find((x) => x.id === el.dataset.id);
    if (!p) return;
    const ok = await confirmDialog({ title: `Ta bort ${p.name}?`, lines: ["Resor som redan är sparade ändras inte."], okLabel: "Ta bort", warn: "" });
    if (!ok) return;
    deleteDoc(doc(col("places"), p.id)).catch(onWriteError);
    S.places = S.places.filter((x) => x.id !== p.id);
    sendPlacesToPhone();
    closeSheet(); render();
  },
  "gap-add"(el) {
    const a = S.trips.find((x) => x.id === el.dataset.a), b = S.trips.find((x) => x.id === el.dataset.b);
    if (!a || !b) return;
    tripForm({ date: a.date, odoStart: a.odoEnd, odoEnd: b.odoStart, from: a.to || "", fromLoc: a.toLoc || null, to: b.from || "", toLoc: b.fromLoc || null, gap: true });
  },
  "gap-ok"(el) {
    const b = S.trips.find((x) => x.id === el.dataset.b);
    if (!b) return;
    b.gapOk = true;
    updateDoc(doc(col("trips"), b.id), { gapOk: true }).catch(onWriteError);
    render();
    showToast("Luckan är markerad som okej");
  },
  "trip-nav"() {
    const t = openTrip();
    if (t) openMapChooser({ name: t.toLoc?.name || t.to, addr: t.toLoc?.addr, lat: t.toLoc?.lat, lon: t.toLoc?.lon, pid: t.toLoc?.pid, directions: true });
  },
  "start-trip"() { const o = openTrip(); tripForm(o || {}, o ? "end" : "start"); },
  "edit-trip"(el) { const t = S.trips.find((x) => x.id === el.dataset.id); if (t) tripForm(t, t.odoEnd == null ? "end" : "new"); },
  trips() { tripsSheet(); },
  "export-trips"() { exportTrips(); },
  async "delete-trip"(el) {
    const t = S.trips.find((x) => x.id === el.dataset.id);
    if (!t) return;
    const ok = await confirmDialog({ title: "Ta bort resan?", lines: [[fmtDate(t.date), t.purpose, t.to].filter(Boolean).join(", ")] });
    if (!ok) return;
    deleteDoc(doc(col("trips"), t.id)).catch(onWriteError);
    S.trips = S.trips.filter((x) => x.id !== t.id);
    closeSheet(); render(); showToast("Resan är borttagen");
  },
  "plus-tip"(el) {
    pref.set("plusTip." + S.hid, "1");
    render();
    if (el.dataset.id === "read") plusSheet();
  },
  "admin-plus"(el) {
    const h = S.adminData?.houses?.find((x) => x.id === el.dataset.id);
    if (!h || !isAdmin()) return;
    const paid = !!h.plus?.by;
    openSheet(`Plus för ${h.name || "hushållet"}`, `<p class="muted">${esc(tsMs(h.plus?.until) > Date.now() ? `Har Plus till ${fmtDate(ymd(new Date(tsMs(h.plus.until))))}.` : "Har inte Plus.")} Plus gäller alla i hushållet. Ger du mer läggs det till efter nuvarande slutdatum.</p>
      <div class="form" style="margin-top:12px">
        ${[[1, "Ge 1 månad"], [3, "Ge 3 månader"], [12, "Ge 1 år"]].map(([m, l]) => `<button class="btn block" type="button" data-act="admin-plus-set" data-id="${esc(h.id)}" data-m="${m}">${l}</button>`).join("")}
        ${tsMs(h.plus?.until) > Date.now() && !paid ? `<button class="btn block solid-danger" type="button" data-act="admin-plus-set" data-id="${esc(h.id)}" data-m="0">Ta bort Plus</button>` : ""}
        ${paid ? `<p class="hint">Hushållet betalar själv för Plus, så det går inte att ta bort här.</p>` : ""}
      </div>`);
  },
  // Spola tillbaka ett hushåll: välj en tid de senaste 7 dagarna, se vad som fanns då och återställ det.
  "admin-rewind"(el) {
    const h = S.adminData?.houses?.find((x) => x.id === el.dataset.id);
    if (!h || !isAdmin()) return;
    const local = (ms) => { const d = new Date(ms - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
    openSheet(`Spola tillbaka ${h.name || "hushållet"}`, `<p class="muted">Välj en tid de senaste 7 dagarna, till exempel strax innan något raderades. Du ser först vad som fanns då, och väljer sedan vad som ska tillbaka. Bara det här hushållet ändras.</p>
      <div class="form" style="margin-top:12px">
        <label class="field"><span>Tid</span><input type="datetime-local" id="rw-at" value="${local(Date.now() - 3600000)}" min="${local(Date.now() - 7 * 864e5 + 600000)}" max="${local(Date.now() - 180000)}"></label>
        <button class="btn primary block" type="button" data-act="admin-rewind-peek" data-id="${esc(h.id)}">Visa hur det såg ut</button>
        <div id="rw-out" aria-live="polite"></div>
      </div>`);
  },
  async "admin-rewind-peek"(el) {
    const out = $("#rw-out"), at = Date.parse($("#rw-at").value);
    if (!out || !at) return;
    el.disabled = true;
    out.innerHTML = `<p class="loading">Hämtar …</p>`;
    try {
      const r = await callFn("adminRewind", { hid: el.dataset.id, at, action: "peek" });
      if (!r.house) { out.innerHTML = `<p class="muted">Hushållet fanns inte vid den tiden.</p>`; return; }
      const nowTxt = { finns: "Finns nu", papperskorgen: "Ligger i papperskorgen nu", borta: "Borta nu" };
      out.innerHTML = `<p class="label" style="margin:14px 0 4px">${esc(`Bilar ${fmtDate(ymd(new Date(r.at)))} kl ${clock(r.at)}`)}</p>
        <div class="rows">${r.cars.map((c) => `<div class="dl"><span class="dl-ic">${icon("car", 20)}</span>
          <span><span class="dl-t">${esc(c.name)}</span><span class="dl-s">${esc(`${c.entries} poster${c.trashThen ? " · låg i papperskorgen då" : ""} · ${nowTxt[c.now]}`)}</span></span>
          <button class="btn-soft" type="button" data-act="admin-rewind-do" data-id="${esc(el.dataset.id)}" data-car="${esc(c.id)}" data-at="${r.at}" data-name="${esc(c.name)}">Återställ</button></div>`).join("") || `<p class="muted">Inga bilar.</p>`}</div>
        ${r.missingEntries ? `<button class="btn block" type="button" style="margin-top:12px" data-act="admin-rewind-do" data-id="${esc(el.dataset.id)}" data-at="${r.at}" data-n="${r.missingEntries}">${esc(`Återställ ${r.missingEntries} ${r.missingEntries === 1 ? "post" : "poster"} som har raderats sedan dess`)}</button>` : `<p class="hint" style="margin-top:10px">Inga poster har raderats sedan dess.</p>`}`;
    } catch (e) { out.innerHTML = `<p class="err">${esc(`Det gick inte: ${e.message || e}`)}</p>`; } finally { el.disabled = false; }
  },
  async "admin-rewind-do"(el) {
    const car = el.dataset.car, at = Number(el.dataset.at);
    const ok = await confirmDialog(car
      ? { title: `Återställ ${el.dataset.name}?`, lines: [`Bilen, dess logg, resor och bilder skrivs tillbaka som de var ${fmtDate(ymd(new Date(at)))} kl ${clock(at)}.`, "Det som har lagts till efter det finns kvar. Ändringar efter det skrivs över."], okLabel: "Återställ", warn: "" }
      : { title: "Återställ raderade poster?", lines: [`${el.dataset.n} ${el.dataset.n === "1" ? "post" : "poster"} som fanns ${fmtDate(ymd(new Date(at)))} kl ${clock(at)} läggs tillbaka.`], okLabel: "Återställ", warn: "" });
    if (!ok) return;
    el.disabled = true;
    try {
      const r = await callFn("adminRewind", { hid: el.dataset.id, at, action: car ? "car" : "entries", carId: car });
      showToast(car ? `${el.dataset.name} är återställd med ${r.entries} poster` : `${r.entries} poster är återställda`, 6000);
      closeSheet(); S.adminData = null; render();
    } catch (e) { el.disabled = false; showToast(`Det gick inte: ${e.message || e}`, 6000); }
  },
  // Glenns röst: lista rösterna, provlyssna och spara.
  async "admin-voice"() {
    if (!isAdmin()) return;
    openSheet("Glenns röst", `<div id="av-box"><p class="loading">Hämtar rösterna …</p></div>`);
    try {
      const r = await callFn("adminVoice", { action: "list" });
      S.voiceAdmin = { voices: r.voices, current: r.current, autoVoice: r.autoVoice, auto: r.auto, rate: r.rate || 1, savedRate: r.rate || 1 };
      renderVoiceAdmin();
    } catch (e) { $("#av-box").innerHTML = `<p class="err">${esc(`Det gick inte: ${e.message || e}`)}</p>`; }
  },
  // Lyssna: en röst i taget. Trycker man på en annan stannar den förra, och knappen blir Lyssna igen.
  // Trycker man på samma knapp medan den spelar stannar den.
  async "admin-voice-play"(el) {
    const v = S.voiceAdmin; if (!v) return;
    const name = el.dataset.v, playing = v.playing === name;
    stopSpeech();
    try { voiceAudio?.pause(); } catch { /* inget ljud */ }
    v.playing = null; v.loading = null;
    renderVoiceAdmin();
    if (playing) return;
    unlockAudio();
    v.loading = name; renderVoiceAdmin();
    const key = `${name}|${v.rate}`;
    try {
      v.samples = v.samples || {};
      const audio = v.samples[key] || (v.samples[key] = (await callFn("adminVoice", { action: "sample", voice: name, rate: v.rate })).audio);
      if (v.loading !== name) return; // man har hunnit trycka på en annan
      v.loading = null; v.playing = name; renderVoiceAdmin();
      const id = sayId;
      await playB64(audio, id);
      if (v.playing === name && id === sayId) { v.playing = null; renderVoiceAdmin(); }
    } catch (e) {
      if (v.loading === name) { v.loading = null; renderVoiceAdmin(); }
      showToast(`Det gick inte: ${e.message || e}`, 5000);
    }
  },
  async "admin-voice-set"(el) {
    const v = S.voiceAdmin; if (!v) return;
    try {
      await callFn("adminVoice", { action: "set", voice: el.dataset.v || "", rate: v.rate });
      v.current = el.dataset.v || v.current; v.auto = !el.dataset.v; v.savedRate = v.rate;
      showToast(el.dataset.v ? `Glenn pratar nu med ${voiceLabel(el.dataset.v)}` : "Glenn använder den bästa mansrösten automatiskt", 5000);
      renderVoiceAdmin();
    } catch (e) { showToast(`Det gick inte: ${e.message || e}`, 5000); }
  },
  "admin-voice-rate"(el) { if (S.voiceAdmin) { S.voiceAdmin.rate = Number(el.dataset.v); renderVoiceAdmin(); } },
  async "admin-plus-set"(el) {
    if (!isAdmin()) return;
    el.disabled = true;
    try {
      const r = await callFn("adminPlus", { hid: el.dataset.id, months: Number(el.dataset.m) });
      closeSheet();
      showToast(r.until ? `Plus till ${fmtDate(ymd(new Date(r.until)))}` : "Plus är borttaget");
      S.adminData = null;
      render();
    } catch (e) { el.disabled = false; showToast(`Det gick inte: ${e.message || e}`, 6000); }
  },
  "plus-buy"() { plusBuySheet(); },
  async "plus-pkg"(el) {
    const pk = rcPkgs[Number(el.dataset.i)];
    if (!pk) return;
    const btns = [...document.querySelectorAll("#sheet .plus-pkg, #sheet [data-act=plus-restore]")];
    btns.forEach((b) => (b.disabled = true));
    el.classList.add("busy");
    try {
      const P = await rcPlugin();
      const r = await P.purchasePackage({ aPackage: pk });
      if (rcHasPlus(r)) plusThanks();
      else { showToast("Köpet gick igenom, men Plus syns inte än. Tryck på Återställ tidigare köp om en stund.", 6000); plusBuySheet(); }
    } catch (e) {
      if (!rcCancelled(e)) { reportError(e, "plus-purchase"); showToast(`Köpet gick inte igenom${e?.message ? `: ${e.message}` : "."}`, 6000); }
      btns.forEach((b) => (b.disabled = false));
      el.classList.remove("busy");
    }
  },
  async "plus-restore"(el) {
    el.disabled = true;
    try {
      const P = await rcPlugin();
      const r = await P.restorePurchases();
      if (rcHasPlus(r)) plusThanks();
      else showToast("Hittade inget köp av Plus på det här Apple-kontot.", 5000);
    } catch (e) { reportError(e, "plus-restore"); showToast(`Det gick inte att återställa${e?.message ? `: ${e.message}` : "."}`, 6000); }
    el.disabled = false;
  },
  "add-car"() {
    if (caps() && S.cars.length >= caps().cars) return limitSheet("cars");
    carSheet(false);
  },
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
  // Logga byte: på verkstad (service) eller själv (eget jobb). Datumet kan vara bakåt i tiden.
  "log-item"(el) {
    const item = (car()?.items || []).find((i) => i.id === el.dataset.id);
    if (!item) return;
    openSheet(`Logga byte: ${item.name}`, `<p class="muted">Var byttes ${esc(item.name.toLowerCase())}? Har det redan gjorts tidigare väljer du bara datumet då.</p>
      <div class="rows" style="margin-top:10px">
        <button class="dl as-btn" type="button" data-act="log-item-as" data-id="${esc(item.id)}" data-type="service"><span class="dl-ic">${icon("wrench", 20)}</span><span><span class="dl-t">På verkstad</span><span class="dl-s">Med verkstad, kostnad och kvitto om du vill</span></span><span class="dl-v">›</span></button>
        <button class="dl as-btn" type="button" data-act="log-item-as" data-id="${esc(item.id)}" data-type="eget"><span class="dl-ic">${icon("hand", 20)}</span><span><span class="dl-t">Själv</span><span class="dl-s">Ett eget jobb</span></span><span class="dl-v">›</span></button>
      </div>`, { back: "edit-item", backId: item.id });
  },
  "log-item-as"(el) {
    const item = (car()?.items || []).find((i) => i.id === el.dataset.id);
    if (!item) return;
    entryForm(el.dataset.type, { items: [item.id], ...(el.dataset.type === "eget" ? { title: `${item.name} bytt` } : {}) }, { back: "edit-item", backId: item.id });
  },
  "w-add"(el) {
    const list = $("#work-rows");
    if (!list) return;
    const itemId = el.dataset.item || null;
    const key = itemId ? `item:${itemId}` : normWord(el.dataset.name);
    // Ett förslag med sida (Bromsbelägg fram) väljer den sidan. Finns raden redan läggs sidan till där.
    const sides = (el.dataset.sides || "").split("|").filter(Boolean);
    let row = list.querySelector(`.work-row[data-key="${CSS.escape(key)}"]`);
    if (!row) {
      list.insertAdjacentHTML("beforeend", workRowHtml({ key, itemId, name: el.dataset.name }, { action: "bytt", sides }));
      row = list.lastElementChild;
    } else if (sides.length) {
      const sel = row.querySelector(".w-pos");
      if (sel) {
        const all = [...new Set([...sel.value.split("|").filter(Boolean), ...sides])];
        sel.innerHTML = posOptions(itemId, all, posKind(itemId, el.dataset.name) || "corners");
        sel.hidden = false;
        row.querySelector(".w-posbtn")?.remove();
      }
    }
    row.scrollIntoView({ block: "nearest" });
    const s = $("#w-search"); if (s) s.value = "";
    const box = $("#w-suggest"); if (box) box.hidden = true;
    const sb = $("#w-searchbox"); if (sb) sb.hidden = true;
    const ob = $("#w-open"); if (ob) ob.hidden = false;
    refreshWorkUi();
  },
  "w-remove"(el) { el.closest(".work-row")?.remove(); refreshWorkUi(); },
  "w-open"() {
    const sb = $("#w-searchbox"), ob = $("#w-open");
    if (!sb) return;
    sb.hidden = false; if (ob) ob.hidden = true;
    $("#w-search")?.focus();
  },
  "maint-page"(el) { S.maintPage = Math.max(0, (S.maintPage || 0) + Number(el.dataset.d)); render(); },
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
  "pick-car"(el) { S.carId = el.dataset.id; S.lockSeen = S.carId; if (!carLocked(car())) pref.set("car", S.carId); render(); },
  "active-car-tip"() { pref.set("activeCarTip." + S.hid, 1); render(); },
  async "set-active-car"(el) {
    const c = S.cars.find((x) => x.id === el.dataset.id);
    if (!c || !isOwner() || activeCarNext()) return;
    const a = S.cars.find((x) => x.id === activeCarId());
    const ok = await confirmDialog({ title: `Använda ${carName(c)}?`, lines: [`${carName(c)} fungerar och ${carName(a)} blir låst. Inget raderas.`, `Du kan byta igen om ${ACTIVE_CAR_DAYS} dagar.`], okLabel: "Byt bil", warn: "" });
    if (!ok) return;
    try {
      await updateDoc(doc(db, "households", S.hid), { activeCar: c.id, activeCarAt: Date.now() });
      S.house = { ...S.house, activeCar: c.id, activeCarAt: Date.now() };
      pref.set("car", c.id);
      showToast(`${carName(c)} fungerar nu`);
      render();
    } catch (e) { onWriteError(e); }
  },
  "reg-lookup"() { regFormLookup(true); },
  "reg-refresh"() { const c = car(); if (c) regRefresh(c); },
  license(el) { pref.set("license", el.dataset.v); render(); },
  async "delete-car"(el) {
    const c = S.cars.find((x) => x.id === el.dataset.id) || car();
    if (!c) return;
    if (!isOwner()) return showToast("Bara hushållets ägare kan ta bort bilen.");
    const ok = await confirmDialog({
      title: `Ta bort ${carName(c)}?`,
      lines: [`Bilen och hela dess logg flyttas till papperskorgen och försvinner för alla i hushållet.`, `Du kan återställa den under Inställningar i ${TRASH_DAYS} dagar. Sedan raderas den för gott.`],
      okLabel: "Ta bort bilen",
      warn: "",
    });
    if (!ok) return;
    try {
      await updateDoc(ref("cars", c.id), { deletedAt: serverTimestamp(), deletedBy: uid() });
      if (!sheet.hidden) closeSheet();
      showToast(`${carName(c)} ligger i papperskorgen`, 6000, () => restoreCar(c.id));
    } catch (e) { onWriteError(e); }
  },
  async "trash-restore"(el) { await restoreCar(el.dataset.id); },
  async "trash-delete"(el) {
    const c = (S.trash || []).find((x) => x.id === el.dataset.id);
    if (!c || !isOwner()) return;
    const n = (S.allEntries || []).filter((e) => e.carId === c.id).length;
    const ok = await confirmDialog({ title: `Radera ${carName(c)} för gott?`, lines: [`Bilen${n ? ` och hela dess logg (${n} ${n === 1 ? "post" : "poster"})` : ""} raderas för alla i hushållet.`], okLabel: "Radera för gott" });
    if (!ok) return;
    el.disabled = true;
    try { await deleteCar(c.id); showToast(`${carName(c)} är raderad`); } catch (e) { onWriteError(e); el.disabled = false; }
  },
  "cards-view"(el) { S.cardsView = el.dataset.v; render(); },
  lang(el) {
    const v = el.dataset.v;
    if (v === LANG) return;
    pref.set("lang", v);
    location.reload();
  },
  "garage-glenn"(el) { garageEgg(el); },
  "theme-color"(el) { pref.set("themeColor", el.dataset.v); applyTheme(); render(); },
  "theme-mode"(el) { pref.set("themeMode", el.dataset.v); applyTheme(); render(); },
  async "copy-invite"() {
    if (membersFull()) return limitSheet("members");
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
  "enable-notif"() { return enablePush(); },
  "push-on"() { return enablePush(); },
  "push-off"() { return disablePush(); },
  async "new-invite-code"() {
    const ok = await confirmDialog({ title: "Byta inbjudningskod?", lines: [`Koden ${S.house?.inviteCode || ""} slutar fungera. Ni som redan är med påverkas inte.`], okLabel: "Byt kod", warn: "" });
    if (!ok) return;
    try { await rotateInviteCode(); showToast(`Ny kod: ${S.house.inviteCode}`); } catch (e) { onWriteError(e); }
  },
  async "remove-member"(el) {
    const m = el.dataset.id;
    if (!isOwner()) return showToast("Bara hushållets ägare kan ta bort andra.");
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
  async "leave-house"(el) {
    const rest = (S.house.members || []).filter((x) => x !== uid());
    // Ägaren väljer först vem som tar över.
    let next = el?.dataset?.next || "";
    if (isOwner() && rest.length && !rest.includes(next)) return pickNextOwner("leave-house", rest);
    if (!sheet.hidden) closeSheet();
    const ok = await confirmDialog({
      title: "Lämna hushållet?",
      lines: [`Du kommer inte längre åt ${S.house?.name || "hushållets"} bilar och logg. Det du har loggat finns kvar för de andra.`, next ? `${memberName(next)} blir hushållets ägare.` : null, "Vill du komma tillbaka behöver du en ny inbjudningskod."],
      okLabel: "Lämna",
    });
    if (!ok) return;
    try {
      const upd = { members: rest };
      if (next) upd.owner = next;
      await updateDoc(doc(db, "households", S.hid), upd);
      cleanup();
      renderOnboarding();
      showToast("Du har lämnat hushållet");
    } catch (e) { onWriteError(e); }
  },
  "export-log"() { exportLog(); },
  "export-all"() { exportAll(); },
  "rename-house"() {
    openSheet("Hushållets namn", `<form class="form" data-form="rename-one" data-what="house" novalidate>
      ${field("Hushållets namn", `<input name="v" id="rn-v" maxlength="40" required value="${esc(S.house?.name || "")}" autocomplete="off">`, "Syns för alla ni som delar och i inbjudan.")}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button></form>`);
  },
  "rename-me"() {
    openSheet("Ditt namn", `<form class="form" data-form="rename-one" data-what="me" novalidate>
      ${field("Ditt namn", `<input name="v" id="rn-v" maxlength="30" required value="${esc(myName())}" autocomplete="given-name">`, "Så ser de andra vem som har loggat.")}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button></form>`);
  },
  async "admin-clear-errors"() {
    const errs = S.adminData?.errors || [];
    await Promise.all(errs.map((e) => deleteDoc(doc(db, "errors", e.id)).catch(() => {})));
    S.adminData.errors = [];
    render();
    showToast("Felen är rensade");
  },
  "open-admin"() { S.prevView = "installningar"; S.adminData = null; setView("admin"); },
  "admin-reload"() { S.adminData = null; render(); },
  "hide-start"() { pref.set("startHidden." + S.hid, "1"); render(); showToast("Dolt. Du hittar allt under Bilen och Inställningar."); },
  "dismiss-install"() { pref.set("installDismissed", "1"); render(); },
};

const PROVIDER_NAMES = { google: "Google", apple: "Apple" };
const PROVIDER_IDS = { google: "google.com", apple: "apple.com" };

const nativeCancelled = (e) => /cancel|avbr|1001|-5\b/i.test(String(e?.message || e?.code || e));
async function nativeCredential(name) {
  const fa = nativePlugin("FirebaseAuthentication");
  if (name === "apple") {
    const r = await fa.signInWithApple({ scopes: ["email", "name"], skipNativeAuth: true });
    return new OAuthProvider("apple.com").credential({ idToken: r.credential.idToken, rawNonce: r.credential.nonce });
  }
  const r = await fa.signInWithGoogle({ skipNativeAuth: true });
  return GoogleAuthProvider.credential(r.credential.idToken, r.credential.accessToken);
}

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

// Felrapporter: fel i appen skickas kort till ägarens översikt, så att de går att rätta.
// Högst åtta per gång appen är öppen, aldrig samma fel två gånger, och inga vanliga nätverksfel.
const reportedErrors = new Set();
function reportError(err, where = "") {
  try {
    if (!S.user || !navigator.onLine) return;
    const msg = String(err?.message || err?.code || err || "").trim().slice(0, 500);
    if (!msg || reportedErrors.has(msg) || reportedErrors.size >= 8) return;
    if (/ResizeObserver|^Script error|Load failed|NetworkError|Failed to fetch|network|unavailable|offline|AbortError|aborted/i.test(msg)) return;
    reportedErrors.add(msg);
    const data = { uid: uid(), hid: S.hid || null, msg, where: String(where || "").slice(0, 100) || null, stack: String(err?.stack || "").slice(0, 1500) || null, ver: VERSION, ua: navigator.userAgent.slice(0, 200), native: NATIVE ? (ANDROID ? "android" : "ios") : null, lang: LANG, at: serverTimestamp() };
    for (const k of Object.keys(data)) if (data[k] == null) delete data[k];
    setDoc(doc(collection(db, "errors")), data).catch(() => {});
  } catch { /* en felrapport får aldrig själv ge fel */ }
}
window.addEventListener("error", (ev) => reportError(ev.error || ev.message, ev.filename ? `${ev.filename.split("/").pop()}:${ev.lineno}` : ""));
window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason, "promise"));

function onWriteError(e) {
  console.error(e);
  if (e?.code !== "unavailable") reportError(e, "spara");
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
    if (kind === "rec-price") return saveRecPrice(form);
    if (kind === "trip") return saveTrip(form);
    if (kind === "trip-split") return saveSplit(form);
    if (kind === "place") return savePlace(form);
    if (kind === "chat") { const i = $("#chat-in"); const q = i?.value || ""; if (i) i.value = ""; chatInputChanged(); return askCar(q); }
    if (kind === "doc") return await saveDoc(form);
    if (kind === "rename-one") {
      const v = String(new FormData(form).get("v") || "").trim();
      if (!v) return formError("Skriv ett namn.");
      if (form.dataset.what === "house") {
        updateDoc(doc(db, "households", S.hid), { name: v }).catch(onWriteError);
        S.house = { ...S.house, name: v };
        syncInviteName(v);
      } else {
        updateDoc(doc(db, "households", S.hid), { [`memberInfo.${uid()}.name`]: v }).catch(onWriteError);
      }
      closeSheet();
      render();
      showToast("Namnet är sparat");
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
    owner: uid(),
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
// Ägaren som lämnar (eller raderar sitt konto) väljer vem som blir ny ägare.
function pickNextOwner(act, rest) {
  openSheet("Vem tar över?", `<p>Du är hushållets ägare. Välj vem som blir ägare när du lämnar. Ägaren är den enda som kan ta bort bilar och andra personer.</p>
    <div class="rows">${rest.map((m) => `<button class="dl as-btn" type="button" data-act="${act}" data-next="${esc(m)}"><span class="dl-ic">${icon("home", 20)}</span>
      <span><span class="dl-t">${esc(memberName(m))}</span><span class="dl-s">${esc(S.house.memberInfo?.[m]?.email || "")}</span></span><span class="dl-v">›</span></button>`).join("")}</div>`);
}
async function deleteAccountData(hasOthers, next = "") {
  const hid = S.hid;
  if (!hid) return;
  const myTokens = await getDocs(query(collection(db, "households", hid, "tokens"), where("uid", "==", uid()))).catch(() => null);
  for (const t of myTokens?.docs || []) await deleteDoc(t.ref).catch(() => {});
  pref.set("pushToken", "");
  if (hasOthers) {
    await updateDoc(doc(db, "households", hid), {
      members: (S.house.members || []).filter((x) => x !== uid()),
      [`memberInfo.${uid()}`]: deleteField(),
      ...(next ? { owner: next } : {}),
    });
    return;
  }
  for (const c of S.cars) if (c.shareToken) await deleteDoc(doc(db, "shares", c.shareToken)).catch(() => {});
  if (S.house?.inviteCode) await deleteDoc(doc(db, "invites", S.house.inviteCode)).catch(() => {});
  cleanup();
  for (const sub of ["entries", "trips", "photos", "cars", "tokens"]) {
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
  if (FREE.from) {
    // Fullt hushåll: gå ur igen direkt. Kontrolleras efter att man gått med, eftersom hushållet inte kan läsas innan dess.
    const h = (await getDoc(doc(db, "households", hid)).catch(() => null))?.data();
    const c = h && caps(h);
    if (c && (h.members || []).length > c.members) {
      await updateDoc(doc(db, "households", hid), { members: h.members.filter((x) => x !== uid()), [`memberInfo.${uid()}`]: deleteField(), joinedWith: deleteField() }).catch(() => {});
      btn.disabled = false;
      return renderOnboarding(c === PLUS
        ? `${houseName || "Hushållet"} har redan ${PLUS.members} personer, som är det mesta som går.`
        : `${houseName || "Hushållet"} har redan ${FREE.members} personer, så det är fullt i gratisversionen. Med Bildagboken Plus kan ni vara upp till ${PLUS.members}.`);
    }
  }
  history.replaceState(null, "", location.pathname + "#oversikt");
  S.justJoined = houseName || true;
  subscribe(hid);
}

async function saveNewCar(form) {
  if (caps() && S.cars.length >= caps().cars) return limitSheet("cars");
  const data = readCarForm(form);
  if (!data.make || !data.model) return formError("Fyll i märke och modell.") ?? showToast("Fyll i märke och modell.");
  const startOdo = data.odometer;
  delete data.odometer;
  // Uppgifterna från registret: sparas på bilen, och det formuläret inte har (besiktning, vikter, växellåda) tas därifrån.
  const reg = regFromForm(form);
  if (reg) {
    const d = regToCar(reg.f);
    for (const k of ["besiktning", "gearbox", "towMax", "totalWeight", "trainWeight", "skattBelopp", "bodyStyle", "seats", "firstReg", "co2"]) if (d[k] != null && data[k] == null) data[k] = d[k];
    data.reg = reg;
  }
  if (startOdo != null && (startOdo < 0 || startOdo > 200000)) return formError("Mätarställningen ser fel ut. Ange den i mil, till exempel 21 480.") ?? showToast("Mätarställningen ser fel ut. Ange den i mil.");
  const cRef = doc(col("cars"));
  if (startOdo != null) {
    // Mätarställningen vid start blir bilens första loggpost.
    setDoc(doc(col("entries")), { type: "matare", carId: cRef.id, date: todayStr(), odometer: startOdo, note: null, createdBy: uid(), createdAt: serverTimestamp() }).catch(onWriteError);
  }
  const full = {
    ...clean(data),
    items: defaultItems(data),
    itemsV: 3,
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
  const reg = regFromForm(form);
  if (reg) {
    const d = regToCar(reg.f);
    payload.reg = reg;
    for (const k of ["gearbox", "towMax", "totalWeight", "trainWeight", "skattBelopp"]) if (d[k] != null && payload[k] == null && (c[k] == null || c[k] === "")) payload[k] = d[k];
    if (d.besiktning && !c.besiktning) payload.besiktning = d.besiktning;
  }
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
    });
  }).filter((i) => i.name);
  // Ett gammalt datum ifyllt för hand (före loggen) följer med tills det har flyttats in i loggen.
  const old = Object.fromEntries((car()?.items || []).map((i) => [i.id, i]));
  for (const i of items) if (old[i.id]?.baseDate) Object.assign(i, clean({ baseDate: old[i.id].baseDate, baseMil: old[i.id].baseMil ?? null }));
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
  if (ev.target.id === "chat-in") chatInputChanged();
  if (ev.target.id === "ef-date" && $("#ef-future")) $("#ef-future").hidden = !(ev.target.value > todayStr());
  if (ev.isTrusted && ev.target.classList?.contains("from-receipt")) ev.target.classList.remove("from-receipt");
  if (ev.target.classList?.contains("invalid") && String(ev.target.value || "").trim()) ev.target.classList.remove("invalid");
  if (ev.target.id === "tr-odoEnd" || ev.target.id === "tr-odoStart") {
    const a = $("#tr-odoStart") ? num($("#tr-odoStart").value) : num(ev.target.form?.dataset.start);
    const b = num($("#tr-odoEnd")?.value);
    const out = $("#tr-dist");
    if (out) out.textContent = a != null && b != null && b >= a ? `${fmt(Math.round((b - a) * 10) / 10, 1)} mil (${fmt(Math.round((b - a) * 10))} km)` : "Mil med en decimal. 1,2 mil är 12 km.";
  }
  if (ev.target.id === "ef-amount" && $("#ef-rec-split")) {
    const box = $("#ef-rec-split");
    box.hidden = num(ev.target.value) === Number(box.dataset.orig);
  }
  if (ev.target.id === "ef-recurring") {
    const b = $("#ef-rec-box"); if (b) b.hidden = !ev.target.checked;
    $("#ef-amount")?.toggleAttribute("required", ev.target.checked);
    markRequired($("#sheet"));
    const lab = $("#ef-date")?.closest("label")?.querySelector("span");
    if (lab) lab.textContent = ev.target.checked ? "Första betalningen" : "Datum";
  }
  if (ev.target.id === "w-search") workSuggest(ev.target.value);
  if (ev.target.id === "bk-place") placeSearchSoon("poi");
  if (ev.isTrusted && ["ef-station", "ef-place", "ef-workshop", "tr-to", "tr-from", "pl-addr"].includes(ev.target.id)) placeSearchSoon(ev.target.id);
  if (ev.target.id === "pl-addr") { const a = $("#pl-lat"), b = $("#pl-lon"); if (a) a.value = ""; if (b) b.value = ""; }
  if (ev.target.id === "tr-kind" && ev.isTrusted) ev.target.dataset.touched = "1";
  if (ev.target.id === "tr-from") { const h = $("#tr-fromLoc"); if (h) h.value = ""; ev.target.dataset.touched = "1"; }
  if (ev.target.id === "tr-to") { const h = $("#tr-toLoc"); if (h) h.value = ""; if (!ev.target.value.trim()) recentTripTargets(); }
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
  if (ev.target.id === "ef-date" && $("#ef-future")) $("#ef-future").hidden = !(ev.target.value > todayStr());
  if (ev.target.id === "bk-time-other") setBookingTime(ev.target.value);
  if (ev.target.id === "bk-allday") {
    const wheel = $("#bk-wheel"), hid = $("#bk-time");
    if (wheel) wheel.hidden = ev.target.checked;
    if (hid) hid.value = ev.target.checked ? "" : "09:00";
    const btn = $("#bk-time-btn"); if (btn) btn.textContent = ev.target.checked ? "Heldag" : "09:00";
    if (!ev.target.checked) requestAnimationFrame(() => setWheel("09:00"));
  }
  if (ev.target.dataset?.pushKind) { setPushPref(ev.target.dataset.pushKind, ev.target.checked); return; }
  if (ev.target.id === "ef-tireAction") {
    const box = $("#ef-tirekind-box"); if (box) box.hidden = isSwap(ev.target.value);
    const nb = $("#ef-newtire-box"); if (nb) nb.hidden = ev.target.value !== "nya";
    const swap = isSwap(ev.target.value);
    const ob = $("#ef-depthoff-box"); if (ob) ob.hidden = !swap;
    const dh = $("#ef-depth-hint"); if (dh) dh.hidden = !swap;
    const dl = $("#ef-depth")?.closest("label, .field")?.querySelector("span, .label"); if (dl) dl.textContent = swap ? "Mönsterdjup, däcken som sätts på (mm)" : "Mönsterdjup (mm)";
  }
  if (ev.target.name === "result" && $("#ef-defects-box")) {
    const r = ev.target.value;
    $("#ef-defects-box").hidden = r === "godkand";
    $("#ef-recheck-box").hidden = !inspFailed(r);
    // Nästa besiktning sätts först när bilen är godkänd.
    const nb = $("#ef-next-besikt"); if (nb && !$("#ef-old-besikt:not([hidden])")) nb.hidden = inspFailed(r);
  }
  if (ev.target.id === "ef-tireKind" || ev.target.id === "ef-studded") {
    const winter = $("#ef-tireKind")?.value === "vinter";
    const sb = $("#ef-studded-box"); if (sb) sb.hidden = !winter;
    const ab = $("#ef-alpine-box"); if (ab) ab.hidden = !winter || !!$("#ef-studded")?.checked;
  }
  if (ev.target.id === "ef-scan") { scanReceipt(ev.target.files?.[0]); ev.target.value = ""; }
  if (ev.target.id === "bk-addr") geocodeBookingAddress();
  if ((ev.target.id === "ef-date" || ev.target.id === "ef-category") && $("#ef-nextBesiktning")) updateNextInspection();
  if (ev.target.id === "hero-photo") {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (f) changeHeroPhoto(f);
    return;
  }
  if (ev.target.id === "ef-photo" && !$("#ef-photos")) {
    // Dokument: en bild.
    const f = ev.target.files?.[0];
    const lab = $("#photo-label");
    if (lab) lab.textContent = f ? `Vald bild: ${f.name}` : "Fota eller välj en bild";
  } else if (ev.target.id === "ef-photo") {
    const files = [...(ev.target.files || [])].filter((f) => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    const perPost = MAX_PHOTOS - pendingPhotos.length - ($("#ef-keep")?.value.split(",").filter(Boolean).length || 0);
    const cp = caps();
    const total = cp ? cp.photos - photoCount() - pendingPhotos.length : Infinity;
    const room = Math.min(perPost, total);
    if (files.length > room) {
      if (total < perPost) { if (total <= 0) { ev.target.value = ""; return showToast(cp === PLUS ? `Bildagboken Plus har plats för ${fmt(PLUS.photos)} bilder. Ta bort några för att lägga till nya.` : `Gratisversionen har plats för ${FREE.photos} bilder. Ta bort några eller skaffa Bildagboken Plus för att lägga till fler.`, 7000); } showToast(`Det finns plats för ${total === 1 ? "1 bild" : `${total} bilder`} till i gratisversionen.`); }
      else showToast(`Högst ${MAX_PHOTOS} bilder per post.`);
    }
    pendingPhotos.push(...files.slice(0, Math.max(0, room)));
    ev.target.value = "";
    renderPhotoThumbs();
  }
  if (ev.target.id === "cf-carPhoto") {
    const f = ev.target.files?.[0];
    const lab = $("#photo-label");
    if (lab) lab.textContent = f ? `Vald bild: ${f.name}` : "Ta eller välj ett eget foto på bilen";
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
  S.hid = null; S.house = null; S.cars = []; S.entries = []; S.trips = []; S.places = []; S.carId = null; S.trash = []; S.allEntries = []; S.allTrips = [];
  S.loaded = { house: false, cars: false, entries: false };
  closeSheet();
}

function onListenError(e) {
  console.error(e);
  if (e?.code !== "permission-denied" && e?.code !== "unavailable") reportError(e, "hämta");
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
  S.trips = [];
  // Körjournalen (Plus). Tom för de flesta hushåll, och påverkar inte när appen räknas som laddad.
  S.unsubs.push(onSnapshot(collection(db, "households", hid, "trips"), (s) => {
    S.allTrips = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    syncTrash();
    if (S.loaded.entries) render();
  }, () => {}));
  // Sparade platser för körjournalen, som Hem och Kontoret.
  S.places = [];
  S.unsubs.push(onSnapshot(collection(db, "households", hid, "places"), (s) => {
    S.places = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name), "sv"));
    sendPlacesToPhone();
    if (S.loaded.entries) render();
  }, () => {}));
  S.loaded = { house: false, cars: false, entries: false };
  render();

  S.unsubs.push(onSnapshot(doc(db, "households", hid), (s) => {
    S.house = s.data({ serverTimestamps: "estimate" });
    S.loaded.house = true;
    applyTheme(); // Glenns Garage kräver Plus
    if (S.justJoined) {
      showToast(typeof S.justJoined === "string" ? `Välkommen till ${S.justJoined}!` : "Välkommen! Nu delar ni bilen.", 4500);
      S.justJoined = null;
    }
    // Äldre inbjudningar saknar hushållets namn. Det läggs till en gång, så att nästa inbjudna ser det.
    const stamp = `${S.house?.inviteCode}|${S.house?.name}`;
    if (S.house?.inviteCode && pref.get("inviteName") !== stamp) { syncInviteName(); pref.set("inviteName", stamp); }
    refreshPush();
    // När man senast öppnade appen, högst en gång per dag (syns i ägarens översikt).
    if (pref.get("activeDay") !== todayStr() && (S.house?.members || []).includes(uid())) {
      pref.set("activeDay", todayStr());
      updateDoc(doc(db, "households", hid), { [`memberInfo.${uid()}.lastActive`]: serverTimestamp() }).catch(() => {});
    }
    render();
  }, onListenError));

  S.unsubs.push(onSnapshot(collection(db, "households", hid, "cars"), { includeMetadataChanges: true }, (s) => {
    S.pending.cars = s.docs.filter((d) => d.metadata?.hasPendingWrites).length;
    updateNetBanner();
    const all = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
      .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
    // Bilar i papperskorgen syns bara där, tills de återställs eller raderas för gott.
    S.cars = all.filter((c) => !c.deletedAt);
    S.trash = all.filter((c) => c.deletedAt);
    syncTrash();
    if (!S.cars.find((c) => c.id === S.carId)) {
      const saved = pref.get("car");
      S.carId = S.cars.find((c) => c.id === saved)?.id || S.cars[0]?.id || null;
    }
    addNewItems(S.cars);
    S.cars.forEach(migrateBaseDates);
    checkFuelChanges(S.cars, !S.loaded.cars);
    checkNewBookings(S.cars, !S.loaded.cars);
    S.loaded.cars = true;
    render();
  }, onListenError));

  let first = true;
  S.unsubs.push(onSnapshot(query(collection(db, "households", hid, "entries"), orderBy("date", "desc")), { includeMetadataChanges: true }, (s) => {
    S.pending.entries = s.docs.filter((d) => d.metadata?.hasPendingWrites).length;
    updateNetBanner();
    S.allEntries = sortEntries(s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })));
    syncTrash();
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
document.addEventListener("focusin", (ev) => { if ((ev.target.id === "tr-to" || ev.target.id === "tr-from") && !ev.target.value.trim()) recentTripTargets(ev.target.id); });
// Fråga om bilen: Enter skickar frågan, Skift+Enter ger en ny rad.
document.addEventListener("keydown", (ev) => {
  if (ev.target.id === "chat-in" && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); if (ev.target.value.trim()) ev.target.form?.requestSubmit(); }
});
// Diktering och uppläsning använder ljudet samtidigt: tysta uppläsningen när man ska skriva eller prata in.
document.addEventListener("focusin", (ev) => { if (ev.target.id === "chat-in") stopSpeech(); });
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

applyTheme();
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
    // En ny version har tagit över: ladda om en gång. Är en ruta öppen väntar omladdningen tills den stängs.
    if (!hadController || reloaded) return;
    if (!sheet.hidden) { reloadWhenClosed = true; return; }
    reloaded = true;
    location.reload();
  });
}
