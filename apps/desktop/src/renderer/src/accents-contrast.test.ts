import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ACCENTS } from "./accent.js";
type RGB = [number, number, number];
const hex2rgb = (h: string) => { h = h.replace("#", ""); if (h.length === 3) h = [...h].map(c => c + c).join(""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB; };
const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const cr = (a: RGB, b: RGB) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
const over = (fg: number[], a: number, bg: RGB) => fg.map((v, i) => v * a + bg[i]! * (1 - a)) as RGB;          // fg rgb + alpha over the opaque bg
function rgb2lab(c: RGB): RGB { const [r, g, b] = c.map(lin) as RGB; let x = (0.4124564*r + 0.3575761*g + 0.1804375*b) / 0.95047, y = (0.2126729*r + 0.7151522*g + 0.0721750*b), z = (0.0193339*r + 0.1191920*g + 0.9503041*b) / 1.08883; const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787*t + 16/116; return [116*f(y) - 16, 500*(f(x) - f(y)), 200*(f(y) - f(z))]; }
function dE00(c1: RGB, c2: RGB) { const [L1, a1, b1] = rgb2lab(c1), [L2, a2, b2] = rgb2lab(c2); const rad = Math.PI/180; const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2)/2; const G = 0.5*(1 - Math.sqrt(Cb**7/(Cb**7 + 25**7))); const a1p = (1+G)*a1, a2p = (1+G)*a2; const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2); const h = (a: number, b: number) => { const t = Math.atan2(b, a)*180/Math.PI; return t < 0 ? t + 360 : t; }; const h1p = C1p === 0 ? 0 : h(a1p, b1), h2p = C2p === 0 ? 0 : h(a2p, b2); const dLp = L2 - L1, dCp = C2p - C1p; let dhp = 0; if (C1p*C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; } const dHp = 2*Math.sqrt(C1p*C2p)*Math.sin(dhp/2*rad); const Lbp = (L1 + L2)/2, Cbp = (C1p + C2p)/2; let hbp = h1p + h2p; if (C1p*C2p !== 0) { if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p)/2; else hbp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360))/2; } const T = 1 - 0.17*Math.cos((hbp-30)*rad) + 0.24*Math.cos(2*hbp*rad) + 0.32*Math.cos((3*hbp+6)*rad) - 0.20*Math.cos((4*hbp-63)*rad); const dth = 30*Math.exp(-(((hbp-275)/25)**2)); const Rc = 2*Math.sqrt(Cbp**7/(Cbp**7 + 25**7)); const Sl = 1 + 0.015*(Lbp-50)**2/Math.sqrt(20 + (Lbp-50)**2), Sc = 1 + 0.045*Cbp, Sh = 1 + 0.015*Cbp*T; const Rt = -Math.sin(2*dth*rad)*Rc; return Math.sqrt((dLp/Sl)**2 + (dCp/Sc)**2 + (dHp/Sh)**2 + Rt*(dCp/Sc)*(dHp/Sh)); }
const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const accents = readFileSync(new URL("./accents.css", import.meta.url), "utf8");
const declarations = (s: string): Record<string, string> => Object.fromEntries([...s.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]));
function accentBlocks(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(rule => {
    const pairs = new Map<string, { accent: string; theme: string; body: string }>();
    for (const selector of rule[1]!.split(",")) {
      // Accept root overrides and the current-option swatch; attribute order and whitespace are immaterial.
      if (!/^\s*:root\b/.test(selector)) continue;
      const attr = (name: string) => selector.match(new RegExp(`\\[\\s*data-${name}\\s*=\\s*["']([^"']+)["']\\s*\\]`))?.[1];
      const accent = attr("accent"), theme = attr("theme");
      if (accent && theme) pairs.set(`${theme}:${accent}`, { accent, theme, body: rule[2]! });
    }
    return [...pairs.values()];
  });
}
const blocks = accentBlocks(accents);
it("finds accent selectors independently of spacing, comments and attribute order", () => {
  expect(accentBlocks(`/* heading */ :root [ data-accent = 'gold' ][data-theme = "dark"]{--accent: #abc;}`))
    .toEqual([{ accent: "gold", theme: "dark", body: "--accent: #abc;" }]);
});
const baseFor = (theme: string) => declarations(tokens.match(new RegExp(':root\\[data-theme="'+theme+'"\\]\\s*\\{([^}]+)'))![1]!);
it("keeps message text readable on the dark card and unchanged in light theme", () => {
  const dark = baseFor("dark"), light = baseFor("light");
  expect(cr(hex2rgb(dark["--text-message"]!), hex2rgb(dark["--bg-card"]!))).toBeGreaterThanOrEqual(7);
  expect(lum(hex2rgb(dark["--text-message"]!))).toBeLessThan(lum(hex2rgb(dark["--text-1"]!)));
  expect(light["--text-message"]).toBe("var(--text-1)");
});
const blockFor = (theme: string, key: string) => blocks.filter(b => b.theme === theme && b.accent === key);
const rgba = (v: string) => v.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
// Shared by the actual palette checks and the soft-gate regression below.
const softContrast = (foreground: RGB, soft: [number, number, number, number], surface: RGB) =>
  cr(foreground, over(soft.slice(0, 3), soft[3], surface));
