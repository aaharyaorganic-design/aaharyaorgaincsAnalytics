# Aaharya Growth Dashboard: setup for the dev team

This is one page that shows three things together:
- **Meta Ads:** spend, clicks, purchases, and cost per purchase, by campaign and by ad.
- **Google Analytics (GA4):** visits, traffic sources, landing pages, and the shopping funnel.
- **Aaharya CRM:** website orders from Firestore (`orders`, `events`, `abandoned_carts`, `customers`).

It follows the same pattern as the WealthUpp dashboard:
- It runs on Netlify.
- A scheduled function refreshes the data every hour and saves it in Netlify Blobs.
- The page reads the saved data from `/api/data`.

No phone numbers, emails or addresses leave Firestore. The page shows first names, city and pincode only, and customer IDs are hashed.

## 1. Deploy
1. Push this folder to a new GitHub repo, then use Netlify → **Add new site → Import from Git**. The build command is empty and the publish directory is `public`.
2. Netlify runs `npm install` and bundles the functions automatically.

## 2. Environment variables (Netlify → Site settings → Environment variables)

| Name | What to put |
|---|---|
| `META_ACCESS_TOKEN` | A System User token from Business Manager with the `ads_read` permission, with the ad account assigned to that system user. Use a never-expiring token. |
| `META_AD_ACCOUNT_ID` | `835336882638493` (the ad account currently used for Aaharya ads) |
| `CAMPAIGN_NAME_CONTAINS` | Optional. Example: `Aaharya`. Set this if the ad account also runs other brands' campaigns, so that only Aaharya campaigns are counted. |
| `GA4_PROPERTY_ID` | The numeric GA4 property ID (GA4 → Admin → Property details). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The full JSON key of a service account in Firebase project `aaharyaorganicsproj` (Firebase → Project settings → Service accounts → Generate new private key). Paste the whole JSON. |
| `REFRESH_KEY` | Any long random text. The ↻ Refresh button asks for it once. |
| `DASHBOARD_KEY` | Optional password for the page. Recommended, because the page shows order data. |

**Important:** give the same service account email (`...@aaharyaorganicsproj.iam.gserviceaccount.com`) **Viewer** access in GA4 (Admin → Property access management). Without this, the GA4 section will show "not connected".

## 3. First run
Open `https://<your-site>.netlify.app/api/data?refresh=<REFRESH_KEY>` once. Then open the site.

Any source that is not set up yet shows a yellow note at the top. The rest of the page still works.

## 4. Firestore notes
- `events` is filtered on `timestamp`. A single-field index is automatic, so no composite index is needed.
- If `timestamp` is stored as a string, the code also tries an ISO-string comparison.
- Order statuses are grouped into: New / pending, Confirmed, Shipped, Delivered, Cancelled, and Payment not completed (online orders still `pending_payment`). Revenue counts every order except Cancelled and Payment not completed.

## 5. Recommended tracking improvements (website)
1. **Meta Conversions API:** send a server-side `Purchase` event from the Razorpay success or webhook handler, with the same `event_id` as the Pixel event so Meta removes the duplicate. Ad blockers and iOS currently hide some purchases from Meta.
2. Keep UTMs on all Meta ads as `utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`. This makes GA4 report the traffic as **Paid Social**.
3. In GA4 → Admin → Data streams → Configure tag settings, add `rzp.io` and `razorpay.com` to **unwanted referrals**. Otherwise paid orders show Razorpay as their source.
