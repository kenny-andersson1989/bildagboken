// Pushnotiser för Bildagboken.
// 1) Varje morgon kl 08: påminnelser om bokade tider, besiktning, försäkring, dokument, skatt och däckbyte.
// 2) När någon loggar något: en notis till de andra i hushållet.
// 3) En resa i körjournalen som inte har avslutats efter fyra timmar.
// 4) Läsning med AI av servicefakturor, besiktningsprotokoll och kvitton (Plus).
// Telefonernas adresser för notiser sparas av appen i households/{hid}/tokens/{token}.
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const AnthropicSdk = require("@anthropic-ai/sdk");
const Anthropic = AnthropicSdk.default || AnthropicSdk;
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 2 });
const db = admin.firestore();

const TZ = "Europe/Stockholm";
const MONTHS = {
  sv: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};
const BOOK_KINDS = {
  sv: { service: "Service", reparation: "Reparation", besiktning: "Besiktning", dack: "Däckbyte", annat: "Bokad tid" },
  en: { service: "Service", reparation: "Repair", besiktning: "Inspection", dack: "Tyre change", annat: "Booking" },
};
const TAX_MONTH_BY_DIGIT = { 0: 3, 1: 4, 2: 5, 3: 6, 4: 8, 5: 10, 6: 11, 7: 12, 8: 1, 9: 2 };

// Dagens datum i Sverige som "2026-11-12".
function todayStr() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const parse = (s) => { const [y, m, d] = String(s).split("-").map(Number); return Date.UTC(y, (m || 1) - 1, d || 1); };
const daysBetween = (from, to) => Math.round((parse(to) - parse(from)) / 864e5);
const shortDate = (s, lang) => { const [, m, d] = String(s).split("-").map(Number); return `${d} ${MONTHS[lang][m - 1]}`; };
const carName = (c) => [c.make, c.model].filter(Boolean).join(" ") || "Bilen";

// Alla påminnelser för en bil i dag, på svenska och engelska.
function reminders(c, today) {
  const out = [];
  const add = (tag, sv, en) => out.push({ tag, sv, en });
  const name = carName(c);
  for (const b of c.bookings || []) {
    const d = daysBetween(today, b.date);
    if (d !== 0 && d !== 1) continue;
    const time = b.time ? ` kl ${b.time}` : "";
    const timeEn = b.time ? ` at ${b.time}` : "";
    const place = b.place ? ` · ${b.place}` : "";
    add(`booking-${b.id}-${d}`,
      { title: d === 0 ? "I dag" : "I morgon", body: `${BOOK_KINDS.sv[b.kind] || "Bokad tid"}${time}${place}` },
      { title: d === 0 ? "Today" : "Tomorrow", body: `${BOOK_KINDS.en[b.kind] || "Booking"}${timeEn}${place}` });
  }
  if (c.besiktning) {
    const d = daysBetween(today, c.besiktning);
    const booked = (c.bookings || []).some((b) => b.kind === "besiktning" && b.date >= today && b.date <= c.besiktning);
    if (!booked && [30, 7, 1].includes(d)) {
      add(`besiktning-${d}`,
        { title: `Besiktning om ${d === 1 ? "1 dag" : `${d} dagar`}`, body: `${name} ska vara besiktigad senast ${shortDate(c.besiktning, "sv")}.` },
        { title: `Inspection in ${d === 1 ? "1 day" : `${d} days`}`, body: `${name} must be inspected by ${shortDate(c.besiktning, "en")}.` });
    }
  }
  if (c.efterkontroll?.by) {
    const d = daysBetween(today, c.efterkontroll.by);
    if ([7, 1].includes(d)) {
      add(`efterkontroll-${d}`,
        { title: `Efterkontroll om ${d === 1 ? "1 dag" : `${d} dagar`}`, body: `${name} ska efterkontrolleras senast ${shortDate(c.efterkontroll.by, "sv")}.` },
        { title: `Re-inspection in ${d === 1 ? "1 day" : `${d} days`}`, body: `${name} must be re-inspected by ${shortDate(c.efterkontroll.by, "en")}.` });
    }
  }
  if (c.forsakringDatum && daysBetween(today, c.forsakringDatum) === 14) {
    add("forsakring",
      { title: "Försäkringen förnyas om 14 dagar", body: `Bra tillfälle att jämföra priser för ${name}.` },
      { title: "Insurance renews in 14 days", body: `A good time to compare prices for ${name}.` });
  }
  for (const doc of c.docs || []) {
    if (!doc.validTo) continue;
    const d = daysBetween(today, doc.validTo);
    if (d === 30 || d === 7) {
      add(`doc-${doc.id}-${d}`,
        { title: `${doc.title || "Ett dokument"} går ut om ${d} dagar`, body: `Gäller till ${shortDate(doc.validTo, "sv")}.` },
        { title: `${doc.title || "A document"} expires in ${d} days`, body: `Valid until ${shortDate(doc.validTo, "en")}.` });
    }
  }
  const [, month, day] = today.split("-").map(Number);
  const digits = String(c.plate || "").replace(/[^0-9]/g, "");
  const taxMonth = c.skattManad === "av" ? null : Number(c.skattManad) || (digits ? TAX_MONTH_BY_DIGIT[digits[digits.length - 1]] : null);
  if (taxMonth && day === 1) {
    const months = c.skattBelopp > 3600 ? [taxMonth, ((taxMonth + 3) % 12) + 1, ((taxMonth + 7) % 12) + 1] : [taxMonth];
    if (months.includes(month)) {
      add("skatt",
        { title: "Fordonsskatt", body: `Skatten för ${name} ska betalas i ${MONTHS.sv[month - 1]}.` },
        { title: "Vehicle tax", body: `The tax for ${name} is due in ${MONTHS.en[month - 1]}.` });
    }
  }
  const on = c.tiresOn || "sommar";
  if (on === "sommar" && month === 11 && day === 24) {
    add("dack-vinter",
      { title: "Dags för vinterdäck", body: `Vinterdäcken ska vara på senast 1 december.` },
      { title: "Time for winter tyres", body: `Winter tyres must be on by 1 December.` });
  }
  const studded = (c.tires || []).some((t) => t.kind === "vinter" && t.studded);
  if (on === "vinter" && studded && month === 4 && day === 8) {
    add("dack-dubb",
      { title: "Dubbdäcken ska av", body: `Senast 15 april.` },
      { title: "Studded tyres off", body: `By 15 April.` });
  }
  return out.map((r) => ({ ...r, car: name }));
}

