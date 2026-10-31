// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPOSER_CLEARANCE_GAP_PX,
  COMPOSER_CLEARANCE_VAR,
  composerClearancePx,
  publishComposerClearance,
  trackComposer,
} from "./composer-clearance.js";

/**
 * The number the live composer publishes for the toast stack (UI audit v0.0.49
 * C2): the distance from the viewport's bottom edge to the stack's lower edge,
 * i.e. everything from the card's top edge downward plus the breathing gap.
 */
describe("composerClearancePx", () => {
  it("reaches from the composer's top edge to the window's bottom, plus the gap", () => {
    // A 110px card ending 16px above the bottom: the stack's floor is 126+gap.
    expect(composerClearancePx(674, 800)).toBe(126 + COMPOSER_CLEARANCE_GAP_PX);
    expect(COMPOSER_CLEARANCE_GAP_PX).toBeGreaterThan(0);
  });

  it("grows as the card grows — a taller draft lifts the stack further", () => {
    const short = composerClearancePx(674, 800);
    const tall = composerClearancePx(550, 800);
    expect(tall).toBeGreaterThan(short);
    expect(tall - short).toBe(124);
  });

  it("rounds to whole pixels, and never returns a negative offset", () => {
    expect(composerClearancePx(674.4, 800)).toBe(138);
    // Degenerate geometry (a mid-animation or zero-height card below the fold)
    // must leave the stack at the window floor, not push it off screen.
    expect(composerClearancePx(820, 800)).toBe(0);
    expect(composerClearancePx(Number.NaN, 800)).toBe(0);
  });
});

const rect = (top: number, height: number): DOMRect =>
  ({ x: 0, y: top, top, left: 0, right: 700, bottom: top + height, width: 700, height, toJSON: () => ({}) }) as DOMRect;

/** A card element whose layout the test controls (jsdom does no layout of its own). */
function card(top: number, height = 110): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => rect(top, height);
  return element;
}

describe("publishing --composer-clearance for the live cards", () => {
  const untrack: Array<() => void> = [];
  const track = (element: HTMLElement): HTMLElement => {
    untrack.push(trackComposer(element));
    return element;
  };
  const published = (): string => document.documentElement.style.getPropertyValue(COMPOSER_CLEARANCE_VAR);

  afterEach(() => {
    while (untrack.length > 0) {
      untrack.pop()!();
    }
    document.documentElement.style.removeProperty(COMPOSER_CLEARANCE_VAR);
  });

  it("publishes the card's clearance, so the stylesheet can lift the stack", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    track(card(640));
    expect(published()).toBe(`${composerClearancePx(640, 800)}px`);
  });

  it("takes the LARGEST clearance when two composers are on screen (split layout)", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    track(card(700)); // master, short card
    track(card(560)); // child pane, taller card — its controls sit higher
    expect(published()).toBe(`${composerClearancePx(560, 800)}px`);
  });

  it("ignores a card that is not laid out, instead of inflating the value", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    track(card(640));
    track(card(0, 0)); // a display:none pane's zero rect
    expect(published()).toBe(`${composerClearancePx(640, 800)}px`);
  });

  it("drops the property only when the LAST card leaves, and republishes for the rest", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const master = card(700);
    const child = card(560);
    const untrackChild = trackComposer(child);
    const untrackMaster = trackComposer(master);
    expect(published()).toBe(`${composerClearancePx(560, 800)}px`);

    untrackChild();
    expect(published()).toBe(`${composerClearancePx(700, 800)}px`);

    untrackMaster();
    // No composer on screen (start/welcome/empty): the corner fallback applies.
    expect(published()).toBe("");
    // Publishing on demand with nothing tracked stays a no-op.
    publishComposerClearance();
    expect(published()).toBe("");
  });
});
