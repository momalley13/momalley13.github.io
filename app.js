const ATM_BAR = 1.01325;
const BAR_TO_PSI = 14.5038;
const FILTERS = [
  ["common", "Common"],
  ["all", "All"],
  ["natural", "Natural"],
  ["commercial", "Commercial"],
  ["ac", "A/C"],
  ["industrial", "Industrial"],
  ["ultralow", "Ultra-low"],
  ["chiller", "Chillers"],
  ["automotive", "Auto"],
  ["domestic", "Domestic"],
  ["transport", "Transport"],
  ["legacy", "Legacy"],
];
const USED = {
  natural: "natural-refrigerant systems",
  domestic: "domestic refrigerators and freezers",
  commercial: "commercial refrigeration",
  industrial: "industrial plants",
  ac: "A/C systems",
  automotive: "automotive air conditioning",
  chiller: "chillers",
  ultralow: "ultra-low and cascade freezers",
  transport: "transport refrigeration",
  legacy: "legacy systems still in service",
};

const $ = (id) => document.getElementById(id);
let refs = [];
const state = {
  id: "R-744",
  tab: "lookup",
  mode: "t",
  temp: "-50",
  tUnit: "C",
  press: "6.8",
  pUnit: "barabs",
  coilP: "6.8",
  coilPU: "barabs",
  coilT: "-45",
  coilTU: "C",
  step: 5,
  logScale: false,
  query: "",
  filter: "common",
  coilSeeded: false,
};