// Skickar till telefonerna och tar bort adresser som inte längre fungerar.
async function send(hid, tokenDocs, msg) {
  if (!tokenDocs.length) return;
  const byLang = { sv: [], en: [] };
  for (const t of tokenDocs) byLang[t.lang === "en" ? "en" : "sv"].push(t);
  for (const lang of ["sv", "en"]) {
    const list = byLang[lang];
    if (!list.length) continue;
    const text = msg[lang];
    const res = await admin.messaging().sendEachForMulticast({
      tokens: list.map((t) => t.token),
      data: { title: text.title, body: text.body, tag: msg.tag || "", url: msg.url || "./#oversikt" },
      webpush: { headers: { Urgency: "high", TTL: "43200" } },
      // Android-appen: Android visar notisen själv.
      android: { priority: "high", ttl: 43200000, notification: { title: text.title, body: text.body, color: "#E8711F", icon: "ic_stat_notify", ...(msg.tag ? { tag: msg.tag } : {}) } },
      // iPhone-appen: iOS visar notisen själv. Webbens adresser bryr sig inte om den här delen.
      apns: { headers: { "apns-priority": "10" }, payload: { aps: { alert: { title: text.title, body: text.body }, sound: "default", "thread-id": msg.tag || "bildagboken" } } },
    });
    await Promise.all(res.responses.map((r, i) => {
      const code = r.error?.code || "";
      if (r.success || !/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) return null;
      return db.doc(`households/${hid}/tokens/${list[i].id}`).delete().catch(() => null);
    }));
  }
}

// kind: "bookings", "dates" eller "activity". Enheter som har stängt av den sortens notiser hoppas över.
async function tokensOf(hid, kind) {
  const qs = await db.collection(`households/${hid}/tokens`).get();
  return qs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.token && (!kind || t.prefs?.[kind] !== false));
}

exports.morgonpaminnelser = onSchedule({ schedule: "every day 08:00", timeZone: TZ }, async () => {
  const today = todayStr();
  const houses = await db.collection("households").get();
  let sent = 0;
  for (const h of houses.docs) {
    const all = await tokensOf(h.id);
    if (!all.length) continue;
    const byKind = { bookings: all.filter((t) => t.prefs?.bookings !== false), dates: all.filter((t) => t.prefs?.dates !== false) };
    const cars = await db.collection(`households/${h.id}/cars`).get();
    const several = cars.size > 1;
    for (const c of cars.docs) {
      for (const r of reminders(c.data(), today)) {
        // Med flera bilar står bilens namn först i rubriken.
        const msg = { tag: `${c.id}-${r.tag}`, url: "./#oversikt",
          sv: { title: several ? `${r.car}: ${r.sv.title}` : r.sv.title, body: r.sv.body },
          en: { title: several ? `${r.car}: ${r.en.title}` : r.en.title, body: r.en.body } };
        await send(h.id, byKind[r.tag.startsWith("booking-") ? "bookings" : "dates"], msg);
        sent++;
      }
    }
  }
  logger.info(`Påminnelser skickade: ${sent}`);
});

const LOGGED = {
  sv: { tank: "loggade en tankning", matare: "uppdaterade mätarställningen", service: "loggade en service", eget: "loggade ett eget jobb", dack: "loggade något om däcken", tvatt: "loggade en tvätt", parkering: "loggade en parkering", kostnad: "loggade en kostnad" },
  en: { tank: "logged a fill-up", matare: "updated the odometer", service: "logged a service", eget: "logged an own job", dack: "logged something about the tyres", tvatt: "logged a car wash", parkering: "logged parking", kostnad: "logged a cost" },
};

