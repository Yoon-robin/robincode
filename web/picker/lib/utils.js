import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui's class joiner: later Tailwind classes win over earlier ones
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
