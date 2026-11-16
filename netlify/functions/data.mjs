// Serves the saved numbers to the dashboard page.
//   /api/data                       -> latest saved numbers
//   /api/data?refresh=<REFRESH_KEY> -> fetch fresh numbers now
// If DASHBOARD_KEY is set, the page must send it (simple password).
import { refresh, latest } from "../../lib/refresh.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const url = new URL(req.url);
  const pass = process.env.DASHBOARD_KEY;
  if (pass && req.headers.get("x-dashboard-key") !== pass && url.searchParams.get("key") !== pass) {
    return json({ needKey: true }, 401);
  }
  const r = url.searchParams.get("refresh");
  if (r !== null) {
    if (!process.env.REFRESH_KEY || r !== process.env.REFRESH_KEY) return json({ error: "Wrong refresh key" }, 403);
    return json(await refresh());
  }
  let data = await latest();
  if (!data) data = await refresh(); // first visit ever
  return json(data);
};
