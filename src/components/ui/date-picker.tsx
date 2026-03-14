import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DatePickerProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

function parseDate(value: string): Date | undefined {
  if (!value) return undefined;

  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;

  return new Date(year, month - 1, day);
}

export function DatePicker({
  id,
  value,
  onChange,
  placeholder = "Pick a date",
  className,
  ariaLabel,
}: DatePickerProps) {
  const selected = parseDate(value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          aria-label={ariaLabel}
          className={cn(
            "w-[172px] justify-between rounded-xl border-stone-700 bg-stone-950/80 text-left font-normal text-stone-100 hover:bg-stone-900 hover:text-stone-100",
            !selected && "text-stone-500",
            className,
          )}
        >
          {selected ? format(selected, "MM/dd/yyyy") : placeholder}
          <CalendarIcon className="h-4 w-4 text-stone-500" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto rounded-2xl border-stone-800 bg-stone-950/95 p-3 text-stone-100 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
      >
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (date) {
              onChange(format(date, "yyyy-MM-dd"));
            }
          }}
          initialFocus
          className="rounded-xl"
        />
      </PopoverContent>
    </Popover>
  );
}
