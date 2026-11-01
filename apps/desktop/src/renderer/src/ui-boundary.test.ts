import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { maskComments } from "./source-comments.test-utils.js";
function files(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}
it("keeps the UI kit independent and exposes only ui/index to consumers",()=>{
  const root=fileURLToPath(new URL("./",import.meta.url)), ui=join(root,"ui");
  const errors:string[]=[];
  for(const path of files(root).filter(p=>/\.(ts|tsx)$/.test(p)&&!p.includes(".test."))) {
    const source=maskComments(readFileSync(path,"utf8"));
    const inside=path.startsWith(ui+sep);
    if(inside && /\bwindow\s*(?:\?\.)?\.?\s*anycode\b/.test(source)) errors.push(`${relative(root,path)}: window.anycode`);
    for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const spec=match[1]!;
      if(!spec.startsWith(".")) continue;
      const target=resolve(dirname(path),spec);
      if(inside&&!target.startsWith(ui+sep)) errors.push(`${relative(root,path)}: imports outside kit: ${spec}`);
      if(!inside&&target.startsWith(ui+sep)&&!/^index(?:\.js|\.ts)?$/.test(relative(ui,target))) {
        // The sole deep-import exception is the explicitly DEV-gated gallery bootstrap.
        if(path===join(root,"main.tsx")&&spec==="./ui/gallery/Gallery.js"&&/if\s*\(import\.meta\.env\.DEV && view === "ui-gallery"\)\s*\{\s*void import\("\.\/ui\/gallery\/Gallery\.js"\)/.test(source)) continue;
        errors.push(`${relative(root,path)}: use ui/index instead of ${spec}`);
      }
    }
  }
  expect(errors).toEqual([]);
});
function unscopedSelectors(css: string): string[] {
  const clean=css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)].flatMap(m=>m[1]!.split(",").map(s=>s.trim()))
    .filter(s=>!s.startsWith(".ak-")&&!s.startsWith("@")&&!/^(?:from|to|\d+%)/.test(s));
}
it("rejects an unscoped selector anywhere in a selector list",()=>{
  expect(unscopedSelectors(".ak-a, button {}" )).toEqual(["button"]);
  expect(unscopedSelectors("button, .ak-a {}" )).toEqual(["button"]);
  expect(unscopedSelectors(".ak-a, .ak-b {}" )).toEqual([]);
});
it("scopes kit CSS selectors and keeps modal layout out of inline styles",()=>{
  const css=readFileSync(new URL("./ui/ui.css",import.meta.url),"utf8");
  expect(unscopedSelectors(css)).toEqual([]);
  expect(css).toMatch(/\.ak-modal\s*\{[^}]*position:\s*fixed[^}]*max-height:\s*86vh/s);
});
it("hides a closed native modal even though its open layout uses flex",()=>{
  const css=readFileSync(new URL("./ui/ui.css",import.meta.url),"utf8");
  expect(css).toMatch(/\.ak-modal:not\(\[open\]\)\s*\{\s*display:\s*none\s*;/);
});

it("keeps URL strings and multiline templates while masking boundary comments",()=>{
  const source = 'const url="https://example.test"; import { Button } from "./ui/components/Button.js"; // ignored\nconst template=`first\nhttps://example.test\nlast`;';
  const clean=maskComments(source);
  expect(clean).toContain('from "./ui/components/Button.js"');
  expect(clean).toContain("https://example.test\nlast");
  expect(clean).not.toContain("// ignored");
});
