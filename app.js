// Bildagboken — delad bilapp för ett hushåll. Data synkas via Firebase (Firestore + Google-inloggning).
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp, arrayUnion, writeBatch
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const VERSION = "2.4";

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
};

/* ---------------------------------------------------------------- helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = [0, 1, 2].map((d) => new Intl.NumberFormat("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : nf[d].format(n));
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
  matare: { label: "Mätare", icon: "gauge" },
  service: { label: "Service", icon: "wrench" },
  eget: { label: "Eget jobb", icon: "hand" },
  dack: { label: "Däck", icon: "tire" },
  tvatt: { label: "Tvätt", icon: "wash" },
  parkering: { label: "Parkering", icon: "parking" },
  kostnad: { label: "Kostnad", icon: "receipt" },
};
const FUELS = ["Bensin", "Diesel", "Flexifuel (bensin/E85)", "Laddhybrid", "Hybrid", "El"];
const COST_CATS = ["Försäkring", "Skatt", "Besiktning", "Parkering", "Tvätt", "Tillbehör", "Övrigt"];
const TIRE_ACTIONS = {
  till_vinter: "Bytte till vinterdäck",
  till_sommar: "Bytte till sommardäck",
  monster: "Mätte mönsterdjup",
  nya: "Köpte nya däck",
  forvaring: "Däckförvaring",
  ovrigt: "Övrigt",
};
const BOOK_KINDS = { service: "Service", reparation: "Reparation", besiktning: "Besiktning", dack: "Däckbyte", annat: "Annat" };
const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
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
const GENERIC_TIPS = [
  { sev: "mid", when: (m) => m >= 10 || m <= 1, title: "Batteriet inför vintern", text: "Kyla tar hårt på batteriet. Är det äldre än fem år, låt testa det innan det blir riktigt kallt." },
  { sev: "low", title: "Lufttryck", text: "Kolla lufttrycket en gång i månaden och före långresor. Rätt tryck sparar bränsle och däck." },
  { sev: "low", title: "Oljenivån", text: "Dra oljestickan med jämna mellanrum, till exempel varannan tankning. Äldre motorer kan dra lite olja." },
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
const carEntries = () => S.entries.filter((e) => e.carId === S.carId);
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
    case "parkering": return e.fine ? "P-bot" : "Parkering";
    case "kostnad": return e.title || e.category || "Kostnad";
    default: return "Logg";
  }
}

function itemNames(e, c) {
  const items = c?.items || [];
  return (e.items || []).map((id) => items.find((i) => i.id === id)?.name).filter(Boolean);
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
    case "matare": return `${fmt(e.odometer)} mil`;
    case "service":
    case "eget": return [...itemNames(e, c), ...(e.parts || [])].join(", ") || e.note || "";
    case "dack": {
      const bits = [];
      if (e.depth != null) bits.push(`${fmt(e.depth, 1)} mm`);
      if (e.note) bits.push(e.note);
      return bits.join(" · ");
    }
    case "tvatt":
    case "parkering": return [e.place, e.note].filter(Boolean).join(" · ");
    case "kostnad": return e.title && e.category ? e.category : e.note || "";
    default: return "";
  }
}

function activityText(e) {
  const n = whoName(e.createdBy);
  const unit = /kWh/.test(e.fuel || "") ? "kWh" : "l";
  const kr = e.amount != null ? ` för ${fmt(e.amount)} kr` : "";
  switch (e.type) {
    case "tank": return `${n} tankade${e.liters != null ? ` ${fmt(e.liters, 1)} ${unit} ${e.fuel || ""}`.trimEnd() : e.fuel ? ` ${e.fuel}` : ""}${kr}`;
    case "matare": return `${n} uppdaterade mätarställningen till ${fmt(e.odometer)} mil`;
    case "service": return `${n} loggade service${e.workshop ? ` hos ${e.workshop}` : ""}${kr}`;
    case "eget": return `${n}: ${e.title || "eget jobb"}${kr}`;
    case "dack": return `${n}: ${(TIRE_ACTIONS[e.tireAction] || "däck").toLowerCase()}`;
    case "tvatt": return `${n} tvättade bilen${e.place ? ` hos ${e.place}` : ""}${kr}`;
    case "parkering": return e.fine ? `${n} fick en p-bot${e.place ? ` vid ${e.place}` : ""}${kr}` : `${n} parkerade${e.place ? ` vid ${e.place}` : ""}${kr}`;
    case "kostnad": return `${n} lade till ${(e.title || e.category || "en kostnad").toLowerCase()}${kr}`;
    default: return `${n} loggade något`;
  }
}

function itemStatus(item, c, ents) {
  let last = null;
  for (const e of ents) {
    if (!(e.items || []).includes(item.id)) continue;
    if (!last || (e.date || "") > (last.date || "")) last = e;
  }
  let lastDate = last?.date ?? null;
  let lastMil = last?.odometer ?? null;
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

// Ungefärligt datum när servicen behövs: det som kommer först av tiden och milen (med hur mycket ni brukar köra).
function serviceDueEstimate(st, c) {
  if (!st || st.unknown) return null;
  const out = [];
  if (st.dueDate) out.push({ date: st.dueDate, by: "time" });
  const rate = st.remMil != null ? milPerDay(c) : null;
  if (rate) {
    const d = today0();
    d.setDate(d.getDate() + Math.max(0, Math.round(st.remMil / rate)));
    out.push({ date: d, by: "mil" });
  }
  out.sort((a, b) => a.date - b.date);
  return out[0] || null;
}

// Förslag på nästa sista dag för besiktning, räknat från dagen bilen besiktigades.
// Personbil: första gången senast 3 år efter att den togs i trafik, sedan 2 år, därefter var 14:e månad.
// Årsmodellen används som ungefärligt år i trafik. Datumet går alltid att ändra.
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
function lastWash(c) {
  return S.entries.filter((e) => e.carId === c.id && (e.type === "tvatt" || (e.type === "kostnad" && e.category === "Tvätt")))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0] || null;
}

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
    return { icon: "tire", title: "Sommardäck sitter på", sub: "Nästa byte i oktober–november", days: daysUntil(new Date(y, 9, 15)), level: "ok" };
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
  return { icon: "tire", title: "Vinterdäck sitter på", sub: studded ? "Dubbdäck · av senast 15 april" : "Byt till sommardäck i april", days: null, label: "Klart", level: "ok" };
}

function deadlines(c) {
  const out = [tireDeadline(c)];
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
function bookingWhen(b) {
  const d = parseDate(b.date);
  if (!d) return "";
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
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
    const lastDay = b.kind === "besiktning" && c.besiktning && !past ? (late ? `efter sista dagen ${fmtDateShort(c.besiktning)}!` : `sista dag ${fmtDateShort(c.besiktning)}`) : null;
    return {
      icon: "calendar",
      title: past ? `${kind}: blev det gjort?` : `${kind} bokad`,
      sub: [bookingWhen(b), b.place, lastDay].filter(Boolean).join(" · "),
      days,
      level: past || late || days <= 1 ? "urgent" : days <= 7 ? "soon" : "ok",
      label: past ? "Logga" : days === 0 ? "I dag" : days === 1 ? "I morgon" : daysText(days),
      act: "open-booking",
      id: b.id,
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
const CAT_ICON = { "Bränsle": "fuel", "Service och reparationer": "wrench", "Däck": "tire", "Skatt och besiktning": "check", "Försäkring": "calendar", "Tvätt": "wash", "Parkering": "parking", "P-böter": "parking", "Övrigt": "receipt" };

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
  return list.filter((t) => (!t.when || t.when(m)) && (!t.flex || isFlex(c))).slice(0, 5);
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
  if (S.screen === key) app.querySelectorAll(".filters, .car-chips").forEach((el) => { keepScroll[el.className] = el.scrollLeft; });
  // Behåll fokus och markören i ett fält (till exempel sökfältet) om sidan ritas om medan man skriver.
  const active = app.contains(document.activeElement) && document.activeElement.id ? document.activeElement : null;
  const caret = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  S.screen = key;
  // Vilken vy som visas, så att datorlayouten kan ordna korten olika per vy.
  app.dataset.screen = key;
  app.innerHTML = html;
  if (active) {
    const again = document.getElementById(active.id);
    if (again && again !== active) {
      again.focus({ preventScroll: true });
      try { if (caret) again.setSelectionRange(caret[0], caret[1]); } catch { /* fältet stödjer inte markör */ }
    }
  }
  app.querySelectorAll(".filters, .car-chips").forEach((el) => {
    if (keepScroll[el.className] != null) el.scrollLeft = keepScroll[el.className];
    const sel = el.querySelector('[aria-pressed="true"]');
    if (sel) {
      const r = sel.getBoundingClientRect(), box = el.getBoundingClientRect();
      if (r.right > box.right || r.left < box.left) el.scrollLeft += r.left - box.left - (box.width - r.width) / 2;
    }
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
}

function renderLogin(error = "") {
  setScreen("login", `
    <section class="login">
      <h1><img class="login-logo" src="icons/logo.png" alt="Bildagboken" width="900" height="244"></h1>
      <p>Service, tankning, däck, datum och kostnader för er bil. Ni ser samma sak i båda telefonerna.</p>
      <button class="btn google block" type="button" data-act="login">${icon("google", 20)} Logga in med Google</button>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <p class="hint">Har du fått en inbjudan? Logga in först, sedan skriver du in koden.</p>
    </section>`);
}

function renderOnboarding(error = "") {
  const join = new URLSearchParams(location.search).get("join") || "";
  const first = (S.user.displayName || "").split(" ")[0];
  setScreen("onboarding", `
    <header class="top"><div class="hello"><small>Välkommen</small><h1>Kom igång</h1></div></header>
    <form class="card form" data-form="create-house" data-keep>
      <h2>Starta en ny bildagbok</h2>
      <label class="field"><span>Ditt namn</span><input name="name" id="ob-name" required maxlength="30" value="${esc(first)}" autocomplete="given-name"></label>
      <label class="field"><span>Vad heter hushållet?</span><input name="house" id="ob-house" maxlength="40" placeholder="Till exempel Familjen Andersson"></label>
      <button class="btn primary block" type="submit">Skapa</button>
      <p class="hint">Sedan bjuder du in din sambo med en kod.</p>
    </form>
    <form class="card form" data-form="join-house" data-keep>
      <h2>Gå med i en befintlig</h2>
      <label class="field"><span>Ditt namn</span><input name="name" id="ob-name2" required maxlength="30" value="${esc(first)}" autocomplete="given-name"></label>
      <label class="field"><span>Inbjudningskod</span><input name="code" id="ob-code" required maxlength="8" value="${esc(join)}" autocapitalize="characters" autocomplete="off" placeholder="Sex tecken" style="text-transform:uppercase;letter-spacing:.12em"></label>
      <button class="btn block" type="submit">Gå med</button>
    </form>
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
  specs: "Bra att ha",
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
      ${inp("make", "Märke", c.make, 'required placeholder="Volvo"')}
      ${inp("model", "Modell", c.model, 'required placeholder="V50"')}
    </div>
    <div class="row2">
      ${inp("year", "Årsmodell", c.year, 'inputmode="numeric" placeholder="2007"')}
      ${inp("engine", "Motor", c.engine, 'placeholder="1.8F"')}
    </div>
    <label class="field"><span>Drivmedel</span>${sel("fuel", FUELS, c.fuel || "Bensin")}</label>
    <div class="row2">
      ${inp("color", "Färg", c.color, 'placeholder="Svart"')}
      ${inp("plate", "Registreringsnummer", c.plate, 'placeholder="ABC 123" autocapitalize="characters"')}
    </div>
    ${isNew
      ? inp("odometer", "Mätarställning (mil)", "", 'inputmode="numeric" placeholder="21 480"')
      : `<div class="field"><span>Mätarställning</span>
          <div class="odo-row"><b>${odoOf(c) != null ? `${fmt(odoOf(c))} mil` : "Inte angiven"}</b>
          <button class="btn-soft" type="button" data-act="new-entry" data-type="matare">Uppdatera</button></div>
          <small>Hämtas från loggen. Har någon skrivit fel, ändra eller ta bort den posten i loggen.</small></div>`}`;
  parts.photo = `
    <label class="photo-in">${icon("image", 22)}<span id="photo-label">${c.photoId ? "Eget foto används. Välj ett nytt för att byta." : "Ta eller välj ett eget foto på bilen"}</span><input type="file" name="carPhoto" id="cf-carPhoto" accept="image/*"></label>
    ${c.photoId ? `<label class="check"><input type="checkbox" name="removePhoto" id="cf-removePhoto"> Ta bort eget foto och använd bild från Wikipedia</label>`
      : `<p class="hint">Utan eget foto hämtas en bild på modellen från Wikipedia.</p>`}`;
  parts.dates = `
    <div class="row2">
      ${inp("besiktning", "Besiktning senast", c.besiktning, 'type="date"')}
      ${inp("besiktningPlats", "Besiktningsstation", c.besiktningPlats, 'placeholder="Bilprovningen Kungsbacka"')}
    </div>
    <div class="row2">
      ${inp("forsakringBolag", "Försäkringsbolag", c.forsakringBolag, 'placeholder="If, Folksam …"')}
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
    ${tireHead("vinter", "Vinterdäck")}
    <div class="row2">
      ${inp("w_brand", "Märke", winter.brand)}
      ${inp("w_size", "Dimension", winter.size, 'autocomplete="off"')}
    </div>
    <div class="row2">
      ${inp("w_year", "Tillverkningsår", winter.year, 'inputmode="numeric" autocomplete="off"')}
      ${inp("w_depth", "Mönsterdjup (mm)", winter.depth, 'inputmode="decimal" autocomplete="off"')}
    </div>
    <label class="check"><input type="checkbox" name="w_studded" id="cf-w_studded"${winter.studded ? " checked" : ""}> Vinterdäcken är dubbade</label>
    <p class="hint">Dimensionen står på däckets sida, till exempel 205/55 R16. Sommar- och vinterdäcken sparas var för sig.</p>`;
  parts.specs = `
    <label class="field"><span>En sak per rad, till exempel "Motorolja: 5W-30"</span><textarea name="specsText" id="cf-specsText" rows="9">${esc(c.specsText ?? SPEC_TEMPLATE)}</textarea></label>
    <p class="hint">Fusklapp för butiken: oljetyp, däckdimension, lufttryck, torkarblad, glödlampor och liknande.</p>`;
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
function loadPhoto(id) {
  if (photoCache[id] || photoPending[id] || !S.hid) return;
  photoPending[id] = true;
  getDoc(ref("photos", id)).then((s) => {
    photoCache[id] = s.exists() ? s.data().data : "";
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
    const d = photoCache[c.photoId];
    if (d) return `<figure class="car-fig"><img class="car-photo" src="${esc(d)}" alt="Foto på er ${esc(`${c.make} ${c.model}`)}"></figure>`;
    loadPhoto(c.photoId);
    return carSvg(c);
  }
  if (c.imageUrl) {
    return `<figure class="car-fig"><img class="car-photo" src="${esc(c.imageUrl)}" alt="${esc(`${c.make} ${c.model}`)}, bild från Wikipedia" referrerpolicy="no-referrer"${c.imageFallback && c.imageFallback !== c.imageUrl ? ` data-fallback="${esc(c.imageFallback)}"` : ""} onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.removeAttribute('data-fallback')}else{this.closest('figure').hidden=true}">
      <figcaption><a href="${esc(c.imageCredit || "https://wikipedia.org")}" target="_blank" rel="noopener">Bild: Wikipedia</a></figcaption></figure>`;
  }
  return carSvg(c);
}

/* Bränslemätare: hur mycket som finns kvar i tanken, i åttondelar som på instrumentbrädan. */
const FUEL_LABELS = ["Tom", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞", "Full"];
const fuelText = (l) => (l === 0 ? "Tom tank" : l === 8 ? "Full tank" : `${FUEL_LABELS[l]} tank`);
const fuelClass = (l) => (l <= 2 ? "low" : l <= 4 ? "mid" : "ok");
const fuelNowHtml = (l) => (l == null ? `<small>Inte angivet</small>` : `${esc(fuelText(l))}${l <= 2 ? " <small>Tanka snart</small>" : ""}`);

function fuelCard(c) {
  const f = c.fuelLevel;
  const draft = S.fuelDraft && S.fuelDraft.carId === c.id ? S.fuelDraft.level : null;
  const level = draft ?? (f && typeof f.level === "number" ? f.level : null);
  const meta = f
    ? `${f.via === "tank" ? "Fulltankad" : "Uppdaterad"} av ${whoName(f.by) === "Du" ? "dig" : whoName(f.by)} · ${timeAgo(tsMs(f.at)).toLowerCase()}`
    : "Dra i reglaget så ser ni båda hur mycket som finns kvar i tanken.";
  return `<article class="card fuel-card">
    <div class="fuel-head"><h2>Bränsle</h2><div class="fuel-now ${level != null ? fuelClass(level) : ""}" id="fuel-now">${fuelNowHtml(level)}</div></div>
    <input type="range" class="fuel-range${level == null ? " unset" : ""}" id="fuel-range" min="0" max="8" step="1" value="${level ?? 4}" aria-label="Bränsle kvar i tanken" aria-valuetext="${esc(level != null ? fuelText(level) : "Inte angivet")}">
    <div class="fuel-ticks" aria-hidden="true">${FUEL_LABELS.map((l, i) => `<span${i % 2 ? ' class="minor"' : ""}>${l}</span>`).join("")}</div>
    <p class="fuel-meta" id="fuel-meta">${esc(meta)}</p>
  </article>`;
}

function unseenFromOthers() {
  const seen = lastSeenMs();
  return S.entries.filter((e) => e.createdBy !== uid() && tsMs(e.createdAt) > seen);
}

function headerMain() {
  const d = new Date();
  const dateTxt = `${["Söndag", "Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag"][d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const n = unseenFromOthers().length;
  return `<header class="top">
    <div class="hello"><small>${dateTxt}</small><h1>Hej ${esc(myName())}</h1></div>
    <div class="top-actions">
      <button class="icon-btn" type="button" data-go="aviseringar" aria-label="Aviseringar${n ? `, ${n} nya` : ""}">${icon("bell")}${n ? `<span class="badge">${n > 9 ? "9+" : n}</span>` : ""}</button>
      <button class="icon-btn" type="button" data-go="installningar" aria-label="Inställningar">${icon("gear")}</button>
    </div>
  </header>`;
}

function subHeader(small, title, back = false) {
  return `<header class="top">
    <div class="hello"><small>${esc(small)}</small><h1>${esc(title)}</h1></div>
    ${back ? `<button class="icon-btn" type="button" data-go="oversikt" aria-label="Tillbaka till översikten">${icon("back")}</button>` : ""}
  </header>`;
}

function rowHtml(x) {
  const inner = `<span class="dl-ic">${icon(x.icon, 22)}</span>
    <span><span class="dl-t">${esc(x.title)}</span><span class="dl-s">${esc(x.sub || "")}</span></span>
    <span class="pill ${x.level}">${esc(x.label)}</span>`;
  return x.act
    ? `<button class="dl as-btn" type="button" data-act="${x.act}" data-id="${esc(x.id)}">${inner}</button>`
    : `<div class="dl">${inner}</div>`;
}

function installCard() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone || pref.get("installDismissed")) return "";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<article class="card">
    <h2>Lägg appen på hemskärmen <button class="link" type="button" data-act="dismiss-install">Dölj</button></h2>
    <p class="muted">${ios
      ? "Tryck på Dela-knappen i Safari och välj <b>Lägg till på hemskärmen</b>. Då öppnas Bildagboken som en vanlig app."
      : "Öppna webbläsarens meny och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>."}</p>
  </article>`;
}

function inviteCard() {
  if (!S.house || (S.house.members || []).length > 1) return "";
  return `<article class="card">
    <h2>Bjud in din sambo</h2>
    <p class="muted">Ni delar allt i appen. Din sambo loggar in med sitt Google-konto och skriver in koden:</p>
    <p class="code" style="margin:10px 0">${esc(S.house.inviteCode)}</p>
    <button class="btn-soft" type="button" data-act="copy-invite">Kopiera inbjudningslänk</button>
  </article>`;
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

  const switcher = S.cars.length > 1
    ? `<label class="field car-switch"><span class="label">Byt bil</span><select data-act="switch-car" id="car-switch">${S.cars.map((x) => `<option value="${x.id}"${x.id === c.id ? " selected" : ""}>${esc(carName(x))}</option>`).join("")}</select></label>`
    : "";
  parts.push(`<article class="card hero">
    <div class="hero-top">
      <div><h2>${esc(carName(c))}</h2>
      <div class="sub">${esc([c.year, c.fuel, c.color].filter(Boolean).join(" · "))}</div></div>
      ${c.plate ? `<span class="plate">${esc(c.plate)}</span>` : ""}
    </div>
    <label class="car-pick" title="Byt bild på bilen">
      ${carVisual(c)}
      <span class="cam" aria-hidden="true">${icon("camera", 19)}</span>
      <input type="file" accept="image/*" id="hero-photo" class="vh" aria-label="Byt bild på bilen">
    </label>
    <div class="odo">
      <div><div class="label">Mätarställning</div><div class="odo-num">${odoOf(c) != null ? fmt(odoOf(c)) : "–"}<span>mil</span></div>${odoAgeHtml(c)}</div>
      <button class="btn-soft" type="button" data-act="new-entry" data-type="matare">Uppdatera</button>
    </div>
    ${switcher}
  </article>`);

  parts.push(fuelCard(c));

  const dls = deadlines(c);
  parts.push(`<article class="card">
    <h2>Att hålla koll på <button class="link" type="button" data-act="edit-car" data-section="dates">Ändra datum</button></h2>
    ${kollRowsHtml([...bookingRows(c).map((b) => ({ ...b, always: true })), ...dls])}
    ${!c.besiktning && !c.forsakringDatum && !taxMonth(c) ? `<p class="hint" style="margin-top:10px">Lägg till besiktning, försäkring och skatt under Ändra datum.</p>` : ""}
    <div class="ask"><button class="btn-soft" type="button" data-act="new-booking">${icon("calendar", 16)} Lägg in bokad tid</button></div>
  </article>`);

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
        <div class="ask"><button class="btn-soft" type="button" data-act="goto-maintenance">Ange senaste byte</button></div></article>`);
  } else if (known.length) {
    const top = known.slice(0, 3);
    const first = top[0];
    parts.push(`<article class="card">
      <h2>Underhåll <button class="link" type="button" data-act="goto-maintenance">Alla ${st.length}</button></h2>
      <div class="rows">${top.map((x) => `<button class="dl as-btn" type="button" data-act="goto-maintenance">
        <span class="dl-ic">${icon("wrench", 20)}</span>
        <span><span class="dl-t">${esc(x.item.name)}</span><span class="dl-s">${esc(dueText(x))}</span>${wearBar(x)}</span>
        <span class="pill ${x.level}">${esc(x.label)}</span></button>`).join("")}</div>
      ${unknownCount && pref.get("maintHintHidden." + c.id) !== String(unknownCount) ? `<div class="ask"><button class="btn-soft" type="button" data-act="goto-maintenance">Fyll i underhåll (${unknownCount} kvar)</button><button class="link" type="button" data-act="hide-maint-hint" data-n="${unknownCount}">Dölj</button></div>` : ""}
      ${serviceDueEstimate(first, c) ? `<div class="ask"><button class="btn-soft" type="button" data-act="service-calendar" data-id="${esc(first.item.id)}">${icon("calendar", 16)} Påminn mig i kalendern</button><small>Gäller ${esc(first.item.name.toLowerCase())}.</small></div>` : ""}
    </article>`);
  }


  parts.push(recentCard(c));

  const eco = economy(carEntries());
  const maxBar = Math.max(1, ...eco.bars.map((b) => b.sum));
  const hasCosts = carEntries().some((e) => e.amount > 0);
  parts.push(`<article class="card">
    <h2>Ekonomi <button class="link" type="button" data-go="ekonomi">Mer</button></h2>
    ${hasCosts ? `<div class="eco">
      <div class="stat"><div class="label">${MONTHS[new Date().getMonth()].replace(/^./, (x) => x.toUpperCase())}</div><div class="n">${fmt(eco.thisMonth)} <small>kr</small></div></div>
      <div class="stat"><div class="label">Snitt per månad</div><div class="n">${eco.total > 0 ? fmt(eco.perMonth) : "–"} <small>kr</small></div></div>
      <div class="bars" aria-label="Kostnad per månad de senaste sex månaderna">
        ${eco.bars.map((b) => `<div class="bar${b.now ? " now" : ""}">${b.sum ? `<b>${fmt(b.sum / 1000, 1)}k</b>` : ""}<i style="height:${Math.round((b.sum / maxBar) * 70)}%"></i><span>${b.label}</span></div>`).join("")}
      </div>
    </div>
`
    : `<p class="muted">Här ser ni vad bilen kostar per månad när ni har loggat er första tankning eller kostnad.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="new-entry" data-type="tank">${icon("fuel", 16)} Logga en tankning</button></div>`}
  </article>`);

  const tips = tipsFor(c);
  parts.push(`<article class="card">
    <h2>Tips för ${esc(carName(c))}</h2>
    <div class="recs">${tips.map((t) => `<div class="rec"><span class="sev ${t.sev === "high" ? "high" : t.sev === "mid" ? "mid" : ""}"></span><div><b>${esc(t.title)}</b><p>${esc(t.text)}</p></div></div>`).join("")}</div>
    <div class="ask">
      <a class="btn" href="https://claude.ai/new" target="_blank" rel="noopener" data-act="ask-claude">${icon("spark", 18)} Fråga Claude</a>
      <small>Kopierar en fråga med er bil och historik som du klistrar in i Claude.</small>
    </div>
  </article>`);
  parts.push(inviteCard());
  parts.push(installCard());
  return parts.join("");
}

// "Uppdaterad för 3 veckor sedan" under mätarställningen. Orange efter en månad.
function odoAgeHtml(c) {
  const last = latestOdoEntry(c.id);
  if (!last?.date) return "";
  const ago = Math.max(0, -daysUntil(parseDate(last.date)));
  const when = ago === 0 ? "i dag" : ago === 1 ? "i går" : ago < 14 ? `för ${ago} dagar sedan` : ago < 60 ? `för ${Math.round(ago / 7)} veckor sedan` : `för ${daysText(ago)} sedan`;
  return `<div class="odo-age${ago >= 30 ? " old" : ""}">Uppdaterad ${esc(when)}${ago >= 30 ? " · dags att uppdatera" : ""}</div>`;
}

// Att hålla koll på: bokningar, tvätt, brådskande och det som händer inom tre månader. Resten bakom "Visa fler".
function kollRowsHtml(rows) {
  const near = (x) => x.always || x.level === "urgent" || x.level === "soon" || (x.days != null && x.days <= 92);
  const shown = rows.filter(near), later = rows.filter((x) => !near(x));
  const all = S.kollAll;
  return `<div class="rows">${[...shown, ...(all ? later : [])].map(rowHtml).join("")}</div>
    ${later.length ? `<button class="link" type="button" data-act="toggle-koll" style="margin-top:10px">${all ? "Visa färre" : `Visa ${later.length} till`}</button>` : ""}`;
}

// De tre senaste loggarna, för båda, så att man ser vad den andra har gjort.
function recentCard(c) {
  const list = [...S.entries].filter((e) => e.carId === c.id).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)).slice(0, 3);
  if (!list.length) return "";
  return `<article class="card">
    <h2>Senaste <button class="link" type="button" data-go="logg">Logg</button></h2>
    <div class="rows">${list.map((e) => {
      const mine = e.createdBy === uid();
      return `<button class="dl as-btn" type="button" data-act="open-entry" data-id="${esc(e.id)}">
        <span class="avatar${mine ? " me" : ""}">${esc((mine ? myName() : memberName(e.createdBy)).slice(0, 1).toUpperCase())}</span>
        <span><span class="dl-t">${esc(activityText(e))}</span><span class="dl-s">${esc(timeAgo(tsMs(e.createdAt)) || fmtDateShort(e.date))}</span></span>
        <span></span></button>`;
    }).join("")}</div>
  </article>`;
}

function entryRow(e, fromCat = null) {
  const mine = e.createdBy === uid();
  const d = entryDetail(e);
  return `<button class="entry" type="button" data-act="open-entry" data-id="${esc(e.id)}"${fromCat ? ` data-cat="${esc(fromCat)}"` : ""}>
    <span class="dl-ic">${icon(TYPE[e.type]?.icon || "list", 20)}</span>
    <span><span class="t">${esc(entryTitle(e))}</span>${d ? `<span class="d">${esc(d)}</span>` : ""}
      <span class="m"><span class="who${mine ? " me" : ""}">${esc(whoName(e.createdBy))}</span>${esc(fmtDateShort(e.date))}${e.odometer != null && e.type !== "matare" ? ` · ${fmt(e.odometer)} mil` : ""}${e.photoId ? " · bild" : ""}</span></span>
    <span class="amt">${e.amount != null ? `${fmt(e.amount)} kr` : ""}</span>
  </button>`;
}

// Sök: varje ord man skriver måste finnas någonstans i posten (titel, detaljer, verkstad, anteckning, vem, belopp, datum).
function entryMatches(e, q) {
  if (!q) return true;
  const c = S.cars.find((x) => x.id === e.carId) || car();
  const hay = [
    TYPE[e.type]?.label, entryTitle(e), entryDetail(e, c), e.note, e.workshop, e.station, e.place, e.category, e.fuel,
    (e.parts || []).join(" "), itemNames(e, c).join(" "), whoName(e.createdBy), memberName(e.createdBy),
    e.amount != null ? `${Math.round(e.amount)} ${fmt(e.amount)} kr` : "", e.odometer != null ? `${e.odometer} ${fmt(e.odometer)} mil` : "",
    fmtDate(e.date), e.date,
  ].filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w.replace(/\s/g, "")) || hay.replace(/\s/g, "").includes(w));
}

function logListHtml() {
  const q = (S.query || "").trim();
  const ents = carEntries().filter((e) => (S.filter === "alla" || e.type === S.filter) && entryMatches(e, q));
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
  const count = q ? `<p class="hint" style="margin:0 4px">${ents.length === 1 ? "1 träff" : `${ents.length} träffar`} för ”${esc(q)}”</p>` : "";
  if (!groups.length) {
    return q
      ? `${count}<div class="card empty"><b>Inga träffar</b>Prova ett annat ord, till exempel verkstad, del eller belopp.</div>`
      : `<div class="card empty"><b>${S.filter === "alla" ? "Inget loggat än" : "Inget här än"}</b>Tryck på plusknappen för att logga en tankning, service eller något du gjort själv.</div>`;
  }
  return count + groups.map((g) => `<div class="month">${esc(monthLabel(g.key))}</div><div class="card">${g.items.map((e) => entryRow(e)).join("")}</div>`).join("");
}

function viewLog() {
  const filters = [["alla", "Alla"], ["tank", "Tankning"], ["service", "Service"], ["eget", "Eget jobb"], ["dack", "Däck"], ["tvatt", "Tvätt"], ["parkering", "Parkering"], ["kostnad", "Kostnader"], ["matare", "Mätare"]];
  return `${subHeader("Allt som hänt med bilen", "Logg")}
    <label class="search">${icon("search", 18)}
      <input type="search" id="log-search" placeholder="Sök i loggen, till exempel bromsar eller Mekonomen" value="${esc(S.query || "")}" autocomplete="off" enterkeyhint="search" aria-label="Sök i loggen">
      ${S.query ? `<button class="search-clear" type="button" data-act="clear-search" aria-label="Rensa sökningen">${icon("close", 14)}</button>` : ""}
    </label>
    <div class="filters" role="group" aria-label="Filtrera loggen">
      ${filters.map(([k, l]) => `<button type="button" data-act="filter" data-f="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join("")}
    </div>
    <div id="log-list" class="log-list">${logListHtml()}</div>`;
}

function viewEconomy() {
  const eco = economy(carEntries());
  const cats = Object.entries(eco.cats).sort((a, b) => b[1] - a[1]);
  return `${subHeader("Senaste 12 månaderna", "Ekonomi")}
    <div class="card"><div class="eco">
      <div class="stat"><div class="label">Totalt</div><div class="n">${fmt(eco.total)} <small>kr</small></div></div>
      <div class="stat"><div class="label">Per mil</div><div class="n">${eco.perMil != null && eco.total > 0 ? fmt(eco.perMil, 2) : "–"} <small>kr</small></div></div>
      <div class="stat"><div class="label">Per månad</div><div class="n">${eco.total > 0 ? fmt(eco.perMonth) : "–"} <small>kr</small></div></div>
      <div class="stat"><div class="label">Körsträcka</div><div class="n">${eco.driven != null ? fmt(eco.driven) : "–"} <small>mil</small></div></div>
    </div></div>
    <div class="card"><h2>Fördelning</h2>
      ${cats.length ? `<div class="rows">${cats.map(([k, v]) => `<button class="dl as-btn" type="button" data-act="open-cat" data-id="${esc(k)}"><span class="dl-ic">${icon(CAT_ICON[k] || "receipt", 20)}</span><span><span class="dl-t">${esc(k)}</span><span class="dl-s">${eco.total ? fmt((v / eco.total) * 100) : 0} % · ${eco.catCount[k]} st</span></span><span class="dl-v">${fmt(v)} kr ›</span></button>`).join("")}</div>
        <p class="hint" style="margin-top:10px">Tryck på en rad för att se vad som ingår.</p>`
        : `<p class="muted">Inga kostnader loggade de senaste 12 månaderna. Belopp från tankningar, service, däck och andra kostnader hamnar här.</p>`}
    </div>
    <p class="hint" style="text-align:center">Kostnad per mil räknas på körsträckan mellan loggade mätarställningar.</p>`;
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
  const specs = (c.specsText || "").split("\n").map((l) => {
    const i = l.indexOf(":");
    return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l.trim(), ""];
  }).filter(([k, v]) => k && v);
  const st = allItemStatus(c);
  const tires = ["sommar", "vinter"].map((k) => {
    const t = (c.tires || []).find((x) => x.kind === k) || {};
    const on = (c.tiresOn || "sommar") === k;
    const sub = [t.brand, t.size, t.year, t.depth != null && t.depth !== "" ? `${fmt(num(t.depth), 1)} mm` : "", k === "vinter" && t.studded ? "dubbade" : ""].filter(Boolean).join(" · ");
    const depth = num(t.depth);
    const low = depth != null && depth < (k === "vinter" ? 4 : 3);
    return `<div class="dl"><div class="dl-ic">${icon("tire", 20)}</div><div><div class="dl-t">${k === "sommar" ? "Sommardäck" : "Vinterdäck"}${on ? " · sitter på" : ""}</div><div class="dl-s">${esc(sub || "Inga uppgifter")}</div></div><span class="pill ${low ? "soon" : on ? "ok" : "none"}">${low ? "Slitna" : on ? "På" : "Förråd"}</span></div>`;
  }).join("");
  return `${subHeader([c.year, c.fuel].filter(Boolean).join(" · "), carName(c))}
    <div class="car-chips" role="group" aria-label="Välj bil">
      ${S.cars.map((x) => `<button type="button" data-act="pick-car" data-id="${esc(x.id)}" aria-pressed="${x.id === c.id}">${icon("car", 16)}${esc(carName(x))}</button>`).join("")}
      <button type="button" class="add" data-act="add-car">${icon("plus", 16)}Lägg till bil</button>
    </div>
    <div class="card">
      <h2>Bra att ha <button class="link" type="button" data-act="edit-car" data-section="specs">Ändra</button></h2>
      ${specs.length ? `<div class="spec">${specs.map(([k, v]) => `<div><div class="label">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`
        : `<p class="muted">Fyll i oljetyp, däckdimension, lufttryck, torkarblad och glödlampor, så har ni det till hands i butiken.</p>`}
    </div>
    <div class="card" id="underhall" style="scroll-margin-top:16px">
      <h2>Underhåll <button class="link" type="button" data-act="edit-items">Ändra</button></h2>
      <div class="rows">${st.map((s) => `<div class="dl"><div class="dl-ic">${icon("wrench", 20)}</div><div><div class="dl-t">${esc(s.item.name)}</div><div class="dl-s">${esc([
        s.item.mil ? `var ${fmt(s.item.mil)} mil` : "", s.item.months ? `${s.item.months >= 24 && s.item.months % 12 === 0 ? `${s.item.months / 12} år` : `${s.item.months} mån`}` : ""].filter(Boolean).join(" eller ") + (s.noOdo ? " · mätarställning saknas" : s.unknown ? " · senaste byte okänt" : s.lastDate ? ` · senast ${fmtDateShort(s.lastDate)}` : ""))}</div>${wearBar(s)}</div><span class="pill ${s.unknown ? "none" : s.level}">${esc(s.unknown ? "Okänt" : s.label)}</span></div>`).join("") || `<p class="muted">Inga punkter. Lägg till under Ändra.</p>`}</div>
      <p class="hint" style="margin-top:10px">Intervallen är vanliga riktvärden. Kontrollera mot bilens servicebok.</p>
    </div>
    <div class="card"><h2>Däck <button class="link" type="button" data-act="edit-car" data-section="tires">Ändra</button></h2><div class="rows">${tires}</div></div>
    <div class="card"><h2>Uppgifter <button class="link" type="button" data-act="edit-car" data-section="basic,photo,dates">Ändra</button></h2>
      <dl class="detail-list">
        ${[["Registreringsnummer", c.plate], ["Motor", c.engine], ["Färg", c.color], ["Mätarställning", odoOf(c) != null ? `${fmt(odoOf(c))} mil` : ""], ["Besiktning senast", [c.besiktning ? fmtDate(c.besiktning) : "", c.besiktningPlats].filter(Boolean).join(", ")], ["Försäkring", [c.forsakringBolag, c.forsakringDatum ? `förnyas ${fmtDate(c.forsakringDatum)}` : ""].filter(Boolean).join(", ")], ["Skatt", [c.skattBelopp ? `${fmt(c.skattBelopp)} kr/år` : "", taxMonth(c) ? MONTHS[taxMonth(c) - 1] : ""].filter(Boolean).join(", ")], ["Senast tvättad", lastWash(c) ? [fmtDate(lastWash(c).date), lastWash(c).place].filter(Boolean).join(", ") : ""]]
          .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v || "–")}</dd></div>`).join("")}
      </dl>
    </div>`;
}

function viewNotifications() {
  const seen = lastSeenMs();
  const c = car();
  const fl = c.fuelLevel?.level;
  const reminders = [
    ...(typeof fl === "number" && fl <= 2 ? [{ icon: "fuel", title: "Tanka snart", sub: `Bränslet är på ${fuelText(fl).toLowerCase()}`, label: FUEL_LABELS[fl] }] : []),
    ...bookingRows(c).filter((b) => b.days <= 1),
    ...deadlines(c).filter((d) => d.level === "urgent"),
    ...allItemStatus(c).filter((s) => !s.unknown && s.level === "urgent").map((s) => ({ title: `Dags för ${s.item.name.toLowerCase()}`, sub: s.label })),
  ];
  const feed = [...S.entries].sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)).slice(0, 40);
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  return `${subHeader("Det ni gjort med bilen", "Aviseringar", true)}
    ${perm === "default" ? `<div class="card"><h2>Få notiser i telefonen</h2><p class="muted">Då ser du när din sambo loggar något. Notiserna kommer när appen är öppen eller nyss har använts.</p><div class="ask"><button class="btn-soft" type="button" data-act="enable-notif">Slå på notiser</button></div></div>` : ""}
    ${reminders.length ? `<div class="card"><h2>Påminnelser</h2><div class="rows">${reminders.map((r) => rowHtml({ icon: r.icon || "bell", title: r.title, sub: r.sub, level: "urgent", label: r.label || "Nu", act: r.act, id: r.id })).join("")}</div></div>` : ""}
    <div class="card">
      ${feed.length ? feed.map((e) => {
        const mine = e.createdBy === uid();
        const isNew = !mine && tsMs(e.createdAt) > seen;
        const otherCar = S.cars.length > 1 ? carName(S.cars.find((x) => x.id === e.carId)) : "";
        return `<button class="entry" type="button" data-act="open-entry" data-id="${esc(e.id)}">
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
      <label class="field"><span>Ditt namn, så ser din sambo dig i appen</span><input name="name" id="st-name" required maxlength="30" value="${esc(myName())}"></label>
      <button class="btn block" type="submit">Spara</button>
    </form>
    <div class="card">
      <h2>Utseende</h2>
      <div class="seg" role="group" aria-label="Utseende">
        ${[["auto", "Automatiskt"], ["light", "Ljust"], ["dark", "Mörkt"]].map(([k, l]) => `<button type="button" data-act="theme" data-v="${k}" aria-pressed="${(pref.get("theme") || "auto") === k}">${l}</button>`).join("")}
      </div>
      <p class="hint" style="margin-top:10px">Automatiskt följer telefonens inställning för mörkt läge.</p>
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
      <p class="hint" style="margin-top:10px">Ta bort raderar bilen och hela dess logg för er båda. Du får frågan en gång till innan något tas bort.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="add-car">Lägg till bil</button></div>
    </div>
    <div class="card">
      <h2>Säkerhetskopia</h2>
      <p class="muted">Ladda ner hela loggen för alla bilar som ett kalkylark. Bra att spara, eller att ha med vid försäljning av bilen.</p>
      <div class="ask"><button class="btn-soft" type="button" data-act="export-log">Ladda ner loggen</button></div>
    </div>
    <div class="card">
      <h2>Konto</h2>
      <p class="muted">Inloggad som ${esc(S.user.email || "")}</p>
      <div class="ask"><button class="btn ghost" type="button" data-act="logout">Logga ut</button></div>
    </div>
    <p class="hint" style="text-align:center">Bildagboken ${VERSION}</p>`;
}

/* ------------------------------------------------------------------ sheets */

const sheet = $("#sheet");
const scrim = $("#scrim");

let sheetReturnFocus = null;
function openSheet(title, body, { back = null, backId = null } = {}) {
  if (sheet.hidden) sheetReturnFocus = document.activeElement;
  sheet.innerHTML = `<div class="grab"></div>
    <div class="sheet-head">
      ${back ? `<button class="icon-btn" type="button" data-act="${back}"${backId ? ` data-id="${esc(backId)}"` : ""} aria-label="Tillbaka">${icon("back", 18)}</button>` : ""}
      <h3 id="sheet-title">${esc(title)}</h3>
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
function closeSheet() {
  sheet.hidden = true;
  scrim.hidden = true;
  sheet.innerHTML = "";
  document.body.style.overflow = "";
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

const TYPE_DEFINITE = { tank: "tankningen", matare: "mätarställningen", service: "servicen", eget: "jobbet", dack: "däckposten", tvatt: "tvätten", parkering: "parkeringen", kostnad: "kostnaden" };

function typePicker() {
  openSheet("Vad vill du logga?", `<div class="types">
    ${Object.entries(TYPE).map(([k, t]) => `<button type="button" data-act="new-entry" data-type="${k}">${icon(t.icon, 26)}${t.label}</button>`).join("")}
  </div>
  <button class="btn ghost block" type="button" data-act="new-booking" style="margin-top:12px">${icon("calendar", 18)} Lägg in bokad tid</button>
  <p class="hint" style="margin-top:14px">Det du sparar syns direkt hos din sambo.</p>`);
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
      ${isEdit ? `<button class="btn primary block" type="button" data-act="booking-done" data-id="${esc(b.id)}">${b.kind === "annat" ? "Klart, ta bort bokningen" : "Klart, logga det"}</button>` : ""}
      ${field("Vad är bokat?", `<select name="kind" id="bk-kind">${kinds.map(([k, l]) => `<option value="${k}"${(b.kind || "service") === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
      <div class="row2">
        ${field("Datum", `<input type="date" name="date" id="bk-date" required value="${esc(b.date || "")}">`)}
        ${field("Tid", `<input type="time" name="time" id="bk-time" value="${esc(b.time || "")}">`)}
      </div>
      ${field("Var", `<input name="place" id="bk-place" value="${esc(b.place || "")}" placeholder="Skriv företagets namn, till exempel Mölndals däckservice" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="bk-suggest" aria-expanded="false">
        <input type="hidden" name="placeAddr" id="bk-addr" value="${esc(b.addr || "")}">
        <input type="hidden" name="placeLat" id="bk-lat" value="${b.lat ?? ""}">
        <input type="hidden" name="placeLon" id="bk-lon" value="${b.lon ?? ""}">
        <span class="suggest" id="bk-suggest" role="listbox" hidden></span>
        <small id="bk-addr-show">${b.addr ? esc(b.addr) : "Välj ett förslag så kommer adressen med, och kartan fungerar i kalendern."}</small>`)}
      ${field("Anteckning", `<textarea name="note" id="bk-note" rows="2" placeholder="Till exempel lämna nyckeln i brevlådan">${esc(b.note || "")}</textarea>`)}
      <p class="err" id="form-err" hidden></p>
      <button class="btn ${isEdit ? "" : "primary "}block" type="submit">${isEdit ? "Spara ändringar" : "Spara bokningen"}</button>
      ${isEdit
        ? `<button class="btn ghost block" type="button" data-act="booking-calendar" data-id="${esc(b.id)}">${icon("calendar", 18)} Lägg till i kalendern</button>
           <button class="btn danger block" type="button" data-act="delete-booking" data-id="${esc(b.id)}">Ta bort bokningen</button>`
        : `<button class="btn ghost block" type="submit" name="cal" value="1">${icon("calendar", 18)} Spara och lägg till i kalendern</button>`}
      <p class="hint">Bokningen syns för er båda under Att hålla koll på och bland påminnelserna dagen innan. Lägger du den i kalendern påminner telefonen dig också.</p>
    </form>`, { back: isEdit ? null : "new-entry" });
  // Väljer man Besiktning och inte skrivit någon plats fylls bilens besiktningsstation i.
  const kindSel = $("#bk-kind"), placeIn = $("#bk-place");
  if (station && kindSel && placeIn) {
    const fill = () => { if (kindSel.value === "besiktning" && !placeIn.value.trim()) placeIn.value = station; };
    kindSel.addEventListener("change", fill);
    fill();
  }
}

function saveBooking(form, wantCalendar = false) {
  const c = car();
  const fd = new FormData(form);
  const str = (k) => String(fd.get(k) ?? "").trim();
  const date = str("date");
  if (!date) return formError("Välj vilket datum som är bokat.");
  const id = form.dataset.id || "b" + randomId(8);
  const lat = num(fd.get("placeLat")), lon = num(fd.get("placeLon"));
  const b = clean({
    id, kind: str("kind") || "service", date, time: str("time") || null, place: str("place") || null,
    addr: str("placeAddr") || null, lat: lat ?? null, lon: lon ?? null,
    note: str("note") || null, createdBy: uid(),
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
function exportLog() {
  if (!S.entries.length) return showToast("Det finns inget loggat att ladda ner än.");
  const cell = (v) => {
    if (v == null || v === "") return "";
    const t = typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ["Bil", "Reg.nr", "Datum", "Typ", "Vad", "Detaljer", "Belopp (kr)", "Mätarställning (mil)", "Mängd", "Drivmedel", "Verkstad", "Station eller plats", "Anteckning", "Loggad av"];
  const rows = [...S.entries].sort((a, b) => (a.date || "").localeCompare(b.date || "")).map((e) => {
    const c = S.cars.find((x) => x.id === e.carId);
    return [
      c ? carName(c) : "Borttagen bil", c?.plate, e.date, TYPE[e.type]?.label || e.type, entryTitle(e), entryDetail(e, c),
      e.amount, e.odometer, e.liters, e.fuel, e.workshop, e.station || e.place, e.note, memberName(e.createdBy),
    ].map(cell).join(";");
  });
  const csv = "\ufeff" + [head.join(";"), ...rows].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `Bildagboken ${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  showToast(`Loggen är nedladdad (${S.entries.length} poster).`);
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

function addToCalendar(ev) {
  const ics = buildIcs(ev);
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
      ${x.sub ? `<div><dt>Info</dt><dd>${esc(x.sub)}</dd></div>` : ""}
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
  const date = field("Datum", `<input type="date" name="date" id="ef-date" required value="${esc(e.date || todayStr())}">`);
  const odo = (required = false) => field("Mätarställning (mil)", `<input name="odometer" id="ef-odometer" inputmode="numeric" ${required ? "required" : ""} placeholder="${odoOf(c) != null ? `Senast ${fmt(odoOf(c))}` : "Till exempel 21 480"}" value="${e.odometer ?? ""}">`);
  const amount = (label = "Kostnad (kr)") => field(label, `<input name="amount" id="ef-amount" inputmode="decimal" value="${e.amount ?? ""}">`);
  const note = field("Anteckning", `<textarea name="note" id="ef-note" rows="2">${v("note")}</textarea>`);
  const photo = `<label class="photo-in">${icon("image", 22)}<span id="photo-label">${e.photoId ? "Bild bifogad. Välj en ny för att byta." : "Lägg till kvitto eller bild"}</span><input type="file" name="photo" id="ef-photo" accept="image/*"></label>`;
  const items = (c.items || []).length ? `<fieldset><legend>Det här gjordes</legend><div class="checks">
    ${c.items.map((i) => `<label class="check"><input type="checkbox" name="items" value="${esc(i.id)}"${(e.items || []).includes(i.id) ? " checked" : ""}> ${esc(i.name)}</label>`).join("")}
  </div></fieldset>` : "";
  const parts = field("Annat som byttes", `<input name="parts" id="ef-parts" value="${esc((e.parts || []).join(", "))}" placeholder="Till exempel bromsklossar fram, glödlampa">`, "Skilj med kommatecken.");
  let body = "";
  switch (type) {
    case "tank": {
      const fuels = fuelOptions(c);
      const hasDetails = e.station || e.photoId;
      body = `${field("Totalt (kr)", `<input name="amount" id="ef-amount" inputmode="decimal" required value="${e.amount ?? ""}" placeholder="Till exempel 579" class="big-input">`,
          "Läs av pumpen med kameran: tryck i fältet, välj <b>Skanna text</b> och peka på totalsumman.")}
        <label class="check"><input type="checkbox" name="full" id="ef-full"${e.full === false ? "" : " checked"}> Tankade fullt</label>
        ${odo(false)}
        ${date}
        <details class="more"${hasDetails ? " open" : ""}>
          <summary>Fler detaljer (valfritt)</summary>
          <div class="form">
            <div class="row2">
              ${field("Drivmedel", `<select name="fuel" id="ef-fuel">${fuels.map((f) => `<option${(e.fuel || pref.get("fuel." + c.id) || fuels[0]) === f ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>`)}
              ${field("Station", geoInput("station", "ef-station", e.station, "fuel", ""))}
            </div>
            ${photo}
          </div>
        </details>`;
      break;
    }
    case "matare":
      body = `${odo(true)}${date}`;
      break;
    // Samma ordning i alla formulär: vad → belopp → mätarställning → datum → detaljer.
    case "service":
      body = `${items}${parts}
        ${field("Verkstad", `<input name="workshop" id="ef-workshop" value="${v("workshop")}" placeholder="Till exempel Mekonomen">`)}
        ${amount()}${odo(false)}${date}${note}${photo}`;
      break;
    case "eget":
      body = `${field("Vad gjorde du?", `<input name="title" id="ef-title" required value="${v("title")}" placeholder="Till exempel bytte glödlampa bak">`)}
        ${items}${parts}${amount("Kostnad för delar (kr)")}${odo(false)}${date}${note}${photo}`;
      break;
    case "dack": {
      const actDefault = e.tireAction || ((c.tiresOn || "sommar") === "sommar" ? "till_vinter" : "till_sommar");
      body = `${field("Vad gjordes?", `<select name="tireAction" id="ef-tireAction">${Object.entries(TIRE_ACTIONS).map(([k, l]) => `<option value="${k}"${actDefault === k ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
        <div class="row2">
          ${field("Gäller", `<select name="tireKind" id="ef-tireKind"><option value="">–</option><option value="sommar"${e.tireKind === "sommar" ? " selected" : ""}>Sommardäck</option><option value="vinter"${e.tireKind === "vinter" ? " selected" : ""}>Vinterdäck</option></select>`)}
          ${field("Mönsterdjup (mm)", `<input name="depth" id="ef-depth" inputmode="decimal" value="${e.depth ?? ""}" placeholder="Valfritt">`)}
        </div>
        ${amount()}${odo(false)}${date}${note}${photo}`;
      break;
    }
    case "tvatt":
      body = `${field("Var", geoInput("place", "ef-place", e.place ?? (e.id ? "" : pref.get("wash." + c.id) || ""), "car_wash", "Till exempel Circle K Mölndal"))}
        ${field("Kostnad (kr)", `<input name="amount" id="ef-amount" inputmode="decimal" value="${e.amount ?? ""}" placeholder="Till exempel 149">`)}
        ${date}${note}${photo}`;
      break;
    case "parkering":
      body = `${field("Var", geoInput("place", "ef-place", e.place, "parking", "Till exempel Kungsgatan, Göteborg"))}
        ${field("Kostnad (kr)", `<input name="amount" id="ef-amount" inputmode="decimal" value="${e.amount ?? ""}" placeholder="Till exempel 45">`)}
        <label class="check"><input type="checkbox" name="fine" id="ef-fine"${e.fine ? " checked" : ""}> P-bot eller felparkeringsavgift</label>
        ${date}${note}${photo}`;
      break;
    case "kostnad":
      body = `${field("Typ", `<select name="category" id="ef-category">${COST_CATS.filter((k) => !["Tvätt", "Parkering"].includes(k) || e.category === k).map((k) => `<option${e.category === k ? " selected" : ""}>${k}</option>`).join("")}</select>`)}
        ${field("Beskrivning", `<input name="title" id="ef-title" value="${v("title")}" placeholder="Valfritt, till exempel Halvförsäkring 2027">`)}
        ${amount("Belopp (kr)")}${date}
        ${!e.id ? `<div id="ef-next-besikt"${e.category === "Besiktning" ? "" : " hidden"}>${field("Nästa besiktning senast", `<input type="date" name="nextBesiktning" id="ef-nextBesiktning" value="${e.category === "Besiktning" ? esc(nextInspectionDate(e.date || todayStr(), c)) : ""}">`, "Uträknat från dagens besiktning. Kontrollera mot besiktningsprotokollet och ändra om det inte stämmer.")}</div>` : ""}
        ${note}${photo}`;
      break;
  }
  const isEdit = !!e.id;
  openSheet(isEdit ? `Ändra ${TYPE[type].label.toLowerCase()}` : TYPE[type].label, `
    <form class="form" data-form="entry" data-type="${type}"${isEdit ? ` data-id="${esc(e.id)}"` : ""}${opts.bookingId ? ` data-booking="${esc(opts.bookingId)}"` : ""} novalidate>
      ${body}
      <p class="err" id="form-err" hidden></p>
      <button class="btn primary block" type="submit">Spara</button>
      ${type === "tank" && !isEdit ? `<p class="hint">Din sambo får en avisering när du sparar.</p>` : ""}
    </form>`, { back: isEdit || opts.bookingId ? null : "new-entry" });
  // Sätt markören i första fältet bara på dator. På telefon öppnar det tangentbordet direkt och döljer formuläret.
  if (!window.matchMedia("(pointer: coarse)").matches) {
    if (type === "tank" && !isEdit) $("#ef-amount")?.focus({ preventScroll: true });
    if (type === "matare") $("#ef-odometer")?.focus({ preventScroll: true });
  }
}

/* ------------------------------------------------- sök företag och adress */

// Förslag på företag och adresser medan man skriver, från Photon (byggd på OpenStreetMap).
// Sökningen görs först efter en kort paus i skrivandet och bara inom Sverige.
let placeTimer = null, placeAbort = null;
function placeSearchSoon(input) {
  clearTimeout(placeTimer);
  const q = input.value.trim();
  const box = $("#bk-suggest");
  if (q.length < 3) { if (box) box.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
  placeTimer = setTimeout(() => placeSearch(q), 400);
}

const placeLabel = (pr) => {
  const street = [pr.street, pr.housenumber].filter(Boolean).join(" ");
  const addr = [street, [pr.postcode, pr.city || pr.town || pr.village || pr.district].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return { name: pr.name || street || pr.city || "", addr };
};

async function placeSearch(q) {
  const box = $("#bk-suggest"), input = $("#bk-place");
  if (!box || !input) return;
  placeAbort?.abort();
  placeAbort = new AbortController();
  try {
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&bbox=10.5,55.0,24.3,69.1`, { signal: placeAbort.signal });
    if (!res.ok) throw new Error("photon " + res.status);
    const j = await res.json();
    if (input.value.trim() !== q) return;
    const seen = new Set();
    const list = (j.features || []).filter((f) => f.properties?.countrycode === "SE" || !f.properties?.countrycode).map((f) => {
      const { name, addr } = placeLabel(f.properties || {});
      const [lon, lat] = f.geometry?.coordinates || [];
      return name ? { name, addr, lat, lon } : null;
    }).filter((x) => x && !seen.has(x.name + x.addr) && seen.add(x.name + x.addr));
    box.innerHTML = list.length
      ? list.map((x) => `<button type="button" role="option" data-act="place-pick" data-name="${esc(x.name)}" data-addr="${esc(x.addr)}" data-lat="${x.lat ?? ""}" data-lon="${x.lon ?? ""}"><b>${esc(x.name)}</b>${x.addr ? `<span>${esc(x.addr)}</span>` : ""}</button>`).join("")
      : `<p class="hint">Inga träffar. Du kan skriva platsen själv.</p>`;
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
  } catch (e) {
    if (e.name !== "AbortError") { box.innerHTML = `<p class="hint">Sökningen fungerar inte just nu. Du kan skriva platsen själv.</p>`; box.hidden = false; }
  }
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
      data.items = fd.getAll("items").map(String);
      data.parts = str("parts").split(",").map((s) => s.trim()).filter(Boolean);
      data.workshop = type === "service" ? str("workshop") || null : null;
      data.title = type === "eget" ? str("title") : null;
      if (type === "eget" && !data.title) return formError("Skriv vad du gjorde.");
      break;
    case "dack":
      data.tireAction = str("tireAction");
      data.depth = num(fd.get("depth"));
      data.tireKind = str("tireKind") || (data.tireAction === "till_vinter" ? "vinter" : data.tireAction === "till_sommar" ? "sommar" : null);
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
      break;
    case "kostnad":
      data.category = str("category");
      data.title = str("title") || null;
      if (data.amount == null) return formError("Fyll i beloppet.");
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
    carUpdate.fuelLevel = { level: 8, by: uid(), at: serverTimestamp(), via: "tank" };
  }
  // Gjord besiktning: flytta "Besiktning senast" till nästa datum.
  if (type === "kostnad" && data.category === "Besiktning" && str("nextBesiktning")) carUpdate.besiktning = str("nextBesiktning");
  if (form.dataset.booking) {
    carUpdate.bookings = (carTarget.bookings || []).filter((x) => x.id !== form.dataset.booking);
  }
  if (Object.keys(carUpdate).length) updateDoc(ref("cars", carTarget.id), carUpdate).catch(onWriteError);

  closeSheet();
  showToast(existing ? "Ändringen är sparad" : `${TYPE[type].label} sparad${type === "tank" ? ". Din sambo ser den direkt." : ""}`);
  if (!existing && S.view !== "oversikt" && S.view !== "logg") setView("logg");
}

function openEntry(id, { fromCat = null } = {}) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  const c = S.cars.find((x) => x.id === e.carId) || car();
  const rows = [
    ["Datum", fmtDate(e.date)],
    ["Loggad av", whoName(e.createdBy)],
    e.odometer != null ? ["Mätarställning", `${fmt(e.odometer)} mil`] : null,
    e.amount != null ? ["Belopp", `${fmt(e.amount, e.amount % 1 ? 2 : 0)} kr`] : null,
    e.liters != null ? ["Mängd", `${fmt(e.liters, 2)} ${/kWh/.test(e.fuel || "") ? "kWh" : "l"} ${e.fuel || ""}`] : null,
    e.pricePerL != null ? ["Pris", `${fmt(e.pricePerL, 2)} kr per enhet`] : null,
    e.type === "tank" ? ["Fulltankad", e.full ? "Ja" : "Nej"] : null,
    e.station ? ["Station", e.station] : null,
    e.place ? ["Plats", e.place] : null,
    e.type === "parkering" && e.fine ? ["Typ", "P-bot eller felparkeringsavgift"] : null,
    e.workshop ? ["Verkstad", e.workshop] : null,
    e.category && e.type === "kostnad" ? ["Typ", e.category] : null,
    e.depth != null ? ["Mönsterdjup", `${fmt(e.depth, 1)} mm`] : null,
    itemNames(e, c).length ? ["Gjordes", itemNames(e, c).join(", ")] : null,
    e.parts?.length ? ["Annat", e.parts.join(", ")] : null,
    e.note ? ["Anteckning", e.note] : null,
  ].filter(Boolean);
  openSheet(entryTitle(e), `
    <dl class="detail-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${e.photoId ? `<div id="photo-box" style="margin-top:14px"><p class="hint">Hämtar bilden …</p></div>` : ""}
    <div class="btn-row" style="margin-top:18px">
      <button class="btn" type="button" data-act="edit-entry" data-id="${esc(e.id)}">Ändra</button>
      <button class="btn danger" type="button" data-act="delete-entry" data-id="${esc(e.id)}">Ta bort</button>
    </div>`, fromCat ? { back: "open-cat", backId: fromCat } : {});
  if (e.photoId) {
    getDoc(ref("photos", e.photoId)).then((s) => {
      const box = $("#photo-box");
      if (!box) return;
      box.innerHTML = s.exists() ? `<img class="photo" src="${esc(s.data().data)}" alt="Bifogad bild för ${esc(entryTitle(e))}">` : `<p class="hint">Bilden finns inte längre.</p>`;
    }).catch(() => { const box = $("#photo-box"); if (box) box.innerHTML = `<p class="hint">Bilden gick inte att hämta just nu.</p>`; });
  }
}

function itemsSheet() {
  const c = car();
  openSheet("Underhåll", `
    <form class="form" data-form="items" novalidate>
      <p class="hint">Fyll i när det gjordes senast om det inte finns i loggen. När ni loggar en service med punkten ikryssad räknas den om automatiskt.</p>
      <div class="form" id="item-rows">${(c.items || []).map(itemRowHtml).join("")}</div>
      <button class="btn ghost block" type="button" data-act="add-item-row">Lägg till punkt</button>
      <button class="btn primary block" type="submit">Spara</button>
      <button class="link" type="button" data-act="reset-items" style="align-self:center">Återställ standardpunkter för ${esc(`${c.make} ${c.model}`)}</button>
    </form>`);
}

function itemRowHtml(i) {
  return `<div class="item-row" data-item="${esc(i.id)}">
    <label class="field"><span>Namn</span><input name="name" value="${esc(i.name)}" required></label>
    <div class="row2">
      <label class="field"><span>Var … mil</span><input name="mil" inputmode="numeric" value="${i.mil ?? ""}" placeholder="–"></label>
      <label class="field"><span>eller var … månad</span><input name="months" inputmode="numeric" value="${i.months ?? ""}" placeholder="–"></label>
    </div>
    <div class="row2">
      <label class="field"><span>Senast gjort</span><input name="baseDate" type="date" value="${esc(i.baseDate || "")}"></label>
      <label class="field"><span>vid (mil)</span><input name="baseMil" inputmode="numeric" value="${i.baseMil ?? ""}"></label>
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

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode;
  else delete root.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const isDarkMeta = /dark/.test(m.media);
    m.content = mode === "dark" ? "#171514" : mode === "light" ? "#E9E4DF" : isDarkMeta ? "#171514" : "#E9E4DF";
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
        clean({ kind: "sommar", brand: str("s_brand") || null, size: str("s_size") || null, year: str("s_year") || null, depth: num(fd.get("s_depth")) }),
        clean({ kind: "vinter", brand: str("w_brand") || null, size: str("w_size") || null, year: str("w_year") || null, depth: num(fd.get("w_depth")), studded: fd.get("w_studded") === "on" }),
      ],
    });
  }
  if (has("specsText")) data.specsText = String(fd.get("specsText") ?? "");
  return data;
}

/* ----------------------------------------------------------------- actions */

function setView(v) {
  S.view = v;
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
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
  async login() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
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
  async logout() {
    cleanup();
    await signOut(auth);
  },
  "close-sheet": closeSheet,
  "new-entry"(el) {
    const t = el.dataset.type;
    if (t && TYPE[t]) entryForm(t);
    else typePicker();
  },
  "open-entry"(el) { openEntry(el.dataset.id, { fromCat: el.dataset.cat || null }); },
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
    addToCalendar({
      uid: `${c.id}-${x.key}-${ymd(x.date)}`,
      title: `${x.calTitle}: ${carName(c)}`,
      date: x.date,
      location: x.place,
      // Platsen står redan som plats i kalendern, så den behövs inte i beskrivningen också.
      description: [x.place ? x.sub.replace(` · ${x.place}`, "") : x.sub, c.plate ? `Reg.nr ${c.plate}` : null, "Inlagd från Bildagboken"].filter(Boolean).join("\n"),
      alarm: "-P6DT15H",
      fileName: `${x.title} ${ymd(x.date)}`,
    });
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
    set("bk-place", el.dataset.name);
    set("bk-addr", el.dataset.addr);
    set("bk-lat", el.dataset.lat);
    set("bk-lon", el.dataset.lon);
    const show = $("#bk-addr-show");
    if (show) show.textContent = el.dataset.addr || "Adressen saknas för den här platsen.";
    const box = $("#bk-suggest");
    if (box) box.hidden = true;
    $("#bk-place")?.setAttribute("aria-expanded", "false");
  },
  "geo-pick"(el) {
    const input = document.getElementById(el.dataset.target);
    if (input) { input.value = el.dataset.v; input.dispatchEvent(new Event("input", { bubbles: true })); }
    const picks = document.getElementById(el.dataset.target + "-picks");
    if (picks) picks.hidden = true;
  },
  "toggle-koll"() { S.kollAll = !S.kollAll; render(); },
  "hide-maint-hint"(el) { pref.set("maintHintHidden." + S.carId, el.dataset.n); render(); },
  "book-inspection"() { bookingForm({ kind: "besiktning" }); },
  async "deadline-remove"(el) {
    const key = el.dataset.id;
    const fields = { besiktning: { besiktning: null }, forsakring: { forsakringDatum: null }, skatt: { skattManad: "av" } }[key];
    if (!fields) return;
    const name = { besiktning: "sista dagen för besiktning", forsakring: "datumet för försäkringen", skatt: "månaden för skatten" }[key];
    const ok = await confirmDialog({ title: `Ta bort ${name}?`, lines: ["Påminnelsen försvinner för er båda. Du kan lägga in det igen under Ändra datum."], warn: "" });
    if (!ok) return;
    updateDoc(ref("cars", S.carId), fields).catch(onWriteError);
    closeSheet();
    showToast("Datumet är borttaget");
  },
  "service-calendar"(el) {
    const c = car();
    const ps = (el?.dataset.id && allItemStatus(c).find((x) => x.item.id === el.dataset.id)) || primaryService(c);
    const est = serviceDueEstimate(ps, c);
    if (!est) return showToast("Det går inte att räkna ut när servicen behövs än.");
    const due = [ps.item.mil && ps.lastMil != null ? `vid ${fmt(ps.lastMil + ps.item.mil)} mil` : "", ps.dueDate ? `senast ${fmtDate(ps.dueDate)}` : ""].filter(Boolean).join(" eller ");
    addToCalendar({
      uid: `${c.id}-service-${ps.item.id}-${ps.lastDate || "x"}`,
      title: `Dags för ${ps.item.name.toLowerCase()}: ${carName(c)}`,
      date: est.date,
      description: [
        due ? `Nästa ${due}.` : null,
        est.by === "mil" ? "Datumet är uppskattat utifrån hur mycket ni brukar köra." : null,
        c.plate ? `Reg.nr ${c.plate}` : null,
        "Inlagd från Bildagboken",
      ].filter(Boolean).join("\n"),
      alarm: "-P6DT15H",
      fileName: `Service ${ymd(est.date)}`,
    });
  },
  "open-cat"(el) {
    const cat = el.dataset.id;
    const since = addMonths(today0(), -12);
    const list = carEntries().filter((e) => e.amount > 0 && parseDate(e.date) >= since && catOf(e) === cat);
    const sum = list.reduce((s, e) => s + e.amount, 0);
    openSheet(cat, `
      <p class="muted" style="margin-bottom:10px">Senaste 12 månaderna · ${list.length} st · <b>${fmt(sum)} kr</b></p>
      <div class="rows">${list.map((e) => entryRow(e, cat)).join("") || `<p class="muted">Inget här.</p>`}</div>`);
  },
  "goto-maintenance"() {
    setView("bilen");
    document.getElementById("underhall")?.scrollIntoView({ block: "start" });
  },
  "open-booking"(el) {
    const b = (car()?.bookings || []).find((x) => x.id === el.dataset.id);
    if (b) bookingForm(b);
  },
  "booking-done"(el) {
    const c = car();
    const b = (c.bookings || []).find((x) => x.id === el.dataset.id);
    if (!b) return closeSheet();
    const note = b.note || null;
    const date = b.date <= todayStr() ? b.date : todayStr();
    switch (b.kind) {
      case "service":
      case "reparation":
        return entryForm("service", { date, workshop: b.place, note, title: b.kind === "reparation" ? "Reparation" : null }, { bookingId: b.id });
      case "dack":
        return entryForm("dack", { date, note: [b.place, note].filter(Boolean).join(" · ") || null }, { bookingId: b.id });
      case "besiktning":
        return entryForm("kostnad", { date, category: "Besiktning", title: b.place ? `Besiktning hos ${b.place}` : "Besiktning", note }, { bookingId: b.id });
      default:
        removeBooking(c.id, b.id);
        closeSheet();
        showToast("Bokningen är borttagen");
    }
  },
  async "delete-booking"(el) {
    const b = (car()?.bookings || []).find((x) => x.id === el.dataset.id);
    if (!b) return closeSheet();
    const ok = await confirmDialog({
      title: "Ta bort bokningen?",
      lines: [`${BOOK_KINDS[b.kind] || "Bokning"} · ${bookingWhen(b)}`, b.place],
    });
    if (!ok) return;
    removeBooking(S.carId, b.id);
    closeSheet();
    showToast("Bokningen är borttagen");
  },
  "edit-entry"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (e) entryForm(e.type, e);
  },
  async "delete-entry"(el) {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (!e) return closeSheet();
    const detail = entryDetail(e);
    const ok = await confirmDialog({
      title: `Ta bort ${TYPE_DEFINITE[e.type] || "posten"}?`,
      lines: [
        [fmtDate(e.date), e.amount != null ? `${fmt(e.amount)} kr` : null, `loggad av ${whoName(e.createdBy).replace(/^Du$/, "dig")}`].filter(Boolean).join(" · "),
        e.type === "eget" || e.type === "kostnad" ? entryTitle(e) : detail,
      ],
    });
    if (!ok) return;
    deleteDoc(ref("entries", e.id)).catch(onWriteError);
    if (e.photoId) deleteDoc(ref("photos", e.photoId)).catch(() => {});
    closeSheet();
    showToast("Borttaget");
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
  "edit-items"() { itemsSheet(); },
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
        `Bilen${n ? ` och hela dess logg (${n} ${n === 1 ? "post" : "poster"})` : ""} tas bort för er båda.`,
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
  theme(el) {
    const v = el.dataset.v;
    pref.set("theme", v);
    applyTheme(v);
    el.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
  },
  async "copy-invite"() {
    const link = `${location.origin}${location.pathname}?join=${S.house.inviteCode}`;
    const ok = await copyText(`Gå med i vår bildagbok: ${link}\nKod: ${S.house.inviteCode}`);
    showToast(ok ? "Inbjudan kopierad. Skicka den till din sambo." : `Koden är ${S.house.inviteCode}. Länk: ${link}`, ok ? 3500 : 9000);
  },
  "ask-claude"() {
    const text = claudePrompt(car());
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
  "dismiss-install"() { pref.set("installDismissed", "1"); render(); },
};

function authError(e) {
  const map = {
    "auth/network-request-failed": "Ingen kontakt med nätet. Försök igen.",
    "auth/unauthorized-domain": "Den här adressen är inte godkänd för inloggning i Firebase.",
    "auth/popup-closed-by-user": "Inloggningen avbröts.",
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
    if (kind === "rename") {
      const fd = new FormData(form);
      const name = String(fd.get("name") || "").trim();
      const house = String(fd.get("house") || "").trim();
      if (!name || !house) return showToast("Fyll i både hushållets namn och ditt namn.");
      updateDoc(doc(db, "households", S.hid), { name: house, [`memberInfo.${uid()}.name`]: name }).catch(onWriteError);
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
  await setDoc(doc(db, "invites", code), { householdId: hRef.id, createdBy: uid(), createdAt: serverTimestamp() });
  subscribe(hRef.id);
}

// Skapar en ny inbjudningskod och tar bort den gamla, så att den inte går att använda längre.
async function rotateInviteCode() {
  const old = S.house?.inviteCode;
  const code = randomId(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  await setDoc(doc(db, "invites", code), { householdId: S.hid, createdBy: uid(), createdAt: serverTimestamp() });
  await updateDoc(doc(db, "households", S.hid), { inviteCode: code });
  S.house = { ...S.house, inviteCode: code };
  if (old) deleteDoc(doc(db, "invites", old)).catch(() => {});
  render();
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
  await updateDoc(doc(db, "households", hid), {
    members: arrayUnion(uid()),
    [`memberInfo.${uid()}`]: { name, email: S.user.email || null, lastSeen: serverTimestamp() },
    joinedWith: code,
  });
  history.replaceState(null, "", location.pathname + "#oversikt");
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

async function saveCarEdit(form) {
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
  closeSheet();
  showToast("Bilen är uppdaterad");
}

function saveItems(form) {
  const rows = [...form.querySelectorAll(".item-row")];
  const items = rows.map((r) => {
    const g = (n) => r.querySelector(`[name="${n}"]`)?.value.trim() ?? "";
    return clean({
      id: r.dataset.item,
      name: g("name"),
      mil: num(g("mil")),
      months: num(g("months")),
      baseDate: g("baseDate") || null,
      baseMil: num(g("baseMil")),
    });
  }).filter((i) => i.name);
  updateDoc(ref("cars", S.carId), { items }).catch(onWriteError);
  closeSheet();
  showToast("Underhållet är sparat");
}

/* ---------------------------------------------------------- input helpers */

function onInput(ev) {
  if (ev.target.id === "bk-place") {
    ["bk-addr", "bk-lat", "bk-lon"].forEach((id) => { const x = document.getElementById(id); if (x) x.value = ""; });
    const show = $("#bk-addr-show");
    if (show) show.textContent = "Välj ett förslag så kommer adressen med, och kartan fungerar i kalendern.";
    placeSearchSoon(ev.target);
  }
  if (ev.target.id === "ef-category") {
    const box = $("#ef-next-besikt");
    if (box) box.hidden = ev.target.value !== "Besiktning";
  }
  // Föreslå nästa besiktning så länge man inte själv har ändrat datumet.
  if (ev.target.id === "ef-nextBesiktning") ev.target.dataset.manual = "1";
  if ((ev.target.id === "ef-category" || ev.target.id === "ef-date") && $("#ef-nextBesiktning")) {
    const next = $("#ef-nextBesiktning");
    if (next.dataset.manual !== "1" && $("#ef-category")?.value === "Besiktning") next.value = nextInspectionDate($("#ef-date")?.value || todayStr(), car());
  }
  if (ev.target.id === "cf-tiresOn") {
    // Flytta "sitter på" till den däcksats som väljs.
    document.querySelectorAll(".tire-head").forEach((h) => { h.querySelector(".tire-on").hidden = h.dataset.tire !== ev.target.value; });
    return;
  }
  if (ev.target.id === "fuel-range") {
    // Visa nivån direkt medan man drar; den sparas när man släpper (change).
    const l = Number(ev.target.value);
    S.fuelDraft = { carId: S.carId, level: l };
    ev.target.classList.remove("unset");
    const now = $("#fuel-now");
    if (now) { now.className = `fuel-now ${fuelClass(l)}`; now.innerHTML = fuelNowHtml(l); }
    ev.target.setAttribute("aria-valuetext", fuelText(l));
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
  if (ev.target.id === "car-switch") {
    S.carId = ev.target.value;
    pref.set("car", S.carId);
    render();
  }
  if (ev.target.id === "fuel-range") {
    const l = Number(ev.target.value);
    updateDoc(ref("cars", S.carId), { fuelLevel: { level: l, by: uid(), at: serverTimestamp(), via: "manual" } }).catch(onWriteError);
    S.fuelDraft = null;
    const meta = $("#fuel-meta");
    if (meta) meta.textContent = "Uppdaterad av dig · nyss";
    return;
  }
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
function showToast(text, ms = 3500) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function notify(text, tag) {
  if (document.visibilityState === "visible") {
    showToast(text, 5000);
  } else if ("Notification" in window && Notification.permission === "granted" && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification("Bildagboken", { body: text, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag })).catch(() => {});
  }
}
function announce(e) { notify(activityText(e), e.id); }

// När någon annan sätter bränslet lågt får de andra en avisering.
const fuelSeen = {};
function checkFuelChanges(cars, first) {
  for (const c of cars) {
    const f = c.fuelLevel;
    if (!f || typeof f.level !== "number") continue;
    const at = tsMs(f.at);
    const prev = fuelSeen[c.id];
    fuelSeen[c.id] = at;
    if (first || !prev || at <= prev || f.by === uid()) continue;
    if (f.level <= 2) notify(`${memberName(f.by)}: bränslet i ${carName(c)} är på ${fuelText(f.level).toLowerCase()}. Tanka snart.`, `fuel-${c.id}`);
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
    render();
  }, onListenError));

  S.unsubs.push(onSnapshot(collection(db, "households", hid, "cars"), (s) => {
    S.cars = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
      .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
    if (!S.cars.find((c) => c.id === S.carId)) {
      const saved = pref.get("car");
      S.carId = S.cars.find((c) => c.id === saved)?.id || S.cars[0]?.id || null;
    }
    checkFuelChanges(S.cars, !S.loaded.cars);
    S.loaded.cars = true;
    render();
  }, onListenError));

  let first = true;
  S.unsubs.push(onSnapshot(query(collection(db, "households", hid, "entries"), orderBy("date", "desc")), (s) => {
    S.entries = sortEntries(s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })));
    if (!first) {
      for (const ch of s.docChanges()) {
        if (ch.type !== "added" || ch.doc.metadata.hasPendingWrites) continue;
        const e = { id: ch.doc.id, ...ch.doc.data({ serverTimestamps: "estimate" }) };
        if (e.createdBy !== uid()) announce(e);
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

document.addEventListener("click", (ev) => {
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
  if (ev.key !== "Escape") return;
  if (!$("#confirm").hidden) return closeConfirm(false);
  if (!sheet.hidden) closeSheet();
});
window.addEventListener("offline", () => showToast("Ingen kontakt med nätet. Det du sparar laddas upp när nätet är tillbaka.", 6000));
window.addEventListener("online", () => showToast("Nätet är tillbaka"));
window.addEventListener("hashchange", () => {
  const v = location.hash.slice(1);
  if (v && v !== S.view) { S.view = v; render(); }
});

applyTheme(pref.get("theme") || "auto");
const initial = location.hash.slice(1);
if (initial) S.view = initial;

getRedirectResult(auth).catch((e) => renderLogin(authError(e)));
onAuthStateChanged(auth, (user) => {
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
