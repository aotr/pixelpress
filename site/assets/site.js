const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* Mobile navigation */
const navToggle = $(".nav-toggle");
const nav = $("#site-nav");
if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.textContent = open ? "Close" : "Menu";
  });
  $$("a", nav).forEach((link) => link.addEventListener("click", () => {
    nav.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.textContent = "Menu";
  }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("open")) {
      nav.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.textContent = "Menu";
      navToggle.focus();
    }
  });
}

/* Copy buttons */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

$$("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const selector = button.getAttribute("data-copy");
    const target = selector ? $(selector) : null;
    const text = target ? target.textContent.trim() : button.getAttribute("data-copy-text")?.trim();
    if (!text) return;
    if (await copyText(text)) {
      const previous = button.textContent;
      button.textContent = "Copied";
      button.classList.add("done");
      window.setTimeout(() => {
        button.textContent = previous;
        button.classList.remove("done");
      }, 1400);
    }
  });
});

/* Tabs */
$$("[data-tabs]").forEach((group) => {
  const buttons = $$("[role=tab]", group);
  const scope = group.closest("[data-tab-scope]") ?? document;
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((item) => item.setAttribute("aria-selected", String(item === button)));
      const name = button.dataset.tab;
      $$("[data-panel]", scope).forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === name);
      });
    });
  });
});

/* Command builder */
const builder = $("[data-builder]");
if (builder) {
  const preset = $("#b-preset", builder);
  const formats = $("#b-formats", builder);
  const widths = $("#b-widths", builder);
  const hash = $("#b-hash", builder);
  const prune = $("#b-prune", builder);
  const lqip = $("#b-lqip", builder);
  const report = $("#b-report", builder);
  const cli = $("#b-cli", builder);
  const api = $("#b-api", builder);
  const config = $("#b-config", builder);

  const values = () => {
    const formatList = formats.value.split(",").map((item) => item.trim()).filter(Boolean);
    const widthList = widths.value.split(",").map((item) => item.trim()).filter(Boolean);
    return { formatList, widthList };
  };

  const render = () => {
    const { formatList, widthList } = values();
    const flags = [];
    if (hash.checked) flags.push("--hash");
    if (prune.checked) flags.push("--prune");
    if (lqip.checked) flags.push("--lqip");
    if (report.checked) flags.push("--report dist/report.html");

    const cliParts = [
      'pixelpress "public/images/**/*.{jpg,png}"',
      "-o dist/images",
      "-r",
      preset.value ? `--preset ${preset.value}` : "",
      formatList.length ? `-f ${formatList.join(",")}` : "",
      widthList.length ? `-w ${widthList.join(",")}` : "",
      ...flags,
    ].filter(Boolean);
    cli.textContent = cliParts.join(" ");

    const apiOptions = [
      "  outDir: 'dist/images',",
      "  recursive: true,",
      preset.value ? `  preset: '${preset.value}',` : "",
      `  formats: [${formatList.map((item) => `'${item}'`).join(", ")}],`,
      `  widths: [${widthList.join(", ")}],`,
      hash.checked ? "  hash: true," : "",
      prune.checked ? "  prune: true," : "",
      lqip.checked ? "  lqip: true," : "",
      "  cache: true,",
    ].filter(Boolean);
    api.textContent = [
      "import { optimize } from 'pixelpress';",
      "",
      "const report = await optimize(",
      "  ['public/images/**/*.{jpg,png}'],",
      "  {",
      ...apiOptions,
      "  },",
      ");",
      "",
      "console.log(report.totals.savedPercent, '% smaller');",
      report.checked ? "\n// HTML report is CLI-only: pixelpress ... --report dist/report.html" : "",
    ].filter(Boolean).join("\n");

    const configLines = [
      "{",
      preset.value ? `  "preset": "${preset.value}",` : "",
      '  "inputs": ["public/images/**/*.{jpg,png}"],',
      '  "outDir": "dist/images",',
      "  \"recursive\": true,",
      formatList.length ? `  "formats": [${formatList.map((item) => `"${item}"`).join(", ")}],` : "",
      widthList.length ? `  "widths": [${widthList.join(", ")}],` : "",
      hash.checked ? '  "hash": true,' : "",
      '  "cache": true,',
      prune.checked ? '  "prune": true,' : "",
      lqip.checked ? '  "lqip": true,' : "",
      report.checked ? '  "report": "dist/report.html",' : "",
      "}",
    ].filter(Boolean);
    config.textContent = configLines.join("\n").replace(",\n}", "\n}");
  };

  [preset, formats, widths, hash, prune, lqip, report].forEach((input) => {
    input.addEventListener("input", render);
    input.addEventListener("change", render);
  });
  render();

  const builderCopy = $("#b-copy", builder);
  if (builderCopy) {
    builderCopy.addEventListener("click", async () => {
      const active = $("[data-panel].active", builder);
      if (!active) return;
      if (await copyText(active.textContent.trim())) {
        builderCopy.textContent = "Copied";
        window.setTimeout(() => { builderCopy.textContent = "Copy"; }, 1400);
      }
    });
  }
}

/* Footer year */
$$("[data-year]").forEach((element) => {
  element.textContent = String(new Date().getFullYear());
});
