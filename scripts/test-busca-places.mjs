/**
 * E2E rápido: campo "Para onde vamos" + Google PlaceAutocompleteElement.
 * Uso: node scripts/test-busca-places.mjs [baseUrl]
 */
import { chromium } from "playwright";

const base = process.argv[2] || "http://localhost:3456";

const mockUser = {
  id: 1,
  nome: "Teste E2E",
  matricula: "111111",
  politica_pendente: false,
  is_admin: false,
};

async function main() {
  const browser = await chromium.launch({
    headless: true,
  });
  const context = await browser.newContext({
    geolocation: { latitude: -6.068, longitude: -49.902 },
    permissions: ["geolocation"],
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
  });

  await context.addInitScript((u) => {
    localStorage.setItem("token", "e2e-fake-token");
    localStorage.setItem("user", JSON.stringify(u));
    localStorage.setItem("papel", "passageiro");
  }, mockUser);

  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/config")) return route.continue();
    if (url.includes("/api/perfil")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockUser),
      });
    }
    if (url.includes("/api/viagens")) {
      return route.fulfill({ status: 200, body: "[]" });
    }
    if (url.includes("/api/motoristas-online")) {
      return route.fulfill({ status: 200, body: "[]" });
    }
    if (url.includes("/api/propostas") || url.includes("/api/oferta-fila")) {
      return route.fulfill({ status: 200, body: "[]" });
    }
    if (url.includes("/api/habilitacao")) {
      return route.fulfill({ status: 200, body: JSON.stringify({ habilitado: false }) });
    }
    return route.fulfill({ status: 200, body: "{}" });
  });

  console.log("Abrindo", base + "/dashboard.html");
  await page.goto(`${base}/dashboard.html`, { waitUntil: "domcontentloaded", timeout: 90000 });

  // Passageiro + aba pedir
  await page.waitForTimeout(2000);
  const papel = page.locator("#telaPapel");
  if (await papel.isVisible().catch(() => false)) {
    await page.locator("button.papel-opt").first().click();
  }

  let pacVisible = false;
  try {
    await page.waitForSelector("gmp-place-autocomplete", { timeout: 120000 });
    pacVisible = true;
  } catch (e) {
    console.error("FALHA: gmp-place-autocomplete não apareceu em 90s");
  }

  const pacInfo = await page.evaluate(() => {
    const pac = document.querySelector("#tabPedir gmp-place-autocomplete");
    const wrap = document.querySelector("#tabPedir .map-search-wrap");
    if (!pac) return { ok: false, reason: "sem pac" };
    const root = pac.shadowRoot;
    const input = root?.querySelector("input, [role=combobox]");
    const rect = pac.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    const stage = document.querySelector("#tabPedir .map-stage");
    const stageStyle = stage ? getComputedStyle(stage) : null;
    return {
      ok: true,
      hasShadow: !!root,
      hasInput: !!input,
      pacDisplay: getComputedStyle(pac).display,
      pacVisibility: getComputedStyle(pac).visibility,
      pacPointerEvents: getComputedStyle(pac).pointerEvents,
      pacHeight: rect.height,
      pacWidth: rect.width,
      wrapVisibility: wrap ? getComputedStyle(wrap).visibility : null,
      stageOverflow: stageStyle?.overflow,
      placeholder: pac.placeholder || input?.placeholder,
    };
  });

  console.log("PAC:", JSON.stringify(pacInfo, null, 2));

  let suggestions = 0;
  let typed = false;
  if (pacInfo.ok && pacInfo.hasInput) {
    await page.evaluate(() => {
      const pac = document.querySelector("#tabPedir gmp-place-autocomplete");
      const input = pac.shadowRoot.querySelector("input, [role=combobox]");
      input.focus();
      input.click();
    });
    await page.keyboard.type("Parauapebas", { delay: 40 });
    typed = true;
    await page.waitForTimeout(3500);

    suggestions = await page.evaluate(() => {
      const pac = document.querySelector("#tabPedir gmp-place-autocomplete");
      const root = pac?.shadowRoot;
      if (!root) return 0;
      const items = root.querySelectorAll(
        '[role="option"], .dropdown-item, li, gmp-place-autocomplete-item, [data-place-id]'
      );
      return items.length;
    });
    console.log("Sugestões no shadow (heurística):", suggestions);

    // painel flutuante fora do shadow (algumas versões do widget)
    const ext = await page.locator('[role="listbox"] [role="option"]').count();
    console.log("Sugestões listbox na página:", ext);
    suggestions = Math.max(suggestions, ext);
  }

  const warnPlaces = logs.filter(
    (l) =>
      /autocomplete|places|Maps|ApiTargetBlocked|RefererNotAllowed|InvalidKey/i.test(l)
  );
  if (warnPlaces.length) {
    console.log("Logs relevantes:");
    warnPlaces.slice(0, 15).forEach((l) => console.log(" ", l));
  }

  const ok =
    pacVisible &&
    pacInfo.ok &&
    pacInfo.pacHeight > 10 &&
    pacInfo.pacWidth > 50 &&
    typed &&
    suggestions > 0;

  console.log("\nRESULTADO:", ok ? "BUSCA OK (sugestões apareceram)" : "BUSCA QUEBRADA");
  if (!ok) {
    console.log("Últimos 20 logs:");
    logs.slice(-20).forEach((l) => console.log(" ", l));
    process.exitCode = 1;
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
