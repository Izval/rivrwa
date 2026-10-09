// useScrollReveal.ts — the film's pacing on the page: each beat rises into place as it scrolls into view, and the
// figures the story leans on count up from zero, once. Built on anime.js's scroll observer.
//
// Markup opts in with data attributes, so pages stay plain JSX:
//   data-reveal           the element rises and fades in;
//   data-reveal="stagger" its children do, one after another;
//   data-count="67.7"     the text counts up to the value (data-dp decimals, data-prefix, data-suffix).
// The server renders every element in its final state, so nothing depends on JavaScript. On the client, only what
// is still below the fold is hidden and animated, so nothing already on screen flickers. Visitors who prefer reduced
// motion get the page as rendered. The scope reverts every style it set when the page unmounts.

import { useEffect } from "react";
import { animate, createScope, onScroll, stagger, utils } from "animejs";

const ENTER = "bottom-=60 top"; // when the element's top is 60px above the bottom of the viewport

/** Start `anim` the first time `el` scrolls in. Not `autoplay: onScroll(...)`: that pauses an animation whose element
 *  leaves the viewport, so a fast scroll would strand it half-faded. Once started, it always finishes. */
const playOnEnter = (el: Element, anim: { play(): unknown }) => onScroll({ target: el, enter: ENTER, repeat: false, onEnter: () => anim.play() });

export function useScrollReveal() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const below = (el: Element) => el.getBoundingClientRect().top > window.innerHeight - 60;
    const scope = createScope().add(() => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
        if (!below(el)) continue;
        const items = el.dataset.reveal === "stagger" ? [...el.children] : [el];
        utils.set(items, { opacity: 0, y: 28 });
        playOnEnter(el, animate(items, { opacity: 1, y: 0, duration: 900, delay: stagger(110), ease: "out(4)", autoplay: false }));
      }
      for (const el of document.querySelectorAll<HTMLElement>("[data-count]")) {
        if (!below(el)) continue;
        const to = Number(el.dataset.count), dp = Number(el.dataset.dp ?? 1);
        const show = (n: number) => { el.textContent = `${el.dataset.prefix ?? ""}${n.toFixed(dp)}${el.dataset.suffix ?? ""}`; };
        const v = { n: 0 };
        show(0);
        playOnEnter(el, animate(v, { n: to, duration: 1600, ease: "out(3)", onUpdate: () => show(v.n), onComplete: () => show(to), autoplay: false }));
      }
    });
    return () => scope.revert();
  }, []);
}
