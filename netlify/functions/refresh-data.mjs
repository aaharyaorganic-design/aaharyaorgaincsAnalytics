// Runs automatically every hour and saves fresh numbers.
import { refresh } from "../../lib/refresh.mjs";

export default async () => {
  const p = await refresh();
  console.log("Aaharya dashboard refreshed", p.updatedAt);
  return new Response("ok");
};

export const config = { schedule: "0 * * * *" };
