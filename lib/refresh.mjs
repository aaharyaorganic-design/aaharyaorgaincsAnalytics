// Aaharya Organics dashboard — collects numbers from 3 places and stores them:
//   1. Meta Ads (ad spend, clicks, purchases from ads)
//   2. GA4 (website visits, traffic sources, shopping steps)
//   3. Our own store database (Firestore: orders, customers, website events)
// No customer phone numbers or emails are stored or shown.

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const env = process.env;
const META_TOKEN = env.META_ACCESS_TOKEN;
const META_ACCOUNT = (env.META_AD_ACCOUNT_ID || "").replace(/^act_/, "");
const META_VERSION = env.META_API_VERSION || "v23.0";
const CAMPAIGN_FILTER = (env.CAMPAIGN_NAME_CONTAINS || "").trim();
const GA4_PROPERTY = (env.GA4_PROPERTY_ID || "").replace(/^properties\//, "");
const SA_JSON = env.GOOGLE_SERVICE_ACCOUNT_JSON;
const DAYS = 90;
const TZ = "Asia/Kolkata";

const STORE_NAME = "aaharya-dashboard";

// ───────────────────────── helpers ─────────────────────────
const num = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v) || 0);
const istDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
const sinceDate = () => istDate(new Date(Date.now() - (DAYS - 1) * 86400000));
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

function serviceAccount() {
  if (!SA_JSON) return null;
  try {
    const txt = SA_JSON.trim().startsWith("{") ? SA_JSON : Buffer.from(SA_JSON, "base64").toString("utf8");
    return JSON.parse(txt);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file, or its base64).");
  }
}

// ───────────────────────── 1. Meta Ads ─────────────────────────
const META_FIELDS = [
  "spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks",
  "ctr", "cpm", "actions", "action_values"
].join(",");