exports.nyLogg = onDocumentCreated("households/{hid}/entries/{eid}", async (event) => {
  const e = event.data?.data();
  if (!e || !e.createdBy) return;
  // Gamla poster som läggs in i efterhand skickar ingen notis.
  if (e.date && daysBetween(e.date, todayStr()) > 2) return;
  const hid = event.params.hid;
  const tokens = (await tokensOf(hid, "activity")).filter((t) => t.uid !== e.createdBy);
  if (!tokens.length) return;
  const house = (await db.doc(`households/${hid}`).get()).data() || {};
  const who = house.memberInfo?.[e.createdBy]?.name || "Någon";
  const amount = e.amount != null ? ` · ${Math.round(e.amount)} kr` : "";
  const odo = e.type === "matare" && e.odometer != null ? ` · ${e.odometer} mil` : "";
  await send(hid, tokens, {
    tag: `entry-${event.params.eid}`, url: "./#aviseringar",
    sv: { title: "Bildagboken", body: `${who} ${LOGGED.sv[e.type] || "loggade något"}${amount}${odo}` },
    en: { title: "Bildagboken", body: `${who === "Någon" ? "Someone" : who} ${LOGGED.en[e.type] || "logged something"}${amount}${odo}` },
  });
});

// 3) Körjournalen: en resa som har pågått i fyra timmar utan att avslutas. Påminnelse en gång, till föraren.
exports.glomdResa = onSchedule({ schedule: "every 60 minutes", timeZone: TZ }, async () => {
  const limit = Date.now() - 4 * 36e5;
  const houses = await db.collection("households").get();
  let sent = 0;
  for (const h of houses.docs) {
    const open = await db.collection(`households/${h.id}/trips`).where("odoEnd", "==", null).get();
    for (const d of open.docs) {
      const t = d.data();
      if (t.remindedAt || !t.startedAt || t.startedAt > limit) continue;
      await d.ref.update({ remindedAt: Date.now() });
      const who = t.driver || t.createdBy;
      const tokens = (await tokensOf(h.id)).filter((x) => x.uid === who);
      const to = t.to ? ` mot ${t.to}` : "";
      await send(h.id, tokens, {
        tag: `trip-${d.id}`, url: "./#bilen",
        sv: { title: "Glömde du avsluta resan?", body: `Resan${to} startade för mer än fyra timmar sedan. Fyll i mätarställningen.` },
        en: { title: "Did you forget to finish the trip?", body: `The trip${t.to ? ` to ${t.to}` : ""} started more than four hours ago. Fill in the odometer.` },
      });
      sent++;
    }
  }
  if (sent) logger.info(`Påminnelser om resor: ${sent}`);
});

// 4) AI (Plus): läser ett foto av en servicefaktura, ett besiktningsprotokoll eller ett kvitto och fyller i formuläret.
// Nyckeln sparas som hemlighet: firebase functions:secrets:set ANTHROPIC_API_KEY. Den når aldrig appen.
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ADMIN_UID = "mjQJQzsMCpVURkuVSyK5ctKVhG23";
const AI_MONTHLY_LIMIT = 60;   // läsningar av dokument per hushåll och månad
const CHAT_MONTHLY_LIMIT = 30; // frågor till Glenn per person och månad
// Claude Haiku 5.5: billig nog att Plus alltid täcker kostnaden, även för den som använder allt varje månad.
const AI_MODEL = "claude-haiku-5-5";

const DOC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["docType", "date", "amount", "odometerMil", "place", "work", "inspectionResult", "defects", "recheckBy", "nextInspection", "note"],
  properties: {
    docType: { type: "string", enum: ["service", "besiktning", "tankning", "kvitto", "annat"] },
    date: { type: ["string", "null"], description: "Datum på dokumentet, YYYY-MM-DD" },
    amount: { type: ["number", "null"], description: "Totalt att betala i kronor inklusive moms" },
    odometerMil: { type: ["number", "null"], description: "Mätarställning i svenska mil (1 mil = 10 km). Står den i km, dela med 10." },
    place: { type: ["string", "null"], description: "Verkstad, station, besiktningsföretag eller butik" },
    work: {
      type: "array",
      description: "Det som gjordes på bilen, en rad per del eller åtgärd, med vanliga svenska namn (till exempel Motorolja och oljefilter, Bromsbelägg fram, Torkarblad)",
      items: {
        type: "object", additionalProperties: false, required: ["name", "action"],
        properties: { name: { type: "string" }, action: { type: "string", enum: ["bytt", "kontrollerat", "lagat", "justerat"] } },
      },
    },
    inspectionResult: { anyOf: [{ type: "string", enum: ["godkand", "anmarkning", "efterkontroll", "korforbud"] }, { type: "null" }], description: "Besiktningens resultat, eller null om det inte är ett besiktningsprotokoll" },
    defects: { type: "array", items: { type: "string" }, description: "Brister från besiktningen, en per rad" },
    recheckBy: { type: ["string", "null"], description: "Sista dag för efterkontroll, YYYY-MM-DD" },
    nextInspection: { type: ["string", "null"], description: "Nästa besiktning senast, YYYY-MM-DD" },
    note: { type: ["string", "null"], description: "Kort anteckning om något viktigt som inte passar i fälten, till exempel rekommenderade åtgärder" },
  },
};

