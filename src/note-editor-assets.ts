import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { HttpRoute } from "./http-routing.js";

const gsapPath = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");

export function noteEditorAssetRoute(): HttpRoute {
  return {
    matches: (request, url) => request.method === "GET" && url.pathname === "/assets/gsap.min.js",
    async handle(_request, response) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" });
      response.end(await readFile(gsapPath));
      return true;
    },
  };
}

export const noteEditorMotion = `
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
const move=(target,vars)=>{if(reducedMotion){gsap.set(target,{clearProps:'all'});return}gsap.fromTo(target,vars.from,{...vars.to,duration:vars.duration||.28,ease:'power2.out'})};
const announce=(message,kind)=>{status.textContent=message;status.dataset.kind=kind;if(!reducedMotion){gsap.fromTo(status,{opacity:.35,y:-3},{opacity:1,y:0,duration:.22,ease:'power2.out'});if(kind==='error'||kind==='conflict')gsap.fromTo('.toolbar',{x:-3},{x:0,duration:.32,ease:'elastic.out(1,.45)'})}};
`;