async function metaInsights(params) {
  const url = new URL(`https://graph.facebook.com/${META_VERSION}/act_${META_ACCOUNT}/insights`);
  const p = { access_token: META_TOKEN, limit: "500", ...params };
  if (CAMPAIGN_FILTER) p.filtering = [{ field: "campaign.name", operator: "CONTAIN", value: CAMPAIGN_FILTER }];
  for (const [k, v] of Object.entries(p)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  let rows = [];
  let next = url.toString();
  while (next) {
    const res = await fetch(next);
    const json = await res.json();
    if (json.error) throw new Error(`Meta: ${json.error.message}`);
    rows = rows.concat(json.data || []);
    next = json.paging && json.paging.next;
  }
  return rows;
}

// Meta reports the same step under a few names; take the first that exists.
function pick(list, names) {
  if (!Array.isArray(list)) return 0;
  for (const n of names) {
    const hit = list.find((a) => a.action_type === n);
    if (hit) return num(hit.value);
  }
  return 0;
}
const A = {
  landing: ["landing_page_view", "omni_landing_page_view"],
  view: ["omni_view_content", "offsite_conversion.fb_pixel_view_content", "view_content"],
  cart: ["omni_add_to_cart", "offsite_conversion.fb_pixel_add_to_cart", "add_to_cart"],
  checkout: ["omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "initiate_checkout"],
  purchase: ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase"]
};
function shapeMeta(r = {}) {
  return {
    date: r.date_start,
    campaign: r.campaign_name,
    adset: r.adset_name,
    ad: r.ad_name,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.inline_link_clicks || r.clicks),
    landing: pick(r.actions, A.landing),
    views: pick(r.actions, A.view),
    carts: pick(r.actions, A.cart),
    checkouts: pick(r.actions, A.checkout),
    purchases: pick(r.actions, A.purchase),
    purchaseValue: pick(r.action_values, A.purchase)
  };
}

async function getMeta() {
  if (!META_TOKEN || !META_ACCOUNT) return { error: "Meta not connected yet (add META_ACCESS_TOKEN and META_AD_ACCOUNT_ID)." };
  const time_range = { since: sinceDate(), until: istDate(new Date()) };
  const [daily, campaignsDaily, adsDaily] = await Promise.all([
    metaInsights({ level: "account", time_range, time_increment: "1", fields: META_FIELDS }),
    metaInsights({ level: "campaign", time_range, time_increment: "1", fields: `campaign_name,${META_FIELDS}` }),
    metaInsights({ level: "ad", time_range, time_increment: "1", fields: `campaign_name,adset_name,ad_name,${META_FIELDS}` })
  ]);
  return {
    daily: daily.map(shapeMeta),
    campaignsDaily: campaignsDaily.map(shapeMeta),
    adsDaily: adsDaily.map(shapeMeta)
  };
}

// ───────────────────────── 2. GA4 ─────────────────────────
async function getGA4() {
  if (!GA4_PROPERTY || !SA_JSON) return { error: "GA4 not connected yet (add GA4_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_JSON)." };
  const { BetaAnalyticsDataClient } = await import("@google-analytics/data");
  const sa = serviceAccount();
  const client = new BetaAnalyticsDataClient({ credentials: { client_email: sa.client_email, private_key: sa.private_key } });
  const property = `properties/${GA4_PROPERTY}`;
  const dateRanges = [{ startDate: `${DAYS}daysAgo`, endDate: "today" }];
  const d = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

  const [[daily], [events], [channels], [sources], [pages]] = await Promise.all([
    client.runReport({ property, dateRanges, dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "newUsers" }, { name: "ecommercePurchases" }, { name: "purchaseRevenue" }, { name: "engagementRate" }], limit: 1000 }),
    client.runReport({ property, dateRanges, dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["session_start", "view_item", "add_to_cart", "begin_checkout", "purchase"] } } }, limit: 5000 }),
    client.runReport({ property, dateRanges, dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "ecommercePurchases" }, { name: "purchaseRevenue" }], limit: 5000 }),
    client.runReport({ property, dateRanges, dimensions: [{ name: "date" }, { name: "sessionSourceMedium" }],
      metrics: [{ name: "sessions" }, { name: "ecommercePurchases" }], limit: 10000 }),
    client.runReport({ property, dateRanges, dimensions: [{ name: "date" }, { name: "landingPagePlusQueryString" }],
      metrics: [{ name: "sessions" }], limit: 10000 })
  ]);
  const rows = (rep, fn) => (rep.rows || []).map((r) => fn(r.dimensionValues.map((x) => x.value), r.metricValues.map((x) => num(x.value))));
  return {
    daily: rows(daily, ([date], [sessions, users, newUsers, purchases, revenue, engagement]) => ({ date: d(date), sessions, users, newUsers, purchases, revenue, engagement })),
    events: rows(events, ([date, event], [count]) => ({ date: d(date), event, count })),
    channels: rows(channels, ([date, channel], [sessions, purchases, revenue]) => ({ date: d(date), channel, sessions, purchases, revenue })),
    sources: rows(sources, ([date, source], [sessions, purchases]) => ({ date: d(date), source, sessions, purchases })),
    pages: rows(pages, ([date, page], [sessions]) => ({ date: d(date), page: page.split("?")[0] || "/", sessions }))
  };
}

// ───────────────────────── 3. Store database (CRM) ─────────────────────────
let _db;
async function firestore() {
  if (_db) return _db;
  const admin = (await import("firebase-admin")).default;
  const sa = serviceAccount();
  const app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa), projectId: env.FIREBASE_PROJECT_ID || sa.project_id });
  _db = app.firestore();
  return _db;
}
const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v ? new Date(v) : null);

function cleanStatus(o) {
  const s = String(o.status || "").toLowerCase();
  const p = String(o.paymentStatus || "").toLowerCase();
  if (/cancel|refund|fail|reject|return/.test(s)) return "Cancelled";
  if (s === "pending_payment" && p !== "paid") return "Payment not completed";
  if (/deliver|complete/.test(s)) return "Delivered";
  if (/ship|dispatch|transit|out for/.test(s)) return "Shipped";
  if (/confirm|process|pack|paid/.test(s) || p === "paid") return "Confirmed";
  return "New / pending";
}