exports.lasDokument = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB", maxInstances: 2 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Logga in först.");
  const { hid, image, mediaType = "image/jpeg", formType = "" } = req.data || {};
  if (typeof hid !== "string" || typeof image !== "string" || image.length > 8e6) throw new HttpsError("invalid-argument", "Bilden saknas eller är för stor.");
  if (!/^image\/(jpeg|png|webp)$/.test(mediaType)) throw new HttpsError("invalid-argument", "Fel bildformat.");
  const houseRef = db.doc(`households/${hid}`);
  const house = (await houseRef.get()).data();
  if (!house || !(house.members || []).includes(uid)) throw new HttpsError("permission-denied", "Du hör inte till hushållet.");
  const plus = (house.plus?.until?.toMillis?.() ?? house.plus?.until ?? 0) > Date.now();
  if (!plus && uid !== ADMIN_UID) throw new HttpsError("permission-denied", "Läsning med AI ingår i Bildagboken Plus.");

  // Tak per månad, så att ingen kan dra iväg kostnaden.
  const month = todayStr().slice(0, 7);
  const usageRef = db.doc(`households/${hid}/ai/${month}`);
  const used = await db.runTransaction(async (tx) => {
    const n = ((await tx.get(usageRef)).data()?.count || 0) + 1;
    if (n > AI_MONTHLY_LIMIT) return n;
    tx.set(usageRef, { count: n, updatedAt: Date.now() }, { merge: true });
    return n;
  });
  if (used > AI_MONTHLY_LIMIT) throw new HttpsError("resource-exhausted", `Ni har använt AI ${AI_MONTHLY_LIMIT} gånger den här månaden. Det fylls på nästa månad.`);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  let res;
  try {
    res = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: DOC_SCHEMA } },
    system: "Du läser av svenska dokument om bilar: servicefakturor, verkstadskvitton, besiktningsprotokoll och tankkvitton. Fyll bara i det som står i dokumentet. Gissa inte; använd null eller en tom lista när något saknas eller inte går att läsa. Svara på svenska.",
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
      { type: "text", text: `Läs av dokumentet.${formType ? ` Användaren fyller i ett formulär för: ${formType}.` : ""} Dagens datum är ${todayStr()}.` },
    ] }],
    });
  } catch (e) {
    logger.error("Claude svarade med fel", { status: e?.status, message: e?.message });
    if (e?.status === 401 || e?.status === 403) throw new HttpsError("failed-precondition", "AI-nyckeln fungerar inte.");
    if (e?.status === 429 || e?.status === 529) throw new HttpsError("unavailable", "AI-tjänsten är upptagen. Försök igen om en stund.");
    throw new HttpsError("internal", "Dokumentet gick inte att läsa.");
  }
  if (res.stop_reason === "refusal") throw new HttpsError("failed-precondition", "Dokumentet gick inte att läsa.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return { ok: true, doc: JSON.parse(text), left: AI_MONTHLY_LIMIT - used };
  } catch (e) {
    logger.warn("AI-svaret gick inte att tolka", text.slice(0, 200));
    throw new HttpsError("internal", "Dokumentet gick inte att läsa.");
  }
});

// För test: reminders() kan provas lokalt utan Firebase.
exports._reminders = reminders;

// Glenn kan fylla i en tankning. Appen visar den som ett kort med Spara och Ändra, och sparar som en vanlig tankning.
const TANK_TOOL = {
  name: "logga_tankning",
  description: "Fyller i en tankning åt användaren. Anropa bara när station, belopp och full tank är kända.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["station", "belopp_kr", "full_tank"],
    properties: {
      station: { type: "string", description: "Var användaren tankade, till exempel Circle K Mölndal" },
      belopp_kr: { type: "number", description: "Vad tankningen kostade totalt, i kronor" },
      full_tank: { type: "boolean", description: "Om användaren tankade fullt" },
      datum: { type: "string", description: "YYYY-MM-DD. Utelämna om det var i dag." },
      matarstallning_mil: { type: "number", description: "Mätarställning i svenska mil, bara om användaren sa den" },
    },
  },
};

