// Pushnotiser för Bildagboken.
// 1) Varje morgon kl 08: påminnelser om bokade tider, besiktning, försäkring, dokument, skatt och däckbyte.
// 2) När någon loggar något: en notis till de andra i hushållet.
// Telefonernas adresser för notiser sparas av appen i households/{hid}/tokens/{token}.
const { onSchedule } = require("firebase-functions/v2/scheduler");
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
    });
    await Promise.all(res.responses.map((r, i) => {
      const code = r.error?.code || "";
      if (r.success || !/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) return null;
      return db.doc(`households/${hid}/tokens/${list[i].id}`).delete().catch(() => null);
    }));
  }
}

async function tokensOf(hid) {
  const qs = await db.collection(`households/${hid}/tokens`).get();
  return qs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.token);
}

exports.morgonpaminnelser = onSchedule({ schedule: "every day 08:00", timeZone: TZ }, async () => {
  const today = todayStr();
  const houses = await db.collection("households").get();
  let sent = 0;
  for (const h of houses.docs) {
    const tokens = await tokensOf(h.id);
    if (!tokens.length) continue;
    const cars = await db.collection(`households/${h.id}/cars`).get();
    const several = cars.size > 1;
    for (const c of cars.docs) {
      for (const r of reminders(c.data(), today)) {
        // Med flera bilar står bilens namn först i rubriken.
        const msg = { tag: `${c.id}-${r.tag}`, url: "./#oversikt",
          sv: { title: several ? `${r.car}: ${r.sv.title}` : r.sv.title, body: r.sv.body },
          en: { title: several ? `${r.car}: ${r.en.title}` : r.en.title, body: r.en.body } };
        await send(h.id, tokens, msg);
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
  const tokens = (await tokensOf(hid)).filter((t) => t.uid !== e.createdBy);
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

// För test: reminders() kan provas lokalt utan Firebase.
exports._reminders = reminders;