async function getCRM() {
  if (!SA_JSON) return { error: "Store database not connected yet (add GOOGLE_SERVICE_ACCOUNT_JSON)." };
  const db = await firestore();
  const since = new Date(Date.now() - DAYS * 86400000);

  // Orders: all of them (a small shop has few enough). Only non-personal fields are kept.
  const ordersSnap = await db.collection("orders").get();
  const firstOrder = {}; // customer -> first order date (to tell new vs repeat)
  const orders = ordersSnap.docs.map((doc) => {
    const o = doc.data();
    const created = toDate(o.createdAt) || toDate(o.paidAt) || toDate(o.updatedAt);
    const cust = String(o.customerId || (o.customer && o.customer.phone) || "").replace(/\D/g, "").slice(-10);
    const items = (o.items || []).map((i) => ({
      name: i.name || i.productName || i.productId || "Item",
      qty: num(i.quantity || i.qty || 1),
      amount: num(i.price) * num(i.quantity || i.qty || 1)
    }));
    return {
      id: o.orderId || doc.id,
      date: created ? istDate(created) : null,
      ts: created ? created.getTime() : 0,
      total: num(o.total ?? o.amount),
      discount: num(o.couponDiscount || o.discount),
      shipping: num(o.shipping),
      status: cleanStatus(o),
      rawStatus: o.status || "",
      payment: String(o.paymentMethod || "").toLowerCase() === "cod" ? "Cash on delivery" : "Online",
      coupon: (o.couponCode || "").toUpperCase(),
      city: ((o.shippingAddress && o.shippingAddress.city) || "").trim(),
      pincode: (o.shippingAddress && o.shippingAddress.pincode) || "",
      customer: cust ? hash(cust) : null,
      firstName: ((o.customer && o.customer.name) || "").trim().split(/\s+/)[0] || "",
      items
    };
  }).filter((o) => o.date).sort((a, b) => a.ts - b.ts);

  for (const o of orders) {
    if (!o.customer || o.status === "Cancelled" || o.status === "Payment not completed") continue;
    if (!firstOrder[o.customer]) firstOrder[o.customer] = o.date;
  }
  for (const o of orders) o.repeat = !!(o.customer && firstOrder[o.customer] && firstOrder[o.customer] < o.date);

  // Our own website event log (works even when GA4/Meta are blocked by the browser).
  const funnelEvents = ["page_view", "product_view", "add_to_cart", "checkout_started", "order_completed"];
  // timestamp may be saved as a Firestore date or as text — try both.
  let evSnap = await db.collection("events").where("timestamp", ">=", since).select("event", "sessionId", "timestamp").get();
  if (evSnap.empty) evSnap = await db.collection("events").where("timestamp", ">=", since.toISOString()).select("event", "sessionId", "timestamp").get();
  const sets = {}; // date|event -> Set(sessionId)
  for (const doc of evSnap.docs) {
    const e = doc.data();
    if (!funnelEvents.includes(e.event)) continue;
    const t = toDate(e.timestamp);
    if (!t) continue;
    const key = `${istDate(t)}|${e.event}`;
    (sets[key] ||= new Set()).add(e.sessionId || doc.id);
  }
  const siteEvents = Object.entries(sets).map(([k, s]) => {
    const [date, event] = k.split("|");
    return { date, event, sessions: s.size };
  });

  // Simple counts
  const count = async (name) => {
    try { return (await db.collection(name).count().get()).data().count; } catch { return null; }
  };
  const [customers, abandonedCarts, leads] = await Promise.all([count("customers"), count("abandoned_carts"), count("leads")]);

  return { orders, siteEvents, totals: { customers, abandonedCarts, leads } };
}

// ───────────────────────── run all ─────────────────────────
async function safe(fn) {
  try { return await fn(); } catch (e) { return { error: String(e.message || e) }; }
}

export async function refresh() {
  const store = getStore(STORE_NAME);
  const [meta, ga4, crm] = await Promise.all([safe(getMeta), safe(getGA4), safe(getCRM)]);
  const payload = { updatedAt: new Date().toISOString(), days: DAYS, campaignFilter: CAMPAIGN_FILTER, meta, ga4, crm };
  // Keep the last good data for any source that failed this time.
  const previous = (await store.get("latest", { type: "json" })) || {};
  for (const k of ["meta", "ga4", "crm"]) {
    if (payload[k] && payload[k].error && previous[k] && !previous[k].error) {
      payload[k] = { ...previous[k], staleError: payload[k].error };
    }
  }
  await store.setJSON("latest", payload);
  return payload;
}

export async function latest() {
  return getStore(STORE_NAME).get("latest", { type: "json" });
}