// Fråga om bilen (Bildagboken Plus): svarar på frågor utifrån det hushållet har loggat om bilen.
// Appen skickar bilens uppgifter som text (med summor och snitt redan uträknade) och samtalet hittills.
const CHAT_SYSTEM = [
  "Du heter Glenn och är AI:n i appen Bildagboken. Du svarar på frågor om användarens bil.",
  "Du är en go och glad göteborgare: varm, positiv och lite skämtsam, med koll på bilar som en erfaren mekaniker.",
  "Skriv vanlig svenska med en lätt göteborgsk ton (till exempel Tjenare, go, gött, ba), och slå ibland till med en kort göteborgsvits, men inte i varje svar och aldrig när det gäller säkerhet eller pengar som är på väg att bli dyra.",
  "Bilens uppgifter, underhåll, kostnader, förbrukning, körjournal och hela loggen finns nedan. Utgå från dem.",
  "Summor, snitt och förbrukning är redan uträknade av appen. Använd de siffrorna i stället för att räkna själv, och hitta aldrig på siffror.",
  "Säg tydligt när något inte finns i loggen. Du får använda allmän kunskap om bilmodellen och bilskötsel, men säg då att det är allmänna råd och inte från loggen.",
  "Svara kort: oftast två till fyra meningar, om användaren inte ber om mer. Skriv i hela meningar, utan rubriker, listor, tabeller, fetstil eller tecken som * och #, eftersom svaret ofta läses upp.",
  "Svara på svenska, eller på engelska om användaren skriver på engelska (då som en glad göteborgare som pratar engelska).",
  "Du kan logga en tankning åt användaren med verktyget logga_tankning. Vill användaren logga en tankning: fråga först efter det som saknas, en sak i taget och kort: var hen tankade, vad det kostade totalt och om det var full tank. Mätarställning är frivillig, så fråga inte efter den, men ta med den om användaren säger den. Datum är i dag om användaren inte säger något annat. Anropa verktyget först när du vet station, belopp och full tank, och skriv samtidigt en kort mening om att du har fyllt i det. Användaren sparar själv med en knapp i appen.",
  "Du vet var användaren är just nu om appen har fått lov (se Just nu nedan). Med verktyget sok_i_narheten hittar du närmaste mack, laddstolpe, verkstad, däckverkstad, biltvätt eller parkering, och med verktyget vader får du vädret där användaren är eller på en ort. Säg grader och vind i hela tal, avstånd i kilometer med högst en decimal, och nämn gärna halka, snö eller hård vind när det spelar roll för bilen. Appen visar knappar med vägbeskrivning till ställena du hittar, så du behöver inte läsa upp hela adresser.",
    "Glenn syns som en liten figur i appen. Är svaret goda nyheter, beröm eller något som ser bra ut, avsluta med taggen [tumme]. Skämtar du eller säger något med glimten i ögat, avsluta med [blink]. Annars ingen tagg. Högst en tagg, och inte i varje svar.",
].join(" ");

exports.fragaBilen = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB", maxInstances: 3 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Logga in först.");
  const { hid, context, messages } = req.data || {};
  if (typeof hid !== "string" || typeof context !== "string" || context.length > 300000) throw new HttpsError("invalid-argument", "Bilens uppgifter saknas eller är för stora.");
  if (!Array.isArray(messages) || !messages.length || messages.length > 20) throw new HttpsError("invalid-argument", "Frågan saknas.");
  const msgs = messages.map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", content: String(m?.text || "").slice(0, 4000) }));
  if (msgs[msgs.length - 1].role !== "user" || !msgs[msgs.length - 1].content.trim()) throw new HttpsError("invalid-argument", "Frågan saknas.");
  const house = (await db.doc(`households/${hid}`).get()).data();
  if (!house || !(house.members || []).includes(uid)) throw new HttpsError("permission-denied", "Du hör inte till hushållet.");
  const plus = (house.plus?.until?.toMillis?.() ?? house.plus?.until ?? 0) > Date.now();
  if (!plus && uid !== ADMIN_UID) throw new HttpsError("permission-denied", "Fråga om bilen ingår i Bildagboken Plus.");

  const usageRef = db.doc(`households/${hid}/ai/${todayStr().slice(0, 7)}`);
  const used = await db.runTransaction(async (tx) => {
    // Gränsen gäller per person, så att ingen gör slut på de andras frågor. chat är hushållets summa.
    const d = (await tx.get(usageRef)).data() || {};
    const n = (d.chatBy?.[uid] || 0) + 1;
    if (n > CHAT_MONTHLY_LIMIT) return n;
    tx.set(usageRef, { chat: (d.chat || 0) + 1, chatBy: { [uid]: n }, updatedAt: Date.now() }, { merge: true });
    return n;
  });
  if (used > CHAT_MONTHLY_LIMIT) throw new HttpsError("resource-exhausted", `Du har ställt ${CHAT_MONTHLY_LIMIT} frågor den här månaden. Det fylls på nästa månad.`);

  // Var användaren är just nu (om appen fick lov), för vädret och för att hitta något i närheten.
  const h = req.data?.here;
  const here = h && Number.isFinite(h.lat) && Number.isFinite(h.lon) && Math.abs(h.lat) <= 90 && Math.abs(h.lon) <= 180
    ? { lat: h.lat, lon: h.lon, name: String(h.name || "").slice(0, 120) } : null;
  const now = new Date().toLocaleString("sv-SE", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const situation = `Just nu: ${now}. ${here ? `Användaren är just nu vid ${here.name || "en okänd adress"} (${here.lat.toFixed(4)}, ${here.lon.toFixed(4)}).` : "Användarens plats är okänd (appen har inte fått lov att använda platsen). Be användaren slå på platsen om det behövs."}`;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const convo = [...msgs];
  let res, action = null, places = null;
  try {
    // Glenn kan använda verktygen några gånger (till exempel väder och sedan en mack) innan han svarar.
    for (let round = 0; round < 4; round++) {
      res = await client.messages.create({
        model: AI_MODEL,
        max_tokens: 4000,
        output_config: { effort: "medium" },
        // Bilens uppgifter sparas tillfälligt hos Anthropic, så att följdfrågor i samma samtal kostar nästan inget.
        // Tid och plats ligger efter, eftersom de ändras.
        system: [{ type: "text", text: CHAT_SYSTEM }, { type: "text", text: context, cache_control: { type: "ephemeral" } }, { type: "text", text: situation }],
        tools: [TANK_TOOL, NEARBY_TOOL, WEATHER_TOOL],
        messages: convo,
      });
      if (res.stop_reason !== "tool_use") break;
      const results = [];
      for (const b of res.content.filter((x) => x.type === "tool_use")) {
        let out;
        try {
          if (b.name === "logga_tankning") { action = tankAction(b.input) || action; out = action ? "Kortet med tankningen visas nu för användaren, som sparar med en knapp." : "Uppgifterna räckte inte. Fråga efter det som saknas."; }
          else if (b.name === "sok_i_narheten") { const r = await nearby(b.input, here); if (r.places?.length) places = r.places.slice(0, 3); out = JSON.stringify(r); }
          else if (b.name === "vader") out = JSON.stringify(await weather(b.input, here));
          else out = "Okänt verktyg.";
        } catch (e) {
          logger.warn("Verktyget fungerade inte", { tool: b.name, message: e?.message });
          out = "Det gick inte att hämta just nu.";
        }
        results.push({ type: "tool_result", tool_use_id: b.id, content: String(out).slice(0, 8000) });
      }
      convo.push({ role: "assistant", content: res.content }, { role: "user", content: results });
    }
  } catch (e) {
    logger.error("Claude svarade med fel", { status: e?.status, message: e?.message });
    if (e?.status === 401 || e?.status === 403) throw new HttpsError("failed-precondition", "AI-nyckeln fungerar inte.");
    if (e?.status === 429 || e?.status === 529) throw new HttpsError("unavailable", "AI-tjänsten är upptagen. Försök igen om en stund.");
    throw new HttpsError("internal", "Frågan gick inte att besvara.");
  }
  if (res.stop_reason === "refusal") return { ok: true, answer: "Det kan jag tyvärr inte svara på. Fråga gärna något annat om bilen.", left: CHAT_MONTHLY_LIMIT - used };
  let answer = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!answer && action) answer = "Gött, jag har fyllt i tankningen. Tryck på Spara så är den loggad!";
  // Taggen styr Glenns figur i appen (tummen upp eller blinkning) och tas bort ur texten.
  const tag = answer.match(/\[(tumme|blink)\]/i);
  answer = answer.replace(/\s*\[(tumme|blink)\]\s*/gi, " ").trim();
  return { ok: true, answer: answer || "Jag hittade inget svar. Försök fråga på ett annat sätt.", mood: tag ? (tag[1].toLowerCase() === "tumme" ? "thumb" : "wink") : null, action, places, left: CHAT_MONTHLY_LIMIT - used };
});

