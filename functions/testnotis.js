// Skickar en testnotis till alla telefoner där appens ägare har slagit på notiser.
// Körs i Cloud Shell:  cd ~/bildagboken && git pull && node functions/testnotis.js
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "bildagboken-3f931" });
const OWNER = "mjQJQzsMCpVURkuVSyK5ctKVhG23";

(async () => {
  const db = admin.firestore();
  const houses = await db.collection("households").where("members", "array-contains", OWNER).get();
  const tokens = [];
  for (const h of houses.docs) {
    const qs = await db.collection(`households/${h.id}/tokens`).where("uid", "==", OWNER).get();
    qs.forEach((d) => tokens.push({ ref: d.ref, ...d.data() }));
  }
  if (!tokens.length) {
    console.log("Hittade ingen telefon med notiser påslagna. Öppna appen → Inställningar → Notiser → Slå på notiser, och kör skriptet igen.");
    return;
  }
  console.log(`Skickar till ${tokens.length} enhet(er) …`);
  const res = await admin.messaging().sendEachForMulticast({
    tokens: tokens.map((t) => t.token),
    data: { title: "Bildagboken", body: "Testnotis: pushnotiserna fungerar! 🎉", tag: "test", url: "./#oversikt" },
    webpush: { headers: { Urgency: "high" } },
    apns: { headers: { "apns-priority": "10" }, payload: { aps: { alert: { title: "Bildagboken", body: "Testnotis: pushnotiserna fungerar! 🎉" }, sound: "default" } } },
    android: { priority: "high", notification: { title: "Bildagboken", body: "Testnotis: pushnotiserna fungerar! 🎉", icon: "ic_stat_notify", color: "#E8711F" } },
  });
  res.responses.forEach((r, i) => console.log(`${r.success ? "✓ Skickad" : "✗ Misslyckades"} · ${tokens[i].platform === "ios" ? "iPhone-appen" : tokens[i].ua || "okänd enhet"}${r.error ? ` · ${r.error.code}` : ""}`));
})().catch((e) => { console.error("Fel:", e.message); process.exit(1); });
