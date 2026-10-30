import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class helper: joins classes and lets later Tailwind classes win. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