function cToF(c) { return c * 1.8 + 32; }
function fToC(f) { return (f - 32) / 1.8; }
function toPa(value, unit) {
  const bar = unit === "barabs" ? value : unit === "barg" ? value + ATM_BAR : unit === "psia" ? value / BAR_TO_PSI : value / BAR_TO_PSI + ATM_BAR;
  return bar * 1e5;
}
function fromPa(pa, unit) {
  const bar = pa / 1e5;
  if (unit === "barabs") return bar;
  if (unit === "barg") return bar - ATM_BAR;
  if (unit === "psia") return bar * BAR_TO_PSI;
  return (bar - ATM_BAR) * BAR_TO_PSI;
}
function curveOf(r, which) { return which === "d" && r.pd ? r.pd : r.pb; }
function tMax(r) { return r.t0 + (r.pb.length - 1) * r.dt; }
function pressureAt(r, tC, which) {
  const arr = curveOf(r, which);
  if (tC < r.t0 - 1e-6 || tC > tMax(r) + 1e-6) return null;
  const x = (tC - r.t0) / r.dt;
  const i = Math.floor(x);
  const frac = x - i;
  if (i >= arr.length - 1) return arr[arr.length - 1];
  const p0 = arr[i], p1 = arr[i + 1];
  if (frac < 1e-9 || p0 <= 0 || p1 <= 0) return p0;
  return Math.exp(Math.log(p0) * (1 - frac) + Math.log(p1) * frac);
}
function tempAt(r, pa, which) {
  const arr = curveOf(r, which);
  if (!(pa > 0) || pa < arr[0] || pa > arr[arr.length - 1]) return null;
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < pa) lo = mid; else hi = mid;
  }
  const p0 = arr[lo], p1 = arr[hi];
  if (p1 <= p0) return r.t0 + lo * r.dt;
  const frac = (Math.log(pa) - Math.log(p0)) / (Math.log(p1) - Math.log(p0));
  return r.t0 + (lo + frac) * r.dt;
}
function glideAt(r, pa) {
  if (!r.pd) return r.glide;
  const tb = tempAt(r, pa, "b");
  const td = tempAt(r, pa, "d");
  if (tb == null || td == null) return null;
  return td - tb;
}
const UNIT = { barabs: "bar abs", barg: "bar gauge", psia: "psia", psig: "psig" };
function formatP(pa, unit) {
  const v = fromPa(pa, unit);
  const abs = Math.abs(v);
  const digits = unit.startsWith("psi") ? (abs >= 100 ? 0 : 1) : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.1 ? 3 : 4;
  return `${v.toFixed(digits)} ${UNIT[unit]}`;
}
function formatT(c, unit, digits = 1) {
  const v = unit === "F" ? cToF(c) : c;
  return `${v.toFixed(digits).replace("-", "−")} °${unit}`;
}
function bothT(c) { return `${formatT(c, "C")} / ${formatT(c, "F")}`; }
function otherPressures(pa, primary) {
  return ["barabs", "barg", "psig", "psia"].filter((u) => u !== primary).map((u) => formatP(pa, u)).join("  ·  ");
}
function vacuumNote(pa) {
  const psig = fromPa(pa, "psig");
  if (psig >= -0.05) return null;
  return `${(-psig * 2.036).toFixed(1)} inHg vacuum`;
}
function usedIn(groups) {
  const parts = (groups || []).map((g) => USED[g]).filter(Boolean);
  if (!parts.length) return "Specialty or less common. The saturation curve is still here.";
  if (parts.length === 1) return `Used in ${parts[0]}.`;
  return `Used in ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}
function current() { return refs.find((r) => r.id === state.id) || refs[0]; }
function minus(s) { return String(s).replace("-", "−"); }
function esc(s) {
  const map = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" };
  return String(s ?? "").replace(/[&<>"']/g, (c) => "&" + map[c] + ";");
}
function tone(safety) {
  if (!safety) return "";
  if (safety.startsWith("A3") || safety.startsWith("B3") || safety === "A2" || safety === "B2") return "warn";
  if (safety.includes("2L") || safety.startsWith("B")) return "note";
  return "";
}
function flagsFor(r, tC) {
  let warn = null, note = null;
  if (r.ttriple != null && tC <= r.ttriple + 0.4) {
    warn = r.id === "R-744" ? "At the triple point. Liquid cannot exist. Dry-ice risk." : "At the triple point. Liquid cannot exist below this.";
  } else if (r.critExact && r.tcrit != null && tC >= r.tcrit - 0.4) {
    warn = "At the critical point. Saturation ends. Do not treat this as a condenser pressure.";
  } else if (r.id === "R-744" && tC < -52) {
    note = "Below the practical CO2 coil floor of about −50 to −52 °C. Watch the cutout.";
  }
  if (r.safety === "A3" || r.safety === "A2" || r.safety === "B3" || r.safety === "B2") note = note ?? `${r.safety} refrigerant. Flammable — keep ignition sources out of the work.`;
  else if (r.safety === "A2L") note = note ?? "A2L. Mildly flammable. Stay inside the OEM charge limit.";
  else if (r.id === "R-717") note = note ?? "B2L ammonia. Toxic and mildly flammable. Not a halocarbon job.";
  else if (r.safety && r.safety.startsWith("B")) note = note ?? `${r.safety}. Higher toxicity — follow the mechanical-room rules.`;
  return { warn, note };
}
function readLookup(r) {
  if (state.mode === "t") {
    const raw = Number(state.temp);
    if (!Number.isFinite(raw)) return { error: "Enter a temperature." };
    const tC = state.tUnit === "F" ? fToC(raw) : raw;
    const bubble = pressureAt(r, tC, "b");
    const dew = pressureAt(r, tC, "d");
    if (bubble == null) {
      return { error: tC > tMax(r) ? (r.critExact ? "Above the critical temperature. No saturation pressure, and no condenser." : "Above the top of the saturation curve.") : "Below the bottom of the saturation curve. No liquid here.", tC };
    }
    return { tC, bubble, dew: r.pd ? dew : bubble, ...flagsFor(r, tC) };
  }
  const raw = Number(state.press);
  if (!Number.isFinite(raw)) return { error: "Enter a pressure." };
  const pa = toPa(raw, state.pUnit);
  const tBub = tempAt(r, pa, "b");
  const tDew = tempAt(r, pa, "d");
  if (tBub == null && tDew == null) {
    const top = r.pb[r.pb.length - 1];
    return { error: pa > top ? (r.critExact ? "Above the critical pressure. There is no saturation temperature." : "Above the top of the saturation curve. No bubble or dew point.") : "Below the bottom of the saturation curve." };
  }
  const tC = tDew ?? tBub;
  return { tC, bubble: tBub == null ? null : pa, dew: tDew == null ? null : pa, ...flagsFor(r, tC) };
}
function banners(lookup) {
  return `${lookup.warn ? `<div class="banner warn">${esc(lookup.warn)}</div>` : ""}${lookup.note ? `<div class="banner note">${esc(lookup.note)}</div>` : ""}`;
}
function readout(kicker, value) {
  return `<div><p class="kicker">${kicker}</p><p class="big">${esc(value)}</p></div>`;
}

function renderLookup(r) {
  const lookup = readLookup(r);
  const zeo = Boolean(r.pd);
  const modes = `
    <div class="modes">
      <button type="button" data-mode="t" class="${state.mode === "t" ? "on" : ""}">Temp → pressure</button>
      <button type="button" data-mode="p" class="${state.mode === "p" ? "on" : ""}">Pressure → temp</button>
    </div>`;
  const field = state.mode === "t"
    ? fieldHtml("Temperature", "temp", state.temp, "tUnit", state.tUnit, [["C", "°C"], ["F", "°F"]])
    : fieldHtml("Pressure", "press", state.press, "pUnit", state.pUnit, [["barabs", "bar abs"], ["barg", "bar gauge"], ["psig", "psig"], ["psia", "psia"]]);
  let body = "";
  if (lookup.error) body = `<div class="banner warn">${esc(lookup.error)}</div>`;
  else if (state.mode === "t" && lookup.bubble != null) {
    const vac = vacuumNote(lookup.bubble);
    body = `<div class="result">
      ${zeo ? `<div class="split">${readout("Liquid", formatP(lookup.bubble, state.pUnit))}${readout("Vapor", lookup.dew != null ? formatP(lookup.dew, state.pUnit) : "—")}</div>` : readout("Saturation", formatP(lookup.bubble, state.pUnit))}
      <p class="sub">${esc(otherPressures(lookup.bubble, state.pUnit))}</p>
      <p class="fine">${esc(bothT(lookup.tC))}</p>
      ${vac ? `<p class="fine">${esc(vac)}</p>` : ""}
      ${zeo ? `<p class="fine">At one temperature the liquid and vapor sit at different pressures. In the field, pressure is usually what you know.</p>` : ""}
      ${banners(lookup)}
    </div>`;
  } else if (state.mode === "p" && lookup.tC != null) {
    const glide = lookup.bubble != null ? glideAt(r, lookup.bubble) : null;
    body = `<div class="result">
      ${zeo
        ? `<div class="split">${readout("Vapor", tempLabel(r, lookup, "d"))}${readout("Liquid", tempLabel(r, lookup, "b"))}</div>`
        : readout("Saturation", bothT(lookup.tC))}
      ${zeo && glide != null ? `<p class="sub">Glide ${glide.toFixed(1)} K / ${(glide * 1.8).toFixed(1)} °F</p>` : ""}
      ${lookup.bubble != null ? `<p class="fine">${esc(otherPressures(lookup.bubble, state.pUnit))}</p>` : ""}
      ${banners(lookup)}
    </div>`;
  }
  $("panel-lookup").innerHTML = modes + field + body;
}
function tempLabel(r, lookup, which) {
  if (lookup.bubble == null) return "—";
  const t = tempAt(r, lookup.bubble, which);
  return t == null ? "—" : bothT(t);
}
function fieldHtml(label, inputId, value, unitId, unit, options) {
  return `<label><span>${label}</span><span class="row">
    <input id="${inputId}" inputmode="decimal" value="${esc(value)}" aria-label="${label}">
    <select id="${unitId}" aria-label="${label} unit">${options.map(([id, name]) => `<option value="${id}"${id === unit ? " selected" : ""}>${name}</option>`).join("")}</select>
  </span></label>`;
}

function renderCoil(r) {
  const pv = Number(state.coilP), tv = Number(state.coilT);
  let body;
  if (!Number.isFinite(pv) || !Number.isFinite(tv)) body = `<div class="banner warn">Enter a pressure and a temperature.</div>`;
  else {
    const pa = toPa(pv, state.coilPU);
    const tIn = state.coilTU === "F" ? fToC(tv) : tv;
    const tDew = tempAt(r, pa, "d");
    const tBub = tempAt(r, pa, "b");
    if (tDew == null || tBub == null) body = `<div class="banner warn">That pressure is outside the saturation curve.</div>`;
    else {
      const sh = tIn - tDew, sc = tBub - tIn;
      body = `<div class="result">
        <div class="split">${readout("Superheat", `${sh.toFixed(1)} K`)}${readout("Subcooling", `${sc.toFixed(1)} K`)}</div>
        <p class="sub">${(sh * 1.8).toFixed(1)} °F superheat · ${(sc * 1.8).toFixed(1)} °F subcooling</p>
        <p class="fine">Vapor saturation ${esc(bothT(tDew))}</p>
        <p class="fine">Liquid saturation ${esc(bothT(tBub))}</p>
        ${sh < 2 ? `<div class="banner warn">Low superheat. Risk of flood-back. A typical DX target is about 5–8 K — confirm the OEM.</div>` : ""}
        ${sh > 12 ? `<div class="banner note">High superheat. The coil may be starved. Confirm the OEM target before adding charge.</div>` : ""}
        ${sc < 0 ? `<div class="banner warn">Liquid is warmer than the bubble point, so it is not subcooled.</div>` : ""}
      </div>`;
    }
  }
  $("panel-coil").innerHTML = `<p class="fine" style="margin-top:0">Superheat uses the vapor (dew) line. Subcooling uses the liquid (bubble) line. Read the coil outlet, not the compressor.</p>
    ${fieldHtml("Coil outlet pressure", "coilP", state.coilP, "coilPU", state.coilPU, [["barabs", "bar abs"], ["barg", "bar gauge"], ["psig", "psig"], ["psia", "psia"]])}
    ${fieldHtml("Coil outlet temperature", "coilT", state.coilT, "coilTU", state.coilTU, [["C", "°C"], ["F", "°F"]])}
    ${body}`;
}

function renderChart(r) {
  const lookup = readLookup(r);
  const zeo = Boolean(r.pd);
  const activeC = lookup.tC;
  const steps = [1, 2, 5, 10].map((s) => `<button type="button" data-step="${s}" class="${state.step === s ? "on" : ""}">${s} °${state.tUnit}</button>`).join("");
  $("panel-chart").innerHTML = `
    <div class="chart-top">
      <p class="fine" style="margin:0">${zeo ? "Liquid in teal, vapor in navy." : "Saturation pressure."}</p>
      <button type="button" class="log-btn ${state.logScale ? "on" : ""}" id="logBtn">Log pressure</button>
    </div>
    <p class="fine" id="logNote" hidden>Log scale needs pressures above zero. Gauge units dip into vacuum on this fluid.</p>
    <canvas id="plot" width="680" height="220"></canvas>
    <div class="steps">${steps}</div>
    <div class="table-wrap"><table><thead><tr>
      <th>°${state.tUnit}</th><th>${zeo ? "Liquid" : "Pressure"}</th>${zeo ? "<th>Vapor</th>" : ""}<th>psig</th>
    </tr></thead><tbody id="rows"></tbody></table></div>`;
  const rows = [];
  const lo = state.tUnit === "F" ? cToF(r.t0) : r.t0;
  const hi = state.tUnit === "F" ? cToF(tMax(r)) : tMax(r);
  for (let t = Math.ceil(lo / state.step) * state.step; t <= hi + 1e-6; t += state.step) {
    const tC = state.tUnit === "F" ? fToC(t) : t;
    const pb = pressureAt(r, tC, "b");
    if (pb == null) continue;
    const pd = pressureAt(r, tC, "d") ?? pb;
    const mark = activeC != null && Math.abs(tC - activeC) <= state.step / 2;
    rows.push(`<tr class="${mark ? "mark" : ""}"><td>${minus(t)}</td><td>${formatP(pb, state.pUnit).replace(/ .*/, "")}</td>${zeo ? `<td>${formatP(pd, state.pUnit).replace(/ .*/, "")}</td>` : ""}<td>${formatP(pb, "psig").replace(" psig", "")}</td></tr>`);
  }
  $("rows").innerHTML = rows.join("");
  drawChart(r, activeC);
}
function drawChart(r, activeC) {
  const cv = $("plot");
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || 320;
  const h = 220;
  cv.width = Math.floor(w * dpr);
  cv.height = Math.floor(h * dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--ink").trim();
  const muted = css.getPropertyValue("--muted").trim();
  const line = css.getPropertyValue("--line").trim();
  const brand = css.getPropertyValue("--brand").trim();
  const dew = css.getPropertyValue("--dew").trim();
  const surface = css.getPropertyValue("--surface").trim();
  const stride = Math.max(1, Math.floor(r.pb.length / 140));
  const pts = [];
  for (let i = 0; i < r.pb.length; i += stride) {
    const tC = r.t0 + i * r.dt;
    const bubble = fromPa(r.pb[i], state.pUnit);
    const dewP = r.pd ? fromPa(r.pd[i], state.pUnit) : bubble;
    pts.push({ t: state.tUnit === "F" ? cToF(tC) : tC, bubble, dew: dewP });
  }
  const canLog = state.logScale && pts.every((p) => p.bubble > 0 && p.dew > 0);
  $("logNote").hidden = !(state.logScale && !canLog);
  const pad = { l: 46, r: 10, t: 10, b: 26 };
  const xs = pts.map((p) => p.t);
  const ys = pts.flatMap((p) => [p.bubble, p.dew]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMax === yMin) yMax = yMin + 1;
  const X = (t) => pad.l + ((t - xMin) / (xMax - xMin || 1)) * (w - pad.l - pad.r);
  const Y = (p) => {
    if (canLog) {
      const a = Math.log(Math.max(yMin, 1e-6)), b = Math.log(Math.max(yMax, yMin * 1.01));
      return h - pad.b - ((Math.log(Math.max(p, 1e-6)) - a) / (b - a || 1)) * (h - pad.t - pad.b);
    }
    const span = (yMax - yMin) * 1.06 || 1;
    const base = yMin - span * 0.03;
    return h - pad.b - ((p - base) / span) * (h - pad.t - pad.b);
  };
  g.fillStyle = surface;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = line;
  g.fillStyle = muted;
  g.font = "11px sans-serif";
  g.lineWidth = 1;
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const p = canLog ? Math.exp(Math.log(Math.max(yMin, 1e-6)) + (i / ticks) * (Math.log(yMax) - Math.log(Math.max(yMin, 1e-6)))) : yMin + ((yMax - yMin) * i) / ticks;
    const y = Y(p);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    const label = Math.abs(p) >= 100 ? Math.round(p).toString() : p.toFixed(Math.abs(p) >= 10 ? 0 : 1);
    g.fillText(label, 2, y + 3);
  }
  const stroke = (key, color) => {
    g.beginPath();
    g.strokeStyle = color;
    g.lineWidth = 2;
    pts.forEach((p, i) => { const x = X(p.t), y = Y(p[key]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  };
  stroke("bubble", brand);
  if (r.pd) stroke("dew", dew);
  if (activeC != null) {
    const pa = pressureAt(r, activeC, "b");
    if (pa != null) {
      const yv = fromPa(pa, state.pUnit);
      if (!canLog || yv > 0) {
        const x = X(state.tUnit === "F" ? cToF(activeC) : activeC);
        g.fillStyle = ink;
        g.beginPath(); g.arc(x, Y(yv), 4, 0, Math.PI * 2); g.fill();
      }
    }
  }
  g.fillStyle = muted;
  g.fillText(`°${state.tUnit}`, w / 2 - 8, h - 6);
}


const LOW_STAGE = new Set(["R-13", "R-13B1", "R-14", "R-23", "R-50", "R-170", "R-503", "R-508A", "R-508B", "R-1150"]);

function chargeGuide(r) {
  const glide = r.glide || 0;
  const zeo = Boolean(r.pd) && glide >= 0.4;
  const near = r.kind === "blend" && !zeo;
  const a3 = (r.safety || "").startsWith("A3");
  const a2l = (r.safety || "").includes("2L");
  const gK = glide.toFixed(1);
  const gF = (glide * 1.8).toFixed(1);
  const steps = [];
  let title = `Charge ${r.id} by weight`;
  if (r.id === "R-744") {
    title = "Charge R-744 by weight, not by the gauge";
    steps.push(
      "Evacuate the circuit. Break the vacuum with CO2 only — don't leave nitrogen or air in it.",
      "Weigh liquid CO2 in from the cylinder. A warm idle vessel is already hundreds of psig, so the gauge cannot tell you the charge.",
      "On a transcritical rack, once the gas-cooler outlet is above 31 °C (88 °F) there is no condenser and no subcooling. Stop at the OEM charge weight.",
      "On a subcritical cascade low stage, set evaporator superheat from this one saturation line, and keep that stage's high side below the critical point.",
    );
  } else if (r.id === "R-717") {
    title = "Charge R-717 as liquid, by weight";
    steps.push(
      "Use the ammonia charging procedure and a clean ammonia-rated hose. This is not a halocarbon gauge job.",
      "Weigh liquid into the high side or the receiver. A flooded or overfeed plant is charged to operating level, not to a DX superheat.",
      "A DX ammonia coil still uses this single saturation temperature for superheat. Don't borrow a halocarbon target.",
    );
  } else if (a3) {
    title = `Charge ${r.id} by weight, in grams`;
    steps.push(
      `Evacuate, then weigh liquid ${r.id} in. The nameplate is the limit — domestic hydrocarbon cabinets are often 150 g or less.`,
      "Do not charge to a pressure, a frost line, or a superheat number. A few grams high overcharges a capillary.",
      "No ignition sources, and don't vent it into the room. A3 means it burns.",
    );
    if (zeo) steps.push("It is also a blend: only liquid may leave the cylinder. Vapor charging changes the mix.");
  } else if (zeo) {
    title = `Charge ${r.id} as liquid only`;
    steps.push(
      "Invert the cylinder or open the liquid valve. If vapor leaves first, the light component boils off and the charge no longer matches this chart.",
      "Weigh it in. After a leak, do not top off by gauge — the vapor that escaped is a different mixture. Recover and weigh a fresh charge when you don't know what left.",
      "If you feed the low side while it runs, throttle the liquid so the compressor doesn't slug. Skip that if the OEM forbids it.",
    );
  } else if (near) {
    title = `Charge ${r.id} as liquid, by weight`;
    steps.push(
      `Glide is only ${gK} K, but it is still a blend. Take liquid from the cylinder and weigh it.`,
      "A small top-off shifts this mix less than a high-glide blend. After a real leak, recover and weigh a fresh charge.",
    );
  } else {
    steps.push(
      "Evacuate, then weigh liquid into the high side with the system off. That is the accurate charge.",
      "A pure fluid can be added as vapor into the suction side while it runs — it will not fractionate. Weigh it anyway.",
      "Capillary systems live or die by the weight. TXV systems forgive a little, but the nameplate is still the target.",
    );
  }
  if (a2l && r.id !== "R-717") steps.push(`${r.safety}. Weigh to the nameplate and stay inside the charge limit for that unit and that room.`);
  if (LOW_STAGE.has(r.id)) steps.push("This is a low-stage fluid. Charge that stage alone, by weight, after a deep vacuum. Don't use the high-stage chart, and don't move gas between stages.");
  return { title, steps, places: bubblePlaces(r, zeo, near, gK, gF) };
}

function bubblePlaces(r, zeo, near, gK, gF) {
  if (r.id === "R-744") {
    return [
      ["Evaporator", "Below the critical point, R-744 has one saturation temperature. Bubble and dew are the same. Superheat is the outlet temperature minus that temperature, at the outlet pressure."],
      ["Condenser or gas cooler", "If the high side stays below 31 °C, subcooling is real: saturation temperature minus liquid-line temperature. Above 31 °C there is no bubble point and no dew point. The gas-cooler outlet is dense gas, not subcooled liquid."],
      ["Compressor", "Suction and discharge are vapor only, so bubble and dew do not apply. Read superheat at the evaporator outlet, not at the compressor, when the suction line is long."],
    ];
  }
  if (r.id === "R-717") {
    return [
      ["One temperature", "Ammonia is a pure fluid. At a given pressure, bubble point and dew point are the same number."],
      ["DX evaporator", "Superheat is the outlet temperature minus the saturation temperature at the outlet pressure. Use the evaporator outlet, not the compressor."],
      ["Flooded or overfeed coil", "The coil is kept wet on purpose. There is no useful superheat. Watch receiver or level-column level, and the pressure."],
      ["Condenser and liquid line", "Subcooling is the saturation temperature minus the liquid-line temperature, at the liquid-line pressure."],
    ];
  }
  if (zeo) {
    return [
      ["Two temperatures", `At one pressure, ${r.id} starts boiling at the bubble point and finishes at the dew point. That gap is the glide, about ${gK} K (${gF} °F).`],
      ["Evaporator", "Pressure stays about steady while the temperature glides up from the bubble point at the inlet to the dew point at the outlet. Superheat is outlet temperature minus the dew point at the outlet pressure. The bubble column makes superheat look too high."],
      ["Condenser", "Hot vapor starts condensing at the dew point and the last vapor disappears at the bubble point, so the temperature glides down. Subcooling is the bubble point minus the liquid-line temperature. The dew column makes subcooling look too high."],
      ["Compressor and liquid line", "No boiling or condensing there. The compressor sees superheated vapor. The liquid line should already be cooler than the bubble point. Read the pressure at the same place you read the temperature."],
    ];
  }
  if (near) {
    return [
      ["Almost one temperature", `${r.id} glides about ${gK} K (${gF} °F). Bubble and dew are close enough for a rough check on either column.`],
      ["Evaporator", "The careful reading uses the dew (vapor) side: superheat is outlet temperature minus dew point at the outlet pressure."],
      ["Condenser and liquid line", "The careful reading uses the bubble (liquid) side: subcooling is bubble point minus liquid-line temperature, at the liquid-line pressure."],
      ["If you swap them", "Swapping bubble and dew only costs you about the glide. On a high-glide blend that shortcut is wrong. Here the error is small."],
    ];
  }
  return [
    ["One temperature", `${r.id} is a pure fluid. At a given pressure, bubble point and dew point are the same number. This chart has one column.`],
    ["Evaporator", "Liquid starts boiling at the metering device and finishes at the outlet. Superheat is how much warmer the outlet vapor is than the saturation temperature at the outlet pressure."],
    ["Condenser and liquid line", "Vapor finishes condensing at that same saturation temperature. Subcooling is how much cooler the liquid line is than the saturation temperature at the liquid-line pressure."],
    ["Compressor", "No phase change. It only sees superheated vapor. A reading at the compressor is not the coil's superheat if the suction line picked up heat."],
  ];
}


function phasePicture(r) {
  const glideK = r.glide || 0;
  const glide = Boolean(r.pd) && glideK >= 0.4;
  const near = r.kind === "blend" && !glide;
  const mode = r.id === "R-744" ? "co2" : glide ? "glide" : near ? "near" : "pure";
  const clamp = (t) => Math.min(tMax(r) - 0.4, Math.max(r.t0 + 0.4, t));
  const sideAt = (target) => {
    const t = clamp(target);
    const pressure = pressureAt(r, t, "d") ?? pressureAt(r, t, "b");
    if (pressure == null) return null;
    const dew = tempAt(r, pressure, "d");
    const bubble = tempAt(r, pressure, "b");
    if (dew == null || bubble == null) return null;
    return { bubble, dew, pressure };
  };
  const highTarget = r.tcrit != null ? Math.min(38, r.tcrit - 4) : 38;
  return {
    mode,
    glideK,
    low: sideAt(4),
    high: sideAt(highTarget),
    tcrit: r.tcrit,
    showCriticalEnd: Boolean(r.critExact && r.tcrit != null && r.tcrit < 36),
  };
}

function arrowPath(x, y, dir) {
  if (dir === "right") return `M ${x - 5} ${y - 6} L ${x + 7} ${y} L ${x - 5} ${y + 6}`;
  if (dir === "left") return `M ${x + 5} ${y - 6} L ${x - 7} ${y} L ${x + 5} ${y + 6}`;
  if (dir === "up") return `M ${x - 6} ${y + 5} L ${x} ${y - 7} L ${x + 6} ${y + 5}`;
  return `M ${x - 6} ${y - 5} L ${x} ${y + 7} L ${x + 6} ${y - 5}`;
}

function dot(x, y, kind) {
  const fill = kind === "bubble" ? "var(--brand)" : "var(--dew)";
  return `<circle cx="${x}" cy="${y}" r="7" fill="${fill}" stroke="var(--surface)" stroke-width="2"/>`;
}

function labelAnchor(x) {
  if (x < 96) return { x: 4, anchor: "start" };
  if (x > 264) return { x: 356, anchor: "end" };
  return { x, anchor: "middle" };
}

function loopSvg(mode) {
  const split = mode === "glide";
  const uid = split ? "glide" : "same";
  const pipe = (x1, y1, x2, y2, stroke) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="8" stroke-linecap="round"/>`;
  const end = split ? ["Dew", "Bubble"] : ["Sat", "Sat"];
  return `<svg viewBox="0 0 360 214" role="img" aria-label="Refrigeration loop showing bubble and dew points">
    <defs>
      <linearGradient id="${uid}-cond" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--dew)"/><stop offset="1" stop-color="var(--brand)"/></linearGradient>
      <linearGradient id="${uid}-evap" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="var(--brand)"/><stop offset="1" stop-color="var(--dew)"/></linearGradient>
    </defs>
    <circle cx="14" cy="14" r="5" fill="var(--brand)"/>
    <text x="24" y="18" fill="var(--muted)" font-size="12">Bubble, liquid</text>
    <circle cx="148" cy="14" r="5" fill="var(--dew)"/>
    <text x="158" y="18" fill="var(--muted)" font-size="12">Dew, vapor</text>
    <text x="180" y="46" text-anchor="middle" fill="var(--ink)" font-size="13" font-weight="600">Condenser</text>
    ${pipe(86, 70, 274, 70, split ? `url(#${uid}-cond)` : "var(--brand)")}
    <path d="${arrowPath(180, 70, "right")}" fill="var(--ink)"/>
    ${dot(86, 70, "dew")}${dot(274, 70, "bubble")}
    <text x="86" y="58" text-anchor="middle" fill="var(--dew)" font-size="11" font-weight="600">${end[0]}</text>
    <text x="274" y="58" text-anchor="middle" fill="var(--brand)" font-size="11" font-weight="600">${end[1]}</text>
    ${pipe(86, 70, 86, 156, "var(--line)")}
    <path d="${arrowPath(86, 112, "up")}" fill="var(--ink)"/>
    ${pipe(274, 70, 274, 156, "var(--line)")}
    <path d="${arrowPath(274, 112, "down")}" fill="var(--ink)"/>
    <text x="132" y="118" text-anchor="middle" fill="var(--muted)" font-size="12">Compressor</text>
    <text x="228" y="118" text-anchor="middle" fill="var(--muted)" font-size="12">TXV</text>
    <text x="180" y="196" text-anchor="middle" fill="var(--ink)" font-size="13" font-weight="600">Evaporator</text>
    ${pipe(86, 156, 274, 156, split ? `url(#${uid}-evap)` : "var(--brand)")}
    <path d="${arrowPath(180, 156, "left")}" fill="var(--ink)"/>
    ${dot(274, 156, "bubble")}${dot(86, 156, "dew")}
    <text x="274" y="176" text-anchor="middle" fill="var(--brand)" font-size="11" font-weight="600">${end[1]}</text>
    <text x="86" y="176" text-anchor="middle" fill="var(--dew)" font-size="11" font-weight="600">${end[0]}</text>
  </svg>`;
}

function trackSvg(title, hint, side, flow, glideK, mode) {
  const left = 28, right = 332, y = 46;
  const same = !side || Math.abs(side.dew - side.bubble) < 0.35;
  const span = 14;
  const mid = side ? (side.bubble + side.dew) / 2 : 0;
  const xOf = (t) => left + ((t - (mid - span / 2)) / span) * (right - left);
  const bubbleX = side && !same ? Math.min(right - 16, Math.max(left + 16, xOf(side.bubble))) : (left + right) / 2;
  const dewX = side && !same ? Math.min(right - 16, Math.max(left + 16, xOf(side.dew))) : (left + right) / 2;
  const goingRight = flow === "evap" ? dewX >= bubbleX : bubbleX >= dewX;
  let body = `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="var(--chip)" stroke-width="8" stroke-linecap="round"/>`;
  if (!same) {
    body += `<line x1="${Math.min(bubbleX, dewX)}" y1="${y}" x2="${Math.max(bubbleX, dewX)}" y2="${y}" stroke="var(--brand)" stroke-width="8" stroke-linecap="round"/>`;
  }
  if (side && same) {
    body += `${dot((left + right) / 2, y, "bubble")}
      <text x="${(left + right) / 2}" y="28" text-anchor="middle" fill="var(--ink)" font-size="12" font-weight="600">${mode === "near" ? `Bubble ≈ dew · ${glideK.toFixed(1)} K glide` : "Bubble = dew"}</text>
      <text x="${(left + right) / 2}" y="96" text-anchor="middle" fill="var(--muted)" font-size="12">${esc(formatT(side.bubble, state.tUnit))} · ${esc(formatP(side.pressure, state.pUnit))}</text>`;
  } else if (side) {
    const b = labelAnchor(bubbleX);
    const d = labelAnchor(dewX);
    body += `${dot(bubbleX, y, "bubble")}${dot(dewX, y, "dew")}
      <path d="${arrowPath((bubbleX + dewX) / 2, y, goingRight ? "right" : "left")}" fill="var(--ink)"/>
      <text x="${b.x}" y="16" text-anchor="${b.anchor}" fill="var(--brand)" font-size="12" font-weight="600">Bubble</text>
      <text x="${b.x}" y="32" text-anchor="${b.anchor}" fill="var(--ink)" font-size="12">${esc(formatT(side.bubble, state.tUnit))}</text>
      <text x="${d.x}" y="78" text-anchor="${d.anchor}" fill="var(--dew)" font-size="12" font-weight="600">Dew ${esc(formatT(side.dew, state.tUnit))}</text>
      <text x="180" y="100" text-anchor="middle" fill="var(--muted)" font-size="12">${esc(`${(side.dew - side.bubble).toFixed(1)} K glide · ${formatP(side.pressure, state.pUnit)}`)}</text>`;
  } else {
    body += `<text x="180" y="52" text-anchor="middle" fill="var(--muted)" font-size="12">No saturation at this example</text>`;
  }
  const evapHint = mode === "glide" ? "Boils from bubble toward dew" : "Bubble and dew are the same point";
  const condHint = mode === "glide" ? "Condenses from dew toward bubble" : "One saturation temperature";
  return `<p class="kicker">${esc(title)}</p><p class="fine" style="margin-top:0">${flow === "evap" ? evapHint : condHint}</p>
    <svg viewBox="0 0 360 108" role="img" aria-label="${esc(title)}">${body}</svg>`;
}

function diagramsHtml(r) {
  const phase = phasePicture(r);
  const note = phase.showCriticalEnd && phase.tcrit != null
    ? `<p class="fine">Above ${esc(bothT(phase.tcrit))} the markers disappear. There is no bubble point and no dew point.</p>`
    : "";
  return `${loopSvg(phase.mode)}
    ${trackSvg("Evaporator, one pressure", "", phase.low, "evap", phase.glideK, phase.mode)}
    ${trackSvg("Condenser, one pressure", "", phase.high, "cond", phase.glideK, phase.mode)}
    ${note}`;
}

function renderCharge(r) {
  const guide = chargeGuide(r);
  $("charge").innerHTML = `<h2>${esc(guide.title)}</h2>
    <ol>${guide.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>
    <h2>Bubble and dew through the system</h2>
    ${diagramsHtml(r)}
    ${guide.places.map(([where, what]) => `<div class="place"><dt>${esc(where)}</dt><dd>${esc(what)}</dd></div>`).join("")}
    <p class="fine">Training guidance. The nameplate and the OEM charging procedure win.</p>`;
}

function renderFacts(r) {
  const room = pressureAt(r, 25, "b");
  const items = [];
  if (r.safety) items.push(["Safety", r.safety]);
  if (r.gwp != null) items.push(["GWP 100", r.gwp.toLocaleString()]);
  if (r.tcrit != null) items.push([r.critExact ? "Critical" : "Curve ends", bothT(r.tcrit)]);
  if (r.tnbp != null) items.push(["Boiling point", bothT(r.tnbp)]);
  else if (r.id === "R-744") items.push(["Boiling point", "None — it sublimes"]);
  if (r.ttriple != null) items.push(["Triple point", bothT(r.ttriple)]);
  if (r.kind === "blend") items.push(["Glide", r.glide < 0.4 ? `${r.glide.toFixed(1)} K, near-azeotrope` : `${r.glide.toFixed(1)} K`]);
  items.push(["25 °C standstill", room != null ? formatP(room, "psig") : "No liquid at room temperature"]);
  $("facts").innerHTML = `
    <div class="facts-head"><span>${esc(r.id)}</span><em>${esc(r.comp || "")}</em></div>
    ${r.trade && r.trade !== r.name ? `<p class="fine">Also called ${esc(r.trade)}.</p>` : ""}
    <p class="sub">${esc(usedIn(r.groups))}</p>
    <dl>${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${r.approx ? `<div class="banner note">Mixture interaction data for this blend is estimated. Use it for training and confirm the OEM chart.</div>` : ""}`;
}

function matches(r, query) {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = `${r.id} ${r.name} ${r.comp} ${r.trade} ${r.safety} ${(r.groups || []).join(" ")}`.toLowerCase();
  const tight = hay.replace(/[^a-z0-9]/g, "");
  return tokens.every((t) => hay.includes(t) || tight.includes(t.replace(/[^a-z0-9]/g, "")));
}
function shown() {
  const pool = state.query.trim()
    ? refs
    : state.filter === "all" ? refs : state.filter === "common" ? refs.filter((r) => r.common) : refs.filter((r) => (r.groups || []).includes(state.filter));
  return pool.filter((r) => matches(r, state.query));
}
function renderPicker() {
  $("chips").innerHTML = FILTERS.map(([id, label]) => `<button type="button" class="chip ${!state.query.trim() && state.filter === id ? "on" : ""}" data-filter="${id}">${label}</button>`).join("");
  const list = shown();
  $("count").textContent = state.query.trim() ? "Searching every refrigerant" : `${list.length} in this group`;
  const cur = current();
  $("list").innerHTML = list.length
    ? list.map((r) => `<li><button type="button" data-id="${esc(r.id)}" class="${r.id === cur.id ? "current" : ""}"><span class="rid">${esc(r.id)}</span><span style="min-width:0;flex:1"><span class="rname">${esc(r.name)}</span><span class="rcomp">${esc(r.comp || "")}</span></span>${r.safety ? `<span class="safety ${tone(r.safety)}">${esc(r.safety)}</span>` : ""}</button></li>`).join("")
    : `<li class="fine" style="padding:16px">No refrigerant matches that.</li>`;
}

function render() {
  const r = current();
  $("subtitle").textContent = `Saturation lookup for ${refs.length} refrigerants. Training values — confirm the OEM chart.`;
  $("refId").textContent = r.id;
  $("refMeta").textContent = [r.name, r.safety, r.gwp != null ? `GWP ${r.gwp.toLocaleString()}` : ""].filter(Boolean).join(" · ");
  $("theme").textContent = document.documentElement.classList.contains("dark") ? "☀" : "☾";
  ["lookup", "chart", "coil"].forEach((tab) => {
    $(`panel-${tab}`).hidden = state.tab !== tab;
    document.querySelector(`[data-tab="${tab}"]`).classList.toggle("on", state.tab === tab);
  });
  if (state.tab === "lookup") renderLookup(r);
  if (state.tab === "chart") renderChart(r);
  if (state.tab === "coil") renderCoil(r);
  renderFacts(r);
  renderCharge(r);
  $("legal").textContent = `Curves are saturation pressures from reference equations of state. Zeotropic blends show liquid and vapor separately.${r.approx ? " This blend’s mixture data is estimated." : ""} A static vessel with liquid in it follows the liquid line at room temperature. Confirm the cylinder and the OEM chart before you set a control or open a system.`;
  if (!$("sheet").hidden) renderPicker();
}

function selectRef(id) {
  state.id = id;
  const r = current();
  if (state.coilSeeded) {
    const pa = pressureAt(r, -10, "d");
    if (pa != null) {
      const dew = tempAt(r, pa, "d") ?? -10;
      const shownT = state.coilTU === "F" ? cToF(dew + 6) : dew + 6;
      state.coilT = shownT.toFixed(1);
      state.coilP = fromPa(pa, state.coilPU).toFixed(state.coilPU.startsWith("psi") ? 1 : 2);
    }
  }
  state.coilSeeded = true;
  try {
    localStorage.setItem("ref-pt-id", id);
  } catch (e) {}
  $("sheet").hidden = true;
  state.query = "";
  $("query").value = "";
  render();
}

function bind() {
  document.body.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; render(); return; }
    const mode = event.target.closest("[data-mode]");
    if (mode) { state.mode = mode.dataset.mode; render(); return; }
    const step = event.target.closest("[data-step]");
    if (step) { state.step = Number(step.dataset.step); render(); return; }
    const filter = event.target.closest("[data-filter]");
    if (filter) { state.filter = filter.dataset.filter; state.query = ""; $("query").value = ""; renderPicker(); return; }
    const pick = event.target.closest("[data-id]");
    if (pick) { selectRef(pick.dataset.id); return; }
    if (event.target.id === "logBtn") { state.logScale = !state.logScale; render(); }
  });
  document.body.addEventListener("input", (event) => {
    const id = event.target.id;
    if (["temp", "press", "coilP", "coilT"].includes(id)) { state[id] = event.target.value; paintLive(); }
  });
  document.body.addEventListener("change", (event) => {
    const id = event.target.id;
    if (["tUnit", "pUnit", "coilPU", "coilTU"].includes(id)) {
      state[id] = event.target.value;
      try {
        if (id === "tUnit") localStorage.setItem("ref-pt-tunit", state.tUnit);
        if (id === "pUnit") localStorage.setItem("ref-pt-punit", state.pUnit);
      } catch (e) {}
      render();
    }
  });
  $("openPicker").onclick = () => { $("sheet").hidden = false; renderPicker(); $("query").focus(); };
  $("closePicker").onclick = () => { $("sheet").hidden = true; };
  $("sheet").addEventListener("click", (event) => { if (event.target === $("sheet")) $("sheet").hidden = true; });
  $("query").addEventListener("input", () => { state.query = $("query").value; renderPicker(); });
  $("theme").onclick = () => {
    const root = document.documentElement;
    const nextDark = !root.classList.contains("dark");
    root.classList.toggle("dark", nextDark);
    root.classList.toggle("light", !nextDark);
    try { localStorage.setItem("ref-pt-theme", nextDark ? "dark" : "light"); } catch (e) {}
    render();
  };
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") $("sheet").hidden = true; });
  window.addEventListener("resize", () => { if (state.tab === "chart") drawChart(current(), readLookup(current()).tC); });
}
function paintLive() {
  const active = document.activeElement;
  const id = active && active.id;
  const start = active && active.selectionStart;
  const end = active && active.selectionEnd;
  const r = current();
  if (state.tab === "lookup") renderLookup(r);
  else if (state.tab === "coil") renderCoil(r);
  else if (state.tab === "chart") renderChart(r);
  renderFacts(r);
  if (id) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      if (typeof start === "number") el.setSelectionRange(start, end);
    }
  }
}

async function boot() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) $("install").hidden = true;
  const response = await fetch("./data/refrigerants.json");
  refs = await response.json();
  try {
    const savedId = localStorage.getItem("ref-pt-id");
    const savedT = localStorage.getItem("ref-pt-tunit");
    const savedP = localStorage.getItem("ref-pt-punit");
    if (savedId && refs.some((r) => r.id === savedId)) state.id = savedId;
    if (savedT === "C" || savedT === "F") state.tUnit = savedT;
    if (["barabs", "barg", "psia", "psig"].includes(savedP)) state.pUnit = savedP;
  } catch (e) {}
  state.coilSeeded = true;
  bind();
  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  }
}
boot().catch((error) => {
  $("subtitle").textContent = "Could not load refrigerant data.";
  console.error(error);
});