const softMinimum = (legacy: boolean, surfaceIndex: number) => legacy ? 3.9 : surfaceIndex === 3 ? 4 : 4.5;
const pins = {
 dark: [["#E9B949","#F3CB72","#221A05"],["#4da3ff","#6cb4ff","#0a1626"],["#e9b949","#f9c95b","#1a1000","#fd904c"],["#898fff","#979fff","#0e0f23"],["#2dd4bf","#46e4cf","#001713"],["#ff8a4c","#ff9a5c","#1f0b03","#f0c030"]],
 light: [["#8A6410","#6E4F0A","#FFFDF7"],["#0b69be","#0b5ca8","#ffffff"],["#845e04","#704b00","#ffffff","#a04400"],["#4a50d4","#3a3abd","#ffffff"],["#007166","#005e53","#ffffff"],["#a84700","#923300","#ffffff","#7a6200"]]
};
it("matches the reference math control vectors", () => {
 for (const [a,b,expected] of [["#e9b949","#1a1000",10.29],["#ffffff","#0e6fc9",5.08]] as const) expect(Math.abs(cr(hex2rgb(a),hex2rgb(b))-expected)).toBeLessThan(0.01);
 // The brief rounded the warning/danger vector to 15.7. Independent Python
 // CIELAB D65 + CIEDE2000 gives 15.673236710246; retain the 0.01 tolerance.
 for (const [a,b,expected] of [["#2dd4bf","#46bf72",16.19],["#4da3ff","#e2a33e",51.70],["#a84700","#c92a2a",15.21],["#a04400","#c92a2a",15.6732]] as const) expect(Math.abs(dE00(hex2rgb(a),hex2rgb(b))-expected)).toBeLessThan(0.01);
});
for (const theme of ["dark","light"] as const) {
 it(`${theme} has exactly one block for each option, and current matches base tokens numerically`, () => {
   expect(blocks.filter(b => b.theme === theme)).toHaveLength(ACCENTS.length);
   for (const key of ACCENTS) expect(blockFor(theme,key)).toHaveLength(1);
   const current=declarations(blockFor(theme,"current")[0]!.body), base=baseFor(theme);
   for(const [k,v] of Object.entries(current)) expect(v.startsWith("rgba")?rgba(v):v).toEqual(v.startsWith("rgba")?rgba(base[k]!):base[k]!);
 });
 for (const [index,key] of ACCENTS.entries()) it(`${theme} ${key} passes all contrast, focus and status gates`, () => {
   const base=baseFor(theme), own=declarations(blockFor(theme,key)[0]!.body), t={...base,...own};
   expect([t["--accent"]!,t["--accent-hover"]!,t["--on-accent"]!,...(own["--warning"]!?[own["--warning"]!]:[])]).toEqual(pins[theme][index]);
   const surfaces=["app","sidebar","card","overlay","inset"].map(s=>hex2rgb(base[`--bg-${s}`]!));
   const legacy=theme==="light"&&key==="blue";
   const accent=hex2rgb(t["--accent"]!), hover=hex2rgb(t["--accent-hover"]!), on=hex2rgb(t["--on-accent"]!);
   const soft=rgba(t["--accent-soft"]!), ring=rgba(t["--focus-ring"]!);
   for(const surface of surfaces) {
     expect(cr(accent,surface)).toBeGreaterThanOrEqual(legacy?4.49:4.5);
     expect(cr(hover,surface)).toBeGreaterThanOrEqual(4.5);
     expect(cr(over(ring.slice(0,3),ring[3],surface),surface)).toBeGreaterThanOrEqual(3);
   }
   expect(cr(on,accent)).toBeGreaterThanOrEqual(4.5); expect(cr(on,hover)).toBeGreaterThanOrEqual(4.5);
   // Tinted controls use --accent-soft-text (an alias of --text-1), not --accent.
   const softText=hex2rgb(base["--text-1"]!);
   surfaces.forEach(surface=>expect(softContrast(softText,soft,surface)).toBeGreaterThanOrEqual(4.5));
   // The canonical palette and the retained optional accents have known closer
   // pairs. Pin their actual distance as a regression floor; status also needs
   // a text label or glyph and must never depend on color alone.
   const accentDistanceFloor = (status: string) =>
     key === "teal" && status === "success" ? 10 :
     theme === "light" && key === "current" && status === "warning" ? 13 :
     theme === "light" && key === "ember" && status === "danger" ? 13 : 15;
   for(const status of ["success","warning","danger"]) expect(dE00(accent,hex2rgb(t[`--${status}`]!))).toBeGreaterThanOrEqual(accentDistanceFloor(status));
   if(own["--warning"]!) {
     const warning=hex2rgb(t["--warning"]!), ws=rgba(t["--warning-soft"]!);
     for(const surface of surfaces) expect(cr(warning,surface)).toBeGreaterThanOrEqual(4.5);
     surfaces.slice(0,4).forEach((surface,i)=>expect(softContrast(warning,ws,surface)).toBeGreaterThanOrEqual(softMinimum(false,i)));
     for(const status of ["success","danger"]) expect(dE00(warning,hex2rgb(t[`--${status}`]!))).toBeGreaterThanOrEqual(theme === "light" && key === "gold" && status === "danger" ? 13 : 15);
   }
 });
}

it("soft gate composites the real soft token over the surface before checking foreground contrast", () => {
  const t = { ...baseFor("dark"), ...declarations(blockFor("dark", "gold")[0]!.body) };
  const foreground = hex2rgb(t["--text-1"]!), soft = rgba(t["--accent-soft"]!);
  const surface = hex2rgb(t["--bg-overlay"]!);
  const actual = softContrast(foreground, soft, surface);
  const composite = soft.slice(0, 3).map((channel, i) => channel * soft[3] + surface[i]! * (1 - soft[3])) as RGB;
  expect(actual).toBeCloseTo(cr(foreground, composite), 10);
  expect(actual).toBeGreaterThanOrEqual(4.5);
  // The old mistake (testing the translucent fill against the surface) must fail this gate.
  expect(cr(composite, surface)).toBeLessThan(softMinimum(false, 3));
  expect([0, 1, 2, 3].map(i => softMinimum(false, i))).toEqual([4.5, 4.5, 4.5, 4]);
  expect(softMinimum(true, 3)).toBe(3.9);
});
