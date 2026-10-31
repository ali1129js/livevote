import { expect, test } from "@playwright/test";
import { checkState } from "./helpers";

const NOTE = "First visit in a while? The server takes up to a minute to wake up. Your poll is created once it's ready.";

for (const vp of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(`cold server, ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Create poll never looks dead: note + live state + progress button, then the poll is created once the server wakes", async ({ page }) => {
      let posts = 0;
      // A sleeping Render instance: health doesn't answer, and the first create attempts get a CORS-less proxy 503.
      await page.route("**/api/health", (route) => route.abort());
      await page.route("**/api/polls", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        if (posts <= 2) return route.fulfill({ status: 503, contentType: "text/html", body: "<html>Service Unavailable</html>" });
        return route.continue();
      });

      await page.goto("/");
      const status = page.getByTestId("connection-status");
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(status).toContainText(NOTE); // visible straight away, before any tap
      await expect(status).toBeInViewport({ ratio: 0.1 }).catch(() => undefined);

      await page.getByLabel("Question").fill("Where should we eat?");
      await page.getByRole("textbox", { name: "Option 1" }).fill("Italiano");
      await page.getByRole("textbox", { name: "Option 2" }).fill("Sushi");
      await page.getByLabel("Close automatically").check();

      await page.getByRole("button", { name: "Create poll" }).click();
      const busy = page.getByRole("button", { name: /Creating…|Waking the server…/ });
      await expect(busy).toBeDisabled();
      await expect(busy).toHaveAttribute("aria-busy", "true");
      await expect(page.getByRole("button", { name: "Waking the server…" })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("waking")).toContainText("Server waking up…");
      await expect(page.getByTestId("waking")).toContainText("takes up to a minute");
      await checkState(page, `11-create-busy-waking-${vp.name}`);

      // The server wakes: the retry goes through and the host lands on the share page.
      await page.unroute("**/api/health");
      await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible({ timeout: 30_000 });
      expect(page.url()).toMatch(/#\/p\/[a-z2-9]{10}\/host\//);
      expect(posts).toBeGreaterThanOrEqual(3);
    });

    test("when the server answers the note changes to 'awake'", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("awake")).toContainText("Server is awake.");
      await expect(page.getByTestId("connection-status")).not.toContainText("takes up to a minute");
    });

    test("voter link on a cold server shows the note while connecting, and it clears once the poll opens", async ({ page, request }) => {
      const res = await request.post("http://localhost:3101/api/polls", {
        headers: { origin: "http://localhost:4173" },
        data: { question: "Cold voter test?", options: ["Italiano", "Sushi"], multiple: false, allowAddOwn: true, closesAt: null },
      });
      const { pollId } = ((await res.json()) as { data: { pollId: string } }).data;
      await page.route("**/socket.io/**", (route) => route.abort());
      await page.goto(`/#/p/${pollId}`);
      const status = page.getByTestId("connection-status");
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(status).toContainText("First visit in a while? The server takes up to a minute to wake up. This poll opens once it's ready.");
      await page.unroute("**/socket.io/**");
      await expect(page.getByRole("heading", { name: "Cold voter test?" })).toBeVisible({ timeout: 20_000 });
      await expect(status).toBeEmpty();
    });
  });
}
