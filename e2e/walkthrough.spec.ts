import { expect, test, type Page } from "@playwright/test";
import { FakeVoter, checkState, createPollViaApi } from "./helpers";

async function shareUrlFrom(host: Page): Promise<string> {
  return host.getByLabel("Share link").inputValue();
}

test.describe("LiveVote walkthrough (e2e + a11y + screenshots)", () => {
  test("host creates a poll, the team votes live, host closes, summary is copyable", async ({ browser, context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    // ---- 1. Create poll -------------------------------------------------
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Where should we eat?" })).toBeVisible();
    await page.getByLabel("Question").fill("Where should the night shift eat on Friday?");
    await page.getByRole("textbox", { name: "Option 1" }).fill("Italiano");
    await page.getByRole("textbox", { name: "Option 2" }).fill("Sushi");
    await page.getByRole("button", { name: "+ Add option" }).click();
    await page.getByRole("textbox", { name: "Option 3" }).fill("Thai");
    await page.getByLabel("Close automatically").check();
    await checkState(page, "01-create-poll");

    await page.getByRole("button", { name: "Create poll" }).click();

    // ---- 2. Host page: share link + QR + private host link --------------
    await expect(page.getByRole("heading", { name: "Where should the night shift eat on Friday?" })).toBeVisible();
    await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
    const shareUrl = await shareUrlFrom(page);
    expect(shareUrl).toMatch(/#\/p\/[a-z2-9]{10}$/);
    const hostUrl = await page.getByLabel(/Private host link/).inputValue();
    expect(hostUrl).toMatch(/\/host\/.{20,}$/);
    expect(hostUrl.startsWith(shareUrl)).toBe(true);
    await checkState(page, "02-host-share-qr");
    const pollId = shareUrl.split("/p/")[1] ?? "";

    // ---- 3. A late joiner sees the ballot but no results ----------------
    const voterCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const voter = await voterCtx.newPage();
    await voter.goto(shareUrl);
    await expect(voter.getByRole("heading", { name: "Where should the night shift eat on Friday?" })).toBeVisible();
    await expect(voter.getByRole("radio", { name: "Italiano" })).toBeVisible();
    await expect(voter.getByText("Vote first, then you'll see the live results")).toBeVisible();
    await expect(voter.getByRole("heading", { name: "Live results" })).toHaveCount(0);
    await checkState(voter, "03-voter-view");

    // ---- 4. Add your own (appears live on the host's screen) ------------
    await voter.getByLabel(/Add your own/).fill("  Burger   Barn ");
    await voter.getByRole("button", { name: "Add", exact: true }).click();
    await expect(voter.getByText("Added. It's selected for you")).toBeVisible();
    await expect(voter.getByRole("radio", { name: "Burger Barn" })).toBeChecked();
    await expect(page.getByText("Burger Barn").first()).toBeVisible({ timeout: 2000 }); // host sees it within ~1 s
    // near-duplicates are merged: only one voter-added option exists, and the add box is gone (1 per voter)
    await expect(voter.getByLabel(/Add your own/)).toHaveCount(0);
    await checkState(voter, "04-add-your-own");

    // ---- 5. Vote, then see live results with people counts --------------
    await voter.getByRole("radio", { name: "Italiano" }).check();
    await voter.getByLabel(/How many people/).fill("3");
    await voter.getByRole("button", { name: "Vote", exact: true }).click();
    await expect(voter.getByRole("heading", { name: "Live results" })).toBeVisible();

    // seed the rest of the team: Italiano 6 votes / 14 people (incl. the browser voter's 3)
    const seeds: Array<[string, number]> = [
      ["o1", 2], ["o1", 3], ["o1", 2], ["o1", 2], ["o1", 2], // 5 voters, 11 people
      ["o2", 2], ["o2", 2], ["o2", 3], ["o2", 1],            // Sushi: 4 votes, 8 people
      ["o4", 2], ["o4", 1],                                  // Burger: 2 votes, 3 people
    ];
    const fakes: FakeVoter[] = [];
    for (const [i, [opt, people]] of seeds.entries()) {
      const f = await FakeVoter.join(pollId, i + 1);
      await f.vote([opt ?? "o1"], people);
      fakes.push(f);
    }
    const italiano = voter.getByRole("listitem").filter({ hasText: "Italiano" }).filter({ hasText: "vote" });
    await expect(italiano.first()).toContainText("Italiano");
    await expect(italiano.first()).toContainText("6 votes, 14 people", { timeout: 2000 });
    await expect(voter.getByTestId("summary")).toHaveText("Winner: Italiano (6 votes, 14 people) · 25 people in total, 12 voters", { timeout: 2000 });
    await expect(voter.getByTestId("totals")).toHaveText("12 voters · 25 people");
    await checkState(voter, "05-live-results");

    // the voter can change the vote before the close
    await voter.getByRole("button", { name: "Change vote" }).click();
    await voter.getByRole("radio", { name: "Sushi" }).check();
    await voter.getByRole("button", { name: "Update vote" }).click();
    await expect(voter.getByTestId("summary")).toContainText("Tie: Italiano / Sushi (5 votes each)", { timeout: 2000 });
    await voter.getByRole("button", { name: "Change vote" }).click();
    await voter.getByRole("radio", { name: "Italiano" }).check();
    await voter.getByRole("button", { name: "Update vote" }).click();
    await expect(voter.getByTestId("summary")).toContainText("6 votes, 14 people", { timeout: 2000 });

    // one vote per browser: a reload remembers who I am
    await voter.reload();
    await expect(voter.getByText("You voted")).toBeVisible();
    await expect(voter.getByTestId("totals")).toHaveText("12 voters · 25 people");

    // ---- 6. Host closes; everyone sees the final summary -----------------
    await page.getByRole("button", { name: "Close poll" }).click();
    await page.getByRole("button", { name: "Yes, close it" }).click();
    await expect(voter.getByRole("heading", { name: "Final results" })).toBeVisible({ timeout: 2000 });
    await expect(voter.getByText("Closed by host")).toBeVisible();
    await expect(voter.getByRole("button", { name: "Update vote" })).toHaveCount(0);
    await voterCtx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:4173" });
    await voter.getByRole("button", { name: "Copy summary" }).click();
    await expect(voter.getByRole("button", { name: "Copied ✓" })).toBeVisible();
    expect(await voter.evaluate(() => navigator.clipboard.readText())).toBe(
      "Winner: Italiano (6 votes, 14 people) · 25 people in total, 12 voters",
    );
    await checkState(voter, "06-closed-summary");
    await checkState(page, "07-host-closed");

    fakes.forEach((f) => f.close());
    await voterCtx.close();
  });

  test("ties are flagged clearly", async ({ page }) => {
    const { pollId, hostToken } = await createPollViaApi({
      question: "Friday dinner: tie-break needed",
      options: ["Italiano", "Sushi", "Thai"],
      multiple: false,
      allowAddOwn: false,
      closesAt: null,
    });
    const seeds: Array<[string, number]> = [["o1", 4], ["o1", 3], ["o2", 5], ["o2", 2], ["o3", 1]];
    const fakes: FakeVoter[] = [];
    for (const [i, [opt, people]] of seeds.entries()) {
      const f = await FakeVoter.join(pollId, 100 + i);
      await f.vote([opt ?? "o1"], people);
      fakes.push(f);
    }
    await page.goto(`/#/p/${pollId}/host/${hostToken}`);
    await expect(page.getByTestId("tie")).toContainText("It's a tie between Italiano and Sushi");
    await expect(page.getByTestId("summary")).toHaveText("Tie: Italiano / Sushi (2 votes each) · 15 people in total, 5 voters");
    await expect(page.getByText("Tied")).toHaveCount(2);
    await checkState(page, "08-tie");
    fakes.forEach((f) => f.close());
  });

  test("shows a 'server waking up' state, then continues by itself once the server answers", async ({ page }) => {
    const { pollId } = await createPollViaApi({
      question: "Waking test: where to?",
      options: ["Italiano", "Sushi"],
      multiple: true,
      allowAddOwn: true,
      closesAt: null,
    });
    // Simulate a cold Render instance: Socket.IO requests don't get through yet.
    await page.route("**/socket.io/**", (route) => route.abort());
    await page.goto(`/#/p/${pollId}`);
    const banner = page.getByTestId("waking");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText("Server waking up");
    await checkState(page, "09-waking-up");
    // the server "wakes up"
    await page.unroute("**/socket.io/**");
    await expect(page.getByRole("heading", { name: "Waking test: where to?" })).toBeVisible({ timeout: 20_000 });
    await expect(banner).toHaveCount(0);
  });

  test("create screen shows the waking state too when the API is slow", async ({ page }) => {
    await page.route("**/api/health", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByTestId("waking")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("waking")).toContainText("takes up to a minute");
    await checkState(page, "10-create-waking-up");
  });

  test("a closed-by-time poll, host reset and remove option", async ({ page }) => {
    const { pollId, hostToken } = await createPollViaApi({
      question: "Host powers: remove and reset",
      options: ["Italiano", "Sushi", "Thai"],
      multiple: false,
      allowAddOwn: true,
      closesAt: null,
    });
    await page.goto(`/#/p/${pollId}/host/${hostToken}`);
    await page.getByRole("button", { name: "Remove option Thai" }).click();
    await expect(page.getByRole("radio", { name: "Thai" })).toHaveCount(0);
    await page.getByRole("radio", { name: "Sushi" }).check();
    await page.getByRole("button", { name: "Vote", exact: true }).click();
    await expect(page.getByTestId("totals")).toHaveText("1 voter · 1 person");
    await page.getByRole("button", { name: "Reset votes" }).click();
    await page.getByRole("button", { name: "Yes, reset" }).click();
    await expect(page.getByTestId("totals")).toHaveText("0 voters · 0 people");
  });

  test("a wrong host token is refused", async ({ page }) => {
    const { pollId } = await createPollViaApi({
      question: "Secret host link test",
      options: ["A place", "Another place"],
      multiple: false,
      allowAddOwn: false,
      closesAt: null,
    });
    await page.goto(`/#/p/${pollId}/host/this-is-not-the-token-1234567890`);
    await expect(page.getByRole("heading", { name: "Can't open this poll" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close poll" })).toHaveCount(0);
  });

  test("reconnects after the connection drops and keeps the user's vote", async ({ page, context }) => {
    const { pollId } = await createPollViaApi({
      question: "Reconnect test: where to?",
      options: ["Italiano", "Sushi"],
      multiple: false,
      allowAddOwn: false,
      closesAt: null,
    });
    await page.goto(`/#/p/${pollId}`);
    await page.getByRole("radio", { name: "Sushi" }).check();
    await page.getByRole("button", { name: "Vote", exact: true }).click();
    await expect(page.getByText("You voted")).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText("Connection lost")).toBeVisible({ timeout: 25_000 });
    await context.setOffline(false);
    await expect(page.getByText("Connection lost")).toHaveCount(0, { timeout: 25_000 });
    // a vote cast by someone else while we were away shows up after the reconnect
    const f = await FakeVoter.join(pollId, 900);
    await f.vote(["o1"], 4);
    await expect(page.getByTestId("totals")).toHaveText("2 voters · 5 people", { timeout: 3000 });
    f.close();
  });
});