// Tankningen som Glenn har fyllt i, kontrollerad innan den skickas till appen.
function tankAction(i = {}) {
  const amount = Number(i.belopp_kr);
  if (!i.station || !(amount > 0 && amount < 100000)) return null;
  return {
    type: "tank", station: String(i.station).slice(0, 80), amount: Math.round(amount * 100) / 100, full: i.full_tank !== false,
    date: /^\d{4}-\d{2}-\d{2}$/.test(i.datum || "") && i.datum <= todayStr() ? i.datum : todayStr(),
    odometer: Number(i.matarstallning_mil) > 0 ? Math.round(Number(i.matarstallning_mil)) : null,
  };
}

/* Närmaste mack, laddstolpe, verkstad med mera: OpenStreetMap (Overpass), fritt och utan nyckel.
   Bara koordinaterna skickas dit, inget om användaren. */
const NEARBY_KINDS = {
  bensin: "[amenity=fuel]", laddning: "[amenity=charging_station]", verkstad: "[shop=car_repair]",
  dack: "[shop=tyres]", biltvatt: "[amenity=car_wash]", parkering: "[amenity=parking]",
};
const NEARBY_TOOL = {
  name: "sok_i_narheten",
  description: "Söker ställen nära användarens plats just nu: bensinmackar, laddstolpar, bilverkstäder, däckverkstäder, biltvättar eller parkeringar. Ger namn, adress, avstånd och öppettider.",
  input_schema: {
    type: "object", additionalProperties: false, required: ["typ"],
    properties: {
      typ: { type: "string", enum: Object.keys(NEARBY_KINDS) },
      radie_km: { type: "number", description: "Hur långt bort att söka, 1 till 25 km. Standard 5." },
    },
  },
};
const distKm = (a, b) => {
  const R = 6371, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
async function nearby(input = {}, here) {
  if (!here) return { fel: "Användarens plats är okänd. Be hen tillåta platsen i appen." };
  const kind = NEARBY_KINDS[input.typ] ? input.typ : "bensin";
  const r = Math.round(Math.min(25, Math.max(1, Number(input.radie_km) || 5)) * 1000);
  const q = `[out:json][timeout:15];nwr(around:${r},${here.lat},${here.lon})${NEARBY_KINDS[kind]};out center tags 40;`;
  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Bildagboken/1.0" },
    body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error("overpass " + resp.status);
  const els = (await resp.json()).elements || [];
  const list = els.map((e) => {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) return null;
    const addr = [[t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), t["addr:city"]].filter(Boolean).join(", ");
    return { namn: t.name || t.brand || t.operator || null, kedja: t.brand || null, adress: addr || null, km: Math.round(distKm(here, { lat, lon }) * 10) / 10, oppet: t.opening_hours || null, lat, lon };
  }).filter((x) => x && (x.namn || kind === "parkering")).sort((a, b) => a.km - b.km).slice(0, 6);
  return { typ: kind, radie_km: r / 1000, antal: list.length, places: list.map((x) => ({ ...x, namn: x.namn || "Parkering" })) };
}

