import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-xl border border-stone-700 bg-stone-950/80 px-3 py-2 text-sm text-stone-100 transition outline-hidden placeholder:text-stone-500 focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-stone-100 aria-invalid:border-rose-700 aria-invalid:ring-2 aria-invalid:ring-rose-500/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
