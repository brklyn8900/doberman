import * as React from "react";
import { DayPicker } from "react-day-picker";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("rounded-2xl bg-stone-950 p-3 text-stone-100", className)}
      classNames={{
        months: "flex flex-col gap-4",
        month: "space-y-4",
        month_caption: "relative flex items-center justify-center pt-1",
        caption_label: "text-sm font-medium text-stone-100",
        nav: "flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute left-1 h-7 w-7 rounded-lg border border-stone-800 bg-stone-900/70 p-0 text-stone-300 hover:bg-stone-800 hover:text-stone-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute right-1 h-7 w-7 rounded-lg border border-stone-800 bg-stone-900/70 p-0 text-stone-300 hover:bg-stone-800 hover:text-stone-100",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "w-9 rounded-md text-[0.8rem] font-normal text-stone-500",
        week: "mt-2 flex w-full",
        day: "relative h-9 w-9 p-0 text-center text-sm",
        day_button: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "h-9 w-9 rounded-lg p-0 font-normal text-stone-200 aria-selected:bg-primary aria-selected:text-primary-foreground hover:bg-stone-800 hover:text-stone-100",
        ),
        selected:
          "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
        today: "border border-stone-600 bg-stone-900 text-stone-100",
        outside: "text-stone-600 aria-selected:text-stone-500",
        disabled: "text-stone-700 opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeftIcon className="h-4 w-4" />
          ) : (
            <ChevronRightIcon className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}

export { Calendar };