/* Vädret: Open-Meteo, fritt och utan nyckel. Där användaren är, eller på en ort som Glenn får som namn. */
const WEATHER_TOOL = {
  name: "vader",
  description: "Hämtar vädret just nu och de närmaste dagarna (temperatur, nederbörd, snö, vind och risk för halka). Utan plats gäller det där användaren är.",
  input_schema: {
    type: "object", additionalProperties: false,
    properties: {
      plats: { type: "string", description: "En ort, till exempel Stockholm. Utelämna för användarens plats." },
      dagar: { type: "integer", description: "Hur många dagar framåt, 1 till 4. Standard 2." },
    },
  },
};
const WMO = { 0: "klart", 1: "mest klart", 2: "halvklart", 3: "mulet", 45: "dimma", 48: "dimma med rimfrost", 51: "lätt duggregn", 53: "duggregn", 55: "kraftigt duggregn", 56: "underkylt duggregn", 57: "kraftigt underkylt duggregn", 61: "lätt regn", 63: "regn", 65: "kraftigt regn", 66: "underkylt regn", 67: "kraftigt underkylt regn", 71: "lätt snöfall", 73: "snöfall", 75: "kraftigt snöfall", 77: "snökorn", 80: "lätta regnskurar", 81: "regnskurar", 82: "kraftiga regnskurar", 85: "snöbyar", 86: "kraftiga snöbyar", 95: "åska", 96: "åska med hagel", 99: "kraftig åska med hagel" };
async function weather(input = {}, here) {
  let place = here, name = here?.name || "användarens plats";
  if (input.plats) {
    const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(input.plats).slice(0, 80))}&count=1&language=sv&format=json`, { signal: AbortSignal.timeout(8000) });
    const hit = g.ok ? (await g.json()).results?.[0] : null;
    if (!hit) return { fel: `Hittade ingen ort som heter ${input.plats}.` };
    place = { lat: hit.latitude, lon: hit.longitude }; name = [hit.name, hit.admin1].filter(Boolean).join(", ");
  }
  if (!place) return { fel: "Användarens plats är okänd. Be hen tillåta platsen i appen, eller nämna en ort." };
  const days = Math.min(4, Math.max(1, Number(input.dagar) || 2));
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_speed_10m_max&timezone=Europe%2FStockholm&forecast_days=${days}&wind_speed_unit=ms`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("open-meteo " + r.status);
  const w = await r.json();
  const c = w.current || {}, d = w.daily || {};
  // Grader och vind i heltal, så att Glenn säger "6 grader" och inte "6,3 grader".
  const r0 = (x) => (x == null ? null : Math.round(x));
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    plats: name,
    nu: { temp: r0(c.temperature_2m), kanns_som: r0(c.apparent_temperature), vader: WMO[c.weather_code] || null, nederbord_mm: r1(c.precipitation), vind_ms: r0(c.wind_speed_10m), byar_ms: r0(c.wind_gusts_10m) },
    dagar: (d.time || []).map((t, k) => ({
      datum: t, vader: WMO[d.weather_code?.[k]] || null, min: r0(d.temperature_2m_min?.[k]), max: r0(d.temperature_2m_max?.[k]),
      nederbord_mm: r1(d.precipitation_sum?.[k]), risk_nederbord_procent: d.precipitation_probability_max?.[k], sno_cm: r1(d.snowfall_sum?.[k]), vind_max_ms: r0(d.wind_speed_10m_max?.[k]),
      // Halka: minusgrader eller runt noll, samtidigt som det kommer nederbörd.
      risk_for_halka: (d.temperature_2m_min?.[k] ?? 9) <= 1 && ((d.precipitation_sum?.[k] ?? 0) > 0 || (d.snowfall_sum?.[k] ?? 0) > 0),
    })),
  };
}

