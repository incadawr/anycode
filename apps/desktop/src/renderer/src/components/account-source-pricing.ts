import type { AccountCatalogView } from "../../../shared/account-sources.js";

type Model = AccountCatalogView["models"][number];
function dollars(micros: string): string {
  const n = BigInt(micros);
  const fraction = String(n % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return `$${n / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
export function accountModelPrice(model: Model, short = false): string {
  if (model.billing === "free") return "Free";
  const rates = model.ratesMicrosPerMillionTokens;
  return rates ? `${dollars(rates.input)} ${short ? "in" : "input"} / ${dollars(rates.output)} ${short ? "out" : "output"} per 1M` : "Price unknown";
}
