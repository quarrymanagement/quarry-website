# Meta (Facebook + Instagram) Setup — Your 30-Minute Checklist

To enable automated posting from your Quarry admin to your Facebook Page and Instagram, complete these steps in order. **You only do this once.** When done, paste the tokens into Netlify env vars (instructions at the bottom).

---

## Step 1 — Make sure Instagram is a Business or Creator account
**Why:** The Instagram Graph API only allows automated posting from Business/Creator accounts. Personal accounts are blocked, no exceptions.

1. Open **Instagram app** on your phone (logged in as `@thequarrystl`)
2. Tap the menu (≡ top right) → **Settings and privacy**
3. Tap **Account type and tools** → **Switch to professional account**
4. Pick **Business** (better than Creator for restaurants — gets you contact buttons + order/reserve actions)
5. Pick the category **Restaurant** when prompted

✅ **Verify:** open your IG profile — you should see "Edit profile / Promotions / Insights" buttons (Business mode).

---

## Step 2 — Connect Instagram to your Facebook Page
**Why:** The API authenticates Instagram THROUGH your Facebook Page. They must be linked.

1. On desktop, open **Meta Business Suite** at https://business.facebook.com
2. Settings (gear icon, lower-left) → **Business assets** → **Instagram accounts**
3. Click **Add** → **Connect Instagram account** → log in with `@thequarrystl`
4. Then: Settings → **Pages** → make sure `The Quarry` Page (facebook.com/thequarrystl) appears
5. If both are listed, the link is established. (Some setups also need a step in the Facebook Page settings → "Linked accounts → Instagram" to confirm.)

✅ **Verify:** in Meta Business Suite, you can see both Page and IG account in the same dashboard with a chain-link icon connecting them.

---

## Step 3 — Create a Meta Developer App
**Why:** This is the technical app that holds your API permissions. It's free and takes ~5 minutes.

1. Go to https://developers.facebook.com/apps
2. Click **Create App**
3. Pick app type: **Business** (NOT Consumer)
4. **App name:** `Quarry Marketing` (or anything — only you see it)
5. **Contact email:** `management@thequarrystl.com`
6. **Business account:** pick your Quarry business if you have one, otherwise "I don't want to connect to a business account"
7. Click **Create app**
8. On the app dashboard, scroll to **Add products to your app** → click **Set up** on:
   - **Facebook Login for Business** (for getting tokens)
   - **Instagram Graph API**
9. In the left sidebar, click **App Review → Permissions and Features** and request these permissions (you'll go through review later — that's fine):
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `pages_show_list`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management`

✅ **Verify:** dashboard shows your app with App ID + App Secret visible.

---

## Step 4 — Generate a long-lived Page Access Token

This is the actual credential the Quarry admin will use to post on your behalf.

1. Open the **Graph API Explorer** at https://developers.facebook.com/tools/explorer
2. **Top right** → make sure **Meta App** dropdown shows your `Quarry Marketing` app
3. Below that, **User or Page** dropdown → click **Get User Access Token**
4. Check these permissions before clicking Generate:
   - `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`
   - `instagram_basic`, `instagram_content_publish`, `business_management`
5. Click **Generate Access Token** → log in with your Facebook account → grant permissions
6. You now have a **short-lived user token** in the box at the top. We need to convert it to a **long-lived Page token**:

   a. In Graph API Explorer, change the dropdown from "User Token" to **Get Page Access Token** → pick `The Quarry` page → confirm
   
   b. Now run this query in the Graph API Explorer to get a 60-day token, then a never-expiring one:
   ```
   GET /me/accounts?fields=name,access_token
   ```
   Copy the `access_token` field for `The Quarry` page from the response. That's your **never-expiring Page Access Token** (Page tokens that come from a long-lived user token don't expire).

7. **ALSO grab your IDs while you're here:**
   - In the explorer, run: `GET /me/accounts` → copy the `id` for The Quarry Page (this is `META_PAGE_ID`)
   - Then run: `GET /{PAGE_ID}?fields=instagram_business_account` (replace `{PAGE_ID}` with that id) → response has an `instagram_business_account.id` field — that's your `META_IG_USER_ID`

✅ **You now have three values to send me:**
- `META_PAGE_ACCESS_TOKEN` — the long-lived Page token (starts with `EAA…`)
- `META_PAGE_ID` — numeric ID of the Quarry Facebook Page
- `META_IG_USER_ID` — numeric ID of the Quarry Instagram Business account

---

## Step 5 — Add tokens to Netlify env vars

When you have those three values, either:

**Option A:** Send them to me in chat and I'll add them to Netlify via the MCP integration. Safer: **rotate the token after testing if you share it in chat** (the token would be in the transcript).

**Option B (recommended):** Add them yourself in Netlify:
1. https://app.netlify.com/projects/roaring-pegasus-444826/configuration/env
2. Click **Add a single variable** for each:
   - Key: `META_PAGE_ACCESS_TOKEN` → Value: `EAA…` (mark as Secret)
   - Key: `META_PAGE_ID` → Value: `12345…`
   - Key: `META_IG_USER_ID` → Value: `12345…`
3. Save. Tell me when done and I'll trigger a redeploy + run the first test post.

---

## What happens next (my side)

While you're doing Steps 1-4, I'm building:
- The Social module in your admin (Calendar / Drafts Inbox / Performance / Settings)
- AI generator that creates Facebook and Instagram posts (different formats, hashtag-aware)
- DALL-E 3 image generation for posts
- The actual Meta Graph API poster (FB Page + IG Business)
- Performance polling for likes/comments/reach
- Default calendar rules (daily live music post, weekly menu spotlight, etc.)

When you ping me with your three values, **first test post** goes out within 5 minutes — to your Facebook Page only, in **Dev Mode** (only admins of the app can see it, no public audience). Once we've confirmed it works, you submit for Meta App Review (1-2 weeks) for production access.

---

## Things to know before App Review

- **Meta App Review** is required to publish posts that anyone outside your dev team can see
- They want a **60-second screen recording** showing your app posting + reading insights
- Approval typically takes 1-2 weeks
- Until then, posts work but only YOU see them on your own Page (perfect for testing the system)

I'll prepare the demo video script + walk you through submission when we get there.

---

**No rush — work through Steps 1-4 at your pace. Ping me with the three values and I'll handle the rest.**