// Glenns röst: Googles text-till-tal med en naturlig svensk mansröst. Kräver att Cloud Text-to-Speech API är
// påslaget i projektet (gcloud services enable texttospeech.googleapis.com). Tak per hushåll och månad i tecken.
const TTS_MONTHLY_CHARS = 20000;
let ttsVoice = null;
// Nyckeln till Googles tjänster sparas tills strax innan den går ut, så att varje uppläsning slipper hämta en ny.
let gToken = null, gTokenUntil = 0;
async function googleToken() {
  if (gToken && Date.now() < gTokenUntil) return gToken;
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error("token " + r.status);
  const j = await r.json();
  gToken = j.access_token;
  gTokenUntil = Date.now() + Math.max(0, (j.expires_in || 300) - 120) * 1000;
  return gToken;
}
// Bästa svenska mansrösten som finns: Chirp 3 HD, annars Neural2, annars WaveNet.
async function pickVoice(token) {
  if (ttsVoice) return ttsVoice;
  const r = await fetch("https://texttospeech.googleapis.com/v1/voices?languageCode=sv-SE", { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error("voices " + r.status);
  const voices = ((await r.json()).voices || []).filter((v) => (v.languageCodes || []).includes("sv-SE"));
  const male = voices.filter((v) => v.ssmlGender === "MALE");
  for (const kind of ["Chirp3-HD", "Chirp-HD", "Neural2", "Wavenet"]) {
    const v = male.find((x) => x.name.includes(kind)) || null;
    if (v) { ttsVoice = v.name; return ttsVoice; }
  }
  ttsVoice = (male[0] || voices[0])?.name || null;
  return ttsVoice;
}

// Text som ska läsas upp: "21 480" blir ett tal, "6,3" blir "6 komma 3" och "kr" blir kronor.
function spoken(t) {
  return t.replace(/[*#_`]/g, "")
    .replace(/(\d)[\s\u00a0\u202f](?=\d{3}\b)/g, "$1")
    .replace(/(\d+),00\s?kr\b/g, "$1 kronor")
    .replace(/(\d+),(\d\d)\s?kr\b/g, "$1 kronor och $2 öre")
    .replace(/(\d),(\d)/g, "$1 komma $2")
    .replace(/\bm\/s\b/g, "meter per sekund")
    .replace(/(\d)\s?kr\b/g, "$1 kronor")
    .replace(/(\d)\s?km\b/g, "$1 kilometer")
    .replace(/(-?\d+)\s?°C?/g, "$1 grader")
    .replace(/\s+/g, " ").trim();
}

exports.glennPratar = onCall({ timeoutSeconds: 60, memory: "256MiB", maxInstances: 3 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Logga in först.");
  // Väckning: appen anropar när man ställer en fråga, så att rösten är redo när svaret kommer.
  if (req.data?.warm) { googleToken().then(pickVoice).catch(() => {}); return { ok: true }; }
  const { hid } = req.data || {};
  const text = spoken(String(req.data?.text || "")).slice(0, 1500);
  if (typeof hid !== "string" || !text) throw new HttpsError("invalid-argument", "Texten saknas.");
  const usageRef = db.doc(`households/${hid}/ai/${todayStr().slice(0, 7)}`);
  // Hushållet, månadens användning och Googles nyckel hämtas samtidigt.
  const [houseSnap, usageSnap, token] = await Promise.all([db.doc(`households/${hid}`).get(), usageRef.get(), googleToken().catch(() => null)]);
  const house = houseSnap.data();
  if (!house || !(house.members || []).includes(uid)) throw new HttpsError("permission-denied", "Du hör inte till hushållet.");
  const plus = (house.plus?.until?.toMillis?.() ?? house.plus?.until ?? 0) > Date.now();
  if (!plus && uid !== ADMIN_UID) throw new HttpsError("permission-denied", "Glenns röst ingår i Bildagboken Plus.");
  if ((usageSnap.data()?.ttsChars || 0) + text.length > TTS_MONTHLY_CHARS) throw new HttpsError("resource-exhausted", "Glenns röst är slut för den här månaden. Svaren läses upp med telefonens röst i stället.");
  // Räknas upp utan att vänta, så att flera delar av samma svar kan läsas in samtidigt.
  usageRef.set({ ttsChars: admin.firestore.FieldValue.increment(text.length), updatedAt: Date.now() }, { merge: true }).catch(() => {});

  try {
    const tok = token || await googleToken();
    const voice = await pickVoice(tok);
    const r = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text }, voice: { languageCode: "sv-SE", ...(voice ? { name: voice } : { ssmlGender: "MALE" }) }, audioConfig: { audioEncoding: "MP3" } }),
    });
    if (!r.ok) { logger.error("Text-till-tal svarade med fel", { status: r.status, body: (await r.text()).slice(0, 300) }); throw new Error("tts " + r.status); }
    return { ok: true, audio: (await r.json()).audioContent, voice };
  } catch (e) {
    logger.error("Glenns röst fungerade inte", { message: e?.message });
    throw new HttpsError("unavailable", "Glenns röst fungerar inte just nu.");
  }
});


// Administratören ger ett hushåll Plus (till exempel till testare eller vänner), förlänger eller tar bort det.
// Klienter får inte skriva plus själva (säkerhetsreglerna), så det görs här.
exports.adminPlus = onCall({ timeoutSeconds: 20, memory: "256MiB", maxInstances: 1 }, async (req) => {
  if (req.auth?.uid !== ADMIN_UID) throw new HttpsError("permission-denied", "Bara administratören.");
  const hid = String(req.data?.hid || "");
  const months = Number(req.data?.months);
  if (!/^[A-Za-z0-9]{10,40}$/.test(hid) || !Number.isInteger(months) || months < 0 || months > 120) throw new HttpsError("invalid-argument", "Fel uppgifter.");
  const ref = db.doc(`households/${hid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Hittade inte hushållet.");
  if (months === 0) {
    // Ta bort en gåva. Plus som någon betalar för (plus.by) rör vi inte.
    if (snap.data().plus?.by) throw new HttpsError("failed-precondition", "Hushållet betalar själv för Plus.");
    await ref.update({ plus: admin.firestore.FieldValue.delete() });
    return { ok: true, until: null };
  }
  const cur = snap.data().plus?.until?.toMillis?.() ?? 0;
  const from = new Date(Math.max(Date.now(), cur));
  const until = new Date(from.getFullYear(), from.getMonth() + months, from.getDate(), 23, 59);
  await ref.update({ "plus.until": admin.firestore.Timestamp.fromDate(until), "plus.gift": true });
  return { ok: true, until: until.getTime() };
});
